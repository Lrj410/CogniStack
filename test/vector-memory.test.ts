import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOCAL_EMBED_DIM, VectorMemoryEngine, type VectorRow } from "../src/memory/VectorMemoryEngine";

const vec = new VectorMemoryEngine();

function row(id: string, text: string): VectorRow {
  return { id, sourceType: "summary", sourceId: id, text, embedding: vec.buildLocalEmbedding(text) };
}

describe("VectorMemoryEngine — embeddings", () => {
  it("is deterministic", () => {
    assert.deepEqual(
      vec.buildLocalEmbedding("同一段文字"),
      vec.buildLocalEmbedding("同一段文字"),
    );
  });

  it("is L2-normalized", () => {
    const v = vec.buildLocalEmbedding("归一化测试文本");
    const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `norm=${norm}`);
  });

  it("produces LOCAL_EMBED_DIM dimensions", () => {
    assert.equal(vec.buildLocalEmbedding("x").length, LOCAL_EMBED_DIM);
  });

  it("returns a zero vector for empty input", () => {
    const v = vec.buildLocalEmbedding("");
    assert.ok(v.every((x) => x === 0));
  });

  it("bounds work on very long input", () => {
    const v = vec.buildLocalEmbedding("字".repeat(200_000));
    assert.equal(v.length, LOCAL_EMBED_DIM);
    assert.ok(v.every((x) => Number.isFinite(x)));
  });
});

describe("VectorMemoryEngine — cosine", () => {
  it("scores identical vectors at 1", () => {
    const a = vec.buildLocalEmbedding("完全一样的句子");
    assert.ok(Math.abs(vec.cosine(a, a) - 1) < 1e-6);
  });

  it("lexical overlap separates related from unrelated text", () => {
    // The bundled local embedder is a cheap n-gram hash — useful as a fallback,
    // not as a semantic oracle. The lexical channel is the reliable signal, so
    // that is what gets asserted here.
    const related = vec.lexicalOverlap("显卡显存上下文长度", "这台机器的显卡有 8GB 显存");
    const unrelated = vec.lexicalOverlap("显卡显存上下文长度", "今天晚饭吃饺子比较好");
    assert.ok(related > unrelated, `${related} vs ${unrelated}`);
  });

  it("hybrid ranking puts the related row first", () => {
    const rows = [
      { id: "a", sourceType: "s", sourceId: "a", text: "这台机器的显卡有 8GB 显存", embedding: [0] },
      { id: "b", sourceType: "s", sourceId: "b", text: "今天晚饭吃饺子比较好", embedding: [0] },
    ];
    const hits = vec.cosineTopK([1], rows, 2, { queryText: "显卡显存" });
    assert.equal(hits[0]!.id, "a");
  });

  it("returns 0 for mismatched or empty dimensions", () => {
    assert.equal(vec.cosine([1, 0], []), 0);
    assert.equal(vec.cosine([1, 0], [1, 0, 0]), 0);
    assert.equal(vec.cosine([0, 0], [1, 1]), 0);
  });
});

describe("VectorMemoryEngine — cosineTopK", () => {
  const rows = [
    row("a", "显卡是 RTX 5070 Laptop，8GB 显存"),
    row("b", "上下文长度取决于量化精度"),
    row("c", "晚饭吃饺子"),
    row("d", "显卡驱动版本是 CUDA 13.3"),
  ];

  it("returns at most k hits", () => {
    const q = vec.buildLocalEmbedding("显卡");
    for (const k of [1, 2, 4, 8]) {
      assert.ok(vec.cosineTopK(q, rows, k).length <= k);
    }
  });

  it("ranks by score descending", () => {
    const q = vec.buildLocalEmbedding("显卡");
    const hits = vec.cosineTopK(q, rows, 4);
    for (let i = 1; i < hits.length; i += 1) {
      assert.ok(hits[i - 1]!.score >= hits[i]!.score);
    }
  });

  it("returns nothing when every score is below the floor", () => {
    const q = vec.buildLocalEmbedding("显卡");
    assert.deepEqual(vec.cosineTopK(q, rows, 4, { minScore: 0.999 }), []);
  });

  it("keeps a lexical path alive on a dimension mismatch", () => {
    const hits = vec.cosineTopK([1, 0, 0, 0], rows, 4, { queryText: "显卡" });
    assert.ok(hits.length > 0, "lexical overlap should rescue the query");
    assert.ok(hits.every((h) => h.text.includes("显卡")));
  });

  it("embedTexts falls back to the local embedder when the remote one throws", async () => {
    const out = await vec.embedTexts(["甲", "乙"], async () => {
      throw new Error("remote down");
    });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.length, LOCAL_EMBED_DIM);
  });

  it("embedTexts prefers a working remote embedder", async () => {
    const out = await vec.embedTexts(["甲", "乙"], async () => [
      [1, 0],
      [0, 1],
    ]);
    assert.deepEqual(out, [
      [1, 0],
      [0, 1],
    ]);
  });
});

