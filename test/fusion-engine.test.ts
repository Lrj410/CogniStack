import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CogniStackEngine,
  createCogniStackEngine,
  resolveBudget,
  countMessages,
  exactCharTokenCounter,
  defaultCompressPolicy,
  collectTextsForTokenHydrate,
} from "../src/index";
import { defaultMacroBinder } from "../src/defaults";
import { EMPTY_FRAGMENTS } from "../src/ports";
import type {
  DialogueMessage,
  MemoryCompressPolicy,
  RegexScriptLike,
  TokenCounter,
  WorldBookEntryLike,
} from "../src/types";

const counter = exactCharTokenCounter();

/** 宿主侧的世界书实现 —— 领域逻辑住在引擎外面，通过协议接入。 */
function makeHostLore(match: string) {
  return {
    selectEntries(entries: WorldBookEntryLike[]) {
      return entries.filter((e) => e.enabled !== false && (e.constant || e.keys.includes(match)));
    },
  };
}



const dialogue: DialogueMessage[] = [
  { id: "m1", role: "user", content: "你好" },
  { id: "m2", role: "assistant", content: "你好，我是阿铁。" },
  { id: "m3", role: "user", content: "帮我看一下这台机器的显卡" },
  { id: "m4", role: "assistant", content: "RTX 5070 Laptop，8GB 显存。" },
  { id: "m5", role: "user", content: "能装多少上下文" },
  { id: "m6", role: "assistant", content: "要看量化精度，先跑一次再说。" },
];

function baseInput(over: Partial<Parameters<CogniStackEngine["prepare"]>[0]> = {}) {
  return {
    card: { name: "阿铁", description: "一个住在机房里的技术搭子", personality: "直接", scenario: "深夜机房" },
    dialogue,
    pairBatchSize: 2,
    tokenCounter: counter,
    ...over,
  };
}

/** Same shape, but big enough that the resolved budget actually bites. */
function inflated(over: Partial<Parameters<CogniStackEngine["prepare"]>[0]> = {}) {
  return baseInput({
    card: { name: "阿铁", description: "设定".repeat(400) },
    cacheScope: "inflated",
    ...over,
  });
}

describe("resolveBudget (pure)", () => {
  it("disables soft trim when n_ctx is unknown", () => {
    const b = resolveBudget(defaultCompressPolicy(10), { mode: "generate" });
    assert.equal(b.softTrimEnabled, false);
    assert.equal(b.softTrimTokenCap, 0);
    assert.ok(b.warnings.includes("budget-missing-context-limit"));
  });

  it("infers n_ctx from totalPromptCharCap when contextCharLimit is missing", () => {
    const b = resolveBudget(defaultCompressPolicy(10, { totalPromptCharCap: 4096 }), {
      mode: "generate",
    });
    assert.equal(b.contextLimit, 4096);
    assert.equal(b.softTrimEnabled, true);
    assert.ok(b.hardFit > 0 && b.hardFit < 4096);
    assert.ok(b.warnings.some((w) => w.startsWith("context-limit-inferred-from-prompt-cap")));
  });

  it("defaults soft trim under hardFit with adaptive pad on small n_ctx", () => {
    const b = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 1000 }), {
      mode: "generate",
    });
    // pad=128, template=32 → hardFit = 1000-128-32 = 840; soft = min(950, 840)
    assert.equal(b.safetyPad, 128);
    assert.equal(b.templateOverhead, 32);
    assert.equal(b.hardFit, 840);
    assert.equal(b.softTrimTokenCap, 840);
  });

  it("never lets the completion reserve eat more than 75% of n_ctx", () => {
    const b = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 1000 }), {
      mode: "generate",
      completionReserveTokens: 99999,
    });
    // reservedFixed = 128+32; floor=250 → reserve = 1000-250-160 = 590
    assert.equal(b.completionReserve, 1000 - 250 - 128 - 32);
    assert.ok(b.warnings.some((w) => w.startsWith("completion-reserve-clamped")));
  });

  it("honours an explicit cap but still clamps it to hardFit", () => {
    const b = resolveBudget(
      defaultCompressPolicy(10, { contextCharLimit: 1000, totalPromptCharCap: 2000 }),
      { mode: "generate" },
    );
    assert.equal(b.softTrimTokenCap, 840);
    assert.ok(b.warnings.some((w) => w.startsWith("soft-trim-clamped")));
  });

  it("respects softTrimOff", () => {
    const b = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 1000, softTrimOff: true }), {
      mode: "generate",
    });
    assert.equal(b.softTrimEnabled, false);
  });

  it("does not soft-trim in status mode", () => {
    const p = { ...defaultCompressPolicy(10, { contextCharLimit: 1000 }) };
    assert.equal(resolveBudget(p, { mode: "status" }).softTrimEnabled, false);
  });

  it("accepts a custom soft-trim ratio", () => {
    const b = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 1000 }), {
      mode: "generate",
      softTrimRatio: 0.5,
    });
    assert.equal(b.softTrimTokenCap, 500);
  });

  it("uses a larger pad on 4096 than on large windows", () => {
    const small = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 4096 }), {
      mode: "generate",
    });
    const large = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 32768 }), {
      mode: "generate",
    });
    assert.ok(small.safetyPad >= 128);
    assert.ok(small.hardFit < 4096 - 64);
    assert.ok(large.safetyPad <= small.safetyPad);
  });
});

