import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  approximateTokenCounter,
  countMessages,
  exactCharTokenCounter,
  memoizeCounter,
} from "../src/fusion/counter";
import { cacheKey, contentFp, contentFpCached, djb2, djb2b } from "../src/fusion/fingerprint";
import {
  buildPrepareChecksum,
  buildTurnObservability,
  classifyPrepareWarning,
  formatGuardWarning,
  partitionPrepareWarnings,
  type ObservabilitySource,
} from "../src/fusion/prepareWarnings";
import type { CogniStackPrepareResult, PrepareTurnResult } from "../src/index";
import type { MemoryStatus, TokenCounter } from "../src/types";

describe("memoizeCounter — 命中 / 未命中 / 统计", () => {
  it("相同内容第二次起命中，distinct 只计一次", () => {
    const m = memoizeCounter(exactCharTokenCounter());
    assert.equal(m.count("abcdef"), 6);
    let s = m.stats();
    assert.deepEqual(s, { hits: 0, misses: 1, distinct: 1, evictions: 0 });

    assert.equal(m.count("abcdef"), 6);
    s = m.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.distinct, 1);
  });

  it("空串返回 0 且不污染统计", () => {
    const m = memoizeCounter(exactCharTokenCounter());
    assert.equal(m.count(""), 0);
    assert.deepEqual(m.stats(), { hits: 0, misses: 0, distinct: 0, evictions: 0 });
  });

  it("相同内容的不同字符串对象命中同一缓存条目", () => {
    const m = memoizeCounter(exactCharTokenCounter());
    const a = "hello";
    const b = ["hel", "lo"].join("");
    assert.equal(m.count(a), 5);
    assert.equal(m.count(b), 5);
    assert.equal(m.stats().hits, 1);
    assert.equal(m.stats().distinct, 1);
  });

  it("超过容量后淘汰最旧条目并计入 evictions", () => {
    const m = memoizeCounter(exactCharTokenCounter(), { maxEntries: 64 });
    for (let i = 0; i < 65; i += 1) m.count(`s${i}`);
    const s = m.stats();
    assert.equal(s.distinct, 64);
    assert.equal(s.evictions, 1);
  });

  it("容量下限为 64", () => {
    const m = memoizeCounter(exactCharTokenCounter(), { maxEntries: 1 });
    for (let i = 0; i < 65; i += 1) m.count(`s${i}`);
    assert.ok(m.stats().distinct <= 64);
  });

  it("LRU 会刷新命中项，热条目不被淘汰", () => {
    const m = memoizeCounter(exactCharTokenCounter(), { maxEntries: 64 });
    m.count("hot");
    for (let i = 0; i < 63; i += 1) m.count(`f${i}`); // 缓存满（64）
    m.count("hot"); // 命中并刷新插入序
    m.count("extra"); // 触发一次淘汰
    // hot 仍应命中（未被淘汰）
    const before = m.stats().hits;
    m.count("hot");
    assert.equal(m.stats().hits, before + 1);
  });

  it("非有限结果（NaN / Infinity）不被记忆化", () => {
    let calls = 0;
    const flaky: TokenCounter = {
      count(text: string) {
        calls += 1;
        return calls === 1 ? Number.NaN : text ? text.length : 0;
      },
    };
    const m = memoizeCounter(flaky);
    assert.ok(Number.isNaN(m.count("x")));
    assert.equal(m.count("x"), 1); // 未缓存 → 重新调用后端
    assert.equal(calls, 2);
    assert.equal(m.stats().distinct, 1); // 只有第 2 次（有限值）被缓存
  });

  it("始终返回 Infinity 时 miss 递增且不缓存", () => {
    const m = memoizeCounter({ count: () => Number.POSITIVE_INFINITY });
    m.count("a");
    m.count("a");
    m.count("a");
    assert.equal(m.stats().distinct, 0);
    assert.equal(m.stats().misses, 3);
    assert.equal(m.stats().hits, 0);
  });

  it("负数（有限）会被记忆化（与 NaN/Infinity 区分）", () => {
    const m = memoizeCounter({ count: () => -7 });
    assert.equal(m.count("a"), -7);
    assert.equal(m.count("a"), -7);
    assert.equal(m.stats().hits, 1);
  });

  it("stats() 每次返回新的独立对象", () => {
    const m = memoizeCounter(exactCharTokenCounter());
    m.count("z");
    assert.notEqual(m.stats(), m.stats());
    assert.deepEqual(m.stats(), m.stats());
  });
});

