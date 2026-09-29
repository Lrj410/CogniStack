import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipOneStructuredDocument,
  clipStructuredSummary,
  dedupeTextUnits,
  isThinColumnBody,
  looksStructured,
  mergeStructuredMemoryTexts,
  minStructuredDocumentLength,
  normalizeStructuredMemory,
  splitMemoryColumns,
  splitMemoryDocuments,
} from "../src/memory/structuredMemory";
import { joinSummaryBlocks } from "../src/memory/MemoryEngine";
import { MEMORY_COLUMN_SACRIFICE_ORDER, MEMORY_COLUMN_TITLES } from "../src/types";

describe("structured memory — layout", () => {
  it("renders every document in the fixed column order", () => {
    const out = normalizeStructuredMemory("【近期情节】甲\n【硬事实】乙\n【未决】丙");
    const titles = out.split("\n").filter((l) => l.startsWith("【") && l.endsWith("】"));
    assert.deepEqual(titles, [...MEMORY_COLUMN_TITLES]);
  });

  it("fills missing columns with 无", () => {
    const out = normalizeStructuredMemory("【硬事实】只有硬事实");
    for (const title of MEMORY_COLUMN_TITLES) {
      assert.ok(out.includes(title), `missing ${title}`);
    }
    assert.ok(out.includes("【时间线】\n无"));
  });

  it("drops repeated hard facts inside one column", () => {
    const out = normalizeStructuredMemory("【硬事实】他叫阿铁；他叫阿铁");
    assert.equal((out.match(/他叫阿铁/g) ?? []).length, 1);
  });

  it("keeps every 记忆块 label so later joins preserve episode identity", () => {
    const docs = splitMemoryDocuments("【记忆块 1/2】\n【硬事实】甲\n\n【记忆块 2/2】\n【硬事实】乙");
    assert.deepEqual(
      docs.map((d) => d.label),
      ["【记忆块 1/2】", "【记忆块 2/2】"],
    );
    assert.deepEqual(
      splitMemoryColumns("【记忆块 1/2】\n【硬事实】甲\n\n【记忆块 2/2】\n【硬事实】乙").map(
        (c) => c.body,
      ),
      ["甲", "乙"],
    );
  });

  it("round-trips multi-block joins through joinSummaryBlocks", () => {
    const joined = joinSummaryBlocks([
      { id: "a", text: "【硬事实】甲", throughMessageId: "m1" },
      { id: "b", text: "【硬事实】乙", throughMessageId: "m2" },
    ]);
    assert.ok(joined.includes("【记忆块 1/2】"));
    assert.ok(joined.includes("【记忆块 2/2】"));
    assert.ok(looksStructured(joined));
  });
});

describe("structured memory — thin-column heuristic", () => {
  it("never sacrifices 硬事实 / 未决 for being short (CogniStack fix)", () => {
    // The source dropped anything shorter than 2 chars regardless of column,
    // so a single-character hard fact was destroyed on every normalize/merge.
    assert.equal(isThinColumnBody("【硬事实】", "火"), false);
    assert.equal(isThinColumnBody("【未决】", "逃"), false);
  });

  it("still treats empty columns as thin", () => {
    assert.equal(isThinColumnBody("【硬事实】", "无"), true);
    assert.equal(isThinColumnBody("【硬事实】", "   "), true);
  });

  it("keeps the 近期情节 stub heuristic intact", () => {
    assert.equal(isThinColumnBody("【近期情节】", "阿铁、小美"), true, "names-only should go");
    assert.equal(isThinColumnBody("【近期情节】", "两人走进了房间"), false);
  });

  it("keeps a 1-char hard fact through a full normalize", () => {
    const out = normalizeStructuredMemory("【硬事实】火");
    assert.ok(out.includes("火"));
  });

  it("keeps short 关系与称呼 / 时间线 nicknames", () => {
    assert.equal(isThinColumnBody("【关系与称呼】", "哥"), false);
    assert.equal(isThinColumnBody("【时间线】", "夜"), false);
    assert.ok(normalizeStructuredMemory("【关系与称呼】哥").includes("哥"));
    assert.ok(normalizeStructuredMemory("【时间线】夜").includes("夜"));
  });

  it("does not drop short 近期情节 beats during cross-column scrub", () => {
    const out = normalizeStructuredMemory("【近期情节】他跑了。");
    assert.ok(out.includes("他跑了"), out);
  });
});