describe("CogniStackEngine.prepare — generate", () => {
  const engine = new CogniStackEngine({ systemRules: "RULE" });

  it("produces a system message plus the full dialogue window", () => {
    const r = engine.prepare(baseInput());
    assert.equal(r.messages[0]!.role, "system");
    assert.equal(r.messages.filter((m) => m.role !== "system").length, 6);
    assert.equal(r.mode, "generate");
  });

  it("fits the prompt inside the resolved soft-trim cap", () => {
    const r = engine.prepare(baseInput({ contextTokenLimit: 400 }));
    const cap = r.budget.softTrimTokenCap;
    assert.ok(cap > 0, "a cap should have been resolved");
    assert.ok(r.promptTokens <= cap, `${r.promptTokens} > ${cap}`);
  });

  it("never exceeds hardFit on 4096 / 8192 windows (small-ctx invariant)", () => {
    for (const nCtx of [2048, 4096, 8192]) {
      const r = engine.prepare(
        inflated({
          contextTokenLimit: nCtx,
          completionReserveTokens: Math.floor(nCtx * 0.125),
          cacheScope: `small-ctx-${nCtx}`,
          card: {
            name: "阿铁",
            description: "设定".repeat(2000),
            personality: "性格".repeat(800),
            scenario: "场景".repeat(800),
            system_prompt: "系统".repeat(600),
          },
          vectorHits: Array.from({ length: 8 }, (_, i) => ({
            name: `v${i}`,
            content: "向量召回".repeat(200),
          })),
        }),
      );
      assert.ok(r.budget.hardFit > 0, `n_ctx=${nCtx} hardFit`);
      assert.ok(
        r.promptTokens <= r.budget.hardFit,
        `n_ctx=${nCtx}: ${r.promptTokens} > hardFit ${r.budget.hardFit}`,
      );
      assert.equal(r.diagnostics.stages.fitsHardFit, true);
      assert.ok(r.promptTokens < nCtx, `must leave room under raw n_ctx=${nCtx}`);
    }
  });

  it("still hard-fits when host only passes softTrimTokenCap (no contextTokenLimit)", () => {
    const r = engine.prepare(
      inflated({
        softTrimTokenCap: 4096,
        cacheScope: "infer-ctx",
        card: { name: "阿铁", description: "设定".repeat(3000) },
      }),
    );
    assert.equal(r.budget.contextLimit, 4096);
    assert.ok(r.promptTokens <= r.budget.hardFit);
    assert.equal(r.diagnostics.stages.fitsHardFit, true);
  });

  it("reports the real prompt size, not an estimate", () => {
    const r = engine.prepare(baseInput());
    assert.equal(r.promptTokens, countMessages(r.messages, counter));
    assert.equal(r.promptChars, r.messages.reduce((n, m) => n + m.content.length, 0));
  });

  it("flags a trimmed prompt instead of hiding it", () => {
    const r = engine.prepare(inflated({ contextTokenLimit: 400 }));
    assert.ok(
      r.warnings.some((w) => w.startsWith("prompt-budget-trimmed")),
      r.warnings.join("|"),
    );
    assert.equal(r.diagnostics.stages.softTrimmed, true);
  });

  it("triggers on the context threshold when the prompt fills n_ctx", () => {
    const r = engine.prepare(inflated({ contextTokenLimit: 400 }));
    assert.equal(r.memory.compressReason, "context");
    assert.equal(r.memory.shouldSummarize, true);
    // Context trigger takes the whole pending batch so compress fires now.
    assert.equal(r.toSummarizePairCount, 3);
    assert.equal(r.nextSummarizedThroughMessageId, "m6");
    assert.equal(r.nextSummarizedCount, 6);
  });

  it("triggers on pair count when there is still room", () => {
    const r = engine.prepare(baseInput({ contextTokenLimit: 100_000, cacheScope: "batch" }));
    assert.equal(r.memory.compressReason, "batch");
    // pairBatchSize = 2, so only two complete pairs move to the summarizer.
    assert.equal(r.toSummarizePairCount, 2);
    assert.equal(r.nextSummarizedThroughMessageId, "m4");
    assert.equal(r.nextSummarizedCount, 4);
  });

  it("keeps every distinct string tokenized at most once per pass", () => {
    const r = engine.prepare(baseInput({ contextTokenLimit: 400 }));
    const { hits, misses, distinct } = r.diagnostics.counter;
    assert.ok(distinct > 0);
    assert.equal(distinct, misses);
    assert.ok(hits > 0, "memoization should be doing work");
  });

  it("injects committed summary blocks into the system prompt", () => {
    const r = engine.prepare(
      baseInput({
        summaryBlocks: [
          {
            id: "b1",
            text: "【硬事实】会话已经开始\n【时间线】无\n【关系与称呼】无\n【未决】无\n【近期情节】无",
            throughMessageId: "m2",
          },
        ],
        summarizedThroughMessageId: "m2",
      }),
    );
    assert.ok(r.messages[0]!.content.includes("会话已经开始"));
    assert.equal(r.memory.watermarkEnd, 1);
  });
});

