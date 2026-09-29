/* eslint-disable no-console */
/**
 * 多轮压力演练（G-8）——回答「这套参数撑到第几轮开始降级」。
 *
 * 为什么单独写一个脚本
 * --------------------
 * `scripts/bench.prepare.cjs` 只跑一个固定快照：60 条对白、3 个记忆块，测的是
 * 「单轮装配有多快」。它回答不了「连续跑下去，记忆块越攒越多，第几轮开始软顶 /
 * 紧急丢弃 / 超硬顶」。而这三个数字恰恰是上线前最需要知道的。
 *
 * 本脚本的关键点是**摘要闭环**：每轮把上一轮返回的 `summaryBlocks` /
 * `summarizedThroughMessageId` / `nextSummarizedCount` 原样回灌下一轮。如果不回灌，
 * 水位线永远停在 0，未摘要对白无限增长——那模拟出来的降级轮次是假的（真实宿主
 * 会摘要、会推进水位）。所以「回灌」是这次模拟有意义的前提，不是可选项。
 *
 * 摘要在这里是**确定性假摘要**（不调模型）：从 `result.toSummarize` 里挑几条用户
 * 消息当硬事实，再按轮次线性增长的占位文本当近期情节。这样记忆块会随轮次变大，
 * 才可能真实压到预算。
 *
 * 分词器：`exactCharTokenCounter()`（1 字符 = 1 token）。这是相对刻度，**不是生产
 * 分词器**；真实模型的 token 数通常明显更小。下表里的绝对值只用于观察趋势与拐点。
 *
 * 用法
 * ----
 *   node scripts/sim.cjs [--turns 200] [--ctx 4096] [--pair-batch 10]
 *                        [--chars-per-turn 120] [--seed 42]
 *
 * 环境变量
 *   SIM_EXPECT_NO_DEGRADE=1  一旦发生任何降级（软顶 / 紧急丢弃 / 超硬顶 / 降级告警）
 *                            就以退出码 1 结束，供 CI 用。默认 0。
 */
"use strict";

const S = require("../dist/index.js");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    turns: 200,
    ctx: 4096,
    pairBatch: 10,
    charsPerTurn: 120,
    seed: 42,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === "--turns") out.turns = Number(next());
    else if (a === "--ctx") out.ctx = Number(next());
    else if (a === "--pair-batch") out.pairBatch = Number(next());
    else if (a === "--chars-per-turn") out.charsPerTurn = Number(next());
    else if (a === "--seed") out.seed = Number(next());
    else if (a === "--help" || a === "-h") out.help = true;
  }
  if (!Number.isFinite(out.turns) || out.turns < 1) out.turns = 200;
  out.turns = Math.floor(out.turns);
  if (!Number.isFinite(out.ctx) || out.ctx < 256) out.ctx = 4096;
  out.ctx = Math.floor(out.ctx);
  if (!Number.isFinite(out.pairBatch) || out.pairBatch < 1) out.pairBatch = 10;
  out.pairBatch = Math.floor(out.pairBatch);
  if (!Number.isFinite(out.charsPerTurn) || out.charsPerTurn < 8) out.charsPerTurn = 120;
  out.charsPerTurn = Math.floor(out.charsPerTurn);
  if (!Number.isFinite(out.seed)) out.seed = 42;
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log("用法: node scripts/sim.cjs [--turns 200] [--ctx 4096] [--pair-batch 10] [--chars-per-turn 120] [--seed 42]");
  console.log("环境变量: SIM_EXPECT_NO_DEGRADE=1 → 发生降级时退出码 1");
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 确定性生成器                                                        */
/* ------------------------------------------------------------------ */

/** mulberry32：32 位固定种子 PRNG，同一 seed 每次产出同一序列。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 常用技术词池——只是让对白有真实长度，不承载任何语义。 */
const WORDS = [
  "显卡", "驱动", "散热", "电源", "显存", "主板", "风扇", "机箱", "内存", "硬盘",
  "温度", "功耗", "接口", "协议", "缓存", "延迟", "带宽", "版本", "兼容", "配置",
];

