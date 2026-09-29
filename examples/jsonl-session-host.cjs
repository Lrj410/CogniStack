/**
 * 参考宿主（G-27）：会话状态到底存哪、怎么存。
 *
 * 运行：
 *   node examples/jsonl-session-host.cjs
 *   node examples/jsonl-session-host.cjs --dir ./_sessions --session alice --turns 40
 *
 * 这个示例只解决一件事：把「每轮 prepare 的输入 / 输出 / 记忆状态」用最朴素的
 * JSONL 文件落盘，直到可以重启续跑。它刻意不碰数据库、不碰网络、不调模型。
 *
 * 为什么用 JSONL 而不是一个 JSON 大对象
 * --------------------------------------
 * 1. 追加写：一轮一行，崩溃只会损坏最后一行，不会毁掉整份历史；
 * 2. 读回时从最后一行往前找第一条完整记录即可，天然要处理「半行」；
 * 3. 它把「记忆状态是宿主自己的存储格式」这件事摆在明面上——引擎从不替你存。
 *
 * 记忆状态为什么用信封（serializeMemoryState / deserializeMemoryState）
 * ---------------------------------------------------------------------
 * 「记忆状态」不是一个字段，而是 summaryBlocks + summarizedThroughMessageId +
 * summarizedCount (+ loreRuntime)。散着存，两个字段一旦对不上（比如人工改了
 * summarizedCount），水位就会静默跳段或重复摘要。信封给它们一个版本化的形状，
 * 并在读回时校验、修复、把修复明细放进 `repaired`——本示例会在末尾演示这一价值。
 *
 * 关于本示例用的"假摘要"
 * ----------------------
 * 引擎绝不调用 LLM。这里用一个确定性纯函数顶替摘要模型，保证可离线复现。
 * 生产把 fakeSummarizeLlm 换成真实模型调用即可，其余闭环完全一致：
 *   prepare → shouldSummarize? → buildUserPrompt → 摘要模型 → parse →
 *   makeReplaceBlock → commitBlock → 推进水位 → 下一轮 prepare 带上新记忆。
 * 更完整的摘要写法参考 examples/summarize-loop.cjs。
 *
 * ⚠️ 分词器警告
 * -------------
 * 本示例用 exactCharTokenCounter()（1 字符 ≈ 1 token），仅仅是为了零依赖、能直接
 * 跑起来。生产必须注入与模型一致的真实分词器（tiktoken / llama.cpp /tokenize 等），
 * 否则预算、软顶、紧急裁剪都在按错误的 token 数做决策。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CogniStackEngine,
  SummaryEngine,
  MemoryBlocksEngine,
  exactCharTokenCounter,
  createKeywordLoreProvider,
  serializeMemoryState,
  deserializeMemoryState,
} = require("../dist/index.js");

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const DIR = arg("dir", path.join(os.tmpdir(), "cognistack-jsonl-host"));
const SESSION = arg("session", "demo-session");
const TURNS = Math.max(1, Number(arg("turns", 32)) || 32);
const FILE = path.join(DIR, `${SESSION}.jsonl`);

fs.mkdirSync(DIR, { recursive: true });

console.log(`[dir] 会话目录: ${DIR}`);
console.log(`[dir] 会话文件: ${FILE}`);
console.log(
  "[warn] 本示例用 exactCharTokenCounter()（1 字符 ≈ 1 token）仅为可跑；" +
    "生产必须注入真实分词器，否则 token 预算不可用于判断。",
);

/* ------------------------------------------------------------------ */
/* 引擎                                                                */
/* ------------------------------------------------------------------ */

// 生产请替换：const counter = createHttpTokenCounter({ url: ".../tokenize" }) + prepareAsync。
const counter = exactCharTokenCounter();
const summary = new SummaryEngine();
const blocksEngine = new MemoryBlocksEngine();

const engine = new CogniStackEngine({
  systemRules: "回答准确、简洁；不确定时说明假设。",
  collaborators: { lore: createKeywordLoreProvider() },
  maxLoreEntries: 4,
});

const PROFILE = { name: "阿铁", description: "机房运维助手。我是{{char}}。" };
const LORE = [
  {
    id: "gpu",
    name: "显卡",
    keys: ["显卡"],
    content: "RTX 5070 Laptop 8GB",
    enabled: true,
    constant: false,
    insertionOrder: 0,
  },
];