describe("CogniStackEngine.prepare — modes", () => {
  const engine = new CogniStackEngine({ systemRules: "RULE" });

  it("status mode assembles nothing but still decides compression", () => {
    const r = engine.prepare(
      baseInput({ mode: "status", contextTokenLimit: 400, priorAssembledPromptTokens: 3000 }),
    );
    assert.equal(r.messages.length, 0);
    assert.equal(r.memory.shouldSummarize, true);
  });

  it("legacy mode plan is coerced to generate with a warning", () => {
    const r = engine.prepare(
      inflated({ mode: "plan" as "generate", contextTokenLimit: 400, cacheScope: "legacy-plan" }),
    );
    assert.equal(r.mode, "generate");
    assert.ok(r.warnings.includes("mode-plan-removed"));
    assert.ok(r.promptTokens <= r.budget.hardFit);
  });

  it("does not share an assemble cache across scopes", () => {
    const a = engine.prepare(baseInput({ cacheScope: "chatA" }));
    const b = engine.prepare(baseInput({ cacheScope: "chatA" }));
    const c = engine.prepare(baseInput({ cacheScope: "chatB" }));
    assert.equal(a.diagnostics.stages.assembleCacheHit, false);
    assert.equal(b.diagnostics.stages.assembleCacheHit, true);
    assert.equal(c.diagnostics.stages.assembleCacheHit, false);
  });
});

describe("CogniStackEngine — lore + memory cooperation", () => {
  const hostLore = makeHostLore("显卡");
  const engine = new CogniStackEngine({
    systemRules: "RULE",
    collaborators: { lore: hostLore },
  });
  const entries: WorldBookEntryLike[] = [
    {
      id: "w1",
      name: "显卡",
      keys: ["显卡"],
      content: "RTX 5070 Laptop 8GB",
      enabled: true,
      constant: false,
      insertionOrder: 0,
    },
    {
      id: "w2",
      name: "无关",
      keys: ["绝不可能出现的关键词"],
      content: "never",
      enabled: true,
      constant: false,
      insertionOrder: 1,
    },
  ];

  it("injects only entries whose keys appear in the scan text", () => {
    const r = engine.prepare(baseInput({ worldEntries: entries }));
    assert.deepEqual(r.loreInjected.map((e) => e.id), ["w1"]);
    assert.ok(r.messages[0]!.content.includes("RTX 5070 Laptop 8GB"));
  });

  it("warns when lore is configured but nothing matched", () => {
    const r = engine.prepare(
      baseInput({ worldEntries: [entries[1]!], cacheScope: "nolore" }),
    );
    assert.ok(r.warnings.includes("world-book-no-hit"));
  });

  it("skips lore entirely when disabled", () => {
    const r = engine.prepare(baseInput({ worldEntries: entries, worldBookEnabled: false, cacheScope: "off" }));
    assert.deepEqual(r.loreInjected, []);
  });

  it("caps lore injection at maxLoreEntries", () => {
    const many: WorldBookEntryLike[] = Array.from({ length: 30 }, (_, i) => ({
      id: `k${i}`,
      name: `条目${i}`,
      keys: ["显卡"],
      content: `内容${i}`,
      enabled: true,
      constant: false,
      insertionOrder: i,
    }));
    const small = new CogniStackEngine({ systemRules: "RULE", collaborators: { lore: hostLore }, maxLoreEntries: 5 });
    const r = small.prepare(baseInput({ worldEntries: many, cacheScope: "cap" }));
    assert.equal(r.loreInjected.length, 5);
    assert.ok(r.warnings.some((w) => w.startsWith("lore-capped")));
    assert.ok(r.warnings.some((w) => w.startsWith("world-book-capped")));
  });

  it("does not emit capped warnings when lore is under the limit", () => {
    const r = engine.prepare(baseInput({ worldEntries: [entries[0]!], cacheScope: "nocap" }));
    assert.ok(r.loreInjected.length >= 1);
    assert.ok(!r.warnings.some((w) => w.startsWith("lore-capped")));
    assert.ok(!r.warnings.some((w) => w.startsWith("world-book-capped")));
  });

  it("does not emit lore-no-hit for the empty default lore provider", () => {
    const bare = new CogniStackEngine({ systemRules: "RULE" });
    const r = bare.prepare(
      baseInput({ worldEntries: [entries[1]!], cacheScope: "default-lore-miss" }),
    );
    assert.equal(r.loreInjected.length, 0);
    assert.ok(!r.warnings.includes("lore-no-hit"));
    assert.ok(!r.warnings.includes("world-book-no-hit"));
  });
});