describe("counters", () => {
  it("exactCharTokenCounter = 字符数", () => {
    assert.equal(exactCharTokenCounter().count("abc"), 3);
    assert.equal(exactCharTokenCounter().count(""), 0);
  });

  it("approximateTokenCounter 对 CJK 与其它字符加权后向上取整", () => {
    const c = approximateTokenCounter();
    // 2 CJK × 0.75 = 1.5；4 latin × 0.25 = 1 → 2.5 → ceil 3
    assert.equal(c.count("中文abcd"), 3);
    assert.equal(c.count(""), 0);
  });

  it("countMessages 累加每条内容", () => {
    const c = exactCharTokenCounter();
    assert.equal(countMessages([{ content: "ab" }, { content: "cde" }], c), 5);
  });
});

describe("fingerprint — contentFp / djb2 / djb2b / cacheKey", () => {
  it("空 / null / undefined 归一为 \"0\"", () => {
    assert.equal(contentFp(""), "0");
    assert.equal(contentFp(null), "0");
    assert.equal(contentFp(undefined), "0");
  });

  it("相同内容 → 相同指纹；中间字符改变（长度不变）→ 指纹变化", () => {
    assert.equal(contentFp("abcdef"), contentFp("abcdef"));
    const a = contentFp("aaXaa");
    const b = contentFp("aaYaa");
    assert.notEqual(a, b, "中间字符编辑必须改变指纹");
    assert.equal(a.split(":")[0], b.split(":")[0], "长度前缀相同");
  });

  it("指纹携带长度前缀", () => {
    assert.ok(contentFp("abc").startsWith("3:"));
    assert.ok(contentFp("abcd").startsWith("4:"));
  });

  it("djb2 / djb2b 对部件顺序敏感，且部件合并改变结果", () => {
    assert.notEqual(djb2(["a", "b"]), djb2(["b", "a"]));
    assert.notEqual(djb2(["ab"]), djb2(["a", "b"]));
    assert.notEqual(djb2b(["a", "b"]), djb2b(["b", "a"]));
    assert.notEqual(djb2b(["ab"]), djb2b(["a", "b"]));
    assert.equal(djb2(["a", "b"]), djb2(["a", "b"]));
  });

  it("cacheKey 含总长度段且对顺序敏感", () => {
    const k = cacheKey(["ab", "cde"]);
    assert.equal(k, cacheKey(["ab", "cde"]));
    assert.notEqual(k, cacheKey(["cde", "ab"]));
    assert.equal(k.split(":")[2], (5).toString(36));
  });

  it("contentFpCached 与 contentFp 结果完全一致（含超长走非缓存分支）", () => {
    const samples = ["", "短", "abcdef", "中".repeat(4096), "长".repeat(5000)];
    for (const s of samples) assert.equal(contentFpCached(s), contentFp(s));
    assert.equal(contentFpCached(null), "0");
    assert.equal(contentFpCached(undefined), "0");
  });

  it("缓存容量溢出后仍返回正确指纹", () => {
    const first = "first-entry-" + "甲".repeat(10);
    assert.equal(contentFpCached(first), contentFp(first));
    for (let i = 0; i < 600; i += 1) contentFpCached(`evict-${i}`);
    // 早期条目已被 FIFO 淘汰，但重新计算仍须与此前一致
    assert.equal(contentFpCached(first), contentFp(first));
  });
});

