/* eslint-disable no-console */
/**
 * 文档数字自动校验（G-25）。
 *
 * 问题
 * ----
 * 文档里的实测数字会漂移：同一份文档正文写「130 项测试全绿」，另一节却写
 * `# tests 177`；README 里的 63.5%、139 次分词也是某次运行的快照。手抄的数字，
 * 过一段时间必然与代码不一致，而读者无从判断哪个是真的。
 *
 * 做法：标记区间
 * --------------
 * 只改写显式带标记的区间，标记之外一个字都不动：
 *
 *     <!-- N:tests -->130<!-- /N -->
 *
 * 键可以是：tests / tests_pass / tests_fail / memo_avoided_pct / tokenizations /
 * prompt_tokens / soft_trim_cap / fill。区间内的旧值会被替换成**本次实测值**。
 *
 * 关键：本脚本**不会**替你往文档里插标记。给 `README.md` 加标记属于
 * 文档作者的编辑决定（也避免脚本擅自改动受保护的文档），所以改为用
 * `--print-markers` 打印"建议的标记写法"，由人来决定贴到哪。
 *
 * 为什么用异步 spawn 而不是 spawnSync
 * -----------------------------------
 * 本机环境下 `spawnSync` 启动 node 子进程**稳定**报 EBUSY（与 README 里记录的
 * 「tsx 的 esbuild 原生二进制装不上（EBUSY / 沙箱 spawn 限制）」是同一类环境限制），
 * 实测同一台机器上异步 `spawn` 正常。因此跑测试改用 `spawn` + Promise 包装。
 * 另注：stdout 是**分块**到达的，必须把全部 chunk 收齐再解析 `# tests N`——
 * 只读第一块就解析会漏掉（甚至解析不到）汇总行。
 *
 * 用法
 * ----
 *   node scripts/doc-numbers.cjs                     # 默认处理 README.md
 *   node scripts/doc-numbers.cjs --check             # 只校验：不一致则退出码 1（CI 用）
 *   node scripts/doc-numbers.cjs --print-markers     # 打印建议标记（不写任何文件）
 *   node scripts/doc-numbers.cjs docs/eval.md USAGE.md
 *   node scripts/doc-numbers.cjs --skip-tests        # 跳过跑测试（快，但 tests 类标记跳过）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const S = require("../dist/index.js");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { check: false, printMarkers: false, skipTests: false, files: [] };
  for (const a of argv) {
    if (a === "--check") out.check = true;
    else if (a === "--print-markers") out.printMarkers = true;
    else if (a === "--skip-tests") out.skipTests = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`未知参数: ${a}`);
    else out.files.push(a);
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(String(err.message || err));
  process.exit(2);
}

if (args.help) {
  console.log("用法: node scripts/doc-numbers.cjs [--check] [--print-markers] [--skip-tests] [doc files...]");
  console.log("标记格式: <!-- N:key -->value<!-- /N -->");
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 测量                                                                */
/* ------------------------------------------------------------------ */

/** 递归收集匹配后缀的文件。 */
function walk(dir, suffix, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, suffix, out);
    else if (e.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

/** 目录树里最新的修改时间；目录不存在返回 0。 */
function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return newest;
}

/**
 * 异步跑 `node --test`，收集**完整**的 stdout / stderr。
 *
 * 用异步 spawn 是因为本机 spawnSync 报 EBUSY（见文件头说明）。返回 Promise，
 * 绝不 reject——所有失败都转成 { error } 交给调用方决定怎么提示。
 */
function runNodeTest(files, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let child;
    try {
      /*
       * Pin the TAP reporter.
       *
       * This script parses `# tests N` / `# pass N` / `# fail N`, which is the TAP
       * summary. Node's *default* reporter is version- and TTY-dependent: on Node 24
       * it prints the `spec` reporter's `ℹ tests N` even when stdout is a pipe, so
       * the regex matched nothing, every `tests` marker was reported "unavailable",
       * and `--check` failed with "0 ranges verified" — a guard that had silently
       * stopped guarding. Pinning the reporter makes the output format deterministic.
       */
      child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: ROOT });
    } catch (err) {
      resolve({ error: `无法启动 node --test（${err && err.message ? err.message : err}）` });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    // stdout 分块到达：全部 push 进来，close 时再拼接解析（只读第一块是常见坑）。
    if (child.stdout) child.stdout.on("data", (c) => outChunks.push(c));
    if (child.stderr) child.stderr.on("data", (c) => errChunks.push(c));
    child.on("error", (e) =>
      finish({ error: `node --test 进程错误（${e && e.message ? e.message : e}）` }),
    );

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({
        error: `node --test 超时（>${Math.round(timeoutMs / 1000)}s）已终止。`,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    }, timeoutMs);

    child.on("close", (code, signal) =>
      finish({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        code,
        signal,
        error: null,
      }),
    );
  });
}

/**
 * 跑测试并解析 `# tests N`。
 *
 * 只跑已编译产物（dist-test + .cjs），不触发 `build:test`——构建会与并行工作的
 * 其他人抢 dist-test 目录。检测不到产物就返回 null（宁可不报，也不报一个假数字）。
 */
