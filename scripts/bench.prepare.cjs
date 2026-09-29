/* eslint-disable no-console */
/**
 * Measures the memoization win of CogniStackEngine.prepare — and measures it
 * *repeatedly*.
 *
 * Why repeats became mandatory
 * ----------------------------
 * This script used to take a single wall-clock sample. A single sample cannot
 * distinguish "the change made it faster" from "the machine happened to be
 * cool this time": the same configuration routinely differs by 20–30% between
 * runs (JIT warmup, GC, background load, thermal drift). Any optimisation
 * conclusion drawn from one sample is a coin flip.
 *
 * So the default is now N samples (with warmup), reported as median + IQR, plus
 * a spread warning. If the spread is wide, the number is printed but flagged as
 * untrustworthy — that is the honest thing to do with a noisy measurement.
 *
 * Usage
 * -----
 *   node scripts/bench.prepare.cjs [--runs 7] [--warmup 2]   # runs 默认 7
 *   node scripts/bench.prepare.cjs --save-baseline bench-baseline.json
 *   node scripts/bench.prepare.cjs --baseline bench-baseline.json
 *
 * Env gates (unchanged names; now checked against the MEDIAN, not one sample):
 *   BENCH_MAX_MS             median wall time per prepare (ms)
 *   BENCH_MIN_AVOIDED_PCT    memo avoid rate lower bound (%)
 *   BENCH_MAX_HEAP_MB        heapUsed delta per prepare (MB)
 *   BENCH_MAX_SPREAD_PCT     (new) spread = (max-min)/median, upper bound (%)
 */
const fs = require("node:fs");
const path = require("node:path");
const S = require("../dist/index.js");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { runs: 7, warmup: 2, baseline: null, saveBaseline: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === "--runs") out.runs = Number(next());
    else if (a === "--warmup") out.warmup = Number(next());
    else if (a === "--baseline") out.baseline = next();
    else if (a === "--save-baseline") out.saveBaseline = next();
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) out.runs = 7;
  if (!Number.isFinite(out.warmup) || out.warmup < 0) out.warmup = 2;
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

let calls = 0;
const counter = {
  id: "bench:char-exact",
  count(text) {
    calls += 1;
    return text ? text.length : 0; // 1 char = 1 token, deterministic
  },
};

function hostLore(match) {
  return {
    selectEntries(entries) {
      return entries.filter((e) => e.enabled !== false && (e.constant || (e.keys || []).includes(match)));
    },
  };
}

const dialogue = Array.from({ length: 60 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  content: `第 ${i} 轮对话内容，这是一段有实际长度的对白文本用于测量分词开销。`,
}));

const engine = new S.CogniStackEngine({
  collaborators: { lore: hostLore("对话") },
  systemRules: "RULE",
});

