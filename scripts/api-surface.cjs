/* eslint-disable no-console */
/**
 * scripts/api-surface.cjs —— 公共 API 快照守卫（G-23）
 *
 * 为什么需要这个脚本
 * ------------------
 * `src/index.ts` 的导出面很大（实测 200+ 个名字）。消费方（xoox AI，以及任何宿主）
 * 通过 `require("cognistack-engine")` 动态取值时，一次"顺手重命名"不会炸在编译期，
 * 而是炸在**下一次升级的运行期**——错误现场离改动现场很远，排查成本极高。
 * 所以这里把"当前导出面"冻结成一份可 diff 的基线，让重命名/删除在 CI 里立刻暴露。
 *
 * 实现方法（以及它的局限）
 * ------------------------
 * 用 typescript 的编译器 API（`ts.createProgram` + `checker.getExportsOfModule`），
 * 不用手写 d.ts 解析器。理由：
 *   1. index.d.ts 里全是 `export { X } from "./y"` 这种**再导出**。一个正则只能看到
 *      导出名，看不到 X 真正的声明，也就拿不到签名；编译器 API 能一路 resolve 到源声明。
 *   2. 同一符号可能以别名导出两次（如 `buildLoreScanText` / `buildLoreScanTextFallback`），
 *      API 能按"导出名"分别给出条目，这正是守卫需要的粒度。
 *   3. 类型/接口/类型别名的"签名"没法用 typeToString 表达（会得到 `any`），
 *      所以统一取**声明节点的归一化文本**（`decl.getText()` 天然不含前后注释）。
 *
 * 局限（刻意不做的部分，全部是"宁可误报不可漏报"的取舍）：
 *   - **纯文本级对比，不做语义等价判断**。接口成员重排、类型别名展开成等价写法、
 *     private 字段改名，都会报"签名变更"。这会把一些无害改动标成破坏性变更。
 *   - **private 成员也在签名里**。`export declare class` 的声明文本包含 private 字段，
 *     所以改一个内部字段名也会触发。保守选择：不区分可见性。
 *   - 只有一个启发式归一化：把 `"1.2.3"` 形态的语义化版本字符串字面量替换为 `"<semver>"`。
 *     否则每次发版（`readonly version: "1.1.0"`）都会产生一条假变更。代价是：如果有人
 *     真的改了某个版本字面量本身，这里不会报——但版本字面量本来就不是 API 契约。
 *   - 基线文件里的 typescript 版本只作提示：不同 TS 版本生成的 d.ts 文本排版可能不同，
 *     会伪造出一堆 diff。脚本会在版本不一致时给出警告，但不会因此判定失败。
 *
 * 用法
 * ----
 *   node scripts/api-surface.cjs                    # 与基线对比，打印「新增/移除/变更」
 *   node scripts/api-surface.cjs --check            # 破坏性变更 → 退出码 1（CI 用）
 *   node scripts/api-surface.cjs --check --strict-additions   # 新增也算破坏
 *   node scripts/api-surface.cjs --write            # 用当前导出面覆盖基线（人工确认破坏性变更）
 *   node scripts/api-surface.cjs --json             # 机器可读输出
 *
 * 基线不存在时：提示"无基线，请先 --write 建立基线"，退出码 0（首次接入不算失败）。
 *
 * 维护约定（接手的人请先读完这一段再动基线）
 * ------------------------------------------
 *   1. **基线必须在其他改动全部落定后再 --write。** 只要 src/ 还有人在改，写出来的基线
 *      几分钟后就会过期，CI 会因为"真实的 API 变更"而红——这是**预期行为，不是 bug**。
 *      基线是"已确认的契约快照"，不是"当前状态缓存"。
 *   2. **权威基线时间戳在 `scripts/api-surface.baseline.json` 的 `generatedAt`
 *      字段里，导出符号数也在那份 JSON 里 —— 以文件为准，不要在这段注释里抄数字**
 *      （抄过的数字必然会滞后：本节曾写死一个 268 导出的旧快照）。
 *   3. **接手后先跑 `node scripts/api-surface.cjs --check` 看差异**，逐条确认每条
 *      「移除/变更」是有意为之（并已在 PR 描述里说明）之后，再 `--write` 覆盖。
 *   4. **不要为了让它变绿而直接覆盖基线。** `--check` 报出的"变更"默认是**保守口径**：
 *      含 private 成员、含声明重排、含类型的文本级改写。也就是说其中一部分是误报。
 *      正确做法是**逐条审阅**，确认无害后连同审阅结论一起提交基线；直接 --write
 *      会把真正的破坏性变更一起吞掉，等于把守卫关掉。
 *   5. **--check 结果与预期不符时，第一个该怀疑的是 dist/ 落后于 src/。**
 *      `npm test` 编译的是 `dist-test/`，**不会更新 `dist/`**；而本脚本读的是 `dist/`。
 *      两者可能不同步。脚本会在入口打印 dist 快照的 mtime，并在 src 比 dist 新时
 *      直接告警；看到告警请先 `npm run build` 再复测。
 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const BASELINE_PATH = path.join(__dirname, "api-surface.baseline.json");
const SCHEMA = "cognistack-api-surface@1";

/* ---------------------------------------------------------------- */
/* 参数解析                                                          */
/* ---------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { check: false, write: false, strictAdditions: false, json: false, help: false };
  for (const a of argv) {
    if (a === "--check") out.check = true;
    else if (a === "--write") out.write = true;
    else if (a === "--strict-additions") out.strictAdditions = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`未知参数：${a}（用 --help 查看用法）`);
      process.exit(2);
    }
  }
  if (out.write && out.check) {
    console.error("--write 与 --check 不能同时使用：前者写基线，后者读基线。");
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`API surface guard (G-23)

  node scripts/api-surface.cjs [--check] [--strict-additions] [--write] [--json]

  （无参数）        对比基线并打印差异，始终退出 0
  --check           有「移除」或「签名变更」时退出 1（--strict-additions 时新增也算）
  --strict-additions 新增导出视为破坏性变更（需与 --check 一起才有退出码意义）
  --write           用当前导出面覆盖 ${path.relative(ROOT, BASELINE_PATH).split(path.sep).join("/")}
  --json            以 JSON 输出结果`);
  process.exit(0);
}

/* ---------------------------------------------------------------- */
/* 依赖与工具                                                        */
/* ---------------------------------------------------------------- */