async function measureTests() {
  const distTestDir = path.join(ROOT, "dist-test", "test");
  const cjsDir = path.join(ROOT, "test");
  const compiled = fs.existsSync(distTestDir) ? walk(distTestDir, ".test.js") : [];
  const cjs = fs.existsSync(cjsDir)
    ? fs
        .readdirSync(cjsDir)
        .filter((f) => f.endsWith(".test.cjs"))
        .map((f) => path.join(cjsDir, f))
    : [];

  if (!compiled.length) {
    return {
      value: null,
      reason:
        "dist-test/test 下没有已编译测试（不存在或为空）。请先运行 `npm run build:test`，本脚本不会代跑构建以免与并行工作冲突。",
    };
  }

  // 过期检测：src 比 dist-test 新 → 编译产物可能不反映当前源码。
  const newestSrc = newestMtime(path.join(ROOT, "src"));
  const newestDist = newestMtime(path.join(ROOT, "dist-test"));
  if (newestSrc > newestDist + 1000) {
    return {
      value: null,
      reason:
        "dist-test 早于 src（编译产物疑似过期）。请先运行 `npm run build:test` 重新编译，勿用旧产物的测试数写进文档。",
    };
  }

  const files = [...compiled, ...cjs];
  const res = await runNodeTest(files);
  if (res.error) {
    return { value: null, reason: res.error };
  }
  const text = `${res.stdout || ""}\n${res.stderr || ""}`;
  const grab = (label) => {
    const m = text.match(new RegExp(`^# ${label} (\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const tests = grab("tests");
  if (tests === null) {
    return {
      value: null,
      reason: `测试运行了但输出里没有 \`# tests N\`（code=${res.code} signal=${res.signal}）。可能测试进程未正常结束。`,
    };
  }
  return { value: tests, pass: grab("pass"), fail: grab("fail"), files: files.length };
}

/**
 * 复刻 `scripts/bench.prepare.cjs` 的 fixture，测 memo 避免率与真实分词次数。
 *
 * 为什么复制 fixture 而不是 import bench 脚本：bench.prepare.cjs 是直接执行的脚本
 * （顶层就 console.log 并有门禁退出码），没有可复用的导出。这里只搬输入构造，
 * 让「文档里的数字」与「bench 里的数字」来自同一件事。
 */
function hostLore(match) {
  return {
    selectEntries(entries) {
      return entries.filter((e) => e.enabled !== false && (e.constant || (e.keys || []).includes(match)));
    },
  };
}

function measureBench() {
  const dialogue = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `第 ${i} 轮对话内容，这是一段有实际长度的对白文本用于测量分词开销。`,
  }));
  const engine = new S.CogniStackEngine({ collaborators: { lore: hostLore("对话") }, systemRules: "RULE" });
  const input = {
    card: {
      name: "阿铁",
      description: "设定".repeat(600),
      personality: "直接".repeat(200),
      mes_example: "示例".repeat(300),
    },
    dialogue,
    pairBatchSize: 4,
    tokenCounter: S.exactCharTokenCounter(),
    contextTokenLimit: 4096,
    cacheScope: "doc-numbers",
    summaryBlocks: Array.from({ length: 3 }, (_, i) => ({
      id: `b${i}`,
      text: `【硬事实】事实${i}：${"内容".repeat(120)}\n【时间线】无\n【关系与称呼】无\n【未决】无\n【近期情节】无`,
      throughMessageId: "m10",
    })),
    worldEntries: Array.from({ length: 12 }, (_, i) => ({
      id: `w${i}`,
      name: `条目${i}`,
      keys: ["对话"],
      content: `世界书内容${i} ${"字".repeat(80)}`,
      enabled: true,
      constant: false,
      insertionOrder: i,
    })),
  };
  engine.clearCache();
  const r = engine.prepare(input);
  const st = r.diagnostics.counter;
  const total = st.hits + st.misses;
  return {
    memoAvoidedPct: total > 0 ? (st.hits / total) * 100 : 0,
    tokenizations: st.misses,
    promptTokens: r.promptTokens,
    softTrimCap: r.budget.softTrimTokenCap,
  };
}

/* ------------------------------------------------------------------ */
/* 键与格式化                                                          */
/* ------------------------------------------------------------------ */

const FORMATTERS = {
  tests: (v) => String(Math.round(v)),
  tests_pass: (v) => String(Math.round(v)),
  tests_fail: (v) => String(Math.round(v)),
  memo_avoided_pct: (v) => Number(v).toFixed(1),
  tokenizations: (v) => String(Math.round(v)),
  prompt_tokens: (v) => String(Math.round(v)),
  soft_trim_cap: (v) => String(Math.round(v)),
  fill: (v) => Number(v).toFixed(3),
};