describe("VectorMemoryEngine — sanitizeHits", () => {
  it("drops empty and duplicate content", () => {
    const out = vec.sanitizeHits([
      { content: "   " },
      { content: "同一段记忆内容" },
      { content: "同一段记忆内容" },
    ]);
    assert.equal(out.length, 1);
  });

  it("drops hits that merely restate the committed summary", () => {
    const summary = "【硬事实】阿铁住在机房里；机器是 5070";
    const out = vec.sanitizeHits(
      [{ content: "阿铁住在机房里；机器是 5070" }],
      { summaryText: summary },
    );
    assert.equal(out.length, 0);
  });

  it("keeps hits whose unique suffix is not in the summary", () => {
    const prefix = "阿铁住在机房里；机器是 5070；详细说明".padEnd(90, "甲");
    const summary = prefix.slice(0, 80);
    const out = vec.sanitizeHits(
      [{ content: `${prefix}密码9241` }],
      { summaryText: summary },
    );
    assert.equal(out.length, 1);
    assert.ok(out[0]!.content.includes("密码9241"));
  });

  it("caps hits and per-hit size", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ content: `独立内容条目${i} ${"x".repeat(200)}` }));
    const out = vec.sanitizeHits(many, { maxHits: 3, maxCharsEach: 200 });
    assert.ok(out.length <= 3);
    for (const h of out) assert.ok(h.content.length <= 200 * 1.05);
  });

  it("returns an empty array for null input", () => {
    assert.deepEqual(vec.sanitizeHits(null), []);
    assert.deepEqual(vec.sanitizeHits(undefined), []);
  });
});

describe("VectorMemoryEngine — formatting", () => {
  it("formats hits with a header and respects the char budget", () => {
    const out = vec.formatAssembleHits(
      [
        { name: "甲", content: "内容甲" },
        { name: "乙", content: "内容乙" },
      ],
      1000,
    );
    assert.ok(out.startsWith("相关检索记忆"));
    assert.ok(out.includes("【甲】"));
    assert.ok(out.includes("【乙】"));
  });

  it("stops before exceeding the budget", () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ content: "y".repeat(200) + i }));
    assert.ok(vec.formatAssembleHits(hits, 300).length <= 300);
  });

  it("numbers unnamed hits", () => {
    const out = vec.formatAssembleHits([{ content: "body" }]);
    assert.ok(out.includes("检索 1"));
  });

  it("returns empty for no hits", () => {
    assert.equal(vec.formatAssembleHits([]), "");
  });
});

describe("VectorMemoryEngine — retrieveLocal", () => {
  it("retrieveLocalSync ranks the related row first", () => {
    const rows = [
      row("a", "这台机器的显卡有 8GB 显存"),
      row("b", "今天晚饭吃饺子比较好"),
      row("c", "显卡驱动版本是 CUDA 13.3"),
    ];
    const hits = vec.retrieveLocalSync("显卡显存", rows, { k: 2 });
    assert.ok(hits.length >= 1);
    assert.ok(hits[0]!.id === "a" || hits[0]!.id === "c");
  });

  it("sourceTypeWeight is opt-in and changes order", () => {
    const rows = [
      row("a", "显卡相关笔记 A"),
      { ...row("b", "显卡相关笔记 B"), sourceType: "policy" },
    ];
    const plain = vec.retrieveLocalSync("显卡", rows, { k: 2 });
    const boosted = vec.retrieveLocalSync("显卡", rows, {
      k: 2,
      sourceTypeWeight: { policy: 3, summary: 0.1 },
    });
    assert.equal(boosted[0]!.id, "b");
    assert.ok(plain.length >= 1);
  });

  it("async retrieveLocal accepts a mock EmbedFn", async () => {
    const rows = [row("a", "alpha"), row("b", "beta unrelated")];
    const hits = await vec.retrieveLocal("alpha", rows, {
      k: 1,
      embed: async (texts) => texts.map((t) => vec.buildLocalEmbedding(t)),
    });
    assert.equal(hits[0]!.id, "a");
  });
});

