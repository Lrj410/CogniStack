import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContextEngine, headTailClip, TRIM_NOTE } from "../src/context/ContextEngine";
import { insertAtDepth } from "../src/context/ContextAssembleEngine";
import {
  LORE_SLOT_ORDER,
  normalizeLoreSlot,
  normalizeWorldBookPosition,
  WORLD_BOOK_POSITION_ORDER,
} from "../src/context/lorePosition";
import {
  clipTextToTokenCap,
  planSectionTokenAllocations,
  sectionBudgetWeight,
} from "../src/context/sectionBudget";
import { buildLoreScanText, defaultLoreProvider, noopRegexApplier } from "../src/defaults";
import { countMessages, exactCharTokenCounter } from "../src/fusion/counter";
import { clipToTokens, fitMessagesUnderTokenCap } from "../src/fusion/fitMessages";
import { defaultCompressPolicy, MemoryEngine } from "../src/memory/MemoryEngine";
import { SECTION_PRIORITY, type DialogueMessage, type LoreSlot, type RpMessage, type SummaryBlock } from "../src/types";

const counter = exactCharTokenCounter();

function engine() {
  return new ContextEngine(new MemoryEngine(), {});
}

function longSystem(extra = ""): RpMessage[] {
  return [
    {
      role: "system",
      content: [
        "长期记忆摘要（请遵守其中已发生的事实）：",
        "甲".repeat(600),
        "",
        "【历史后指令】请在回复时优先遵守：",
        "乙".repeat(300),
        extra,
      ].join("\n"),
    },
    { role: "user", content: "u".repeat(20) },
    { role: "assistant", content: "a".repeat(20) },
  ];
}

describe("headTailClip (CogniStack fix)", () => {
  const text = "因".repeat(400);

  it("never exceeds the budget, no matter how small", () => {
    for (let max = 0; max <= 40; max += 1) {
      const out = headTailClip(text, max);
      assert.ok(out.length <= Math.max(0, max), `max=${max} gave ${out.length} chars`);
    }
  });

  it("returns the input untouched when it already fits", () => {
    assert.equal(headTailClip("短文本", 100), "短文本");
  });

  it("actually clips when the budget bites", () => {
    const out = headTailClip(text, 80);
    assert.ok(out.length <= 80);
    assert.ok(out.includes("…（中段已按预算省略）…"));
  });
});

describe("ContextEngine.compress", () => {
  it("fits every budget it is given — floor is the unsummarized dialogue", () => {
    // Soft trim shrinks the system, it never drops dialogue. So when the
    // dialogue alone busts the cap the honest floor is dialogueTokens, and the
    // caller is expected to run fitMessagesUnderTokenCap afterwards (which is
    // exactly what CogniStackEngine.prepare does in its emergency gate).
    const ctx = engine();
    const messages = longSystem("你是角色扮演 AI。".repeat(20));
    const dialogueTokens = countMessages(
      messages.filter((m) => m.role !== "system"),
      counter,
    );
    for (const cap of [2000, 1200, 800, 400, 200, 120, 60, 30]) {
      const r = ctx.compress(messages, { tokenCounter: counter, maxTokens: cap });
      const total = countMessages(r.messages, counter);
      assert.ok(
        total <= Math.max(cap, dialogueTokens),
        `cap=${cap} gave ${total} tokens (dialogue floor ${dialogueTokens})`,
      );
    }
  });

  it("shrinks the system as far as it can before giving up", () => {
    const ctx = engine();
    const messages = longSystem("你是角色扮演 AI。".repeat(20));
    const r = ctx.compress(messages, { tokenCounter: counter, maxTokens: 120 });
    // 40 tokens of dialogue + at most 80 of system
    assert.ok(countMessages(r.messages, counter) <= 120);
  });

  it("never drops unsummarized dialogue", () => {
    const ctx = engine();
    const messages = longSystem();
    const dialogueBefore = messages.filter((m) => m.role !== "system").length;
    const r = ctx.compress(messages, { tokenCounter: counter, maxTokens: 200 });
    const dialogueAfter = r.messages.filter((m) => m.role !== "system").length;
    assert.equal(dialogueAfter, dialogueBefore);
  });

  it("passes through untouched when already under budget", () => {
    const ctx = engine();
    const messages: RpMessage[] = [
      { role: "system", content: "s".repeat(50) },
      { role: "user", content: "u".repeat(10) },
    ];
    const r = ctx.compress(messages, { tokenCounter: counter, maxTokens: 500 });
    assert.deepEqual(r.messages, messages);
  });

  it("still supports the deprecated positional call order", () => {
    const ctx = engine();
    const r = ctx.compress(longSystem(), 300, 512, counter, null, {});
    assert.ok(countMessages(r.messages, counter) <= 300);
  });

  it("refuses to work without a real TokenCounter", () => {
    const ctx = engine();
    assert.throws(
      () => ctx.compress(longSystem(), { maxTokens: 100 }),
      /TokenCounter/,
    );
  });

  it("keeps high-priority post-history instructions longer than generic rules", () => {
    const ctx = engine();
    const sections = [
      { text: "你是角色扮演 AI。" + "规则".repeat(100), priority: SECTION_PRIORITY.systemRules },
      { text: "【历史后指令】" + "指令".repeat(100), priority: SECTION_PRIORITY.postHistory },
    ];
    const messages: RpMessage[] = [
      { role: "system", content: sections.map((s) => s.text).join("\n\n") },
    ];
    const r = ctx.compress(messages, { tokenCounter: counter, maxTokens: 200, sections });
    const out = r.messages[0]?.content ?? "";
    assert.ok(out.includes("历史后指令"), "post-history should survive the squeeze");
  });
});