/* ------------------------------------------------------------------ */
/* JSONL 持久化                                                        */
/* ------------------------------------------------------------------ */

/** 全新的空会话状态。 */
function baseline() {
  return {
    turn: 0,
    dialogue: [],
    summaryBlocks: [],
    summarizedCount: 0,
    summarizedThroughMessageId: null,
  };
}

/** 追加一行快照。真实系统这里换成 INSERT 到你的表。 */
function writeSnapshot(snap) {
  // 记忆状态不是一堆散字段，而是带版本与校验的信封：写盘统一走 serializeMemoryState。
  const envelope = serializeMemoryState(
    {
      summaryBlocks: snap.summaryBlocks,
      summarizedThroughMessageId: snap.summarizedThroughMessageId,
      summarizedCount: snap.summarizedCount,
    },
    { updatedAt: Date.now() },
  );
  const record = {
    turn: snap.turn,
    dialogue: snap.dialogue, // 宿主自己的会话存储（真实系统会是数据库）
    memory: envelope, // 规范化后的记忆信封
    updatedAt: envelope.updatedAt,
  };
  fs.appendFileSync(FILE, `${JSON.stringify(record)}\n`, "utf8");
}

/** 从磁盘恢复：取最后一条完整记录，并用 deserializeMemoryState 校验记忆。 */
function readSnapshot() {
  if (!fs.existsSync(FILE)) {
    console.log("[load] 文件不存在 → 视为全新会话。");
    return baseline();
  }
  const lines = fs.readFileSync(FILE, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // 进程在写这一行时崩溃 → 最后一行可能是半截 JSON。跳过它，用上一条。
      console.log(`[recover] 第 ${i + 1} 行不是完整 JSON（写入中途），跳过。`);
      continue;
    }
    const { state, repaired, foreign } = deserializeMemoryState(rec.memory);
    if (foreign) {
      console.log(`[load] 第 ${rec.turn} 行的 memory 不是 CogniStack 信封 → 按"无记忆"处理。`);
    }
    if (repaired.some((r) => r.startsWith("summarized-count-repaired"))) {
      // 这里如实说明一个已知的单位不一致（不改源码，只在示例里点明）：
      // 引擎的 nextSummarizedCount / MemoryStatus.summarizedCount 是「已覆盖的**消息条数**」，
      // 而信封 memoryEnvelope 用「块 pairCount 之和（**回合对数**）」去校验它，单位不同，
      // 于是每次读盘都会产生一次 summarized-count-repaired 误报。
      // 由于 summarizedThroughMessageId 优先，装配结果不受影响；只影响纯整数水位的宿主。
      console.log(
        "[note] 出现 summarized-count-repaired 是已知单位不一致（消息数 vs 回合对数），" +
          "详见 examples/REFERENCE-HOSTS.md；本示例因 watermark id 优先而不受影响。",
      );
    }
    console.log(
      `[load] 从第 ${rec.turn} 轮快照恢复：blocks=${state.summaryBlocks?.length ?? 0}` +
        `, watermark=${state.summarizedThroughMessageId ?? "null"}` +
        `, summarizedCount=${state.summarizedCount ?? 0}` +
        `, repaired=${repaired.length ? repaired.join(" | ") : "无"}`,
    );
    return {
      turn: rec.turn ?? 0,
      dialogue: Array.isArray(rec.dialogue) ? rec.dialogue : [],
      summaryBlocks: state.summaryBlocks ?? [],
      summarizedCount: state.summarizedCount ?? 0,
      summarizedThroughMessageId: state.summarizedThroughMessageId ?? null,
    };
  }
  console.log("[load] 文件存在但没有有效记录 → 视为全新会话。");
  return baseline();
}

/* ------------------------------------------------------------------ */
/* 确定性"假摘要"                                                      */
/* ------------------------------------------------------------------ */

/**
 * 真实的摘要由摘要模型产出；引擎绝不调用 LLM。
 * 这里用纯函数顶替，保证示例可离线、可复现。生产替换成你的模型调用即可。
 */
