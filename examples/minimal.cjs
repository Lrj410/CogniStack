/**
 * Minimal consumer example — run after `npm run build`:
 *
 *   node examples/minimal.cjs
 */
const {
  CogniStackEngine,
  exactCharTokenCounter,
} = require("../dist/index.js");

const counter = exactCharTokenCounter();

const lore = {
  selectEntries(entries, scanText) {
    return entries.filter(
      (e) =>
        e.enabled !== false &&
        (e.constant || (e.keys || []).some((k) => String(scanText).includes(k))),
    );
  },
};

const engine = new CogniStackEngine({
  systemRules: "回答准确、简洁；不确定时说明假设。",
  collaborators: { lore },
  maxLoreEntries: 8,
});

const result = engine.prepare({
  profile: {
    name: "阿铁",
    description: "机房运维助手。我是{{char}}。",
  },
  dialogue: [
    { id: "1", role: "user", content: "你好" },
    { id: "2", role: "assistant", content: "你好。" },
    { id: "3", role: "user", content: "显卡型号？" },
    { id: "4", role: "assistant", content: "先看机器配置。" },
  ],
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
  contextTokenLimit: 2048,
  completionReserveTokens: 256,
  tokenCounter: counter,
  cacheScope: "demo",
});

console.log("messages:", result.messages.length);
console.log("promptTokens:", result.promptTokens);
console.log("lore:", result.loreInjected);
console.log("shouldSummarize:", result.memory.shouldSummarize);
console.log("system head:", (result.messages[0]?.content || "").slice(0, 160));