describe("planSectionTokenAllocations", () => {
  const sections = [
    { text: "A".repeat(400), index: 0, priority: SECTION_PRIORITY.postHistory },
    { text: "B".repeat(400), index: 1, priority: SECTION_PRIORITY.systemRules },
  ];

  it("never allocates more than the budget", () => {
    for (const budget of [10, 100, 300, 500, 800, 2000]) {
      const alloc = planSectionTokenAllocations(sections, budget, counter);
      const total = [...alloc.values()].reduce((n, v) => n + v, 0);
      assert.ok(total <= budget, `budget=${budget} allocated ${total}`);
    }
  });

  it("never allocates more than a section's natural size", () => {
    const alloc = planSectionTokenAllocations(sections, 500, counter);
    assert.ok((alloc.get(0) ?? 0) <= 400);
    assert.ok((alloc.get(1) ?? 0) <= 400);
  });

  it("favours higher priority", () => {
    const alloc = planSectionTokenAllocations(sections, 200, counter);
    assert.ok((alloc.get(0) ?? 0) > (alloc.get(1) ?? 0));
  });

  it("returns an empty map for a zero budget", () => {
    assert.equal(planSectionTokenAllocations(sections, 0, counter).size, 0);
  });

  it("weights are monotonic in priority", () => {
    assert.ok(sectionBudgetWeight(90) > sectionBudgetWeight(50));
    assert.ok(sectionBudgetWeight(50) > sectionBudgetWeight(10));
  });
});

describe("clipTextToTokenCap", () => {
  it("returns something no longer than the cap allows", () => {
    const out = clipTextToTokenCap("丙".repeat(400), 40, counter, (t, n) => t.slice(0, n));
    assert.ok(counter.count(out) <= 40);
  });

  it("returns empty for a non-positive cap", () => {
    assert.equal(clipTextToTokenCap("丙".repeat(50), 0, counter, (t, n) => t.slice(0, n)), "");
  });
});

