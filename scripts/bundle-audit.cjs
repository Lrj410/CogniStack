/* eslint-disable no-console */
/**
 * scripts/bundle-audit.cjs —— 包体与冷启动审计（G-26）
 *
 * 为什么需要这个脚本
 * ------------------
 * 宿主服务对冷启动敏感，但在这个脚本出现之前，"dist 有多大""require 一次要多久"
 * "顶层入口是不是把所有子模块都拉起来了"这三个问题没有任何人量过。没有数字的
 * 性能讨论只能靠感觉，而感觉在冷启动这种一次性固定成本上尤其不可靠。
 *
 * 设计边界（刻意为之）
 * --------------------
 *   本脚本**只测量、只报告**。它不修改任何构建配置，也不替调用者下"该优化哪块"的
 *   结论——单次测量不足以支撑改动决策（参见 scripts/bench.prepare.cjs 文件头的同一
 *   条规范）。要下结论，请先把这份报告和 bench/probe 的真实数据放在一起看。
 *
 * 测量方法
 * --------
 *   1. dist 体积：遍历文件系统求和，按扩展名分组，列出最大的 N 个 .js。
 *   2. 冷启动：**必须在独立子进程里测**。同一个进程里第二次 require 会命中
 *      require.cache，测出来的根本不是冷启动。子进程内部用 hrtime.bigint() 只计
 *      require 的墙钟；父进程同时记录端到端耗时（含 Node 启动）。跑 N 次取中位数 +
 *      IQR 并报离散度——单次取样不作为结论（同 bench.prepare.cjs）。首样本单独标出，
 *      因为第一次要真读磁盘、之后走页缓存。
 *   3. 加载模块数：用 require.cache 快照差。**刻意没用 process.moduleLoadList**：
 *      实测本包零运行时依赖、不 require 任何内建模块，require 前后 moduleLoadList
 *      长度完全不变（该列表只记录 Node 内部 binding）——在这里它测不出任何东西。
 *      这是实测结论，不是假设。
 *   4. npm pack：跑 `npm pack --dry-run --json` 解析清单。
 *
 *   关于子进程 API 的一个实测坑（写在这里免得后人重踩）：
 *   本脚本最初用 spawnSync，在部分宿主/沙箱环境下会稳定报
 *   `spawnSync <node.exe> EBUSY`（连 cmd.exe 也起不来），但**异步 spawn / exec 正常**。
 *   所以这里统一用异步 spawn + Promise 包装。若换成 spawnSync 请先确认目标环境能跑通。
 *
 * 副作用
 * ------
 *   默认 `npm pack --dry-run --json --ignore-scripts`：**不触发构建**，无副作用，
 *   但清单反映的是"磁盘上现有的 dist"，dist 过期则数字过期。加 --with-build 会去掉
 *   --ignore-scripts，走真实 prepack（npm run build），代价是会重写 dist/ 目录。
 *
 * 用法
 * ----
 *   node scripts/bundle-audit.cjs                  # 7 次冷启动取样 + 体积 + pack 清单
 *   node scripts/bundle-audit.cjs --runs 15        # 增加取样次数
 *   node scripts/bundle-audit.cjs --json           # 机器可读输出
 *   node scripts/bundle-audit.cjs --no-pack        # 跳过 npm pack
 *   node scripts/bundle-audit.cjs --with-build     # pack 时触发 prepack 构建（会重写 dist/）
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const ENTRY = path.join(DIST, "index.js");
const SCHEMA = "cognistack-bundle-audit@1";

/* ---------------------------------------------------------------- */
/* 参数解析                                                          */
/* ---------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { runs: 7, top: 15, json: false, noPack: false, withBuild: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--runs") out.runs = Number(next());
    else if (a === "--top") out.top = Number(next());
    else if (a === "--json") out.json = true;
    else if (a === "--no-pack") out.noPack = true;
    else if (a === "--with-build") out.withBuild = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`未知参数：${a}（用 --help 查看用法）`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) out.runs = 7;
  if (!Number.isFinite(out.top) || out.top < 1) out.top = 15;
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Bundle & cold-start audit (G-26) —— 只测量、只报告

  node scripts/bundle-audit.cjs [--runs N] [--top N] [--json] [--no-pack] [--with-build]

  --runs N       冷启动取样次数（默认 7；单次取样不作为结论）
  --top N        最大 .js 文件排行条数（默认 15）
  --json         机器可读输出
  --no-pack      跳过 npm pack --dry-run
  --with-build   跑 pack 时触发 prepack 构建（默认加 --ignore-scripts，不构建、无副作用）`);
  process.exit(0);
}

/* ---------------------------------------------------------------- */
/* 工具                                                              */
/* ---------------------------------------------------------------- */

