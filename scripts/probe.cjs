/* eslint-disable no-console */
const S = require("../dist/index.js");

function line(t) {
  console.log("\n=== " + t + " ===");
}
const counter = S.exactCharTokenCounter();

/** Minimal host lore for the end-to-end probe (no adapters package). */
function hostLore(match) {
  return {
    selectEntries(entries) {
      return entries.filter((e) => e.enabled !== false && (e.constant || (e.keys || []).includes(match)));
    },
  };
}

/* ---- A. clipStructuredSummary can EXCEED maxChars ---- */
line("A. clipStructuredSummary budget violation sweep");
const doc = [
  "【硬事实】",
  Array.from({ length: 40 }, (_, i) => `事实条目${i}：描述文字`).join("；"),
  "",
  "【未决】",
  "悬念甲",
].join("\n");
console.log("doc len:", doc.length);
for (const max of [0, 8, 20, 40, 43, 60, 120, 400]) {
  const out = S.clipStructuredSummary(doc, max);
  console.log(
    `  max=${String(max).padStart(3)} -> len=${String(out.length).padStart(3)} ${out.length > max ? "OVER" : "ok"}`,
  );
}

line("A2. minimum viable render length");
console.log(
  "  min render len =",
  S.normalizeStructuredMemory("【硬事实】甲").length,
  JSON.stringify(S.normalizeStructuredMemory("【硬事实】甲")),
);

/* ---- B. merge with realistic text ---- */
line("B. mergeStructuredMemoryTexts (realistic)");
const older =
  "【硬事实】阿铁是住在用户机器里的技术搭子\n【时间线】第一天：两人搭上了话\n【关系与称呼】称呼对方为「老板」\n【未决】要不要把整个工程外挂出去\n【近期情节】两人在机房里对着日志聊了很久";
const newer =
  "【硬事实】这台机器是 RTX 5070 Laptop 8GB\n【时间线】第二天：压测跑完了\n【关系与称呼】无\n【未决】无\n【近期情节】他们把 benchmark 重跑了一遍又一遍";
console.log(S.mergeStructuredMemoryTexts(older, newer));

line("B2. thin column heuristic on short but real recent events");
for (const body of ["新的情节内容", "两人走进了房间", "阿铁、小美", "昨天"]) {
  console.log(`  ${JSON.stringify(body)} thin=${S.isThinColumnBody("【近期情节】", body)}`);
}
console.log("  hard fact single char '火' thin=", S.isThinColumnBody("【硬事实】", "火"));

/* ---- C. weighted budget allocation ---- */
line("C. planSectionTokenAllocations weighting");
const secs = [
  { text: "A".repeat(400), index: 0, priority: 90 },
  { text: "B".repeat(400), index: 1, priority: 10 },
];
for (const budget of [200, 500, 800]) {
  const alloc = S.planSectionTokenAllocations(secs, budget, counter);
  console.log(`  budget=${budget} -> ${JSON.stringify([...alloc.entries()])}`);
}

/* ---- D. soft trim ---- */
line("D. ContextEngine.compress (positional, correct order)");
const mem = new S.MemoryEngine();
const ctx = new S.ContextEngine(mem, {});
const sys =
  "长期记忆摘要（请遵守其中已发生的事实）：\n" +
  "甲".repeat(500) +
  "\n\n【历史后指令】请在回复时优先遵守：\n" +
  "乙".repeat(200) +
  "\n\n" +
  "你是角色扮演 AI。".repeat(10);
const messages = [{ role: "system", content: sys }, { role: "user", content: "hi" }];
console.log("  original total tokens:", S.countMessages(messages, counter));
for (const cap of [1000, 600, 300, 100, 30]) {
  const r = ctx.compress(messages, cap, 512, counter, null, {});
  const total = S.countMessages(r.messages, counter);
  console.log(
    `  cap=${String(cap).padStart(4)} -> total=${String(total).padStart(4)} ${total > cap ? "OVER" : "ok"} sections=${r.systemSections.length} hasSystem=${r.messages[0]?.role === "system"}`,
  );
}

