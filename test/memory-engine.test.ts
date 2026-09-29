import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultCompressPolicy,
  joinSummaryBlocks,
  MemoryEngine,
  normalizeCompressPolicyPatch,
  resolveSummaryBlocks,
} from "../src/memory/MemoryEngine";
import { MemoryBlocksEngine } from "../src/memory/MemoryBlocksEngine";
import type { DialogueMessage, SummaryBlock } from "../src/types";

const dialogue: DialogueMessage[] = [
  { id: "m1", role: "user", content: "u1" },
  { id: "m2", role: "assistant", content: "a1" },
  { id: "m3", role: "user", content: "u2" },
  { id: "m4", role: "assistant", content: "a2" },
  { id: "m5", role: "user", content: "u3" },
  { id: "m6", role: "assistant", content: "a3" },
];

describe("MemoryEngine — complete pairs", () => {
  const mem = new MemoryEngine();

  it("pairs each user message with the following assistant reply", () => {
    assert.deepEqual(mem.listCompletePairs(dialogue).map((p) => p.endIndex), [1, 3, 5]);
  });

  it("skips ciphertext pairs entirely", () => {
    const withCipher: DialogueMessage[] = [
      { id: "c1", role: "user", content: "x", encrypted: true },
      { id: "c2", role: "assistant", content: "y", encrypted: true },
      { id: "p1", role: "user", content: "u" },
      { id: "p2", role: "assistant", content: "a" },
    ];
    const pairs = mem.listCompletePairs(withCipher);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.user.id, "p1");
  });

  it("ignores a leading assistant preamble", () => {
    const prepended: DialogueMessage[] = [
      { id: "greet", role: "assistant", content: "hi" },
      ...dialogue,
    ];
    assert.equal(mem.listCompletePairs(prepended).length, 3);
    assert.deepEqual(mem.leadingPreamble(prepended).map((m) => m.id), ["greet"]);
  });
});

describe("MemoryEngine — watermark", () => {
  const mem = new MemoryEngine();

  it("resolves by message id", () => {
    assert.equal(mem.watermarkEndIndex(dialogue, "m4", 0), 3);
  });

  it("falls back to the numeric count", () => {
    assert.equal(mem.watermarkEndIndex(dialogue, null, 2), 1);
  });

  it("returns -1 when the id points off the active path", () => {
    // Branch switch must NOT fall back to the numeric count — that would slice
    // the wrong branch.
    assert.equal(mem.watermarkEndIndex(dialogue, "gone", 4), -1);
  });

  it("takes the FIRST occurrence when a message id is duplicated", () => {
    // 宿主"追加而非替换"会产生重复 id。取最后一次出现会把未摘要的回合一并
    // 划走（丢内容）；取首次出现只是可能重复摘要，不会丢。
    const dup: DialogueMessage[] = [
      { id: "m1", role: "user", content: "a" },
      { id: "m2", role: "assistant", content: "b" },
      { id: "m1", role: "user", content: "a-again" },
      { id: "m3", role: "assistant", content: "c" },
    ];
    assert.equal(mem.watermarkEndIndex(dup, "m1", 0), 0);
  });

  it("reports off-path watermarks instead of silently guessing", () => {
    const off = mem.resolveEffectiveWatermark(dialogue, "gone", 4);
    assert.equal(off.watermarkOnPath, false);
    assert.equal(off.summarizedCount, 0);

    const on = mem.resolveEffectiveWatermark(dialogue, "m4", 0);
    assert.equal(on.watermarkOnPath, true);
    assert.equal(on.summarizedThroughMessageId, "m4");
  });
});

describe("MemoryEngine — prompt raw window", () => {
  const mem = new MemoryEngine();

  it("returns everything when there is no watermark", () => {
    assert.equal(mem.promptRawMessages(dialogue, -1, 1).length, 6);
  });

  it("prepends exactly K covered pairs as overlap", () => {
    const out = mem.promptRawMessages(dialogue, mem.watermarkEndIndex(dialogue, "m4", 0), 1);
    assert.deepEqual(out.map((m) => m.id), ["m3", "m4", "m5", "m6"]);
  });

  it("honours overlapPairs = 0", () => {
    const out = mem.promptRawMessages(dialogue, mem.watermarkEndIndex(dialogue, "m4", 0), 0);
    assert.deepEqual(out.map((m) => m.id), ["m5", "m6"]);
  });

  it("never emits ciphertext into the window", () => {
    const mixed: DialogueMessage[] = [
      { id: "x1", role: "user", content: "a", encrypted: true },
      { id: "x2", role: "assistant", content: "b", encrypted: true },
      { id: "x3", role: "user", content: "c" },
      { id: "x4", role: "assistant", content: "d" },
    ];
    const out = mem.promptRawMessages(mixed, -1, 0);
    assert.deepEqual(out.map((m) => m.id), ["x3", "x4"]);
    assert.equal(mem.promptRawMessages(mixed, -1, 0, { includeEncrypted: true }).length, 4);
  });

  it("counts every pair as pending when nothing is compressed", () => {
    assert.equal(mem.pendingPairsAfterWatermark(dialogue, -1).length, 3);
    assert.equal(mem.pendingPairsAfterWatermark(dialogue, 3).length, 1);
  });
});

