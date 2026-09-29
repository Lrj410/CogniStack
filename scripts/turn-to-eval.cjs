/* eslint-disable no-console */
/**
 * 从生产回合生成 eval 用例（G-14）。
 *
 * 为什么需要这个脚本
 * ------------------
 * `scripts/eval/cases/*.json` 里的用例都是人手写的。真实系统里跑出一次「差点超窗」
 * 或「触发压力剥离」的回合，比任何人工构造都更接近生产；但如果只能靠回忆去补一个
 * 用例，这份价值就丢了。
 *
 * 关键约束：TurnRecord 默认**没有**原始输入
 * ----------------------------------------
 * `TurnRecord` 记的是计数、预算、告警、摘要——不是 prompt 正文（见 tools/lib/turn-log.cjs
 * 的设计说明）。所以「把这一轮变成可重放的用例」有一个硬前提：日志里得有
 * `inputSnapshot`（宿主开了 `captureInputs: true` 才会写），或者你用 `--input` 手动提供。
 *
 * 两者都没有时，本脚本**直接报错退出**，绝不生成一个"看着像用例、其实跑不起来"
 * 的 JSON——那种输出比没有输出更危险。
 *
 * 断言用不变量，不硬编码当时的输出
 * --------------------------------
 * 生成的用例是 `hard_fit` 类型，断言是 `promptTokens <= budget.hardFit`（以及可选
 * `expectPressure`）。模型的输出会随实现变化，不变量不会。`notes` 里保留那一轮的
 * 实测数字作为溯源，但它们不参与断言。
 *
 * 用法
 * ----
 *   node scripts/turn-to-eval.cjs --log <turns.jsonl> [--index N | --seq N] \
 *        --input <input.json> [--out <case.json>] [--dry]
 *
 *   --index N   取日志里第 N 条（0 = 最新，读出来就是 newest-first）
 *   --seq N     取 seq === N 的那条（更稳，重放时不受条数影响）
 *   --input     额外的/覆盖用的 prepare 输入 JSON（会与 inputSnapshot 浅合并）
 *   --dry       只打印将写入的 JSON，不落盘
 *
 * 不传 --out 也不传 --dry 时会报错：避免把文件写到调用者没指定的位置。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createTurnLog } = require("../tools/lib/turn-log.cjs");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { log: null, index: 0, seq: null, input: null, out: null, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === "--log") out.log = next();
    else if (a === "--index") out.index = Number(next());
    else if (a === "--seq") out.seq = Number(next());
    else if (a === "--input") out.input = next();
    else if (a === "--out") out.out = next();
    else if (a === "--dry") out.dry = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function usage(msg) {
  if (msg) console.error(`错误: ${msg}`);
  console.error(
    "用法: node scripts/turn-to-eval.cjs --log <turns.jsonl> [--index N | --seq N] --input <input.json> [--out <case.json>] [--dry]",
  );
  process.exit(2);
}

if (args.help) {
  console.log(
    "用法: node scripts/turn-to-eval.cjs --log <turns.jsonl> [--index N | --seq N] --input <input.json> [--out <case.json>] [--dry]",
  );
  process.exit(0);
}

if (!args.log) usage("缺少 --log");
if (!fs.existsSync(path.resolve(args.log))) usage(`日志文件不存在: ${args.log}`);
if (args.seq !== null && !Number.isFinite(args.seq)) usage("--seq 需要是数字");
if (!Number.isFinite(args.index) || args.index < 0) args.index = 0;
if (!args.out && !args.dry) usage("必须指定 --out（写入路径）或 --dry（只打印）");

/* ------------------------------------------------------------------ */
/* 读取并选取回合                                                      */
/* ------------------------------------------------------------------ */

const log = createTurnLog({ file: path.resolve(args.log) });
const result = log.read({ limit: 5000 });
if (!result.turns.length) {
  console.error(`日志里没有可读的回合（scanned=${result.scanned}, malformed=${result.malformed}）`);
  console.error("提示：确认路径正确，且该文件确实是 tools/lib/turn-log.cjs 写出的 JSONL。");
  process.exit(1);
}