describe("VectorMemoryEngine — mmrSelect（去冗余）", () => {
  // 查询向量 [1,0]；dup1/dup2 文本完全一致且满分，distinct 文本不同、余弦 0.9。
  const q = [1, 0];
  const rows: VectorRow[] = [
    { id: "dup1", sourceType: "summary", sourceId: "dup1", text: "重复记忆内容甲", embedding: [1, 0] },
    { id: "dup2", sourceType: "summary", sourceId: "dup2", text: "重复记忆内容甲", embedding: [1, 0] },
    {
      id: "distinct",
      sourceType: "summary",
      sourceId: "distinct",
      text: "完全不同的话题内容乙",
      embedding: [0.9, Math.sqrt(1 - 0.81)],
    },
  ];

  it("关闭多样性时纯按分数取前二（保留重复项）", () => {
    const hits = vec.cosineTopK(q, rows, 2, { diversity: false });
    assert.deepEqual(hits.map((h) => h.id), ["dup1", "dup2"]);
  });

  it("开启多样性后 MMR 用低冗余候选替换重复项", () => {
    const hits = vec.cosineTopK(q, rows, 2, { diversity: true });
    assert.equal(hits[0]!.id, "dup1");
    assert.equal(hits[1]!.id, "distinct");
  });

  it("MMR 不改变结果集合的合法性：均为候选、无重复、数量守住 k", () => {
    const ids = new Set(rows.map((r) => r.id));
    for (const k of [1, 2, 3]) {
      const hits = vec.cosineTopK(q, rows, k, { diversity: true });
      assert.ok(hits.length <= k);
      assert.equal(new Set(hits.map((h) => h.id)).size, hits.length, "结果不得重复");
      for (const h of hits) assert.ok(ids.has(h.id), h.id);
      for (let i = 1; i < hits.length; i += 1) {
        assert.ok(hits[i - 1]!.score >= hits[i]!.score, "分数仍需降序");
      }
    }
  });
});

describe("VectorMemoryEngine — recencyBoost", () => {
  const q = [1, 0];
  const dayMs = 86_400_000;

  it("开启后改变排序（新条目优先）但候选集合不变", () => {
    const now = Date.now();
    const oldTs = now - 400 * dayMs;
    const mk = (id: string, ts: number): VectorRow => ({
      id,
      sourceType: "summary",
      sourceId: `${id}#ts=${ts}`,
      text: "相同内容记忆",
      embedding: [1, 0],
    });
    const rows = [mk("old", oldTs), mk("new", now)];

    const plain = vec.cosineTopK(q, rows, 2);
    const boosted = vec.cosineTopK(q, rows, 2, { recencyBoost: 1 });
    assert.deepEqual(
      new Set(plain.map((h) => h.id)),
      new Set(boosted.map((h) => h.id)),
    );
    assert.equal(plain[0]!.id, "old", "无 boost 时同分为原序（稳定）");
    assert.equal(boosted[0]!.id, "new", "boost 后新条目应排前");
  });

  it("时间戳也可来自 rowMeta", () => {
    const now = Date.now();
    const rows: VectorRow[] = [
      { id: "old", sourceType: "summary", sourceId: "old", text: "同内容", embedding: [1, 0] },
      { id: "new", sourceType: "summary", sourceId: "new", text: "同内容", embedding: [1, 0] },
    ];
    const rowMeta = new Map<string, { updatedAt?: number }>([
      ["old", { updatedAt: now - 400 * dayMs }],
      ["new", { updatedAt: now }],
    ]);
    const boosted = vec.cosineTopK(q, rows, 2, { recencyBoost: 1, rowMeta });
    assert.equal(boosted[0]!.id, "new");
  });

  it("缺少时间戳时不放大分数（排序回退为稳定序）", () => {
    const rows: VectorRow[] = [
      { id: "a", sourceType: "summary", sourceId: "a", text: "同内容", embedding: [1, 0] },
      { id: "b", sourceType: "summary", sourceId: "b", text: "同内容", embedding: [1, 0] },
    ];
    const hits = vec.cosineTopK(q, rows, 2, { recencyBoost: 1 });
    assert.deepEqual(hits.map((h) => h.id), ["a", "b"]);
    assert.ok(Math.abs(hits[0]!.score - 1) < 1e-9);
  });

  it("可配置 recencyHalfLifeDays 半衰期", () => {
    const now = Date.now();
    const rows: VectorRow[] = [
      { id: "medium", sourceType: "summary", sourceId: "m", text: "中等新", embedding: [1, 0] },
      { id: "fresh", sourceType: "summary", sourceId: "f", text: "非常新", embedding: [1, 0] },
    ];
    const rowMeta = new Map<string, { updatedAt?: number }>([
      ["medium", { updatedAt: now - 5 * dayMs }],
      ["fresh", { updatedAt: now - 1 * dayMs }],
    ]);
    const boosted = vec.cosineTopK(q, rows, 2, {
      recencyBoost: 1,
      recencyHalfLifeDays: 1,
      rowMeta,
    });
    assert.equal(boosted[0]!.id, "fresh");
    assert.ok(boosted[0]!.score > boosted[1]!.score);
  });
});