describe("prepareWarnings — classify / partition", () => {
  it("assemble / compress 失败 → degraded", () => {
    assert.equal(classifyPrepareWarning("assemble-failed:boom"), "degraded");
    assert.equal(classifyPrepareWarning("degraded:compress-failed:x"), "degraded");
    assert.equal(classifyPrepareWarning("  degraded:assemble-failed:y  "), "degraded");
  });

  it("软失败与预算类 → notice", () => {
    for (const w of [
      "lore-failed:boom",
      "world-book-failed:boom",
      "prompt-budget-trimmed:1",
      "prompt-budget-unreachable",
      "watermark-off-active-path",
      "ciphertext-skipped",
      "branch-memory-empty",
      "vector-dim-mismatch",
      "vector-retrieve-failed",
      "prepare-checksum-stale",
    ]) {
      assert.equal(classifyPrepareWarning(w), "notice", w);
    }
  });

  it("其它 → info", () => {
    assert.equal(classifyPrepareWarning("world-book-no-hit"), "info");
  });

  it("配置 / 尺寸类信号 → notice（含「没给预算」）", () => {
    // `budget-missing-context-limit` used to fall through to `info`, so a host
    // that forgot `contextTokenLimit` got an unbounded prompt and nothing to act
    // on in the dashboard. It is deliberately *notice* and not `degraded`: not
    // passing a limit is a normal state in this codebase's own fixtures.
    for (const w of [
      "budget-missing-context-limit",
      "hard-fit-enforced:1500->900",
      "hard-fit-degenerate:0",
      "soft-trim-defaulted:context*0.95",
      "soft-trim-clamped:completion-reserve",
      "lore-capped:24",
      "lore-trimmed:3->1",
      "world-book-capped:24",
    ]) {
      assert.equal(classifyPrepareWarning(w), "notice", w);
    }
  });

  it("数据丢失类信号 → degraded（修复前全部落到 info，整轮不会被标记）", () => {
    // Measured before the fix: with `softTrimOff` and a long rules block these
    // three fired while `severity.degraded` stayed empty and `isDegraded` was
    // false — the worst outcomes were the least visible.
    for (const w of [
      "hard-fit-violated:300>288",
      "emergency-dialogue-window:dropped-8",
      "dialogue-system-role-dropped",
      "dialogue-role-dropped:tool",
    ]) {
      assert.equal(classifyPrepareWarning(w), "degraded", w);
    }
  });

  it("记忆块被策略压缩 → notice（有损是设计，但不能静默）", () => {
    assert.equal(classifyPrepareWarning("memory-blocks-compacted:20->3"), "notice");
  });

  it("partitionPrepareWarnings 返回四个字段并按严重度分组", () => {
    const out = partitionPrepareWarnings([
      "assemble-failed:x",
      "world-book-no-hit",
      "prompt-budget-trimmed:y",
      "lore-failed:z",
    ]);
    assert.deepEqual(out.degraded, ["assemble-failed:x"]);
    assert.deepEqual(out.notices, ["prompt-budget-trimmed:y", "lore-failed:z"]);
    assert.deepEqual(out.info, ["world-book-no-hit"]);
    assert.equal(out.isDegraded, true);
  });

  it("null / undefined 输入 → 全部为空、isDegraded=false", () => {
    for (const input of [null, undefined]) {
      const out = partitionPrepareWarnings(input);
      assert.deepEqual(out.degraded, []);
      assert.deepEqual(out.notices, []);
      assert.deepEqual(out.info, []);
      assert.equal(out.isDegraded, false);
    }
  });

  it("formatGuardWarning 给临界标签加 degraded 前缀并截断 detail", () => {
    assert.equal(formatGuardWarning("assemble", "x".repeat(100)), `degraded:assemble-failed:${"x".repeat(60)}`);
    assert.equal(formatGuardWarning("lore", "boom"), "lore-failed:boom");
  });
});

function status(over: Partial<MemoryStatus> = {}): MemoryStatus {
  return {
    dialogueCount: 6,
    summarizedCount: 0,
    pending: 6,
    pendingPairs: 3,
    pendingChars: 30,
    contextUsed: 2000,
    contextTriggerAt: 4000,
    shouldSummarize: true,
    compressReason: "context",
    ...over,
  };
}

describe("buildTurnObservability", () => {
  it("汇总 prompt / 待压 / 压缩原因 / 降级为 chip 与 hint", () => {
    const obs = buildTurnObservability({
      promptTokens: 1500,
      promptChars: 3000,
      memory: status({ compressReason: "context" }),
      loreInjected: [{ id: "l1", name: "显卡" }],
      warnings: ["assemble-failed:boom"],
      steps: ["assemble", "trim"],
    });
    assert.equal(obs.promptTokens, 1500);
    assert.equal(obs.warningCount, 1);
    assert.equal(obs.loreCount, 1);
    assert.equal(obs.isDegraded, true);
    assert.ok(obs.memoryChip.includes("1.5k tok"));
    assert.ok(obs.memoryChip.includes("待压 3对"));
    assert.ok(obs.memoryChip.includes("①阈值"));
    assert.ok(obs.memoryChip.includes("降级"));
    assert.ok(obs.detailHint.includes("降级: assemble-failed:boom"));
    assert.ok(obs.detailHint.includes("世界书: 显卡"));
  });

  it("无 prompt 时 chip 回退为 占用/阈值，batch 原因用 ②", () => {
    const obs = buildTurnObservability({
      promptTokens: 0,
      promptChars: 0,
      memory: status({ compressReason: "batch" }),
      loreInjected: [],
      warnings: [],
      steps: [],
    });
    assert.ok(obs.memoryChip.includes("②回合"));
    assert.ok(obs.memoryChip.includes("/"));
  });

  it("所有信号为空 → 「上下文就绪」且 detailHint 为空", () => {
    const obs = buildTurnObservability({
      promptTokens: 0,
      promptChars: 0,
      memory: status({ pendingPairs: 0, contextUsed: 0, contextTriggerAt: 0, compressReason: null }),
      loreInjected: [],
      warnings: [],
      steps: [],
    });
    assert.equal(obs.memoryChip, "上下文就绪");
    assert.equal(obs.detailHint, "");
    assert.equal(obs.isDegraded, false);
  });

  it("showDebugSteps 才输出步骤", () => {
    const base = {
      promptTokens: 10,
      promptChars: 10,
      memory: status(),
      loreInjected: [],
      warnings: [],
      steps: ["a", "b"],
    };
    assert.ok(!buildTurnObservability(base).detailHint.includes("步骤"));
    assert.ok(buildTurnObservability(base, { showDebugSteps: true }).detailHint.includes("步骤: a → b"));
  });

  it("匿名 lore 只报数量", () => {
    const obs = buildTurnObservability({
      promptTokens: 1,
      promptChars: 1,
      memory: status(),
      loreInjected: [{ id: "l1", name: "" }, { id: "l2", name: "" }],
      warnings: [],
      steps: [],
    });
    assert.equal(obs.loreCount, 2);
    assert.ok(obs.detailHint.includes("世界书 ×2"));
  });
});

describe("buildPrepareChecksum", () => {
  const base = {
    cardName: "阿铁",
    summaryJoined: "摘要",
    summaryBlockIds: ["a", "b"],
    worldEntryIds: ["w1"],
    throughMessageId: "m6",
    activeLeafId: "leaf-1",
    vectorHitCount: 3,
  };

  it("同输入稳定且带 pchk_ 前缀", () => {
    const a = buildPrepareChecksum(base);
    const b = buildPrepareChecksum(base);
    assert.equal(a, b);
    assert.ok(a.startsWith("pchk_"));
  });

  it("任一字段变化 → 校验和变化", () => {
    const ref = buildPrepareChecksum(base);
    const variants = [
      { ...base, cardName: "阿铁2" },
      { ...base, summaryJoined: "摘要改了" },
      { ...base, summaryBlockIds: ["a"] },
      { ...base, worldEntryIds: [] },
      { ...base, throughMessageId: "m7" },
      { ...base, activeLeafId: "leaf-2" },
      { ...base, vectorHitCount: 4 },
    ];
    for (const v of variants) assert.notEqual(buildPrepareChecksum(v), ref);
  });

  it("缺省字段等价于空值", () => {
    assert.equal(buildPrepareChecksum({}), buildPrepareChecksum({ cardName: "", summaryJoined: "" }));
  });
});

/**
 * 类型面防漂移（ADR-004）。
 *
 * 这里断言的是**编译期**性质：`{} as X` 的赋值一旦不可行，tsc 就会失败，
 * 测试根本跑不起来。运行时断言只是让这层保护在输出里可见。
 */
describe("类型面：公开结果类型不漂移（ADR-004）", () => {
  it("PrepareTurnResult 与 CogniStackPrepareResult 双向可互赋（同一个类型）", () => {
    const real = {} as CogniStackPrepareResult;
    const viaAlias: PrepareTurnResult = real;
    const back: CogniStackPrepareResult = viaAlias;
    assert.ok(back === real);
  });

  it("引擎结果可直接喂给 buildTurnObservability 的窄输入面", () => {
    const result = {} as CogniStackPrepareResult;
    const narrow: ObservabilitySource = result;
    assert.ok(narrow === result);
  });
});