const toPosix = (p) => p.split(path.sep).join("/");
const rel = (abs) => toPosix(path.relative(ROOT, abs));

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Median + IQR + 相对离散度；不修改入参。 */
function stats(samples) {
  const s = [...samples].sort((a, z) => a - z);
  const at = (q) => {
    if (!s.length) return 0;
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  const median = at(0.5);
  return {
    n: s.length,
    min: s[0] ?? 0,
    max: s[s.length - 1] ?? 0,
    p25: at(0.25),
    median,
    p75: at(0.75),
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
    spreadPct: median > 0 ? ((s[s.length - 1] ?? 0) - (s[0] ?? 0)) / median : 0,
  };
}

/** 递归收集 dist 下所有文件（相对路径 + 字节数）。 */
function walkFiles(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, base, out);
    else if (ent.isFile()) out.push({ abs: p, rel: toPosix(path.relative(base, p)), size: fs.statSync(p).size });
  }
  return out;
}

/**
 * 跑一个子进程并收集输出。刻意用异步 spawn（见文件头 EBUSY 说明）。
 * 永不 reject：失败以 { error } 形式返回，让调用方自己决定怎么报告。
 */
function runChild(command, argv, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    } catch (err) {
      resolve({ error: String((err && err.message) || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => resolve({ error: String((err && err.message) || err), stdout, stderr }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/* ---------------------------------------------------------------- */
/* 主流程                                                            */
/* ---------------------------------------------------------------- */

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`找不到 ${rel(ENTRY)}。本脚本测量编译产物，请先 npm run build。`);
    process.exit(1);
  }

  /* ---------------- 1. dist 体积 ---------------- */

  const files = walkFiles(DIST);
  const byExt = new Map();
  let distTotalBytes = 0;
  let jsCount = 0;
  let dtsCount = 0;
  for (const f of files) {
    distTotalBytes += f.size;
    const ext = f.rel.endsWith(".d.ts.map")
      ? ".d.ts.map"
      : f.rel.endsWith(".d.ts")
        ? ".d.ts"
        : path.extname(f.rel) || "(no ext)";
    byExt.set(ext, (byExt.get(ext) || 0) + f.size);
    if (ext === ".js") jsCount += 1;
    if (ext === ".d.ts") dtsCount += 1;
  }
  const topJs = files
    .filter((f) => f.rel.endsWith(".js"))
    .sort((a, b) => b.size - a.size || a.rel.localeCompare(b.rel))
    .slice(0, args.top)
    .map((f) => ({ path: `dist/${f.rel}`, bytes: f.size }));

  /* ---------------- 2. 冷启动（新进程） ---------------- */

  // 子进程源码：取快照 → 计时 require → 再取快照。sep 由父进程注入，
  // 免得子进程自己 require("node:path") 影响 moduleLoadList 的增量。
  const childSource = [
    `const entry = ${JSON.stringify(ENTRY)};`,
    `const distAbs = ${JSON.stringify(DIST)};`,
    `const sep = ${JSON.stringify(path.sep)};`,
    `const cacheBefore = Object.keys(require.cache).length;`,
    `const loadBefore = process.moduleLoadList.length;`,
    `const t0 = process.hrtime.bigint();`,
    `require(entry);`,
    `const requireMs = Number(process.hrtime.bigint() - t0) / 1e6;`,
    `const cacheAfter = Object.keys(require.cache).length;`,
    `const distMods = Object.keys(require.cache).filter((p) => p.startsWith(distAbs + sep));`,
    `process.stdout.write(JSON.stringify({`,
    `  requireMs,`,
    `  cacheDelta: cacheAfter - cacheBefore,`,
    `  cacheTotal: cacheAfter,`,
    `  moduleLoadDelta: process.moduleLoadList.length - loadBefore,`,
    `  moduleLoadTotal: process.moduleLoadList.length,`,
    `  distModules: distMods.length,`,
    `  distModuleList: distMods.map((p) => p.slice(distAbs.length + 1)),`,
    `}));`,
  ].join("\n");

  const requireMsSamples = [];
  const endToEndSamples = [];
  let coldInfo = null;
  let coldError = null;

  for (let i = 0; i < args.runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await runChild(process.execPath, ["-e", childSource], { cwd: ROOT });
    const endToEndMs = Number(process.hrtime.bigint() - t0) / 1e6;
    endToEndSamples.push(endToEndMs);
    if (res.error) {
      coldError = res.error;
      break;
    }
    if (res.status !== 0) {
      coldError = `子进程退出码 ${res.status}: ${(res.stderr || "").trim().split("\n").slice(0, 3).join(" | ")}`;
      break;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      coldError = `无法解析子进程输出：${JSON.stringify((res.stdout || "").slice(0, 200))}`;
      break;
    }
    requireMsSamples.push(parsed.requireMs);
    if (!coldInfo) coldInfo = parsed;
  }

  const coldStart =
    coldError || !coldInfo
      ? {
          ok: false,
          error: coldError || "未取得任何样本",
          runs: args.runs,
          hint: "若错误为 EBUSY：本环境不支持同步 spawnSync，但本脚本已改用异步 spawn；仍有问题请检查是否禁止创建子进程。",
        }
      : {
          ok: true,
          runs: args.runs,
          requireMs: stats(requireMsSamples),
          endToEndMs: stats(endToEndSamples),
          firstRequireMs: requireMsSamples[0] ?? 0,
          firstEndToEndMs: endToEndSamples[0] ?? 0,
          samples: {
            requireMs: requireMsSamples.map((n) => round(n, 3)),
            endToEndMs: endToEndSamples.map((n) => round(n, 3)),
          },
          modules: {
            cacheDelta: coldInfo.cacheDelta,
            cacheTotal: coldInfo.cacheTotal,
            moduleLoadDelta: coldInfo.moduleLoadDelta,
            moduleLoadTotal: coldInfo.moduleLoadTotal,
            distModules: coldInfo.distModules,
            distModulesTotal: jsCount,
            distModuleList: coldInfo.distModuleList,
          },
        };

  /* ---------------- 3. npm pack --dry-run ---------------- */

  let pack = { ok: false, skipped: true, usedIgnoreScripts: !args.withBuild };
  if (!args.noPack) {
    const packArgs = ["pack", "--dry-run", "--json"];
    // 默认 --ignore-scripts：不触发 prepack 构建，避免审计脚本重写 dist/。
    if (!args.withBuild) packArgs.push("--ignore-scripts");
    // Windows 下通过 cmd.exe /d /s /c 明确调用 npm，避免 EINVAL 与 shell: true 参数拼接的 DEP0190
    const cmd = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
    const cmdArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...packArgs] : packArgs;
    const res = await runChild(cmd, cmdArgs, {
      cwd: ROOT,
    });
    if (res.error) {
      pack = { ok: false, skipped: false, usedIgnoreScripts: !args.withBuild, error: res.error };
    } else {
      const out = res.stdout || "";
      const start = out.indexOf("[");
      let parsed = null;
      try {
        parsed = start >= 0 ? JSON.parse(out.slice(start)) : null;
      } catch {
        parsed = null;
      }
      if (!parsed || !parsed.length) {
        const err = (res.stderr || "").trim().split("\n").slice(-4).join(" | ");
        pack = {
          ok: false,
          skipped: false,
          usedIgnoreScripts: !args.withBuild,
          error: err || `退出码 ${res.status}，未解析到 JSON`,
        };
      } else {
        const p = parsed[0];
        const distInPack = (p.files || []).filter((f) => f.path.startsWith("dist/"));
        pack = {
          ok: true,
          skipped: false,
          usedIgnoreScripts: !args.withBuild,
          filename: p.filename,
          tarballBytes: typeof p.size === "number" ? p.size : null,
          unpackedBytes: typeof p.unpackedSize === "number" ? p.unpackedSize : null,
          entryCount: p.entryCount ?? (p.files || []).length,
          distFileCount: distInPack.length,
          distBytes: distInPack.reduce((s, f) => s + (f.size || 0), 0),
          topFiles: (p.files || [])
            .slice()
            .sort((a, b) => (b.size || 0) - (a.size || 0))
            .slice(0, 10)
            .map((f) => ({ path: f.path, bytes: f.size || 0 })),
        };
      }
    }
  }

  /* ---------------- 报告 ---------------- */

  const engineVersion = (() => {
    try {
      return require(ENTRY).COGNISTACK_VERSION;
    } catch {
      return null;
    }
  })();

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    engine: engineVersion,
    dist: {
      totalBytes: distTotalBytes,
      fileCount: files.length,
      jsCount,
      dtsCount,
      byExt: Object.fromEntries([...byExt.entries()].sort((a, b) => b[1] - a[1])),
      topJs,
    },
    coldStart,
    pack,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const bar = "=".repeat(64);
  console.log(`${bar}\nCogniStack 包体与冷启动审计 (G-26)   只测量，只报告\n${bar}`);
  console.log(`node ${process.version} · ${report.platform} · engine ${engineVersion ?? "?"} · ${report.generatedAt}`);
  console.log("");

  console.log("--- dist 体积 ---");
  console.log(`总计 ${fmtBytes(distTotalBytes)} / ${files.length} 个文件（.js ${jsCount} 个，.d.ts ${dtsCount} 个）`);
  for (const [ext, bytes] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = distTotalBytes ? ((bytes / distTotalBytes) * 100).toFixed(1) : "0.0";
    console.log(`  ${ext.padEnd(11)} ${fmtBytes(bytes).padStart(10)}  (${pct}%)`);
  }
  console.log("");
  console.log(`最大 .js 文件 top ${topJs.length}:`);
  const wMax = Math.max(4, ...topJs.map((f) => f.path.length));
  topJs.forEach((f, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${fmtBytes(f.bytes).padStart(10)}  ${f.path.padEnd(wMax)}`);
  });
  console.log("");

  console.log("--- 冷启动（require dist/index.js，独立子进程）---");
  if (!coldStart.ok) {
    console.log(`测量失败：${coldStart.error}`);
    console.log(`提示：${coldStart.hint}`);
  } else {
    const r = coldStart.requireMs;
    const e = coldStart.endToEndMs;
    console.log(`取样 ${r.n} 次（每次一个新进程）`);
    console.log(`  样本 require(ms): ${coldStart.samples.requireMs.map((n) => round(n, 2)).join(", ")}`);
    console.log(
      `require 耗时  : median ${round(r.median)}ms | p25 ${round(r.p25)} | p75 ${round(r.p75)} | min ${round(r.min)} | max ${round(r.max)}`,
    );
    console.log(
      `端到端耗时    : median ${round(e.median)}ms | p25 ${round(e.p25)} | p75 ${round(e.p75)}（含 Node 启动 + 脚本解析）`,
    );
    console.log(
      `首样本        : require ${round(coldStart.firstRequireMs)}ms / 端到端 ${round(coldStart.firstEndToEndMs)}ms（首次要真读磁盘，之后走页缓存）`,
    );
    const spreadPct = r.spreadPct * 100;
    console.log(
      `离散度        : ${spreadPct.toFixed(1)}% ((max-min)/median) —— ${spreadPct > 30 ? "过宽，本次数字不可信（后台负载 / 杀毒扫描 / 首次冷读都可能）。消除干扰后复测。" : "在可接受范围内。"}`,
    );
    console.log("");
    const m = coldStart.modules;
    console.log("--- 顶层入口实际加载的模块 ---");
    console.log(`require.cache 增量  : ${m.cacheDelta} 个模块（require 后共 ${m.cacheTotal}）`);
    console.log(
      `dist 内被加载       : ${m.distModules} / ${m.distModulesTotal} 个 .js（${m.distModulesTotal ? ((m.distModules / m.distModulesTotal) * 100).toFixed(0) : "?"}%）`,
    );
    console.log(
      `moduleLoadList 增量 : ${m.moduleLoadDelta}（该列表只记录 Node 内部 binding；本包零运行时依赖、不 require 内建模块，所以它不动——实测结论）`,
    );
    if (m.distModulesTotal && m.distModules >= m.distModulesTotal) {
      console.log("");
      console.log("观察：入口是 barrel（re-export 全部子模块），require 任意 1 个符号都会把整个引擎拉起来。");
      console.log('      package.json 的 exports 另有子路径 "cognistack-engine/ports" 与 "cognistack-engine/types"（本脚本不评估其收益）。');
    }
    console.log("");
    console.log("dist 内被加载的文件：");
    console.log(`  ${[...m.distModuleList].map(toPosix).sort().join("\n  ")}`);
  }
  console.log("");

  console.log("--- npm pack --dry-run ---");
  if (pack.skipped) {
    console.log("已跳过（--no-pack）。");
  } else if (!pack.ok) {
    console.log(`失败：${pack.error}`);
  } else {
    console.log(
      `${pack.filename}  ·  tarball ${fmtBytes(pack.tarballBytes)}  ·  解包后 ${fmtBytes(pack.unpackedBytes)}  ·  ${pack.entryCount} 个条目`,
    );
    console.log(`其中 dist/ 占 ${pack.distFileCount} 个文件 / ${fmtBytes(pack.distBytes)}`);
    console.log(
      `构建脚本：${pack.usedIgnoreScripts ? "已用 --ignore-scripts 跳过（清单反映磁盘上现有 dist，可能过期）" : "未跳过 —— prepack 已执行 npm run build（重写了 dist/）"}`,
    );
    console.log("体积最大的 10 个待发布文件：");
    for (const f of pack.topFiles) console.log(`  ${fmtBytes(f.bytes).padStart(10)}  ${f.path}`);
  }
  console.log("");
  console.log(bar);
  console.log("说明：本脚本不修改任何构建配置，也不基于以上数字建议改动。");
  console.log("      单次/单环境测量不足以支撑优化决策——需要结论时请配合 bench/probe 的真实对照数据。");
  console.log(bar);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("审计脚本异常：", err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