function fakeSummarizeLlm(userPrompt) {
  void userPrompt; // 真实实现里把 userPrompt 发给模型
  return [
    "【硬事实】机器为 RTX 5070 Laptop 8GB；机房温度恒定 22C",
    "【时间线】用户连续多轮确认显卡与机房温度",
    "【关系与称呼】用户称呼助手为「阿铁」",
    "【未决】无",
    "【近期情节】助手持续确认硬件配置",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 单轮：prepare → 打印摘要信息 → 需要则摘要并推进水位 → 落盘          */
/* ------------------------------------------------------------------ */

function runTurn(snap, n, tag) {
  // 1) 宿主自己维护对白（本轮先塞入 user；真实系统在拿到模型回复后塞 assistant）。
  snap.dialogue.push({ id: `${n}u`, role: "user", content: `第${n}问：显卡还是那张吗？机房温度呢？` });
  snap.dialogue.push({
    id: `${n}a`,
    role: "assistant",
    content: `第${n}答：仍是 RTX 5070 Laptop 8GB，机房 22C。`,
  });

  // 2) 装配。带全量 dialogue + 已提交记忆 + 水位。
  const result = engine.prepare({
    profile: PROFILE,
    dialogue: snap.dialogue,
    summaryBlocks: snap.summaryBlocks,
    summarizedCount: snap.summarizedCount,
    summarizedThroughMessageId: snap.summarizedThroughMessageId,
    pairBatchSize: 3,
    contextTokenLimit: 8192,
    completionReserveTokens: 1024,
    tokenCounter: counter,
    cacheScope: SESSION, // 会话键：应等于你的会话主键
    loreEntries: LORE,
    label: `第${n}轮`,
  });

  // 3) 只打印"摘要信息"——真实宿主会把 result.messages 原样发给聊天模型。
  const sys = result.messages.find((m) => m.role === "system");
  const sysHead = (sys?.content ?? "").replace(/\s+/g, " ").slice(0, 48);
  console.log(
    `[turn ${String(n).padStart(2)}${tag ? ` ${tag}` : ""}]` +
      ` messages=${result.messages.length}` +
      ` promptTokens=${result.promptTokens}` +
      ` blocks=${snap.summaryBlocks.length}` +
      ` shouldSummarize=${result.memory.shouldSummarize}` +
      ` reason=${result.memory.compressReason ?? "-"}` +
      ` pendingPairs=${result.memory.pendingPairs}` +
      ` watermark=${snap.summarizedThroughMessageId ?? "-"}` +
      ` | system号: "${sysHead}…"`,
  );

  // 4) 触发压缩时走摘要闭环：假摘要 → 结构化块 → 推进水位。
  if (result.memory.shouldSummarize && (result.toSummarize?.length ?? 0) > 0) {
    const wmBefore = snap.summarizedThroughMessageId;
    const blocksBefore = snap.summaryBlocks.length;

    const priorJoined = snap.summaryBlocks.map((b) => b.text).join("\n\n");
    const userPrompt = summary.buildUserPrompt({
      priorJoined,
      transcript: summary.formatTranscript(result.toSummarize),
      mode: "replace",
      maxCharsHint: 800,
    });
    const parsed = summary.parseStructuredCompress(fakeSummarizeLlm(userPrompt));
    const through =
      result.nextSummarizedThroughMessageId ||
      result.toSummarize[result.toSummarize.length - 1]?.id ||
      "";
    const block = summary.makeReplaceBlock({
      text: parsed.summaryText,
      throughMessageId: through,
      pairCount: result.toSummarizePairCount || 0,
      kind: "full",
      importance: 80,
    });
    snap.summaryBlocks = blocksEngine.commitBlock(snap.summaryBlocks, block, 4, 2000, 6000);
    // 只有摘要成功才推进水位——这是防"摘要死循环"的铁律。
    snap.summarizedThroughMessageId = result.nextSummarizedThroughMessageId;
    snap.summarizedCount = result.nextSummarizedCount;

    console.log(
      `[summarize] reason=${result.memory.compressReason} 压缩 ${result.toSummarizePairCount} 对；` +
        ` 水位 ${wmBefore ?? "-"} → ${snap.summarizedThroughMessageId ?? "-"};` +
        ` blocks ${blocksBefore} → ${snap.summaryBlocks.length};` +
        ` 本轮 prompt 已含更早提交的记忆=${result.summary.includes("【硬事实】")}（本块下一轮生效）`,
    );
  }

  snap.turn = n;
  // 5) 落盘（真实系统在一轮结束时把 dialogue + 记忆一起写库）。
  writeSnapshot(snap);
  return result;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  console.log("\n=== 首次运行：从磁盘（或空）恢复，然后连续跑 TURNS 轮 ===");
  const snap = readSnapshot();
  console.log(
    `[run] 起始 turn=${snap.turn}, dialogue=${snap.dialogue.length}, blocks=${snap.summaryBlocks.length}`,
  );

  // 会话内对白会无限增长。真实宿主应在此处按自己的策略裁剪历史，
  // 或只把「水位之后的窗口」传进来以省内存/省存储。
  // 注意循环上界要在循环外算好：runTurn 会把 snap.turn 推进到 n。
  const endTurn = snap.turn + TURNS;
  let summariesSeen = 0;
  for (let n = snap.turn + 1; n <= endTurn; n += 1) {
    const r = runTurn(snap, n, "");
    if (r.memory.shouldSummarize) summariesSeen += 1;
  }
  console.log(`[run] 本轮连跑结束：共触发摘要 ${summariesSeen} 次，blocks=${snap.summaryBlocks.length}。`);
  if (summariesSeen === 0) {
    console.error("FAIL: 在给定轮数内一次摘要都没触发，示例失去意义（调小 pairBatchSize 或调大 --turns）。");
    process.exit(1);
  }

  /* ---- 模拟重启：丢弃内存，只从磁盘恢复，再续跑 ---- */
  console.log("\n=== 模拟重启：丢掉内存里的 snap，只从磁盘恢复 ===");
  const restored = readSnapshot();
  console.log(
    `[restart] dialogue=${restored.dialogue.length}, blocks=${restored.summaryBlocks.length},` +
      ` watermark=${restored.summarizedThroughMessageId ?? "-"}`,
  );
  const endRestored = restored.turn + 4;
  for (let n = restored.turn + 1; n <= endRestored; n += 1) {
    runTurn(restored, n, "续");
  }
  console.log("[restart] 重启后水位没有回退、也没有重复摘要同一批 → 续接成功。");

  /* ---- 信封校验演示：坏记录应被修复而不是让会话崩掉 ---- */
  console.log("\n=== 信封校验演示：喂几种「脏数据」，看它如何被修复或回退 ===");

  // 1) 丢了整数水位、且整数与块对不上：能恢复的尽量恢复，并报告每一处改动。
  const dirty = {
    kind: "cognistack-memory",
    version: 1,
    blocks: [
      {
        id: "blk-demo",
        text: "【硬事实】演示用块",
        throughMessageId: "12a",
        pairCount: 5,
        kind: "full",
      },
    ],
    summarizedThroughMessageId: null, // 水位丢了
    summarizedCount: 999, // 与块不一致
  };
  const r1 = deserializeMemoryState(dirty);
  console.log(`[repair] (缺水位+整数冲突) repaired=${r1.repaired.join(" | ")}`);
  console.log(
    `[repair]   结果 watermark=${r1.state.summarizedThroughMessageId}, summarizedCount=${r1.state.summarizedCount}`,
  );

  // 2) 块缺 throughMessageId：直接丢掉这个块——保留它会让水位找不到锚点。
  const dirty2 = { ...serializeMemoryState({ summaryBlocks: [], summarizedThroughMessageId: null, summarizedCount: 0 }), blocks: [{ id: "x", text: "没有锚点的块" }] };
  const r2 = deserializeMemoryState(dirty2);
  console.log(`[repair] (块缺锚点) blocks=${r2.state.summaryBlocks.length}, repaired=${r2.repaired.join(" | ") || "无"}`);

  // 3) 根本不是 CogniStack 信封：回退为"无记忆"，而不是崩掉整轮。
  const r3 = deserializeMemoryState({ hello: "world" });
  console.log(`[repair] (非信封) foreign=${r3.foreign}, repaired=${r3.repaired.join(" | ")}`);

  console.log("\nOK jsonl-session-host");
}

main();