/** 生成一段近似 `len` 个字符的中文文本。 */
function makeText(rand, len) {
  let s = "";
  while (s.length < len) {
    s += WORDS[Math.floor(rand() * WORDS.length)];
    if (rand() < 0.25) s += "，";
  }
  return s.slice(0, len);
}

/**
 * 确定性假摘要：五栏结构化记忆块。
 *
 * 【近期情节】随轮次线性增长——这是刻意的：真实宿主写出的记忆块会随着"往后滚动
 * 的窗口"变大，只用固定长度永远压不到预算，也就测不出降级点。
 */
function fakeSummary(items, turn) {
  const userLines = items
    .filter((m) => m.role === "user")
    .slice(0, 4)
    .map((m) => `- 用户提到：${String(m.content || "").slice(0, 24)}`);
  const hard = userLines.length ? userLines.join("\n") : "- 无";
  const recent = `第${turn}轮情节占位。`.repeat(4 + Math.floor(turn / 5));
  return [
    "【硬事实】",
    hard,
    "【时间线】",
    `已推进到第 ${turn} 轮。`,
    "【关系与称呼】",
    "用户称呼助手为阿铁。",
    "【未决】",
    "无",
    "【近期情节】",
    recent,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 引擎与固定输入                                                      */
/* ------------------------------------------------------------------ */

// exactCharTokenCounter：1 字符 = 1 token。**不是生产分词器**，只作相对刻度。
const tokenCounter = S.exactCharTokenCounter();

const engine = new S.CogniStackEngine({
  systemRules: "你是机房里的技术搭子，回答要直接、冷静。",
});

const PROFILE = {
  name: "阿铁",
  description: "住在机房里的技术搭子，负责回答硬件与配置问题。",
  personality: "直接、冷静",
};

const rand = mulberry32(args.seed);

/* ------------------------------------------------------------------ */
/* 逐轮模拟                                                            */
/* ------------------------------------------------------------------ */

const rows = [];
let dialogue = [];
let summaryBlocks = [];
let summarizedThroughMessageId = null;
let summarizedCount = 0;

let firstSoftTrim = null;
let firstEmergencyDrop = null;
let firstOverHardFit = null;
let summarizeCount = 0;

function toRow(turn, r) {
  const cap = r.budget.softTrimTokenCap;
  const hardFit = r.budget.hardFit;
  return {
    turn,
    promptTokens: r.promptTokens,
    cap,
    hardFit: hardFit ?? null,
    fill: cap > 0 ? r.promptTokens / cap : 0,
    softTrimmed: r.diagnostics.stages.softTrimmed === true,
    emergencyDropped: r.diagnostics.stages.emergencyDropped ?? 0,
    shouldSummarize: r.memory.shouldSummarize === true,
    pendingPairs: r.memory.pendingPairs ?? 0,
    compressReason: r.memory.compressReason ?? "-",
    warnings: r.warnings.length,
    degraded: r.diagnostics.severity.isDegraded === true,
    overHardFit: hardFit != null && r.promptTokens > hardFit,
  };
}

/** 状态指纹：只有这些字段变化才值得打一行，否则 200 行会淹没拐点。 */
function stateKey(row) {
  return [
    row.softTrimmed ? "T" : "t",
    row.emergencyDropped > 0 ? "E" : "e",
    row.shouldSummarize ? "S" : "s",
    row.compressReason,
    row.warnings,
    row.degraded ? "D" : "d",
    row.overHardFit ? "H" : "h",
  ].join("|");
}

for (let turn = 1; turn <= args.turns; turn += 1) {
  // 1. 追加本轮用户消息（此时对白以 user 结尾，与 INTEGRATION.md §6 的时序一致）
  dialogue.push({ id: `u${turn}`, role: "user", content: makeText(rand, args.charsPerTurn) });

  // 2. 装配
  const r = engine.prepare({
    profile: PROFILE,
    dialogue,
    summaryBlocks,
    summarizedThroughMessageId,
    summarizedCount,
    pairBatchSize: args.pairBatch,
    contextTokenLimit: args.ctx,
    completionReserveTokens: Math.max(64, Math.floor(args.ctx * 0.125)),
    tokenCounter,
    cacheScope: "sim",
    label: `sim-turn-${turn}`,
  });

  const row = toRow(turn, r);
  rows.push(row);

  // 3. 首次降级点
  if (row.softTrimmed && firstSoftTrim === null) firstSoftTrim = turn;
  if (row.emergencyDropped > 0 && firstEmergencyDrop === null) firstEmergencyDrop = turn;
  if (row.overHardFit && firstOverHardFit === null) firstOverHardFit = turn;

  // 4. 摘要闭环：模拟宿主把 toSummarize 交给摘要模型，再把结果写回
  if (r.memory.shouldSummarize && r.toSummarize.length) {
    const through = r.nextSummarizedThroughMessageId;
    summaryBlocks = summaryBlocks.concat([
      {
        id: `blk-${turn}`,
        text: fakeSummary(r.toSummarize, turn),
        throughMessageId: through ?? (dialogue[dialogue.length - 1]?.id ?? `u${turn}`),
        pairCount: r.toSummarizePairCount,
        kind: "full",
      },
    ]);
    summarizedThroughMessageId = through;
    summarizedCount = r.nextSummarizedCount;
    summarizeCount += 1;
  }

  // 5. 追加助手回复（LLM 之后才入队，见 §6 顺序注意）
  dialogue.push({ id: `a${turn}`, role: "assistant", content: makeText(rand, args.charsPerTurn) });
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

const pad = (v, n) => String(v).padEnd(n);
const num = (v, n) => String(v).padStart(n);

console.log("=== CogniStack 多轮压力演练 (G-8) ===");
console.log(
  `轮次 ${args.turns} · ctx ${args.ctx} · pairBatch ${args.pairBatch} · 每轮 ${args.charsPerTurn} 字符 · seed ${args.seed}`,
);
console.log("分词器: exactCharTokenCounter (1 字符 = 1 token) —— 相对刻度，不是生产分词器");
console.log("");
console.log(
  `${pad("turn", 6)}${num("promptTok", 10)}${num("fill", 8)}${num("softTrim", 10)}${num("emgDrop", 9)}${num("pendPair", 10)}  ${pad("compress", 10)}${num("warn", 5)}`,
);

let lastKey = "";
for (const row of rows) {
  const key = stateKey(row);
  const changed = key !== lastKey;
  const sampled = row.turn % 10 === 0;
  if (!changed && !sampled) continue;
  lastKey = key;
  console.log(
    `${pad(row.turn, 6)}${num(row.promptTokens, 10)}${num(row.fill.toFixed(3), 8)}${num(row.softTrimmed ? "yes" : "-", 10)}${num(row.emergencyDropped, 9)}${num(row.pendingPairs, 10)}  ${pad(row.compressReason, 10)}${num(row.warnings, 5)}${changed ? "   *状态变化" : ""}`,
  );
}

const last = rows[rows.length - 1];
console.log("");
console.log("--- 汇总 ---");
console.log(`首次 soft-trim       : ${firstSoftTrim === null ? "未发生" : `第 ${firstSoftTrim} 轮`}`);
console.log(`首次 emergency drop  : ${firstEmergencyDrop === null ? "未发生" : `第 ${firstEmergencyDrop} 轮`}`);
console.log(`首次超 hardFit       : ${firstOverHardFit === null ? "未发生" : `第 ${firstOverHardFit} 轮`}`);
console.log(`末轮 (第 ${last.turn} 轮) fill : ${last.fill.toFixed(3)} (promptTokens ${last.promptTokens} / cap ${last.cap})`);
console.log(`摘要次数             : ${summarizeCount} · 末轮记忆块 ${summaryBlocks.length} 个 · 末轮对白 ${dialogue.length} 条`);

const degraded = rows.some(
  (r) => r.softTrimmed || r.emergencyDropped > 0 || r.overHardFit || r.degraded,
);
console.log(`整体是否降级         : ${degraded ? "是" : "否"}`);

if (process.env.SIM_EXPECT_NO_DEGRADE === "1" && degraded) {
  console.error("\nSIM_EXPECT_NO_DEGRADE=1 且检测到降级 → 退出码 1");
  process.exit(1);
}
process.exit(0);