describe("CogniStackEngine — degradation is loud, never silent", () => {
  it("keeps the prompt usable when a collaborator throws", () => {
    const engine = new CogniStackEngine({
      systemRules: "RULE",
      collaborators: {
        lore: {
          selectEntries() {
            throw new Error("boom");
          },
        },
      },
    });
    const r = engine.prepare(baseInput({ worldEntries: [] }));
    assert.ok(
      r.warnings.some((w) => w.includes("lore-failed") || w.includes("world-book-failed")),
    );
    assert.ok(r.messages.length > 0);
    assert.equal(r.diagnostics.severity.isDegraded, false, "lore failure is not degraded");
  });

  it("marks an assemble failure as degraded", () => {
    const engine = new CogniStackEngine({
      systemRules: "RULE",
      collaborators: {
        macros: {
          resolveVars: defaultMacroBinder.resolveVars,
          bind() {
            throw new Error("boom");
          },
          scrub: defaultMacroBinder.scrub,
          formatMesExample: defaultMacroBinder.formatMesExample,
        },
      },
    });
    const r = engine.prepare(baseInput({ cacheScope: "degraded" }));
    assert.ok(r.warnings.some((w) => w.includes("degraded:assemble-failed")));
    assert.equal(r.diagnostics.severity.isDegraded, true);
  });
});

describe("CogniStackEngine — 接入协议与缓存", () => {
  it("connect() 接上端口并使缓存失效", () => {
    const engine = createCogniStackEngine({ systemRules: "RULE" });
    const before = engine.prepare(baseInput({ cacheScope: "w" }));
    engine.connect({ id: "lore-host", name: "设定宿主", provides: { lore: makeHostLore("显卡") } });
    const after = engine.prepare(
      baseInput({
        cacheScope: "w",
        worldEntries: [
          { id: "z", name: "z", keys: ["显卡"], content: "Z", enabled: true, constant: false, insertionOrder: 0 },
        ],
      }),
    );
    assert.notDeepEqual(before.loreInjected, after.loreInjected);
  });

  it("clearCache forces a rebuild", () => {
    const engine = createCogniStackEngine({ systemRules: "RULE" });
    engine.prepare(baseInput({ cacheScope: "c" }));
    engine.clearCache("c");
    const r = engine.prepare(baseInput({ cacheScope: "c" }));
    assert.equal(r.diagnostics.stages.assembleCacheHit, false);
  });
});

describe("CogniStackEngine — default ports produce a sane prompt", () => {
  it("binds {{char}} / {{user}} without any collaborator", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(
      baseInput({
        card: { name: "阿铁", description: "我是{{char}}，你叫{{user}}。" },
        cacheScope: "bind",
      }),
    );
    const sys = r.messages[0]!.content;
    assert.ok(sys.includes("我是阿铁"), sys.slice(0, 200));
    assert.ok(sys.includes("你叫你"), sys.slice(0, 200));
  });

  it("honours assemble section toggles", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(
      baseInput({
        assembleOptions: { includeDescription: false, includePersonality: false, includeScenario: false },
        cacheScope: "toggles",
      }),
    );
    const sys = r.messages[0]!.content;
    assert.ok(!sys.includes("角色设定：") && !sys.includes("档案设定："));
    assert.ok(!sys.includes("性格："));
  });

  it("applies preset fragments through the preset port", () => {
    const engine = new CogniStackEngine({
      systemRules: "RULE",
      collaborators: {
        preset: {
          resolve: () => ({
            ...EMPTY_FRAGMENTS,
            systemSuffix: ["CUSTOM_SUFFIX_MARKER"],
          }),
        },
      },
    });
    const r = engine.prepare(baseInput({ cacheScope: "preset" }));
    assert.ok(r.messages[0]!.content.includes("CUSTOM_SUFFIX_MARKER"));
  });
});

