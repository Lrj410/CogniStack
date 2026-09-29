/**
 * Reference host loop: prepare → (fake LLM summarize) → commitBlock → watermark → prepare.
 * Core never calls an LLM; this shows the host-owned compress lifecycle.
 *
 *   npm run build && node examples/summarize-loop.cjs
 */
"use strict";

const {
  CogniStackEngine,
  SummaryEngine,
  MemoryBlocksEngine,
  exactCharTokenCounter,
  createKeywordLoreProvider,
} = require("../dist/index.js");

const counter = exactCharTokenCounter();
const summary = new SummaryEngine();
const blocksEngine = new MemoryBlocksEngine();

const engine = new CogniStackEngine({
  systemRules: "回答准确、简洁。",
  collaborators: { lore: createKeywordLoreProvider() },
  maxLoreEntries: 8,
});

/** Deterministic stand-in for a chat/completions call. */
function fakeSummarizeLlm(userPrompt) {
  void userPrompt;
  return [
    "【硬事实】用户关心显卡型号；机器为 RTX 5070 Laptop 8GB",
    "【时间线】开场问候 → 询问显卡",
    "【关系与称呼】无",
    "【未决】无",
    "【近期情节】助手承诺查看配置",
  ].join("\n");
}

function longDialogue(pairs) {
  const out = [];
  for (let i = 0; i < pairs; i++) {
    const n = i * 2 + 1;
    out.push({ id: String(n), role: "user", content: `第${i + 1}轮：显卡还是那个吗？` });
    out.push({
      id: String(n + 1),
      role: "assistant",
      content: `第${i + 1}轮：仍是 RTX 5070，显存 8GB。`,
    });
  }
  return out;
}

let summaryBlocks = [];
let summarizedThroughMessageId = null;
let summarizedCount = 0;
const dialogue = longDialogue(6);

const r1 = engine.prepare({
  profile: { name: "阿铁", description: "运维助手 {{char}}" },
  dialogue,
  summaryBlocks,
  summarizedCount,
  summarizedThroughMessageId,
  pairBatchSize: 2,
  contextTokenLimit: 1200,
  completionReserveTokens: 200,
  tokenCounter: counter,
  cacheScope: "summarize-loop-1",
  loreEntries: [
    {
      id: "gpu",
      name: "显卡",
      keys: ["显卡"],
      content: "RTX 5070 Laptop 8GB",
      enabled: true,
      constant: false,
      insertionOrder: 0,
    },
  ],
});

console.log("turn1 shouldSummarize:", r1.memory.shouldSummarize, "reason:", r1.memory.compressReason);
console.log("turn1 toSummarize pairs:", r1.toSummarizePairCount);

if (!r1.memory.shouldSummarize || !r1.toSummarize?.length) {
  console.error("FAIL: expected shouldSummarize with a non-empty toSummarize slice");
  process.exit(1);
}

const priorJoined = summaryBlocks.map((b) => b.text).join("\n\n");
const userPrompt = summary.buildUserPrompt({
  priorJoined,
  transcript: summary.formatTranscript(r1.toSummarize),
  mode: "replace",
  maxCharsHint: 800,
});
const llmOut = fakeSummarizeLlm(userPrompt);
const parsed = summary.parseStructuredCompress(llmOut);
const through =
  r1.nextSummarizedThroughMessageId ||
  r1.toSummarize[r1.toSummarize.length - 1]?.id ||
  "";
const block = summary.makeReplaceBlock({
  text: parsed.summaryText,
  throughMessageId: through,
  pairCount: r1.toSummarizePairCount || 0,
  kind: "full",
  importance: 80,
});
summaryBlocks = blocksEngine.commitBlock(summaryBlocks, block, 4, 2000, 6000);
summarizedThroughMessageId = r1.nextSummarizedThroughMessageId;
summarizedCount = r1.nextSummarizedCount;

const r2 = engine.prepare({
  profile: { name: "阿铁", description: "运维助手 {{char}}" },
  dialogue,
  summaryBlocks,
  summarizedCount,
  summarizedThroughMessageId,
  pairBatchSize: 2,
  contextTokenLimit: 1200,
  completionReserveTokens: 200,
  tokenCounter: counter,
  cacheScope: "summarize-loop-2",
});

const sys = r2.messages.find((m) => m.role === "system")?.content || "";
const okMemory = sys.includes("RTX 5070") || (r2.summary || "").includes("RTX 5070");
const noDupSameBatch =
  !r2.memory.shouldSummarize ||
  r2.nextSummarizedThroughMessageId !== summarizedThroughMessageId ||
  (r2.toSummarizePairCount || 0) === 0;

console.log("turn2 summaryBlocks:", summaryBlocks.length);
console.log("turn2 watermark:", summarizedThroughMessageId, "→", r2.nextSummarizedThroughMessageId);
console.log("turn2 memory in prompt:", okMemory);
console.log("turn2 shouldSummarize:", r2.memory.shouldSummarize);

if (!okMemory) {
  console.error("FAIL: committed summary did not re-enter the prompt");
  process.exit(1);
}
if (!noDupSameBatch && r2.memory.compressReason === "batch") {
  // Same watermark with another identical batch would mean a host bug; after commit, batch should advance.
  console.error("FAIL: watermark did not advance after commit");
  process.exit(1);
}

console.log("OK summarize-loop");