let ts;
try {
  // scripts/ 在包内，正常解析即可；createRequire 让脚本从任意 cwd 调用都稳。
  ts = createRequire(path.join(ROOT, "package.json"))("typescript");
} catch (err) {
  console.error("无法加载 typescript（devDependency）。请先 npm install。");
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function rel(abs) {
  return toPosix(path.relative(ROOT, abs));
}

/** 递归收集目录下所有 .d.ts（不跟随 node_modules，dist 里本来也没有）。 */
function collectDts(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.endsWith(".d.ts")) out.push(p);
    }
  }
  return out.sort();
}

/**
 * 归一化声明文本：
 *   1. 去掉注释（getText() 通常已不含前后注释，但内联 JSDoc 可能残留）；
 *   2. 空白折叠为单空格；
 *   3. 语义化版本字符串字面量 → "<semver>"（见文件头的局限说明）。
 */
function normalizeSignature(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .replace(/"\d+\.\d+\.\d+(?:[-+][^"]*)?"/g, '"<semver>"')
    .trim();
}

/* ---------------------------------------------------------------- */
/* 抽取导出面                                                        */
/* ---------------------------------------------------------------- */

/**
 * 从 package.json 的 exports 里读出「公开子路径 → d.ts 文件」。
 * 只读 package.json，不修改它。解析失败时退回主入口。
 */
function readEntrypoints() {
  const pkgPath = path.join(ROOT, "package.json");
  const entries = [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    pkg = null;
  }
  const pickTypes = (v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return v.types || v.require || v.default || null;
    return null;
  };
  const ex = pkg && pkg.exports;
  if (ex && typeof ex === "object") {
    for (const [sub, val] of Object.entries(ex)) {
      if (sub === "./package.json") continue;
      let typesPath = pickTypes(val);
      // "./ports" → "./dist/ports.js" 之类，优先取同目录下的 .d.ts
      if (typesPath && !typesPath.endsWith(".d.ts")) {
        const guess = typesPath.replace(/\.js$/, ".d.ts");
        typesPath = fs.existsSync(path.join(ROOT, guess)) ? guess : null;
      }
      if (!typesPath) continue;
      const abs = path.resolve(ROOT, typesPath);
      if (fs.existsSync(abs)) entries.push({ subpath: sub, abs });
    }
  }
  if (!entries.length) {
    const abs = path.join(DIST, "index.d.ts");
    if (fs.existsSync(abs)) entries.push({ subpath: ".", abs });
  }
  // 去重并稳定排序
  const seen = new Set();
  return entries
    .filter((e) => (seen.has(e.abs) ? false : (seen.add(e.abs), true)))
    .sort((a, b) => (a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0));
}