describe("CogniStackEngine — policy plumbing", () => {
  it("accepts the deprecated maxContextChars alias", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(
      baseInput({ maxContextChars: 250, cacheScope: "legacy" }),
    );
    assert.equal(r.budget.contextLimit, 250);
    assert.ok(r.promptTokens <= r.budget.hardFit);
  });

  it("surfaces the policy on the result so callers can log it", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(baseInput({ contextTokenLimit: 800, cacheScope: "log" }));
    assert.ok(r.budget.contextLimit === 800);
    // ≤4k windows use adaptive pad (≥128), not the legacy flat 64.
    assert.ok(r.budget.safetyPad >= 128);
    assert.ok(r.budget.templateOverhead >= 32);
  });

  it("a MemoryCompressPolicy round-trips through the engine", () => {
    const p: Partial<MemoryCompressPolicy> = { pairBatchSize: 3, overlapPairs: 2, maxBlocks: 2 };
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(baseInput({ memory: p, cacheScope: "rt" }));
    assert.equal(r.budget.policy.pairBatchSize, 3);
    assert.equal(r.budget.policy.overlapPairs, 2);
    assert.equal(r.budget.policy.maxBlocks, 2);
  });

  it("softTrimOff still hard-fits generate prompts under n_ctx", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(
      inflated({
        contextTokenLimit: 400,
        cacheScope: "hardfit",
        memory: { softTrimOff: true },
      }),
    );
    assert.equal(r.budget.softTrimEnabled, false);
    assert.ok(r.promptTokens <= r.budget.hardFit, `${r.promptTokens} vs hardFit ${r.budget.hardFit}`);
  });

  it("maxLoreEntries 0 injects none", () => {
    const many: WorldBookEntryLike[] = Array.from({ length: 5 }, (_, i) => ({
      id: `z${i}`,
      name: `条目${i}`,
      keys: ["显卡"],
      content: `内容${i}`,
      enabled: true,
      constant: false,
      insertionOrder: i,
    }));
    const zero = new CogniStackEngine({
      systemRules: "RULE",
      collaborators: { lore: makeHostLore("显卡") },
      maxLoreEntries: 0,
    });
    const r = zero.prepare(baseInput({ worldEntries: many, cacheScope: "lore0" }));
    assert.equal(r.loreInjected.length, 0);
  });

  it("middle edits miss the assemble cache", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const head = "H".repeat(48);
    const tail = "T".repeat(48);
    const midA = "A".repeat(40);
    const midB = "B".repeat(40);
    const a = engine.prepare(
      baseInput({
        cacheScope: "mid-edit",
        card: { name: "阿铁", description: head + midA + tail },
      }),
    );
    const b = engine.prepare(
      baseInput({
        cacheScope: "mid-edit",
        card: { name: "阿铁", description: head + midB + tail },
      }),
    );
    assert.equal(a.diagnostics.stages.assembleCacheHit, false);
    assert.equal(b.diagnostics.stages.assembleCacheHit, false);
    assert.ok(b.messages[0]!.content.includes(midB));
    assert.ok(!b.messages[0]!.content.includes(midA));
  });

  it("assemble cache returns a clone — mutating prepare output does not poison next hit", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const first = engine.prepare(
      baseInput({
        cacheScope: "poison",
        card: { name: "阿铁", description: "稳定设定用于缓存" },
      }),
    );
    assert.equal(first.diagnostics.stages.assembleCacheHit, false);
    const sys = first.messages.find((m) => m.role === "system");
    assert.ok(sys);
    sys!.content = "POISON";

    const second = engine.prepare(
      baseInput({
        cacheScope: "poison",
        card: { name: "阿铁", description: "稳定设定用于缓存" },
      }),
    );
    assert.equal(second.diagnostics.stages.assembleCacheHit, true);
    const sys2 = second.messages.find((m) => m.role === "system");
    assert.ok(sys2);
    assert.notEqual(sys2!.content, "POISON");
    assert.ok(sys2!.content.includes("稳定设定用于缓存") || sys2!.content.includes("阿铁"));
  });

  it("caller assembleOptions.maxLoreEntries cannot exceed engine hard cap", () => {
    const many: WorldBookEntryLike[] = Array.from({ length: 8 }, (_, i) => ({
      id: `cap${i}`,
      name: `条目${i}`,
      keys: ["显卡"],
      content: `内容${i}`.repeat(20),
      enabled: true,
      constant: true,
      insertionOrder: i,
    }));
    const engine = new CogniStackEngine({
      systemRules: "RULE",
      collaborators: { lore: makeHostLore("显卡") },
      maxLoreEntries: 2,
    });
    const r = engine.prepare(
      baseInput({
        worldEntries: many,
        cacheScope: "lore-hardcap",
        assembleOptions: { maxLoreEntries: 99 },
      }),
    );
    assert.ok(r.loreInjected.length <= 2, `got ${r.loreInjected.length}`);
  });

  it("pressure peel re-accounts so shouldSummarize matches post-peel size", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const bigVector = [{ name: "v", content: "V".repeat(2500) }];
    const r = engine.prepare(
      inflated({
        contextTokenLimit: 2000,
        cacheScope: "pressure-reaccount",
        vectorHits: bigVector,
        // Keep soft trim on so we exercise pressure before trim.
        memory: { softTrimOff: false },
      }),
    );
    // After peel, contextUsed should track the (smaller) assembled size used for trigger.
    assert.ok(
      typeof r.memory.contextUsed === "number" && r.memory.contextUsed > 0,
      "contextUsed present",
    );
    if (r.warnings.some((w) => w.startsWith("pressure-drop"))) {
      assert.ok(
        r.memory.contextUsed <= r.promptTokens + 500 || !r.memory.shouldSummarize,
        `post-pressure contextUsed=${r.memory.contextUsed} promptTokens=${r.promptTokens} shouldSummarize=${r.memory.shouldSummarize}`,
      );
    }
  });

  it("prepareLive restarts when ports are rewired mid-flight", async () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const loreA = makeHostLore("显卡");
    const loreB = {
      selectEntries(entries: WorldBookEntryLike[]) {
        return entries.filter((e) => e.enabled !== false && e.keys.includes("ZXQ_UNIQUE"));
      },
    };
    engine.connect({
      id: "wire-a",
      name: "A",
      kind: "service",
      provides: { lore: loreA },
    });

    const entries: WorldBookEntryLike[] = [
      {
        id: "e1",
        name: "显卡条",
        keys: ["显卡"],
        content: "显卡内容应出现",
        enabled: true,
        constant: false,
        insertionOrder: 0,
      },
      {
        id: "e2",
        name: "唯一条",
        keys: ["ZXQ_UNIQUE"],
        content: "唯一内容应出现",
        enabled: true,
        constant: true,
        insertionOrder: 1,
      },
    ];

    // Kick prepareLive, then rewire on the next tick so a checkpoint trips.
    const prep = engine.prepareLive(
      baseInput({
        worldEntries: entries,
        cacheScope: "wire-race",
        contextTokenLimit: 8192,
      }),
    );
    await new Promise<void>((r) => setImmediate(r));
    engine.connect({
      id: "wire-b",
      name: "B",
      kind: "service",
      provides: { lore: loreB },
    });
    const r = await prep;
    // Survived rewire (restarted); result is well-formed.
    assert.ok(Array.isArray(r.messages));
    assert.ok(r.promptTokens >= 0);
  });
});