const input = {
  card: {
    name: "阿铁",
    description: "设定".repeat(600),
    personality: "直接".repeat(200),
    mes_example: "示例".repeat(300),
  },
  dialogue,
  pairBatchSize: 4,
  tokenCounter: counter,
  contextTokenLimit: 4096,
  cacheScope: "bench",
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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Median + IQR of a numeric sample. Sorts a copy; never mutates the input. */
function stats(samples) {
  const s = [...samples].sort((a, z) => a - z);
  const at = (q) => {
    if (!s.length) return 0;
    const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
    return s[idx];
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
    /** Relative spread — the single number that says "trust me or not". */
    spreadPct: median > 0 ? ((s[s.length - 1] ?? 0) - (s[0] ?? 0)) / median : 0,
  };
}

function measureOnce({ fresh }) {
  if (fresh) engine.clearCache();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const r = engine.prepare(input);
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  return { r, wallMs, heapDeltaMb, tokenizations: calls };
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------------ */
/* Warmup + samples                                                    */
/* ------------------------------------------------------------------ */

for (let i = 0; i < args.warmup; i += 1) measureOnce({ fresh: true });

const samples = [];
let detail = null;
let avoidedPct = 0;
for (let i = 0; i < args.runs; i += 1) {
  calls = 0;
  const run = measureOnce({ fresh: true });
  samples.push(run);
  if (!detail) {
    detail = run;
    const st = run.r.diagnostics.counter;
    avoidedPct = st.hits + st.misses > 0 ? (st.hits / (st.hits + st.misses)) * 100 : 0;
  }
}

const wall = stats(samples.map((s) => s.wallMs));
const heap = stats(samples.map((s) => s.heapDeltaMb));
const tok = stats(samples.map((s) => s.tokenizations));
const r = detail.r;
const st = r.diagnostics.counter;

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

console.log("=== prepare() on a 60-turn chat (1 char = 1 token) ===");
console.log(`samples: ${wall.n} (warmup ${args.warmup}) · cache cleared before every sample`);
console.log("");
console.log("wall(ms)     : median", round(wall.median), "| p25", round(wall.p25), "| p75", round(wall.p75));
console.log("               min", round(wall.min), "| max", round(wall.max), "| mean", round(wall.mean));
console.log("heapΔ(MB)    : median", round(heap.median), "| min", round(heap.min), "| max", round(heap.max));
console.log(
  "tokenizations: median",
  tok.median,
  "| min",
  tok.min,
  "| max",
  tok.max,
  "(cache cleared → should be constant)",
);
console.log("");
console.log("real tokenizations (memo misses) :", detail.tokenizations);
console.log("count() calls made by pipeline   :", st.hits + st.misses);
/*
 * `distinct` is the number of entries **currently held** by the memo, not "how
 * many distinct strings this pass saw". Those coincide only until the first
 * eviction; after that `distinct` plateaus at the cap while the pass keeps
 * tokenizing new strings. Printing it under the old label ("distinct strings")
 * would silently under-report exactly when the cache is under pressure — so the
 * eviction count is printed next to it, and `real tokenizations` above is the
 * number to quote.
 */
console.log(
  "memo entries (cached now)        :",
  st.distinct,
  st.evictions > 0 ? `| evictions: ${st.evictions} —— distinct 已触顶，引用上面的 real tokenizations` : "| evictions: 0",
);
console.log("avoided                         :", `${st.hits} (${avoidedPct.toFixed(1)}%)`);
console.log("");
console.log("promptTokens :", r.promptTokens, "| cap:", r.budget.softTrimTokenCap);
console.log("sections     :", r.systemSections.length, "| lore:", r.loreInjected.length);
console.log("timings(ms)  :", JSON.stringify(r.diagnostics.timings));
console.log("warnings     :", r.warnings.length ? r.warnings.join(" | ") : "(none)");
console.log("fits budget  :", r.promptTokens <= r.budget.softTrimTokenCap);

const spreadPct = wall.spreadPct * 100;
console.log("");
if (spreadPct > 30) {
  console.log(
    `!! 离散度 ${spreadPct.toFixed(1)}% ((max-min)/median) —— 本次测量不可信。`,
  );
  console.log("   常见原因：后台进程、热降频、首次冷启动。先消除干扰再复测，别拿这个数下结论。");
} else {
  console.log(`离散度 ${spreadPct.toFixed(1)}% ((max-min)/median) —— 在可接受范围内。`);
}

/* ------------------------------------------------------------------ */
/* Baseline save / compare                                             */
/* ------------------------------------------------------------------ */

const fingerprint = {
  runs: args.runs,
  promptTokens: r.promptTokens,
  softTrimCap: r.budget.softTrimTokenCap,
  avoidedPct: round(avoidedPct, 1),
  tokenizations: detail.tokenizations,
};

if (args.saveBaseline) {
  const payload = {
    schema: "cognistack-bench-baseline@1",
    at: new Date().toISOString(),
    engine: S.COGNISTACK_VERSION,
    node: process.version,
    fixture: "bench.prepare.cjs (60 turns / 12 lore / 3 blocks)",
    wall,
    heap,
    fingerprint,
  };
  const out = path.resolve(args.saveBaseline);
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`已写入基线：${out}`);
}

if (args.baseline) {
  const file = path.resolve(args.baseline);
  console.log("");
  if (!fs.existsSync(file)) {
    console.log(`基线文件不存在，跳过对比：${file}`);
  } else {
    const base = JSON.parse(fs.readFileSync(file, "utf8"));
    const baseWall = base?.wall ?? {};
    const deltaMs = wall.median - (baseWall.median ?? 0);
    const deltaPct = baseWall.median > 0 ? (deltaMs / baseWall.median) * 100 : 0;
    // Noise band: whatever is inside the baseline's own IQR (or 5% of its
    // median) cannot be called a change. This is the guard that stops
    // "24% faster!" claims that are really thermal drift.
    const iqr = Math.max(0, (baseWall.p75 ?? 0) - (baseWall.p25 ?? 0));
    const band = Math.max(iqr, 0.05 * (baseWall.median ?? 0));
    const verdict =
      Math.abs(deltaMs) <= band
        ? "在噪声带内 —— 不能称为变化"
        : deltaMs < 0
          ? "快于基线（超出噪声带）"
          : "慢于基线（超出噪声带）";
    console.log("=== 基线对比 ===");
    console.log(`基线 (${base.at ?? "?"}, engine ${base.engine ?? "?"}): median ${round(baseWall.median)}ms, IQR ${round(iqr)}ms`);
    console.log(`本次: median ${round(wall.median)}ms`);
    console.log(`Δ median: ${round(deltaMs)}ms (${deltaPct >= 0 ? "+" : ""}${round(deltaPct, 1)}%)`);
    console.log(`噪声带: ±${round(band)}ms → ${verdict}`);
    if (fingerprint.tokenizations !== (base.fingerprint?.tokenizations ?? fingerprint.tokenizations)) {
      console.log(
        `注意：分词次数变了（${base.fingerprint?.tokenizations} → ${fingerprint.tokenizations}），比较的不是同一件事。`,
      );
    }
  }
}

console.log("");
/*
 * NOTE (measured, not assumed): on this fixture the assemble cache never hits,
 * because the pressure ladder rewrites `lore` / `maxLoreEntries` and re-assembles,
 * so the entry is stored under a *peeled* key while the next call looks up the
 * full-input key. That is a pre-existing engine characteristic — and it bites
 * hardest exactly here, where the prompt is over budget and re-assembly is most
 * expensive. Make the fixture fit the budget to see the cache hit path.
 */
engine.clearCache();
engine.prepare(input);
calls = 0;
const r2 = engine.prepare(input);
console.log("repeat call (same input, cache NOT cleared):");
console.log("  assembleCacheHit :", r2.diagnostics.stages.assembleCacheHit);
console.log("  tokenizations    :", calls);
if (!r2.diagnostics.stages.assembleCacheHit) {
  const peeled = r2.warnings.some((w) => w.startsWith("pressure-"));
  console.log(
    peeled
      ? "  → 未命中原因：本轮触发了压力剥离（pressure-*），缓存键与下次查询的键不同。"
      : "  → 未命中：输入或预算前后不一致（检查是否改了 contextTokenLimit / 卡片字段）。",
  );
}

/* ------------------------------------------------------------------ */
/* Optional gates (default: print only)                                */
/* ------------------------------------------------------------------ */

const assertions = [];
function checkLimit(name, envKey, actual, mode, unit) {
  const raw = process.env[envKey];
  if (raw == null || raw.trim() === "") return; // unset → skipped
  const limit = Number(raw);
  if (!Number.isFinite(limit)) {
    assertions.push({ ok: false, reason: `${envKey}="${raw}" 不是合法数字` });
    return;
  }
  const pass = mode === "max" ? actual <= limit : actual >= limit;
  const rel = mode === "max" ? "≤" : "≥";
  assertions.push({
    ok: pass,
    reason: pass
      ? `${name}: 实测 ${actual.toFixed(2)}${unit} ${rel} 阈值 ${limit}${unit}（${envKey}）`
      : `${name}: 实测 ${actual.toFixed(2)}${unit} 违反 ${rel} 阈值 ${limit}${unit}（${envKey}）`,
  });
}

checkLimit("prepare 墙钟耗时(median)", "BENCH_MAX_MS", wall.median, "max", "ms");
checkLimit("memo 命中避免率", "BENCH_MIN_AVOIDED_PCT", avoidedPct, "min", "%");
checkLimit("堆内存增量(median)", "BENCH_MAX_HEAP_MB", heap.median, "max", "MB");
checkLimit("离散度", "BENCH_MAX_SPREAD_PCT", spreadPct, "max", "%");

if (assertions.length) {
  console.log("");
  console.log("--- 基准门禁 ---");
  for (const a of assertions) console.log(`${a.ok ? "PASS" : "FAIL"} · ${a.reason}`);
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length) {
    process.exitCode = 1;
    console.error(`\n基准门禁失败：${failed.length} 项超阈值。`);
  }
}