/* ---- E. depth insert fix ---- */
line("E. insertAtDepth multi-insert ordering");
const history = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `u${i}` }));
const inserts = [
  { role: "system", content: "DEEP-5", depth: 5, label: "d5" },
  { role: "system", content: "DEEP-1", depth: 1, label: "d1" },
  { role: "system", content: "DEEP-0", depth: 0, label: "d0" },
];
const out = S.insertAtDepth(history, inserts);
console.log("  " + out.map((m) => m.content).join(" | "));

/* ---- F. headTailClip via section trimming ---- */
line("F. small-budget headTail behaviour (indirect)");
const { clipTextToTokenCap } = S;
const longText = "丙".repeat(500);
console.log(
  "  cap=10 ->",
  JSON.stringify(clipTextToTokenCap(longText, 10, counter, (t, m) => t.slice(0, m))),
);

/* ---- G. full prepare ---- */
line("G. CogniStackEngine.prepare end-to-end");
const dialogue = [
  { id: "m1", role: "user", content: "你好" },
  { id: "m2", role: "assistant", content: "你好，我是阿铁。" },
  { id: "m3", role: "user", content: "帮我看一下这台机器的显卡" },
  { id: "m4", role: "assistant", content: "RTX 5070 Laptop，8GB 显存。" },
  { id: "m5", role: "user", content: "能装多少上下文" },
  { id: "m6", role: "assistant", content: "要看量化精度，先跑一次再说。" },
];
const engine = new S.CogniStackEngine({
  collaborators: { lore: hostLore("显卡") },
  systemRules: "RULE",
});
const res = engine.prepare({
  card: { name: "阿铁", description: "一个住在机房里的技术搭子", personality: "直接、务实", scenario: "深夜的机房" },
  dialogue,
  pairBatchSize: 2,
  tokenCounter: counter,
  contextTokenLimit: 400,
  memory: { contextTriggerRatio: 0.7 },
  worldEntries: [
    { id: "w1", name: "显卡", keys: ["显卡", "上下文"], content: "RTX 5070 Laptop 8GB", enabled: true, constant: false, insertionOrder: 0 },
  ],
});
console.log("  mode:", res.mode, "| steps:", res.steps.join(" -> "));
console.log("  roles:", JSON.stringify(res.messages.map((m) => m.role)));
console.log("  promptTokens:", res.promptTokens, "| softTrimCap:", res.budget.softTrimTokenCap, "| hardFit:", res.budget.hardFit);
console.log("  memory:", JSON.stringify(res.memory));
console.log("  toSummarize:", JSON.stringify(res.toSummarize.map((m) => m.id)), "pairs:", res.toSummarizePairCount);
console.log("  lore:", JSON.stringify(res.loreInjected));
console.log("  warnings:", JSON.stringify(res.warnings));
console.log("  counter:", JSON.stringify(res.diagnostics.counter));
console.log("  system head:", JSON.stringify((res.messages[0]?.content || "").slice(0, 120)));

line("G2. softTrimOff still hard-fits");
const hard = engine.prepare({
  card: { name: "阿铁", description: "设定".repeat(400) },
  dialogue,
  pairBatchSize: 2,
  tokenCounter: counter,
  contextTokenLimit: 400,
  memory: { softTrimOff: true },
  cacheScope: "hard",
});
console.log("  promptTokens:", hard.promptTokens, "hardFit:", hard.budget.hardFit, "fits:", hard.promptTokens <= hard.budget.hardFit);

line("G3. status mode");
const st = engine.prepare({
  card: { name: "阿铁" },
  dialogue,
  pairBatchSize: 2,
  tokenCounter: counter,
  contextTokenLimit: 400,
  mode: "status",
  priorAssembledPromptTokens: 300,
});
console.log("  messages:", st.messages.length, "shouldSummarize:", st.memory.shouldSummarize, "reason:", st.memory.compressReason);
console.log("  toSummarizePairCount:", st.toSummarizePairCount, "next:", st.nextSummarizedCount, st.nextSummarizedThroughMessageId);