describe("fitMessagesUnderTokenCap", () => {
  const messages: RpMessage[] = [
    { role: "system", content: "S".repeat(100) },
    ...Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i} `.repeat(20),
    })),
  ];

  it("reports dropped = 0 when the input already fits", () => {
    const r = fitMessagesUnderTokenCap(messages, 100000, counter);
    assert.equal(r.dropped, 0);
    assert.equal(r.messages.length, messages.length);
  });

  it("brings the list under the cap", () => {
    for (const cap of [500, 300, 150, 80, 40, 20]) {
      const r = fitMessagesUnderTokenCap(messages, cap, counter);
      assert.ok(countMessages(r.messages, counter) <= cap, `cap=${cap} exceeded`);
    }
  });

  it("counts a real change as dropped, not every pass", () => {
    const r = fitMessagesUnderTokenCap(messages, 200, counter);
    assert.ok(r.dropped > 0);
  });

  it("survives a system-only prompt", () => {
    const only: RpMessage[] = [{ role: "system", content: "S".repeat(500) }];
    const r = fitMessagesUnderTokenCap(only, 100, counter);
    assert.ok(countMessages(r.messages, counter) <= 100);
  });
});

describe("clipToTokens", () => {
  it("respects the token cap and appends an ellipsis when there is room", () => {
    const out = clipToTokens("话".repeat(100), 20, counter);
    assert.ok(counter.count(out) <= 20);
    assert.ok(out.endsWith("…"));
  });

  it("falls back to a bare prefix when the cap cannot afford an ellipsis", () => {
    const out = clipToTokens("话".repeat(100), 1, counter);
    assert.ok(counter.count(out) <= 1);
    assert.ok(!out.includes("…"));
  });
});

describe("default ports", () => {
  it("defaultLoreProvider is a no-op — lore is domain logic, not a base service", () => {
    // 引擎不再内置任何世界书选择逻辑：领域实现必须通过接入协议由宿主提供。
    const entries = [
      { id: "1", name: "always", keys: [], content: "c", enabled: true, constant: true, insertionOrder: 0 },
      { id: "2", name: "keyed", keys: ["显卡"], content: "k", enabled: true, constant: false, insertionOrder: 1 },
    ];
    assert.deepEqual(defaultLoreProvider.selectEntries(entries, "这台机器的显卡是 5070"), []);
  });

  it("noopRegexApplier is identity", () => {
    assert.deepEqual(noopRegexApplier.applyMessages([{ role: "user", content: "x" }], []), [
      { role: "user", content: "x" },
    ]);
  });

  it("buildLoreScanText is tail-biased", () => {
    const out = buildLoreScanText({ headText: "HEAD", rawTail: "tail line", maxChars: 100 });
    assert.ok(out.startsWith("HEAD"));
    assert.ok(out.endsWith("tail line"));
  });

  it("clamps a tiny maxChars up to its 200-char floor", () => {
    // The source (and this port) refuse to scan fewer than 200 chars, otherwise
    // a single short lore key would dominate the whole corpus.
    const out = buildLoreScanText({ rawTail: "x".repeat(500), maxChars: 10 });
    assert.equal(out.length, 200);
  });

  it("keeps the newest end of an oversized tail", () => {
    const tail = "x".repeat(2000) + "END";
    const out = buildLoreScanText({ rawTail: tail, maxChars: 500 });
    assert.equal(out.length, 500);
    assert.ok(out.endsWith("END"));
  });
});

describe("TRIM_NOTE round-trip", () => {
  it("is stripped by the documented helper", () => {
    const blocks: SummaryBlock[] = [{ id: "b", text: "x", throughMessageId: "m" }];
    assert.equal(blocks.length, 1);
    const body = `${TRIM_NOTE}body`;
    assert.ok(body.startsWith(TRIM_NOTE));
  });
});

describe("ContextAssembleEngine clip budget (CogniStack fix)", () => {
  it("never exceeds the persona / lore char cap including the marker", async () => {
    const { ContextAssembleEngine } = await import("../src/context/ContextAssembleEngine");
    const { defaultCardResolver, defaultMacroBinder } = await import("../src/defaults");
    const asm = new ContextAssembleEngine({
      card: defaultCardResolver,
      macros: defaultMacroBinder,
    });
    const r = asm.assemble({
      card: { name: "阿铁", description: "d" },
      recentMessages: [],
      personaBio: "人设".repeat(500),
      selectedLore: [
        {
          id: "l1",
          name: "长条目",
          keys: ["k"],
          content: "世界".repeat(500),
          enabled: true,
          constant: true,
          insertionOrder: 0,
        },
      ],
      limits: { personaChars: 200, loreEntryChars: 200 },
      systemRules: "RULE",
    });
    const marker = "\n…（已按预算截断）";
    for (const s of r.systemSections) {
      if (!s.text.includes(marker.trim())) continue;
      // Any section that carries the clip marker must itself be ≤ its cap.
      // Persona/lore caps were both 200 in this call.
      assert.ok(
        s.text.length <= 200 + 40,
        `clipped section still huge: ${s.text.length}`,
      );
    }
    assert.ok(
      r.notes.some((n) => n.startsWith("lore-trimmed:") || n.startsWith("persona-trimmed")),
      `expected trim notes, got ${r.notes.join(",")}`,
    );
  });
});

describe("ContextEngine.status — adaptivePairBatchSize (U-06)", () => {
  const ctx = new ContextEngine(new MemoryEngine(), {});
  const dialogue: DialogueMessage[] = [
    { id: "m1", role: "user", content: "u1" },
    { id: "m2", role: "assistant", content: "a1" },
    { id: "m3", role: "user", content: "u2" },
    { id: "m4", role: "assistant", content: "a2" },
    { id: "m5", role: "user", content: "u3" },
    { id: "m6", role: "assistant", content: "a3" },
  ];
  const policy = defaultCompressPolicy(10, { contextCharLimit: 1000, contextTriggerRatio: 1 });

  function sizeAt(assembled: number): number {
    const s = ctx.status({
      dialogue,
      summarizedCount: 0,
      policy,
      tokenCounter: counter,
      assembledPromptTokens: assembled,
    });
    return s.adaptivePairBatchSize ?? policy.pairBatchSize;
  }

  it("上下文充裕时保持 N 不变", () => {
    assert.equal(sizeAt(400), 10); // fill 0.4
  });

  it("随上下文压力单调不增且有界 [1, N]", () => {
    const fills = [100, 400, 600, 700, 750, 800, 900, 950, 5000];
    const sizes = fills.map(sizeAt);
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(sizes[i]! <= sizes[i - 1]!, `fill index ${i}: ${sizes[i]} > ${sizes[i - 1]}`);
    }
    for (const s of sizes) assert.ok(s >= 1 && s <= policy.pairBatchSize, `out of bounds: ${s}`);
  });

  it("填满阈值 ≥90% 时缩减到约一半", () => {
    assert.equal(sizeAt(600), 9); // fill 0.6 → floor(N*0.9)
    assert.equal(sizeAt(750), 7); // fill 0.75 → floor(N*0.75)
    assert.equal(sizeAt(950), 5); // fill 0.95 → floor(N*0.5)
  });

  it("N=1 时任何压力都不会低于 1", () => {
    const p1 = defaultCompressPolicy(1, { contextCharLimit: 1000, contextTriggerRatio: 1 });
    const s = ctx.status({
      dialogue,
      summarizedCount: 0,
      policy: p1,
      tokenCounter: counter,
      assembledPromptTokens: 999,
    });
    assert.equal(s.adaptivePairBatchSize, 1);
  });
});

describe("insertAtDepth", () => {
  const hist: RpMessage[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
  ];

  it("无插入时原样返回同一引用", () => {
    assert.equal(insertAtDepth(hist, []), hist);
  });

  it("depth=0 插到最后一条之后", () => {
    const out = insertAtDepth(hist, [{ role: "system", content: "D", depth: 0, label: "x" }]);
    assert.deepEqual(out.map((m) => m.content), ["u1", "a1", "u2", "a2", "D"]);
  });

  it("depth=N 从末尾往上数 N 条处插入", () => {
    const out = insertAtDepth(hist, [{ role: "system", content: "D", depth: 2, label: "x" }]);
    assert.deepEqual(out.map((m) => m.content), ["u1", "a1", "D", "u2", "a2"]);
  });

  it("depth 超过消息数 → 插到最前；负数 → 视作 0", () => {
    const front = insertAtDepth(hist, [{ role: "system", content: "D", depth: 99, label: "x" }]);
    assert.equal(front[0]!.content, "D");
    const neg = insertAtDepth(hist, [{ role: "system", content: "D", depth: -5, label: "x" }]);
    assert.equal(neg[neg.length - 1]!.content, "D");
  });

  it("空历史也能插入且不抛异常", () => {
    const out = insertAtDepth([], [{ role: "user", content: "D", depth: 3, label: "x" }]);
    assert.deepEqual(out.map((m) => m.content), ["D"]);
  });

  it("同位置并列时保持调用方顺序，且不修改入参数组", () => {
    const out = insertAtDepth(hist, [
      { role: "system", content: "X", depth: 1, label: "a" },
      { role: "system", content: "Y", depth: 1, label: "b" },
    ]);
    assert.equal(hist.length, 4, "入参数组不得被修改");
    assert.deepEqual(out.map((m) => m.content), ["u1", "a1", "u2", "X", "Y", "a2"]);
    assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "system", "system", "assistant"]);
  });
});

describe("normalizeLoreSlot", () => {
  it("规范字符串别名原样透传", () => {
    for (const s of [
      "before_char",
      "after_char",
      "before_example",
      "after_example",
      "an_top",
      "an_bottom",
      "at_depth",
    ] as const) {
      assert.equal(normalizeLoreSlot(s), s);
    }
  });

  it("数字线序 0–6 映射到别名", () => {
    assert.equal(normalizeLoreSlot(0), "before_char");
    assert.equal(normalizeLoreSlot(3), "after_example");
    assert.equal(normalizeLoreSlot(4), "an_top");
    assert.equal(normalizeLoreSlot(6), "at_depth");
  });

  it("小数向下取整", () => {
    assert.equal(normalizeLoreSlot(2.9), "before_example");
    assert.equal(normalizeLoreSlot(6.9), "at_depth");
  });

  it("非法值一律回退 before_char", () => {
    assert.equal(normalizeLoreSlot("AFTER_CHAR" as unknown as LoreSlot), "before_char"); // 别名大小写敏感
    assert.equal(normalizeLoreSlot("nope" as unknown as LoreSlot), "before_char");
    assert.equal(normalizeLoreSlot(7), "before_char");
    assert.equal(normalizeLoreSlot(-1), "before_char");
    assert.equal(normalizeLoreSlot(Number.NaN), "before_char");
    assert.equal(normalizeLoreSlot(Number.POSITIVE_INFINITY), "before_char");
    assert.equal(normalizeLoreSlot(undefined), "before_char");
  });

  it("别名导出与顺序表保持一致", () => {
    assert.equal(normalizeWorldBookPosition, normalizeLoreSlot);
    assert.deepEqual(WORLD_BOOK_POSITION_ORDER, LORE_SLOT_ORDER);
    assert.deepEqual([...LORE_SLOT_ORDER], [
      "before_char",
      "after_char",
      "before_example",
      "after_example",
      "an_top",
      "an_bottom",
      "at_depth",
    ]);
  });
});