describe("summary block normalization", () => {
  it("wraps a legacy summary string into one block", () => {
    const blocks = resolveSummaryBlocks({ summary: "旧摘要", summarizedThroughMessageId: "m2" });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.throughMessageId, "m2");
    assert.equal(blocks[0]!.id, "legacy-summary");
  });

  it("prefers real blocks over the legacy string", () => {
    const blocks: SummaryBlock[] = [
      { id: "a", text: "甲", throughMessageId: "m1" },
      { id: "b", text: "乙", throughMessageId: "m2" },
    ];
    assert.deepEqual(resolveSummaryBlocks({ summaryBlocks: blocks, summary: "旧" }), blocks);
  });

  it("drops empty blocks", () => {
    const blocks = resolveSummaryBlocks({
      summaryBlocks: [
        { id: "a", text: "  ", throughMessageId: "m1" },
        { id: "b", text: "乙", throughMessageId: "m2" },
      ],
    });
    assert.deepEqual(blocks.map((b) => b.id), ["b"]);
  });

  it("labels multi-block joins and leaves single blocks bare", () => {
    assert.equal(joinSummaryBlocks([{ id: "a", text: "甲", throughMessageId: "m" }]), "甲");
    const joined = joinSummaryBlocks([
      { id: "a", text: "甲", throughMessageId: "m1" },
      { id: "b", text: "乙", throughMessageId: "m2" },
    ]);
    assert.ok(joined.includes("【记忆块 1/2】"));
  });
});

describe("compress policy", () => {
  it("maps the preferred *Token aliases onto canonical fields", () => {
    const patch = normalizeCompressPolicyPatch({
      totalPromptTokenCap: 100,
      contextTokenLimit: 200,
      maxBatchTokenCap: 300,
    });
    assert.equal(patch.totalPromptCharCap, 100);
    assert.equal(patch.contextCharLimit, 200);
    assert.equal(patch.maxBatchChars, 300);
    assert.equal(patch.totalPromptTokenCap, undefined);
  });

  it("clamps nonsense instead of propagating it", () => {
    const policy = defaultCompressPolicy(-5, { contextTriggerRatio: 9, maxBlocks: 0 });
    assert.equal(policy.pairBatchSize, 1);
    assert.equal(policy.contextTriggerRatio, 0.7);
    assert.equal(policy.maxBlocks, 3);
  });
});

describe("MemoryBlocksEngine", () => {
  const blocks = new MemoryBlocksEngine();
  const policy = { maxBlocks: 3, maxTotalBlockChars: 1000 };

  it("plans a fuse when the block count would overflow", () => {
    const three: SummaryBlock[] = Array.from({ length: 3 }, (_, i) => ({
      id: `b${i}`,
      text: "x".repeat(10),
      throughMessageId: `m${i}`,
    }));
    assert.deepEqual(blocks.planAction({ blocks: three, incomingEstimateChars: 10, policy }), {
      action: "fuse",
      reason: "count",
    });
  });

  it("plans a fuse when the total size would overflow", () => {
    const one: SummaryBlock[] = [{ id: "a", text: "x".repeat(950), throughMessageId: "m" }];
    assert.deepEqual(blocks.planAction({ blocks: one, incomingEstimateChars: 100, policy }), {
      action: "fuse",
      reason: "size",
    });
  });

  it("appends otherwise", () => {
    assert.deepEqual(blocks.planAction({ blocks: [], incomingEstimateChars: 10, policy }), {
      action: "incremental",
      reason: "append",
    });
  });

  it("merges oldest blocks until count and size fit", () => {
    const many: SummaryBlock[] = Array.from({ length: 5 }, (_, i) => ({
      id: `b${i}`,
      text: `【硬事实】事件${i}\n【时间线】无\n【关系与称呼】无\n【未决】无\n【近期情节】无`,
      throughMessageId: `m${i}`,
    }));
    const out = blocks.mergeOldestBlocksLocal(many, 3);
    assert.equal(out.length, 3);
  });

  it("committing a block keeps the list within maxBlocks", () => {
    const out = blocks.commitBlock(
      [
        { id: "a", text: "甲", throughMessageId: "m1" },
        { id: "b", text: "乙", throughMessageId: "m2" },
      ],
      { id: "c", text: "丙", throughMessageId: "m3" },
      2,
    );
    assert.equal(out.length, 2);
  });

  it("clipBlockText never exceeds its budget (CogniStack fix)", () => {
    // maxChars <= 0 means "do not clip" (API compatibility) and is excluded.
    for (const max of [1, 4, 8, 12, 20, 60]) {
      const out = blocks.clipBlockText("言".repeat(100), max);
      assert.ok(out.length <= Math.max(0, max), `max=${max} gave ${out.length}`);
    }
  });
});