/* ------------------------------------------------------------------ */
/* 回归：深度审查（第二轮）发现并修复的缺陷                              */
/* ------------------------------------------------------------------ */

describe("回归 — 无 id 的开场白不被重复注入", () => {
  it("watermarkEnd < 0 时 first_mes 只出现一次", () => {
    const engine = new CogniStackEngine();
    const r = engine.prepare({
      profile: { name: "U" },
      dialogue: [
        { role: "assistant", content: "GREETING_UNIQUE" },
        { id: "m1", role: "user", content: "u1" },
        { id: "m2", role: "assistant", content: "a1" },
      ],
      contextTokenLimit: 4096,
      tokenCounter: counter,
    });
    const hits = r.messages.filter((m) => String(m.content).includes("GREETING_UNIQUE")).length;
    assert.equal(
      hits,
      1,
      r.messages.map((m) => `${m.role}:${m.content}`).join(" | "),
    );
  });

  it("有水印时仍会补回被窗口漏掉的开场白", () => {
    const engine = new CogniStackEngine();
    const r = engine.prepare({
      profile: { name: "U" },
      dialogue: [
        { role: "assistant", content: "GREETING_UNIQUE" },
        { id: "m1", role: "user", content: "u1" },
        { id: "m2", role: "assistant", content: "a1" },
        { id: "m3", role: "user", content: "u2" },
        { id: "m4", role: "assistant", content: "a2" },
      ],
      summarizedThroughMessageId: "m2",
      contextTokenLimit: 4096,
      tokenCounter: counter,
    });
    const hits = r.messages.filter((m) => String(m.content).includes("GREETING_UNIQUE")).length;
    assert.equal(hits, 1, r.messages.map((m) => `${m.role}:${m.content}`).join(" | "));
  });
});

describe("回归 — 引擎不得污染调用方的 collaborators 对象", () => {
  it("构造 + wire() 之后调用方对象仍然为空", () => {
    const caller: Record<string, unknown> = {};
    const engine = new CogniStackEngine({ collaborators: caller as never });
    engine.wire({ lore: makeHostLore("x") });
    assert.deepEqual(Object.keys(caller), []);
  });
});

describe("回归 — 装配缓存键纳入 regex 脚本开关", () => {
  it("仅切换 enabled 也会重新装配，不返回被正则改写过的旧 prompt", () => {
    const regex = {
      applyMessages(
        messages: { role: string; content: string }[],
        scripts: RegexScriptLike[] | null | undefined,
      ) {
        const anyEnabled = (scripts ?? []).some((s) => s.enabled !== false);
        if (!anyEnabled) return messages;
        return messages.map((m) => ({
          role: m.role,
          content: m.content.replace(/ALPHA/g, "OMEGA"),
        }));
      },
    };
    const engine = new CogniStackEngine({ collaborators: { regex } });
    const input = (enabled: boolean) =>
      baseInput({
        cacheScope: "regex-flags",
        contextTokenLimit: 8192,
        dialogue: [
          { id: "m1", role: "user", content: "ALPHA 请求" },
          { id: "m2", role: "assistant", content: "ALPHA 回复" },
        ],
        regexScripts: [{ id: "r1", find: "ALPHA", replace: "OMEGA", enabled }],
      });

    const on = engine.prepare(input(true));
    assert.ok(on.messages.some((m) => String(m.content).includes("OMEGA")), "脚本启用 → 被改写");

    const off = engine.prepare(input(false));
    assert.ok(
      !off.messages.some((m) => String(m.content).includes("OMEGA")),
      off.messages.map((m) => `${m.role}:${m.content}`).join(" | "),
    );
  });
});

describe("回归 — token 预热接受首选别名", () => {
  it("profile / loreEntries 的内容也会进预热表", () => {
    const texts = collectTextsForTokenHydrate(
      baseInput({
        profile: { name: "阿铁", description: "CARD_DESC_UNIQUE" },
        loreEntries: [
          {
            id: "l1",
            name: "条",
            keys: ["x"],
            content: "LORE_UNIQUE",
            enabled: true,
            constant: true,
            insertionOrder: 0,
          },
        ],
      }),
    );
    const joined = texts.join("\n");
    assert.ok(joined.includes("CARD_DESC_UNIQUE"), "profile 字段应被预热");
    assert.ok(joined.includes("LORE_UNIQUE"), "loreEntries 内容应被预热");
  });
});