let program = null;
let checker = null;

/**
 * 快照新鲜度检查：本脚本读的是 dist/，但 `npm test` 只编译到 dist-test/，
 * 不会更新 dist/。所以 dist/ 完全可能落后于 src/，此时 --check 报出的差异
 * 只是在描述"源码改了但没重新构建"，不是真实的 API 契约变更。
 * 这里用最大 mtime 做粗判：src 里有比 dist 最新 .d.ts 更新的 .ts 就告警。
 */
function snapshotFreshness(dtsFiles) {
  const newest = (list) => {
    let best = { ms: 0, file: null };
    for (const f of list) {
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (st.mtimeMs > best.ms) best = { ms: st.mtimeMs, file: f };
    }
    return best;
  };
  const srcDir = path.join(ROOT, "src");
  const srcFiles = [];
  if (fs.existsSync(srcDir)) {
    const stack = [srcDir];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) srcFiles.push(p);
      }
    }
  }
  const dist = newest(dtsFiles);
  const src = newest(srcFiles);
  return { dist, src, srcNewer: src.ms > dist.ms };
}

function buildProgram() {
  if (!fs.existsSync(DIST)) {
    console.error(`找不到 dist/（${rel(DIST)}）。本脚本读取编译产物，请先 npm run build。`);
    process.exit(1);
  }
  const files = collectDts(DIST);
  if (!files.length) {
    console.error("dist/ 下没有 .d.ts。请先 npm run build。");
    process.exit(1);
  }
  program = ts.createProgram(files, {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
  checker = program.getTypeChecker();
  return files;
}

/**
 * 单个导出符号的"签名串"。
 *
 * 优先取声明节点的归一化文本（可覆盖 function / const / class / interface / type alias）；
 * 声明不在源码里（极少见）时退回 typeToString。别名（再导出）先 resolve 到真实符号。
 */
function signatureOf(exportSymbol, moduleSf) {
  let sym = exportSymbol;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* 用原始符号兜底 */
    }
  }
  const decls = (sym.declarations || []).filter(
    (d) => !toPosix(d.getSourceFile().fileName).includes("/node_modules/"),
  );
  if (decls.length) {
    return decls
      .map((d) => normalizeSignature(d.getText(d.getSourceFile())))
      .sort()
      .join(" ");
  }
  const t = checker.getTypeOfSymbolAtLocation(sym, moduleSf);
  return normalizeSignature(checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation));
}

function surfaceOf(entryAbs) {
  const sf = program.getSourceFile(entryAbs);
  if (!sf) throw new Error(`ts.createProgram 未包含 ${rel(entryAbs)}`);
  const modSym = checker.getSymbolAtLocation(sf) || sf.symbol;
  if (!modSym) throw new Error(`${rel(entryAbs)} 不是模块（没有导出）`);
  const symbols = {};
  for (const e of checker.getExportsOfModule(modSym)) {
    symbols[e.getName()] = signatureOf(e, sf);
  }
  // 稳定排序 → 基线可 diff
  const sorted = {};
  for (const k of Object.keys(symbols).sort()) sorted[k] = symbols[k];
  return sorted;
}