const MARKER_RE = /<!--\s*N:([A-Za-z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/N\s*-->/g;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const values = {};
  const unavailable = {};

  const bench = measureBench();
  values.memo_avoided_pct = bench.memoAvoidedPct;
  values.tokenizations = bench.tokenizations;
  values.prompt_tokens = bench.promptTokens;
  values.soft_trim_cap = bench.softTrimCap;
  values.fill = bench.softTrimCap > 0 ? bench.promptTokens / bench.softTrimCap : 0;

  if (args.skipTests) {
    unavailable.tests = "--skip-tests：未运行测试";
    unavailable.tests_pass = "--skip-tests：未运行测试";
    unavailable.tests_fail = "--skip-tests：未运行测试";
  } else {
    const t = await measureTests();
    if (t.value === null) {
      unavailable.tests = t.reason;
      unavailable.tests_pass = t.reason;
      unavailable.tests_fail = t.reason;
    } else {
      values.tests = t.value;
      if (t.pass !== null) values.tests_pass = t.pass;
      else unavailable.tests_pass = "测试输出里没有 `# pass N`";
      if (t.fail !== null) values.tests_fail = t.fail;
      else unavailable.tests_fail = "测试输出里没有 `# fail N`";
    }
    if (t.value !== null && t.fail) {
      console.error(`警告：测试运行有 ${t.fail} 项失败——文档数字可能来自一次失败运行。`);
    }
  }

  /* --print-markers：只打印建议标记，不碰任何文件 */
  if (args.printMarkers) {
    console.log("建议的标记写法（贴到文档里对应位置即可，脚本不会替你插入）：");
    console.log("");
    for (const key of Object.keys(FORMATTERS)) {
      if (values[key] === undefined) {
        console.log(`<!-- N:${key} -->?<!-- /N -->   (暂不可用: ${unavailable[key] ?? "未测量"})`);
      } else {
        console.log(`<!-- N:${key} -->${FORMATTERS[key](values[key])}<!-- /N -->`);
      }
    }
    console.log("");
    console.log("说明：值随每次运行变化；tests 取自 dist-test + test/*.test.cjs，其余取自 bench fixture。");
    return 0;
  }

  /* 处理文档 */
  const targets = args.files.length
    ? args.files
    : ["README.md"].filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => f);
  if (!targets.length) {
    console.error("没有可处理的文档（默认目标是 README.md，不存在；也可用位置参数指定）。");
    return 2;
  }

  let mismatches = 0;
  let rewritten = 0;
  let processed = 0;
  let skippedFiles = 0;
  /*
   * Ranges actually compared against a measured value. Tracked separately from
   * `found` (which also counts markers whose key is unknown or unavailable) so
   * `--check` can tell "everything matched" apart from "nothing was checked".
   */
  let compared = 0;

  for (const rel of targets) {
    const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      console.error(`跳过（不存在）: ${rel}`);
      skippedFiles += 1;
      continue;
    }
    const before = fs.readFileSync(file, "utf8");
    const found = [];
    const after = before.replace(MARKER_RE, (full, key, inner) => {
      found.push(key);
      if (!(key in FORMATTERS)) {
        console.error(`  [${rel}] 未知标记键 "${key}"，跳过（不改动）。`);
        return full;
      }
      if (values[key] === undefined) {
        console.error(`  [${rel}] 标记 ${key} 暂不可用，跳过：${unavailable[key] ?? "未测量"}`);
        return full;
      }
      compared += 1;
      const next = FORMATTERS[key](values[key]);
      const current = String(inner).trim();
      if (current !== next) {
        mismatches += 1;
        console.log(`  [${rel}] ${key}: ${current} → ${next}`);
      }
      return `<!-- N:${key} -->${next}<!-- /N -->`;
    });

    if (!found.length) {
      console.log(`跳过（无标记区间）: ${rel}`);
      skippedFiles += 1;
      continue;
    }
    processed += 1;

    if (!args.check && after !== before) {
      fs.writeFileSync(file, after, "utf8");
      rewritten += 1;
      console.log(`已更新: ${rel}（${found.length} 个标记区间）`);
    } else if (!args.check) {
      console.log(`无需更新: ${rel}（${found.length} 个标记区间已是最新）`);
    }
  }

  console.log("");
  console.log(
    `处理 ${processed} 个文档，跳过 ${skippedFiles} 个；标记不一致 ${mismatches} 处，${args.check ? "（--check 模式，未写入）" : `重写 ${rewritten} 个文件`}。`,
  );
  if (unavailable.tests) console.log(`tests 类标记状态: ${unavailable.tests}`);

  if (args.check && mismatches > 0) {
    console.error(`\n--check 失败：${mismatches} 处标记与实测值不一致。`);
    return 1;
  }
  /*
   * A guard that verified nothing must not report success.
   *
   * This used to exit 0 whenever there were no *mismatches* — which is
   * trivially true when neither document carries a marker range. Measured:/n   * "处理 0 个文档，跳过 2 个" with exit code 0, wired into CI, guarding nothing.
   */
  if (args.check && compared === 0) {
    console.error(
      "\n--check 失败：本次没有校验任何标记区间（0 处）。\n" +
        "  文档里没有标记就等于这道门禁没在守东西。请在相关数字处加上" +
        " `<!-- N:key -->值<!-- /N -->`（键与建议写法见 --print-markers）。",
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`未预期的错误: ${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });
