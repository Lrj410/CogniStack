/**
 * Regression tests for the deep-audit batch 1/2 fixes.
 *
 * Every case here corresponds to an entry in the deep-audit of 2026-09-28
 * (`AUDIT-DEEP-2026-09-28.md`, removed in the 2026-09-29 slim-down — see git
 * history) and pins
 * the *measured* behaviour, so the fix cannot silently regress. The "before"
 * numbers quoted in the comments are the ones recorded in that document.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CogniStackEngine } from "../src/fusion/CogniStackEngine";
import { exactCharTokenCounter, memoizeCounter } from "../src/fusion/counter";
import { fitMessagesUnderTokenCap } from "../src/fusion/fitMessages";
import { attributeBudget } from "../src/fusion/budgetAttribution";
import { auditMemory, memoryAuditWarnings } from "../src/memory/memoryAudit";
import { deserializeMemoryState, serializeMemoryState } from "../src/memory/memoryEnvelope";
import { SummaryEngine } from "../src/memory/SummaryEngine";
import {
  detectUnknownColumns,
  normalizeStructuredMemory,
} from "../src/memory/structuredMemory";
import type { RpMessage } from "../src/types";

const counter = exactCharTokenCounter();

describe("记忆：栏目外正文不再静默丢弃（A-5 / P1-4）", () => {
  it("栏目之前的总述句被折入【硬事实】，而不是消失", () => {
    // Before: `normalize` excluded every slice whose title was "" — measured with
    // "主角是林远，一名剑士。\n\n【时间线】…", the output did not contain 「林远」.
    const doc = "主角是林远，一名剑士。\n\n【时间线】\n第一天进城\n\n【硬事实】\n无";
    const out = normalizeStructuredMemory(doc);
    assert.ok(out.includes("林远"), `前言应当被保留，实际输出：${out}`);
    assert.ok(out.includes("【时间线】\n第一天进城"));
  });

  it("纯噪声前言仍会被自然丢弃，不会污染【硬事实】", () => {
    const noise = "---\n…\n\n【硬事实】\n阿铁是技术搭子";
    const out = normalizeStructuredMemory(noise);
    assert.ok(out.includes("阿铁是技术搭子"));
    assert.ok(!out.includes("---"));
  });
});

describe("记忆：括号形态归一（A-4 / P1-6）", () => {
  const variants = ["［硬事实］", "[硬事实]", "# 硬事实"];
  for (const header of variants) {
    it(`${header} 被识别为栏目（此前整篇退化）`, () => {
      // Before: the literal header line stayed as content and 【未决】 became
      // 「无」 — 「仇」 never reached any column, and detectUnknownColumns (which
      // only scanned 【】) reported nothing.
      const doc = `${header}\n火\n\n【未决】\n仇`;
      const out = normalizeStructuredMemory(doc);
      assert.ok(out.includes("火"), `硬事实内容丢失：${out}`);
      assert.ok(out.includes("仇"), `未决内容丢失：${out}`);
    });
  }

  it("全角形态的未知栏目能被检出", () => {
    const out = detectUnknownColumns("【硬事实】\n火\n\n［奇怪栏目］\n乙");
    assert.deepEqual(out, ["【奇怪栏目】"]);
  });

  it("正文里的普通方括号不被改写", () => {
    const doc = "【硬事实】\n见 [附录] 与 [1] 两条";
    const out = normalizeStructuredMemory(doc);
    assert.ok(out.includes("[附录]") && out.includes("[1]"), out);
  });
});

describe("记忆审计：栏目比对看不见的那类丢失（P0-2）", () => {
  it("归一化不再丢数据，因此审计报 clean 且原因成立", () => {
    const before =
      "重要硬事实：火是主角的弱点。\n\n【时间线】\n第一天进城\n\n【硬事实】\n水\n\n【未决】\n要不要回去";
    const after = normalizeStructuredMemory(before);
    // Before the fix this was `clean` while 「火」 had actually been deleted —
    // the guard's blind spot was exactly the loss it was built to catch.
    assert.ok(after.includes("火"), "前言内容应当存活，审计的 clean 才是真的");
    assert.equal(auditMemory(before, after).verdict, "clean");
  });

  it("前言真的消失时会被报出来（而非静默 clean）", () => {
    const before = "重要硬事实：火是主角的弱点。\n\n【硬事实】\n水";
    const after = "【硬事实】\n水";
    const report = auditMemory(before, after);
    assert.notEqual(report.verdict, "clean");
    const all = [
      ...report.preambleLost,
      ...report.lostProtected.flatMap((l) => l.units),
      ...report.lost.flatMap((l) => l.units),
    ];
    assert.ok(
      all.some((u) => u.includes("火")),
      `应当报告「火」的丢失，实际：${JSON.stringify(report)}`,
    );
  });

  it("同一句不会既算栏目丢失又算前言丢失", () => {
    const before = "重要硬事实：火。\n\n【硬事实】\n水";
    const report = auditMemory(before, "【硬事实】\n水");
    const protectedUnits = report.lostProtected.flatMap((l) => l.units);
    for (const u of report.preambleLost) {
      assert.ok(!protectedUnits.includes(u), `重复报告：${u}`);
    }
    assert.ok(memoryAuditWarnings(report).length > 0);
  });
});

describe("摘要机器块：全部 STATE_PATCH 都被提取并剥离（A-3 / P1-3）", () => {
  const two = [
    "【近期情节】\n逃进仓库",
    '<<<STATE_PATCH>>>{"entries":[{"key":"地点","value":"仓库"}]}<<<END>>>',
    '<<<STATE_PATCH>>>{"entries":[{"key":"敌人","value":"黑衣人"}]}<<<END>>>',
  ].join("\n");

  it("第二个块的 payload 不再泄漏进摘要正文", () => {
    const r = new SummaryEngine().parseStructuredCompress(two);
    assert.ok(!String(r.summaryText).includes("STATE_PATCH"), "标记串泄漏进正文");
    assert.ok(!String(r.summaryText).includes("黑衣人"), "第二块 payload 泄漏进正文");
    assert.ok(String(r.summaryText).includes("逃进仓库"), "真实情节被误删");
  });

  it("两块 entries 合并，什么都不丢", () => {
    const r = new SummaryEngine().parseStructuredCompress(two);
    const raw = JSON.stringify(r.statePatchRaw);
    assert.ok(raw.includes("地点") && raw.includes("仓库"));
    assert.ok(raw.includes("敌人") && raw.includes("黑衣人"));
    assert.equal(r.statePatchCount, 2);
  });

  it("截断的未闭合块仍然从正文里剥掉（原有契约不回退）", () => {
    const r = new SummaryEngine().parseStructuredCompress(
      '【硬事实】\n无\n<<<STATE_PATCH>>>{"entries":[{"key":"地点"',
    );
    assert.ok(!String(r.summaryText).includes("STATE_PATCH"));
    assert.equal(r.statePatchParseFailed, true);
  });
});

describe("入口一致性：plan 与 prepare 同一套校验（A-1 / P1-1）", () => {
  const engine = new CogniStackEngine();
  const dialogue = [{ id: "m1", role: "user" as const, content: "你好" }];
  const good = { dialogue, contextTokenLimit: 4096, tokenCounter: counter, card: { name: "阿铁" } };

  it("合法输入两条都通过", () => {
    assert.ok(engine.plan(good));
    assert.ok(engine.prepare(good));
  });

  const bad: [string, Record<string, unknown>][] = [
    ["缺 profile", { dialogue, contextTokenLimit: 4096, tokenCounter: counter }],
    ["profile 是字符串", { ...good, card: undefined, profile: "阿铁" }],
    ["dialogue 是 null", { ...good, dialogue: null }],
    ["summaryBlocks 不是数组", { ...good, summaryBlocks: "x" }],
    ["缺 tokenCounter", { dialogue, contextTokenLimit: 4096, card: { name: "阿铁" } }],
  ];
  for (const [name, input] of bad) {
    it(`${name}：两条入口同时拒绝`, () => {
      // Before: `plan` returned a full budget precheck for the very inputs
      // `prepare` threw on ("profile (or legacy card) required").
      assert.throws(() => engine.plan(input as never));
      assert.throws(() => engine.prepare(input as never));
    });
  }
});

describe("区间预算不会算出 NaN（A-8 / P2-6）", () => {
  it("contextTokenLimit: Infinity 不再产出 hardFit=NaN", () => {
    // Before: minPromptFloor also became Infinity and the reserve clamp computed
    // Infinity - Infinity, so hardFit was NaN and every `<= hardFit` check
    // silently became false (no ceiling at all).
    const r = new CogniStackEngine().prepare({
      card: { name: "阿铁" },
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      contextTokenLimit: Number.POSITIVE_INFINITY,
      tokenCounter: counter,
    });
    assert.ok(Number.isFinite(r.budget.hardFit), `hardFit 必须是有限数，实际 ${r.budget.hardFit}`);
    assert.ok(Number.isFinite(r.budget.softTrimTokenCap));
    assert.ok(Number.isFinite(r.promptTokens));
    assert.ok(
      r.warnings.some((w) => w.startsWith("context-limit-non-finite")),
      `应给出告警，实际：${JSON.stringify(r.warnings)}`,
    );
  });
});

describe("紧急兜底：先裁系统、后丢对白（P1-13）", () => {
  it("系统块是主因时，八条对白一条都不丢", () => {
    // Before: dialogue was cut to a single orphan `assistant` turn (8 → 1) while
    // the 1504-char rules block stayed at 279 chars, and the warning blamed the
    // dialogue (`dialogue-exceeds-cap`).
    const system = `【规则】${"R".repeat(1500)}`;
    const dialogue: RpMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      dialogue.push({ role: i % 2 ? "assistant" : "user", content: `短对白${i + 1}` });
    }
    const out = fitMessagesUnderTokenCap([{ role: "system", content: system }, ...dialogue], 288, counter);
    const kept = out.messages.filter((m) => m.role !== "system");
    assert.equal(kept.length, 8, `对白不应被丢弃，实际保留 ${kept.length} 条`);
    assert.equal(kept[0]!.role, "user", "UA 配对必须完整");
    const shipped = out.messages.reduce((n, m) => n + counter.count(m.content), 0);
    assert.ok(shipped <= 288, `不得超预算，实际 ${shipped}`);
  });

  it("对白本身超预算时仍然会丢（原有兜底不被削弱）", () => {
    const dialogue: RpMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      dialogue.push({ role: i % 2 ? "assistant" : "user", content: "很长的一段对白内容".repeat(6) });
    }
    const out = fitMessagesUnderTokenCap(dialogue, 100, counter);
    const shipped = out.messages.reduce((n, m) => n + counter.count(m.content), 0);
    assert.ok(shipped <= 100, `不得超预算，实际 ${shipped}`);
    assert.ok(out.dropped > 0);
  });

  it("大规模输入保持近线性（O(n^2) 已消除）", () => {
    // Before: n=8000 took 15222ms in a single call. Kept as a smoke bound rather
    // than an exact time so the test is not machine-dependent.
    const many: RpMessage[] = [];
    for (let i = 0; i < 8000; i += 1) {
      many.push({ role: i % 2 ? "assistant" : "user", content: "内容内容内容内容内容内容内容内容" });
    }
    const started = Date.now();
    const out = fitMessagesUnderTokenCap(many, 2000, counter);
    const elapsed = Date.now() - started;
    assert.ok(out.messages.length > 0);
    assert.ok(elapsed < 2000, `n=8000 应远快于旧实现的 15s，实际 ${elapsed}ms`);
  });
});

describe("预算归因描述的是真正发出去的 prompt（P2-21）", () => {
  it("untouched 只在真的没裁时成立", () => {
    const before = [
      { text: "规则".repeat(100), priority: 100 },
      { text: "lore", priority: 60 },
    ];
    const untouched = attributeBudget(before, before, counter);
    assert.equal(untouched.untouched, true);

    const clipped = attributeBudget(before, [{ text: "规则".repeat(10), priority: 100 }], counter);
    assert.equal(clipped.untouched, false);
    assert.ok(clipped.clippedTokens > 0);
  });
});

describe("记忆化计数器的统计口径（P2-5）", () => {
  it("distinct 在淘汰后触顶，misses 仍精确 —— 引用后者", () => {
    // `distinct` is "entries held now", not "distinct strings seen". A caller
    // (bench) used to quote it as a distinct-string count, which under-reports
    // exactly when the memo is under pressure.
    const memo = memoizeCounter(exactCharTokenCounter(), { maxEntries: 64 });
    const total = 200;
    for (let i = 0; i < total; i += 1) memo.count(`string-${i}`);
    const st = memo.stats();
    assert.equal(st.misses, total, "misses 必须精确");
    assert.equal(st.distinct, 64, "distinct 触顶于 maxEntries");
    assert.ok(st.evictions > 0, "应记录淘汰");
  });

  it("无淘汰时两者一致（既有契约不回退）", () => {
    const memo = memoizeCounter(exactCharTokenCounter(), { maxEntries: 512 });
    for (let i = 0; i < 20; i += 1) memo.count(`s-${i}`);
    const st = memo.stats();
    assert.equal(st.distinct, 20);
    assert.equal(st.misses, 20);
    assert.equal(st.evictions, 0);
  });
});

describe("装配缓存键覆盖自定义 card 端口（A-14 / P2-22）", () => {
  it("宿主 resolver 渲染的额外字段变化时不会命中旧缓存", () => {
    // The key used to enumerate exactly the 8 fields `defaultCardResolver` reads.
    // `card` is a port, so a host resolver may render anything else — measured:
    // editing only `creator` returned `cacheHit: true` with the OLD value still in
    // the prompt. Silent wrong prompts are the worst failure mode for a cache.
    const cardPort = {
      resolve(card: unknown) {
        const c = card as Record<string, unknown>;
        return { ...c, system_prompt: `creator=${String(c.creator ?? "")}` };
      },
    };
    const engine = new CogniStackEngine({ collaborators: { card: cardPort as never } });
    const input = (creator: string) => ({
      card: { name: "阿铁", creator },
      dialogue: [{ id: "m1", role: "user" as const, content: "你好" }],
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "card-port",
    });

    const first = engine.prepare(input("ALICE"));
    assert.ok(first.messages.some((m) => String(m.content).includes("ALICE")), "首次应含 ALICE");

    const second = engine.prepare(input("BOB"));
    assert.equal(second.diagnostics.cacheHit, false, "字段变了就不该命中缓存");
    assert.ok(second.messages.some((m) => String(m.content).includes("BOB")), "应含新值 BOB");
    assert.ok(!second.messages.some((m) => String(m.content).includes("ALICE")), "不应残留旧值");
  });

  it("键顺序不同的等价 profile 仍命中缓存（避免假性失效）", () => {
    const engine = new CogniStackEngine();
    const mk = (profile: Record<string, unknown>) => ({
      card: profile,
      dialogue: [{ id: "m1", role: "user" as const, content: "你好" }],
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "order-fp",
    });
    engine.prepare(mk({ name: "阿铁", description: "搭子" }));
    const reordered = engine.prepare(mk({ description: "搭子", name: "阿铁" }));
    assert.equal(reordered.diagnostics.cacheHit, true, "键顺序不应影响指纹");
  });
});

describe("记忆信封往返（P2-16 的防回归守卫）", () => {
  it("serialize → deserialize 对空 blocks 也成立", () => {
    // Context: a sub-agent reported `deserializeMemoryState` relying on
    // `blocks.length` and throwing on malformed envelopes. That claim did NOT
    // reproduce (`[null]` is filtered to `[]`; every re-run of the round trip
    // passed). One throw *was* observed once and could not be reproduced in three
    // subsequent attempts with the identical input, so it is recorded as
    // unreproduced rather than as a defect — but this test is the tripwire: if it
    // ever fires, that intermittent crash is real and here is the input shape.
    const env = serializeMemoryState({
      summaryBlocks: [],
      summarizedThroughMessageId: "m1",
      summarizedCount: 1,
    });
    assert.equal(env.blocks.length, 0);
    const back = deserializeMemoryState(env);
    assert.deepEqual(back.repaired, []);
    assert.equal(back.state.summaryBlocks?.length ?? 0, 0);
  });

  it("正常块的往返不丢内容，且 repaired 为空", () => {
    const env = serializeMemoryState({
      summaryBlocks: [
        { id: "b1", text: "【硬事实】\n火", throughMessageId: "m1", pairCount: 1 },
      ],
      summarizedThroughMessageId: "m1",
      summarizedCount: 1,
    });
    assert.equal(env.blocks.length, 1);
    const back = deserializeMemoryState(env);
    assert.deepEqual(back.repaired, []);
    assert.ok(JSON.stringify(back.state.summaryBlocks ?? []).includes("火"), "内容不得丢失");
  });

  it("畸形块被安全过滤而不是抛错", () => {
    const env = serializeMemoryState({ summaryBlocks: [null as never] });
    assert.equal(env.blocks.length, 0);
    assert.doesNotThrow(() => deserializeMemoryState(env));
  });
});

describe("默认缓存 scope 命名统一（A-15 / P3-22）", () => {
  it("无 cacheScope 时 assemble 与 prefix 用同一个名字（clearCache 能清干净）", () => {
    const engine = new CogniStackEngine();
    const input = {
      card: { name: "阿铁" },
      dialogue: [
        { id: "m1", role: "user" as const, content: "你好" },
        { id: "m2", role: "assistant" as const, content: "你好。" },
      ],
      contextTokenLimit: 4096,
      tokenCounter: counter,
    };
    engine.prepare(input);
    const second = engine.prepare(input);
    assert.equal(second.diagnostics.cacheHit, true, "同输入应当命中装配缓存");

    engine.clearCache();
    const third = engine.prepare(input);
    assert.equal(third.diagnostics.cacheHit, false, "clearCache() 之后不应再命中");
  });
});