describe("回归 — 非数值 maxLoreEntries 不静默变成 0", () => {
  it("NaN 回退到引擎上限，而不是注入 0 条", () => {
    const engine = new CogniStackEngine({ collaborators: { lore: makeHostLore("显卡") } });
    const entries: WorldBookEntryLike[] = [
      {
        id: "e1",
        name: "卡",
        keys: ["显卡"],
        content: "显卡内容",
        enabled: true,
        constant: false,
        insertionOrder: 0,
      },
      {
        id: "e2",
        name: "卡2",
        keys: ["显卡"],
        content: "显卡内容 2",
        enabled: true,
        constant: false,
        insertionOrder: 1,
      },
    ];
    const r = engine.prepare(
      baseInput({
        worldEntries: entries,
        cacheScope: "lore-nan-cap",
        contextTokenLimit: 8192,
        assembleOptions: { maxLoreEntries: Number.NaN },
      }),
    );
    assert.ok(r.loreInjected.length > 0, `loreInjected=${r.loreInjected.length}`);
  });
});

describe("回归 — 退化 n_ctx 显式告警", () => {
  it("hardFit 过小时给出 hard-fit-degenerate", () => {
    const b = resolveBudget(defaultCompressPolicy(10, { contextCharLimit: 1 }), {
      mode: "generate",
    });
    assert.ok(
      b.warnings.some((w) => w.startsWith("hard-fit-degenerate")),
      b.warnings.join("|"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* prepareAsync — hydrate / hydrateOne / CACHE_MISS 重试               */
/* ------------------------------------------------------------------ */

describe("collectTextsForTokenHydrate — full vs status scope", () => {
  const input = {
    tokenCounter: counter,
    summary: "SUMMARY_UNIQUE",
    summaryBlocks: [{ id: "b1", text: "BLOCK_UNIQUE", throughMessageId: "m1" }],
    dialogue: [
      { id: "m1", role: "user", content: "DIALOGUE_UNIQUE" },
      { id: "m2", role: "assistant", content: "REPLY_UNIQUE" },
    ],
    profile: { name: "PROFILE_NAME_UNIQUE", description: "PROFILE_DESC_UNIQUE" },
    loreEntries: [
      {
        id: "l1",
        name: "LORE_NAME_UNIQUE",
        keys: ["k"],
        content: "LORE_CONTENT_UNIQUE",
        enabled: true,
        constant: true,
        insertionOrder: 0,
      },
    ],
    worldState: { entries: [{ key: "KEY_UNIQUE", value: "VALUE_UNIQUE" }] },
    vectorHits: [{ name: "VEC_NAME_UNIQUE", content: "VEC_CONTENT_UNIQUE" }],
  };

  it("status 只预热摘要 / 记忆块 / 对白", () => {
    const status = collectTextsForTokenHydrate(input, "status");
    assert.ok(status.includes("SUMMARY_UNIQUE"));
    assert.ok(status.includes("BLOCK_UNIQUE"));
    assert.ok(status.includes("DIALOGUE_UNIQUE"));
    assert.ok(!status.includes("PROFILE_DESC_UNIQUE"));
    assert.ok(!status.includes("LORE_CONTENT_UNIQUE"));
    assert.ok(!status.includes("VALUE_UNIQUE"));
  });

  it("full（默认）额外预热卡片 / lore / 世界状态 / 向量命中", () => {
    const full = collectTextsForTokenHydrate(input);
    assert.ok(full.includes("PROFILE_NAME_UNIQUE"));
    assert.ok(full.includes("PROFILE_DESC_UNIQUE"));
    assert.ok(full.includes("LORE_CONTENT_UNIQUE"));
    assert.ok(full.includes("VALUE_UNIQUE"));
    assert.ok(full.includes("VEC_CONTENT_UNIQUE"));
    assert.ok(full.length > collectTextsForTokenHydrate(input, "status").length);
  });
});

/* ------------------------------------------------------------------ */
/* 记忆块策略在引擎侧落地（G-33）+ 非 UA 角色告警                       */
/* ------------------------------------------------------------------ */

describe("memory policy — policy.maxBlocks 在引擎侧生效（G-33）", () => {
  function blocks(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      text: `【硬事实】事实${i}：${"内容".repeat(60)}\n【时间线】无\n【关系与称呼】无\n【未决】无\n【近期情节】无`,
      throughMessageId: "m6",
    }));
  }

  it("超过 maxBlocks → 返回合并后的视图，并给出可执行告警", () => {
    // Before: `result.summaryBlocks` came back untouched (20 in → 20 out), so a
    // host storing it as authoritative state grew the list without bound.
    const engine = new CogniStackEngine();
    const r = engine.prepare({ ...baseInput(), summaryBlocks: blocks(20) });
    assert.equal(r.summaryBlocks.length, r.budget.policy.maxBlocks);
    assert.ok(
      r.warnings.some((w) => w.startsWith("memory-blocks-compacted:20->")),
      r.warnings.join("|"),
    );
  });

  it("策略范围内不动：原样返回，也不报警", () => {
    const engine = new CogniStackEngine();
    const r = engine.prepare({ ...baseInput(), summaryBlocks: blocks(2) });
    assert.equal(r.summaryBlocks.length, 2);
    assert.ok(!r.warnings.some((w) => w.startsWith("memory-blocks-compacted")));
  });
});

describe("dialogue — 非 user/assistant 角色", () => {
  it("tool 等角色被丢弃时给出 degraded 告警，而不是静默忽略", () => {
    // Only `system` used to be reported. A library caller passing tool messages
    // got neither the content nor any signal that it had been ignored.
    const engine = new CogniStackEngine();
    const r = engine.prepare({
      ...baseInput(),
      dialogue: [
        { id: "m1", role: "user", content: "你好" },
        { id: "m2", role: "tool", content: '{"a":1}' },
        { id: "m3", role: "assistant", content: "好。" },
      ],
    });
    assert.ok(r.warnings.includes("dialogue-role-dropped:tool"), r.warnings.join("|"));
    assert.ok(r.diagnostics.severity.degraded.includes("dialogue-role-dropped:tool"));
  });
});

describe("CogniStackPrepareInput — 身份字段是「至少其一」", () => {
  it("既不给 profile 也不给 card：类型层拒绝（运行时同样抛）", () => {
    // The type used to be two independent optionals, so this compiled and then
    // threw at runtime. `@ts-expect-error` turns "the type must reject this" into
    // a build-time assertion — it fails typecheck if the union is ever loosened.
    const engine = new CogniStackEngine();
    const withoutIdentity = { dialogue, tokenCounter: counter };
    // @ts-expect-error — profile / card 至少要有其一
    assert.throws(() => engine.prepare(withoutIdentity));
  });

  it("只给 card（legacy）或 profile 仍然可用，两个都给也不报错", () => {
    const engine = new CogniStackEngine();
    assert.ok(engine.prepare({ card: { name: "阿铁" }, dialogue, tokenCounter: counter }).messages.length >= 0);
    assert.ok(engine.prepare({ profile: { name: "阿铁" }, dialogue, tokenCounter: counter }).messages.length >= 0);
    assert.ok(
      engine.prepare({
        profile: { name: "阿铁" },
        card: { name: "阿铁" },
        dialogue,
        tokenCounter: counter,
      }).messages.length >= 0,
    );
  });
});

describe("prepareAsync — hydrate 与 CACHE_MISS 重试", () => {
  const engine = new CogniStackEngine({ systemRules: "RULE" });

  it("先调用 hydrate 预热，再返回正常结果", async () => {
    const payloads: string[][] = [];
    const r = await engine.prepareAsync({
      ...baseInput({ cacheScope: "async-hydrate" }),
      hydrate: async (texts) => {
        payloads.push(texts);
      },
    });
    assert.ok(payloads.length >= 1, "hydrate 至少调用一次");
    assert.ok(payloads[0]!.some((t) => t === "你好"), "对白内容应进入预热表");
    assert.ok(r.messages.length > 0);
  });

  it("status mode 的 hydrate payload 不含卡片字段", async () => {
    const payloads: string[][] = [];
    await engine.prepareAsync({
      mode: "status",
      dialogue: [
        { id: "m1", role: "user", content: "D_UNIQUE" },
        { id: "m2", role: "assistant", content: "A_UNIQUE" },
      ],
      profile: { name: "阿铁", description: "CARD_DESC_UNIQUE_XYZ" },
      tokenCounter: counter,
      hydrate: async (texts) => {
        payloads.push(texts);
      },
    });
    const joined = payloads.flat().join("\n");
    assert.ok(joined.includes("D_UNIQUE"));
    assert.ok(!joined.includes("CARD_DESC_UNIQUE_XYZ"));
  });

  it("计数器抛 CACHE_MISS 时走 hydrateOne 重试并成功", async () => {
    const poison = "POISON_TOKEN_UNIQUE_9f3";
    let thrownOnce = false;
    const flakyCounter: TokenCounter = {
      count(text: string) {
        if (text === poison && !thrownOnce) {
          thrownOnce = true;
          const err = new Error("cache miss") as Error & { code: string; missText: string };
          err.code = "CACHE_MISS";
          err.missText = poison;
          throw err;
        }
        return text ? text.length : 0;
      },
    };
    const hydrateOneCalls: string[] = [];
    const r = await engine.prepareAsync({
      dialogue: [
        { id: "m1", role: "user", content: poison },
        { id: "m2", role: "assistant", content: "回复内容" },
      ],
      profile: { name: "阿铁" },
      pairBatchSize: 1,
      tokenCounter: flakyCounter,
      cacheScope: "cache-miss-retry",
      hydrate: async () => {},
      hydrateOne: async (text) => {
        hydrateOneCalls.push(text);
        return 0;
      },
    });
    assert.deepEqual(hydrateOneCalls, [poison]);
    assert.ok(r.messages.length > 0);
    assert.ok(
      r.messages.some((m) => String(m.content).includes(poison)),
      "重试后应正常产出包含该内容的 prompt",
    );
  });

  it("缺少 hydrate 时退化为同步 prepareLive 路径", async () => {
    const r = await engine.prepareAsync({
      ...baseInput({ cacheScope: "async-no-hydrate" }),
    });
    assert.equal(r.mode, "generate");
    assert.ok(r.messages.length > 0);
    assert.equal(r.promptTokens, countMessages(r.messages, counter));
  });
});