function buildSurface(entrypoints) {
  const out = {};
  for (const ep of entrypoints) {
    out[ep.subpath] = { typesPath: rel(ep.abs), symbols: surfaceOf(ep.abs) };
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* 对比                                                              */
/* ---------------------------------------------------------------- */

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * 对比基线与当前导出面，返回三类差异。
 * 注意：只比较 symbols，不比较 generatedAt / typescript 等元数据（那些不是契约）。
 */
function diffSurfaces(baseSurface, curSurface) {
  const removed = [];
  const added = [];
  const changed = [];
  const subs = new Set([...Object.keys(baseSurface || {}), ...Object.keys(curSurface || {})]);
  for (const sub of [...subs].sort()) {
    const b = (baseSurface && baseSurface[sub] && baseSurface[sub].symbols) || {};
    const c = (curSurface && curSurface[sub] && curSurface[sub].symbols) || {};
    for (const name of Object.keys(b).sort()) {
      if (!(name in c)) {
        removed.push({ entrypoint: sub, name, baseline: b[name] });
      } else if (b[name] !== c[name]) {
        changed.push({ entrypoint: sub, name, from: b[name], to: c[name] });
      }
    }
    for (const name of Object.keys(c).sort()) {
      if (!(name in b)) added.push({ entrypoint: sub, name, signature: c[name] });
    }
  }
  removed.sort((x, y) => x.name.localeCompare(y.name));
  added.sort((x, y) => x.name.localeCompare(y.name));
  changed.sort((x, y) => x.name.localeCompare(y.name));
  return { removed, added, changed };
}

/* ---------------------------------------------------------------- */
/* 主流程                                                            */
/* ---------------------------------------------------------------- */

const entrypoints = readEntrypoints();
const dtsFiles = buildProgram();
const freshness = snapshotFreshness(dtsFiles);
/** 供报告用的 dist/src 快照时间（本地时间字符串，便于人读）。 */
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString("sv-SE") : "?");
const freshnessNote = {
  distSnapshot: fmtTime(freshness.dist.ms),
  distNewestFile: freshness.dist.file ? rel(freshness.dist.file) : null,
  srcNewestFile: freshness.src.file ? rel(freshness.src.file) : null,
  srcNewerThanDist: freshness.srcNewer,
};
const staleHint =
  "提示：dist/ 可能落后于 src/ —— `npm test` 只编译到 dist-test/，不会更新 dist/。先 `npm run build` 再复测，确认差异是真实的 API 变更而不是没重新构建。";

const current = {
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  engine: (() => {
    try {
      return require(path.join(DIST, "version.js")).COGNISTACK_VERSION;
    } catch {
      return null;
    }
  })(),
  typescript: ts.version,
  entrypoints: buildSurface(entrypoints),
};

/* --write：建立/覆盖基线 ------------------------------------------------- */

if (args.write) {
  const payload = { ...current, generatedAt: new Date().toISOString() };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const n = Object.values(payload.entrypoints).reduce((s, e) => s + Object.keys(e.symbols).length, 0);
  if (args.json) {
    console.log(
      JSON.stringify(
        { schema: SCHEMA, action: "write", path: rel(BASELINE_PATH), entrypoints: Object.keys(payload.entrypoints), symbols: n, freshness: freshnessNote },
        null,
        2,
      ),
    );
  } else {
    console.log(`已写入 API 基线：${rel(BASELINE_PATH)}`);
    for (const [sub, ep] of Object.entries(payload.entrypoints)) {
      console.log(`  ${sub.padEnd(8)} → ${ep.typesPath}（${Object.keys(ep.symbols).length} 个导出）`);
    }
    console.log(`  合计 ${n} 个导出符号。`);
    console.log(`  dist 快照时间：${freshnessNote.distSnapshot}（最新 ${freshnessNote.distNewestFile}）`);
    if (freshnessNote.srcNewerThanDist) {
      console.log(`  !! ${staleHint}`);
    }
    console.log("  注意：基线是\"已确认的契约快照\"。若此刻 src/ 仍在改动，这份基线很快会过期——落定后再重建。");
  }
  process.exit(0);
}

/* 无基线：不算失败 ------------------------------------------------------ */

if (!fs.existsSync(BASELINE_PATH)) {
  if (args.json) {
    console.log(JSON.stringify({ schema: SCHEMA, ok: true, baselineMissing: true, freshness: freshnessNote }, null, 2));
  } else {
    console.log(`无基线，请先建立基线：node scripts/api-surface.cjs --write`);
    console.log(`（期望的基线文件：${rel(BASELINE_PATH)}）`);
    console.log(`dist 快照时间：${freshnessNote.distSnapshot}（最新 ${freshnessNote.distNewestFile}）`);
  }
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
const { removed, added, changed } = diffSurfaces(baseline.entrypoints, current.entrypoints);

const breaking = removed.length + changed.length + (args.strictAdditions ? added.length : 0);
const ok = breaking === 0;

/* --json 输出 ---------------------------------------------------------- */

if (args.json) {
  console.log(
    JSON.stringify(
      {
        schema: SCHEMA,
        ok,
        breaking,
        counts: { removed: removed.length, added: added.length, changed: changed.length },
        freshness: freshnessNote,
        removed,
        added,
        changed,
      },
      null,
      2,
    ),
  );
  process.exit(args.check && !ok ? 1 : 0);
}

/* 人类可读输出 --------------------------------------------------------- */

const tag = (s) => (s === "." ? "(root)" : s);
const curTotal = Object.values(current.entrypoints).reduce((s, e) => s + Object.keys(e.symbols).length, 0);

console.log(`API surface guard · ${rel(BASELINE_PATH)}`);
console.log(
  `基线: TS ${baseline.typescript || "?"} · engine ${baseline.engine || "?"} · ${baseline.generatedAt || "?"}`,
);
console.log(`当前: TS ${current.typescript} · engine ${current.engine || "?"} · ${curTotal} 个导出`);
console.log(`dist 快照: ${freshnessNote.distSnapshot}（最新 ${freshnessNote.distNewestFile}）`);
if (freshnessNote.srcNewerThanDist) {
  console.log(`!! src 比 dist 新（最新 ${freshnessNote.srcNewestFile}）—— 下面的差异可能只是"改了源码没重新构建"。`);
}
if (baseline.typescript && baseline.typescript !== current.typescript) {
  console.log(
    `注意: 基线由 TS ${baseline.typescript} 生成，当前是 TS ${current.typescript} —— 排版差异可能制造假 diff，必要时重跑 --write。`,
  );
}
console.log("");

if (!removed.length && !added.length && !changed.length) {
  console.log("无差异：导出面与基线一致。");
  process.exit(args.check ? 0 : 0);
}

const line = (label, sub, name, note) =>
  console.log(`${label} ${tag(sub).padEnd(10)} ${name}${note ? `  ${note}` : ""}`);

if (removed.length) {
  console.log(`--- 移除 (${removed.length}) —— 破坏性 ---`);
  for (const d of removed) line("[REMOVED]", d.entrypoint, d.name, `原本: ${truncate(d.baseline, 90)}`);
  console.log("");
}
if (changed.length) {
  console.log(`--- 签名变更 (${changed.length}) —— 破坏性 ---`);
  for (const d of changed) {
    console.log(`[CHANGED] ${tag(d.entrypoint).padEnd(10)} ${d.name}`);
    console.log(`            - ${truncate(d.from, 150)}`);
    console.log(`            + ${truncate(d.to, 150)}`);
  }
  console.log("");
}
if (added.length) {
  console.log(
    `--- 新增 (${added.length})${args.strictAdditions ? " —— 破坏性（--strict-additions）" : " —— 非破坏性"} ---`,
  );
  for (const d of added) line("[ADDED]  ", d.entrypoint, d.name, "");
  console.log("");
}

console.log(
  `汇总: 移除 ${removed.length} · 变更 ${changed.length} · 新增 ${added.length} · 破坏性合计 ${breaking}`,
);
console.log(
  breaking === 0
    ? "结果: PASS —— 无破坏性 API 变更。"
    : args.check
      ? "结果: FAIL —— 存在破坏性 API 变更。若确属有意为之，审阅后运行 --write 更新基线，并在 PR 描述里说明。"
      : "结果: 检出破坏性 API 变更（当前非 --check 模式，退出码 0）。",
);
if (breaking > 0) {
  console.log("");
  if (freshnessNote.srcNewerThanDist) {
    console.log(`!! ${staleHint}`);
  } else {
    console.log("提醒：dist/ 看起来不比 src/ 旧，但仍可能是漏跑了 build（mtime 只是粗判）。拿不准就先 npm run build 再复测。");
  }
  console.log("提醒：以上\"变更\"是保守口径（含 private 成员、声明重排的文本级差异），可能含误报。");
  console.log("      请逐条审阅确认无害后再 --write；不要为了变绿直接覆盖基线，那会把真正的破坏性变更一起吞掉。");
}

process.exit(args.check && !ok ? 1 : 0);