describe("structured memory — clipping honours the budget (CogniStack fix)", () => {
  const doc = [
    "【硬事实】",
    Array.from({ length: 40 }, (_, i) => `事实条目${i}：描述文字`).join("；"),
    "",
    "【未决】",
    "悬念甲",
  ].join("\n");

  it("never returns more than maxChars for workable budgets", () => {
    for (const max of [60, 80, 120, 200, 400, 1000, 2000]) {
      const out = clipStructuredSummary(doc, max);
      assert.ok(
        out.length <= max,
        `clipStructuredSummary(${max}) returned ${out.length} chars`,
      );
      assert.ok(looksStructured(out), `lost structure at ${max}`);
    }
  });

  it("treats maxChars <= 0 as 'do not clip' (API compatibility)", () => {
    assert.equal(clipStructuredSummary(doc, 0), normalizeStructuredMemory(doc));
  });

  it("returns empty below the minimum viable render instead of an oversized fragment", () => {
    const floor = minStructuredDocumentLength();
    assert.equal(floor, 45);
    assert.equal(clipStructuredSummary(doc, floor - 1), "");
    assert.equal(clipOneStructuredDocument(doc, 8), "");
  });

  it("clips per document when several blocks are joined", () => {
    const multi = [
      "【记忆块 1/3】",
      "【硬事实】" + "甲".repeat(200),
      "",
      "【记忆块 2/3】",
      "【硬事实】" + "乙".repeat(200),
      "",
      "【记忆块 3/3】",
      "【硬事实】" + "丙".repeat(200),
    ].join("\n");
    const out = clipStructuredSummary(multi, 200, { documentImportances: [10, 90, 50] });
    assert.ok(out.length <= 200, `got ${out.length}`);
  });

  it("does not ship orphan 记忆块 labels when the body cannot fit", () => {
    const multi = [
      "【记忆块 1/2】",
      "【硬事实】" + "甲".repeat(200),
      "",
      "【记忆块 2/2】",
      "【硬事实】" + "乙".repeat(200),
    ].join("\n");
    for (const max of [10, 20, 40, 44]) {
      const out = clipStructuredSummary(multi, max);
      assert.equal(out, "", `max=${max} got ${JSON.stringify(out)}`);
    }
  });
});

describe("structured memory — column sacrifice order", () => {
  it("puts 硬事实 last", () => {
    assert.equal(MEMORY_COLUMN_SACRIFICE_ORDER[MEMORY_COLUMN_SACRIFICE_ORDER.length - 1], "【硬事实】");
  });

  it("sacrifices 近期情节 before hard facts when squeezed", () => {
    const rich = [
      "【硬事实】不可丢失的核心设定条目内容",
      "【时间线】时间线占位内容占位内容",
      "【关系与称呼】关系占位内容占位内容",
      "【未决】未决占位内容占位内容",
      "【近期情节】" + "情节缓冲".repeat(30),
    ].join("\n\n");
    const out = clipStructuredSummary(rich, 120);
    assert.ok(out.length <= 120);
    assert.ok(out.includes("不可丢失的核心设定条目内容"), "hard facts survived");
  });
});

describe("structured memory — merge", () => {
  const older =
    "【硬事实】阿铁是住在用户机器里的技术搭子\n【时间线】第一天：两人搭上了话\n【关系与称呼】称呼对方为「老板」\n【未决】要不要把整个工程外挂出去\n【近期情节】两人在机房里对着日志聊了很久";
  const newer =
    "【硬事实】这台机器是 RTX 5070 Laptop 8GB\n【时间线】第二天：压测跑完了\n【关系与称呼】无\n【未决】无\n【近期情节】他们把 benchmark 重跑了一遍又一遍";

  it("unions hard facts and timeline from both sides", () => {
    const out = mergeStructuredMemoryTexts(older, newer);
    assert.ok(out.includes("阿铁是住在用户机器里的技术搭子"));
    assert.ok(out.includes("RTX 5070 Laptop 8GB"));
    assert.ok(out.includes("第一天：两人搭上了话"));
    assert.ok(out.includes("第二天：压测跑完了"));
  });

  it("prefers the newer 近期情节", () => {
    const out = mergeStructuredMemoryTexts(older, newer);
    assert.ok(out.includes("他们把 benchmark 重跑了一遍又一遍"));
    assert.ok(!out.includes("两人在机房里对着日志聊了很久"));
  });

  it("keeps both sides of unstructured input", () => {
    const a = mergeStructuredMemoryTexts("零散事实甲", "零散事实乙");
    assert.ok(a.includes("零散事实甲"));
    assert.ok(a.includes("零散事实乙"));
  });
});

describe("dedupeTextUnits", () => {
  it("removes exact duplicates", () => {
    assert.equal(dedupeTextUnits("苹果；苹果；香蕉"), "苹果；香蕉");
  });

  it("returns 无 for empty / 无-only input", () => {
    assert.equal(dedupeTextUnits(""), "无");
    assert.equal(dedupeTextUnits("无"), "无");
  });

  it("keeps the longer of two near-duplicate units", () => {
    // Near-dupe detection needs the shorter key to be ≥ 8 compaction chars and
    // to cover ≥ 85% of the longer one, so trivia is not silently merged.
    assert.equal(
      dedupeTextUnits("阿铁住在机房里配机器；阿铁住在机房里配机器了"),
      "阿铁住在机房里配机器了",
    );
  });

  it("does not merge genuinely different facts", () => {
    const out = dedupeTextUnits("他叫阿铁；他叫阿铁一号");
    assert.ok(out.includes("他叫阿铁"));
    assert.ok(out.includes("他叫阿铁一号"));
  });
});