let record;
let selection;
if (args.seq !== null) {
  record = result.turns.find((t) => Number(t.seq) === args.seq);
  selection = `seq=${args.seq}`;
  if (!record) {
    console.error(`未找到 seq=${args.seq} 的回合（共读到 ${result.turns.length} 条，最新 seq=${result.turns[0]?.seq}）。`);
    console.error("提示：seq 只在单个 telemetry 实例内单调，跨重启会重置。用 --index 或指定合适的 seq。");
    process.exit(1);
  }
} else {
  record = result.turns[args.index];
  selection = `index=${args.index}`;
  if (!record) {
    console.error(`--index ${args.index} 越界（共 ${result.turns.length} 条）。`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* 解析输入：优先 inputSnapshot，其次 --input                          */
/* ------------------------------------------------------------------ */

function readJson(file) {
  const text = fs.readFileSync(path.resolve(file), "utf8");
  return JSON.parse(text);
}

let override;
if (args.input) {
  try {
    override = readJson(args.input);
  } catch (err) {
    console.error(`--input 解析失败: ${err && err.message ? err.message : err}`);
    process.exit(2);
  }
}

const snapshot = record.inputSnapshot;
const hasSnapshot = snapshot !== undefined && snapshot !== null;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// 这是设计上最重要的一条分支：没有输入就绝不生成用例。
if (!hasSnapshot && !isObj(override)) {
  console.error("无法生成用例：这一轮没有可重放的输入。");
  console.error(
    "原因：TurnRecord 默认不保存原始输入；日志里没有 inputSnapshot（宿主需用 captureInputs: true 采集），同时也没有传 --input。",
  );
  console.error("缺少输入时重放这一轮没有意义——生成的用例会跑不起来，所以这里直接失败而不产出文件。");
  process.exit(1);
}

let merged;
if (isObj(snapshot) && isObj(override)) merged = { ...snapshot, ...override };
else if (isObj(snapshot)) merged = { ...snapshot };
else merged = { ...override };

const inputSource = isObj(snapshot) && isObj(override)
  ? "inputSnapshot + --input (--input 覆盖同名顶层字段)"
  : isObj(snapshot)
    ? "inputSnapshot"
    : "--input";

/* ------------------------------------------------------------------ */
/* 映射成 eval 用例（hard_fit 不变量）                                 */
/* ------------------------------------------------------------------ */

const dialogue = Array.isArray(merged.dialogue) ? merged.dialogue : null;
if (!dialogue || !dialogue.length) {
  console.error("无法生成用例：输入里没有可用的 dialogue[]。");
  console.error("hard_fit 用例必须先装配一段对白；缺失时请用 --input 补上 dialogue。");
  process.exit(1);
}

const warnings = Array.isArray(record.warnings) ? record.warnings.map(String) : [];
const expectPressure = warnings.some((w) => w.startsWith("pressure-"));

const contextTokenLimit = Number.isFinite(Number(merged.contextTokenLimit))
  ? Number(merged.contextTokenLimit)
  : Number(record.contextLimit) || 4096;
const completionReserveTokens = Number.isFinite(Number(merged.completionReserveTokens))
  ? Number(merged.completionReserveTokens)
  : Number(record.completionReserve) || 64;

const droppedFields = [];
if (merged.summaryBlocks || merged.summary) droppedFields.push("summaryBlocks/summary");
if (merged.summarizedThroughMessageId != null) droppedFields.push("summarizedThroughMessageId");
if (merged.pairBatchSize != null) droppedFields.push("pairBatchSize");

const evalCase = {
  kind: "hard_fit",
  contextTokenLimit,
  completionReserveTokens,
  profile: merged.profile ?? merged.card ?? { name: "Agent", description: "x".repeat(200) },
  dialogue,
  expectPressure,
  ...(Array.isArray(merged.loreEntries ?? merged.worldEntries)
    ? { loreEntries: merged.loreEntries ?? merged.worldEntries }
    : {}),
  ...(Array.isArray(merged.vectorHits) ? { vectorHits: merged.vectorHits } : {}),
  ...(typeof merged.systemRules === "string" ? { systemRules: merged.systemRules } : {}),
  // 溯源：那一轮实测到的数字。不参与断言，只用于人回溯。
  notes: {
    provenance: "generated by scripts/turn-to-eval.cjs (G-14)",
    inputSource,
    asserted: "promptTokens <= budget.hardFit" + (expectPressure ? " && pressure-* warning present" : ""),
    observed: {
      promptTokens: record.promptTokens,
      softTrimTokenCap: record.softTrimCap,
      hardFit: record.hardFit ?? null,
      fill: record.fill,
      warnings,
      degraded: record.degraded === true,
      softTrimmed: record.softTrimmed === true,
      emergencyDropped: record.emergencyDropped ?? 0,
    },
    note:
      droppedFields.length > 0
        ? `hard_fit 用例不还原 ${droppedFields.join(", ")}（现有 harness 无此字段），因此这是「同等窗口下的不变量」而非逐 token 复现。`
        : "输入被完整映射到 hard_fit 用例。",
  },
  source: {
    log: path.resolve(args.log),
    selection,
    seq: record.seq,
    at: record.at ? new Date(record.at).toISOString() : null,
    hostId: record.hostId,
    hostName: record.hostName ?? null,
    mode: record.mode,
  },
};

/* ------------------------------------------------------------------ */
/* 重放校验：确保写出的用例在 eval harness 里真的能通过                 */
/* ------------------------------------------------------------------ */

/**
 * 用与 scripts/eval/run.cjs 的 `hard_fit` 分支**相同的语义**重放一遍。
 *
 * 为什么要重放：现有 harness 只认 `hard_fit` / `hard_fact_retention` 等固定字段，
 * 不还原 `summaryBlocks`。所以「当时有 pressure-* 告警」这件事在重放时未必成立——
 * 如果照抄成一个 expectPressure:true 的用例，它会永远失败。宁可在生成时验证并如实
 * 记录，也不要产出一个"看着能用其实必挂"的用例。
 */
function replayHardFit(c) {
  let S;
  try {
    S = require("../dist/index.js");
  } catch (err) {
    return { error: `无法加载 ../dist/index.js（${err && err.message ? err.message : err}）` };
  }
  try {
    const engine = new S.CogniStackEngine({
      systemRules: c.systemRules || "RULE",
      collaborators: { lore: S.createKeywordLoreProvider() },
      maxLoreEntries: c.maxLoreEntries ?? 8,
    });
    const r = engine.prepare({
      profile: c.profile,
      dialogue: c.dialogue,
      loreEntries: c.loreEntries || [],
      vectorHits: c.vectorHits || [],
      contextTokenLimit: c.contextTokenLimit,
      completionReserveTokens: c.completionReserveTokens ?? 64,
      tokenCounter: S.exactCharTokenCounter(),
      cacheScope: `turn-to-eval-${Date.now()}`,
    });
    return {
      promptTokens: r.promptTokens,
      hardFit: r.budget.hardFit,
      fits: r.promptTokens <= r.budget.hardFit,
      pressure: r.warnings.some((w) => String(w).startsWith("pressure-")),
    };
  } catch (err) {
    return { error: `重放抛错：${err && err.message ? err.message : err}` };
  }
}

const replay = replayHardFit(evalCase);

if (replay.error) {
  // 无法验证 → 不写不可复现的 expectPressure。
  if (evalCase.expectPressure) {
    delete evalCase.expectPressure;
    evalCase.notes.replayNote = `重放校验不可用（${replay.error}），已去掉 expectPressure，只保留不变量断言。`;
  } else {
    evalCase.notes.replayNote = `重放校验不可用：${replay.error}`;
  }
} else {
  if (evalCase.expectPressure && !replay.pressure) {
    delete evalCase.expectPressure;
    evalCase.notes.replayNote =
      "原始回合有 pressure-* 告警，但按 hard_fit 语义重放不复现（harness 不还原 summaryBlocks 等字段），" +
      "已去掉 expectPressure，避免写出必然失败的用例。";
  }
  if (!replay.fits) {
    console.error("拒绝生成：按 eval harness 的 hard_fit 语义重放后，promptTokens 仍 > hardFit。");
    console.error(
      `重放结果: promptTokens=${replay.promptTokens} hardFit=${replay.hardFit}。这说明该输入本身违反不变量，写成用例会必然失败。`,
    );
    console.error("请检查输入（例如对白是否已超过窗口），或改用 --input 修正后再生成。");
    process.exit(1);
  }
  evalCase.notes.replay = {
    promptTokens: replay.promptTokens,
    hardFit: replay.hardFit,
    fitsHardFit: replay.fits,
    pressureReproduced: replay.pressure,
  };
}

// 重放校验可能改掉了 expectPressure，同步更新断言描述，避免 notes 与用例不一致。
evalCase.notes.asserted =
  "promptTokens <= budget.hardFit" + (evalCase.expectPressure ? " && pressure-* warning present" : "");

const json = `${JSON.stringify(evalCase, null, 2)}\n`;

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

if (args.dry) {
  console.log(json);
  process.exit(0);
}

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json, "utf8");
console.log(`已写入 eval 用例: ${outPath}`);
console.log(`来源: ${selection} · host=${record.hostId ?? "?"} · seq=${record.seq ?? "?"} · 输入=${inputSource}`);
console.log(
  `溯源(实测): promptTokens=${record.promptTokens} softTrimTokenCap=${record.softTrimCap} hardFit=${record.hardFit ?? "-"} warnings=${warnings.length}`,
);
console.log("运行验证: node scripts/eval/run.cjs");
