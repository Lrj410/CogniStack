import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CogniStackEngine,
  CogniStackTelemetry,
  createFunctionTokenCounter,
  createHttpTokenCounter,
  counterIdentity,
  deserializeMemoryState,
  detectUnknownColumns,
  exactCharTokenCounter,
  Histogram,
  MEMORY_COLUMN_ALIASES,
  MEMORY_ENVELOPE_VERSION,
  migrateStructuredMemoryDocument,
  normalizeStructuredMemory,
  PrefixTracker,
  serializeMemoryState,
  splitMemoryColumns,
  warningClass,
  type SummaryBlock,
} from "../src/index";

const counter = exactCharTokenCounter();

function prepareInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    card: { name: "阿铁", description: "技术搭子" },
    dialogue: [
      { id: "m1", role: "user", content: "你好" },
      { id: "m2", role: "assistant", content: "你好。" },
    ],
    contextTokenLimit: 4096,
    tokenCounter: counter,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* G-1  分词器身份 + 缺失的 CACHE_MISS 生产者                            */
/* ------------------------------------------------------------------ */

describe("G-1 tokenizer identity", () => {
  it("内置计数器带可识别身份，未命名计数器报 unnamed 而不是空", () => {
    assert.equal(counterIdentity(exactCharTokenCounter()), "char-exact(test-only)");
    assert.equal(counterIdentity({ count: () => 1 }), "unnamed");
    assert.equal(counterIdentity(null), "unnamed");
    assert.equal(counterIdentity({ count: () => 1, id: "   " }), "unnamed");
  });

  it("prepare 的 diagnostics 带上计数器身份", () => {
    const engine = new CogniStackEngine();
    const result = engine.prepare(prepareInput() as never);
    assert.equal(result.diagnostics.counterId, "char-exact(test-only)");
  });

  it("createFunctionTokenCounter 记忆化并保留身份", () => {
    let calls = 0;
    const c = createFunctionTokenCounter((t) => {
      calls += 1;
      return t.length;
    }, { id: "tiktoken:cl100k_base" });
    assert.equal(c.count("abcd"), 4);
    assert.equal(c.count("abcd"), 4);
    assert.equal(calls, 1, "第二次应命中缓存");
    assert.equal(c.stats().hits, 1);
    assert.equal(c.id, "tiktoken:cl100k_base");
  });
});

/** Fake /tokenize: returns one token per char, records requests. */
function fakeTokenize(record: { count: number }, fail = false): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    record.count += 1;
    if (fail) return new Response("boom", { status: 500, statusText: "Server Error" });
    const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
    const text = String(body.content ?? "");
    return new Response(JSON.stringify({ tokens: new Array<number>(text.length).fill(1) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("G-1 / G-1b createHttpTokenCounter（CACHE_MISS 契约的唯一生产者）", () => {
  it("count() 命中缓存前抛 CACHE_MISS，hydrate 后可同步计数", async () => {
    const calls = { count: 0 };
    const c = createHttpTokenCounter({
      url: "http://127.0.0.1:8080/tokenize",
      fetchImpl: fakeTokenize(calls),
    });
    assert.equal(c.id, "http:http://127.0.0.1:8080/tokenize");

    assert.throws(
      () => c.count("你好"),
      (err: unknown) => {
        const e = err as { code?: string; missText?: string };
        assert.equal(e.code, "CACHE_MISS");
        assert.equal(e.missText, "你好");
        return true;
      },
    );

    await c.hydrate(["你好", "世界", "你好"]);
    assert.equal(calls.count, 2, "重复串只发一次请求");
    assert.equal(c.count("你好"), 2);
    assert.equal(c.count("世界"), 2);
    assert.equal(c.count(""), 0, "空串不进网络");

    assert.equal(await c.hydrateOne("新的串"), 3);
  });

  it("HTTP 失败直接抛错，绝不退化成估算值", async () => {
    const c = createHttpTokenCounter({
      url: "http://x/tokenize",
      fetchImpl: fakeTokenize({ count: 0 }, true),
    });
    await assert.rejects(() => c.hydrateOne("abc"), /HTTP 500/);
    // 关键：失败后 count() 仍然是 CACHE_MISS，而不是给出一个假数字。
    assert.throws(() => c.count("abc"), /CACHE_MISS|token cache miss/);
  });

  it("无法识别的响应形状抛错，并提示用 parseCount（不猜）", async () => {
    const c = createHttpTokenCounter({
      url: "http://x/tokenize",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ strange: true }), { status: 200 })) as unknown as typeof fetch,
    });
    await assert.rejects(() => c.hydrateOne("abc"), /parseCount/);
  });

  it("自定义 parseCount 可用", async () => {
    const c = createHttpTokenCounter({
      url: "http://x/tokenize",
      parseCount: (json) => (json as { n: number }).n,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ n: 7 }), { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(await c.hydrateOne("abc"), 7);
  });

  it("端到端：engine.prepareAsync 用 HTTP 计数器跑通，不需要任何额外胶水", async () => {
    const c = createHttpTokenCounter({
      url: "http://127.0.0.1:8080/tokenize",
      fetchImpl: fakeTokenize({ count: 0 }),
    });
    const engine = new CogniStackEngine();
    const result = await engine.prepareAsync({
      ...prepareInput(),
      tokenCounter: c,
      hydrate: (texts: string[]) => c.hydrate(texts),
      hydrateOne: (text: string) => c.hydrateOne(text),
    } as never);
    assert.ok(result.promptTokens > 0, "HTTP 计数器下也应有真实 token 数");
    assert.equal(result.diagnostics.counterId, "http:http://127.0.0.1:8080/tokenize");
    assert.deepEqual(result.diagnostics.severity.degraded, [], "不应降级");
  });
});

/* ------------------------------------------------------------------ */
/* G-3  记忆 schema 版本化 / 别名                                       */
/* ------------------------------------------------------------------ */

describe("G-3 记忆栏目别名与迁移", () => {
  it("别名栏目被识别为规范栏目，而不是当作正文塞进硬事实", () => {
    const legacy = "【长期事实】\n用户是阿铁\n\n【待决】\n显卡驱动版本";
    const cols = splitMemoryColumns(legacy);
    const titles = cols.map((c) => c.title);
    assert.ok(titles.includes("【硬事实】"), `应识别【长期事实】为【硬事实】，实际：${titles.join("/")}`);
    assert.ok(titles.includes("【未决】"), `应识别【待决】为【未决】，实际：${titles.join("/")}`);

    const normalized = normalizeStructuredMemory(legacy);
    assert.match(normalized, /【硬事实】\n用户是阿铁/);
    assert.match(normalized, /【未决】\n显卡驱动版本/);
    // 规范顺序：硬事实在最前
    assert.ok(normalized.indexOf("【硬事实】") < normalized.indexOf("【未决】"));
  });

  it("别名是括号自定界的，不会互相误匹配", () => {
    // 【事实】 不应在 【硬事实】 内部命中
    const cols = splitMemoryColumns("【硬事实】\n只有这条");
    assert.equal(cols.filter((c) => c.title === "【硬事实】").length, 1);
    assert.equal(cols.length, 1, `不应产生额外栏目：${JSON.stringify(cols)}`);
  });

  it("每个别名都映射到某个规范栏目（表本身不能有死条目）", () => {
    for (const [canonical, aliases] of Object.entries(MEMORY_COLUMN_ALIASES)) {
      for (const alias of aliases) {
        assert.notEqual(alias, canonical, `${alias} 不该同时是规范名与别名`);
        // 别名彼此不重复
      }
    }
  });

  it("未知栏目被探测出来（这是静默退化的入口）", () => {
    const unknown = detectUnknownColumns("【硬事实】\nx\n\n【新的奇怪栏目】\ny\n\n【记忆块 1/1】\nz");
    assert.deepEqual(unknown, ["【新的奇怪栏目】"]);
    assert.deepEqual(detectUnknownColumns("【硬事实】\nx"), []);
  });

  it("migrate 报告改写了什么、以及认不出的栏目", () => {
    const report = migrateStructuredMemoryDocument("【核心事实】\n甲\n\n【幻觉栏目】\n乙");
    assert.deepEqual(report.rewritten, [{ from: "【核心事实】", to: "【硬事实】" }]);
    assert.deepEqual(report.unknown, ["【幻觉栏目】"]);
    assert.equal(report.changed, true);
    assert.match(report.text, /【硬事实】\n甲/);

    const clean = migrateStructuredMemoryDocument("【硬事实】\n甲");
    assert.deepEqual(clean.rewritten, []);
    assert.deepEqual(clean.unknown, []);
  });
});

/* ------------------------------------------------------------------ */
/* G-4  记忆状态信封                                                    */
/* ------------------------------------------------------------------ */

function block(id: string, throughMessageId: string, pairCount: number): SummaryBlock {
  return { id, text: `【硬事实】\n${id}`, throughMessageId, pairCount };
}

describe("G-4 记忆状态信封", () => {
  it("往返无损", () => {
    const env = serializeMemoryState({
      summaryBlocks: [block("b1", "m2", 1), block("b2", "m4", 1)],
      summarizedThroughMessageId: "m4",
      summarizedCount: 2,
      loreRuntime: { stickyRemaining: { e1: 3 } },
    });
    assert.equal(env.kind, "cognistack-memory");
    assert.equal(env.version, MEMORY_ENVELOPE_VERSION);

    const back = deserializeMemoryState(env);
    assert.deepEqual(back.repaired, []);
    assert.equal(back.state.summarizedThroughMessageId, "m4");
    assert.equal(back.state.summarizedCount, 2);
    assert.deepEqual(back.state.summaryBlocks?.map((b) => b.id), ["b1", "b2"]);
    assert.deepEqual(back.state.loreRuntime, { stickyRemaining: { e1: 3 } });
  });

  it("summarizedCount 原样保留：它是消息数，不能拿块的 pairCount（回合对数）去校验", () => {
    /*
     * 回归：这里原来用 `sum(block.pairCount)` 去校验并改写 summarizedCount，
     * 但两者单位不同——`nextSummarizedCount` 来自 toSummarizeSlice 的 lastEnd+1
     * （**消息条数**），而 pairCount 是"折进这个块的完整 UA **对**数"。
     * 后果是每次读盘都误报修复并把水位改成一个错的值。
     */
    const env = serializeMemoryState({
      summaryBlocks: [block("b1", "m2", 2)],
      summarizedThroughMessageId: "m2",
      summarizedCount: 5,
    });
    const back = deserializeMemoryState(env);
    assert.equal(back.state.summarizedCount, 5, "存进去是多少就是多少，不许按对/条换算出假水位");
    assert.ok(
      !back.repaired.some((r) => r.startsWith("summarized-count-repaired")),
      "不得改写水位",
    );
  });

  it("有块但 count 为 0 → 只标记，不改写（引擎会按 through-id 重新锚定）", () => {
    const env = serializeMemoryState({
      summaryBlocks: [block("b1", "m2", 1)],
      summarizedThroughMessageId: "m2",
      summarizedCount: 1,
    });
    const back = deserializeMemoryState({ ...env, summarizedCount: 0 });
    assert.equal(back.state.summarizedCount, 0);
    assert.ok(back.repaired.includes("summarized-count-missing"));
  });

  it("缺 through-id 时从最后一个块恢复（而不是宣布没有记忆）", () => {
    const env = serializeMemoryState({
      summaryBlocks: [block("b1", "m2", 1), block("b2", "m6", 1)],
      summarizedThroughMessageId: "m6",
      summarizedCount: 2,
    });
    const broken = { ...env, summarizedThroughMessageId: null };
    const back = deserializeMemoryState(broken);
    assert.equal(back.state.summarizedThroughMessageId, "m6");
    assert.ok(back.repaired.includes("through-id-recovered-from-blocks"));
  });

  it("丢块而不是让缺 through-id 的块进入列表", () => {
    const env = serializeMemoryState({
      summaryBlocks: [block("b1", "m2", 1)],
      summarizedThroughMessageId: "m2",
      summarizedCount: 1,
    });
    const dirty = { ...env, blocks: [...env.blocks, { id: "x", text: "abc" }] };
    const back = deserializeMemoryState(dirty);
    assert.equal(back.state.summaryBlocks?.length, 1);
    assert.ok(back.repaired.includes("block-missing-through-id"));
  });

  it("未来版本拒绝导入（不猜格式）", () => {
    const back = deserializeMemoryState({
      kind: "cognistack-memory",
      version: MEMORY_ENVELOPE_VERSION + 5,
      blocks: [block("b1", "m2", 1)],
      summarizedCount: 1,
    });
    assert.deepEqual(back.state.summaryBlocks, []);
    assert.ok(back.repaired.some((r) => r.startsWith("version-ahead:")));
  });

  it("外来 / 坏数据不抛错，降级为无记忆并说明原因", () => {
    const foreign = deserializeMemoryState({ foo: 1 });
    assert.equal(foreign.foreign, true);
    assert.deepEqual(foreign.repaired, ["not-a-cognistack-envelope"]);

    const badJson = deserializeMemoryState("{oops");
    assert.equal(badJson.foreign, true);
    assert.deepEqual(badJson.repaired, ["not-json"]);

    const notObject = deserializeMemoryState("42");
    assert.equal(notObject.foreign, true);
  });
});

/* ------------------------------------------------------------------ */
/* G-7  前缀稳定性                                                      */
/* ------------------------------------------------------------------ */

describe("G-7 前缀复用诊断（与 assembleCacheHit 区分）", () => {
  it("首轮不可比较；追加式增长复用率 1.0 且无漂移", () => {
    const engine = new CogniStackEngine();
    const base = {
      card: { name: "阿铁", description: "技术搭子" },
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "chat-1",
    };
    const t1 = engine.prepare({ ...base, dialogue: [{ id: "m1", role: "user", content: "你好" }] } as never);
    assert.equal(t1.prefixStability.comparable, false, "首轮没有可比对象");

    const t2 = engine.prepare({
      ...base,
      dialogue: [
        { id: "m1", role: "user", content: "你好" },
        { id: "m2", role: "assistant", content: "你好。" },
        { id: "m3", role: "user", content: "看下显卡" },
      ],
    } as never);
    assert.equal(t2.prefixStability.comparable, true);
    assert.equal(t2.prefixStability.midPromptDrift, false, "纯追加不该算漂移");
    assert.equal(t2.prefixStability.firstDivergenceIndex, -1);
    assert.equal(t2.prefixStability.reuseRatio, 1);
    assert.ok(t2.prefixStability.freshTokens > 0, "新增消息仍需 prefill");
  });

  it("system 变了 → 从 0 号消息开始分歧，判为 mid-prompt 漂移", () => {
    const engine = new CogniStackEngine();
    const common = {
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "chat-2",
    };
    // 实测：进入 system 的是档案的 description，卡片「名」只用于宏绑定，
    // 改名字不会改变 prompt（所以这里改 description）。
    engine.prepare({ ...common, card: { name: "阿铁", description: "技术搭子" } } as never);
    const t2 = engine.prepare({ ...common, card: { name: "阿铁", description: "换了设定的搭子" } } as never);
    assert.equal(t2.prefixStability.firstDivergenceIndex, 0);
    assert.equal(t2.prefixStability.midPromptDrift, true);
    assert.equal(t2.prefixStability.prefixTokens, 0);
  });

  it("改历史消息 → 从该条开始分歧，但 system 前缀仍可复用", () => {
    const engine = new CogniStackEngine();
    const base = {
      card: { name: "阿铁", description: "技术搭子" },
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "chat-3",
    };
    engine.prepare({
      ...base,
      dialogue: [
        { id: "m1", role: "user", content: "第一条" },
        { id: "m2", role: "assistant", content: "回复一" },
        { id: "m3", role: "user", content: "第三条" },
      ],
    } as never);
    const t2 = engine.prepare({
      ...base,
      dialogue: [
        { id: "m1", role: "user", content: "第一条被编辑了" },
        { id: "m2", role: "assistant", content: "回复一" },
        { id: "m3", role: "user", content: "第三条" },
      ],
    } as never);
    assert.equal(t2.prefixStability.firstDivergenceIndex, 1, "system(0) 未变，分歧在第 1 条");
    assert.equal(t2.prefixStability.midPromptDrift, true);
    assert.ok(t2.prefixStability.prefixTokens > 0, "system 部分仍应计为可复用");
  });

  it("不同 cacheScope 互不污染", () => {
    const engine = new CogniStackEngine();
    const base = {
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      card: { name: "阿铁" },
      contextTokenLimit: 4096,
      tokenCounter: counter,
    };
    engine.prepare({ ...base, cacheScope: "a" } as never);
    const other = engine.prepare({ ...base, cacheScope: "b" } as never);
    assert.equal(other.prefixStability.comparable, false);
  });

  it("clearCache(scope) 同时丢弃该 scope 的前缀记忆", () => {
    const engine = new CogniStackEngine();
    const base = {
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      card: { name: "阿铁" },
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "c",
    };
    engine.prepare(base as never);
    engine.clearCache("c");
    const again = engine.prepare(base as never);
    assert.equal(again.prefixStability.comparable, false);
  });

  it("status 模式无消息，恒不可比较（不污染 generate 的统计）", () => {
    const engine = new CogniStackEngine();
    const base = { card: { name: "阿铁" }, contextTokenLimit: 4096, tokenCounter: counter };
    const st = engine.prepare({
      ...base,
      mode: "status",
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      priorAssembledPromptTokens: 100,
    } as never);
    assert.equal(st.prefixStability.comparable, false);
  });

  it("单 scope 指纹表有上限；超限后不给猜出来的复用率", () => {
    // 逐条指纹是必要的，但条数必须封顶：prompt 消息数由宿主预算决定。
    // 这里把上限压到 4，用「上一轮被截断 + 本轮更长」触发降级路径。
    const tracker = new PrefixTracker({ maxFingerprintsPerScope: 4 });
    const many = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `消息-${i}`,
    }));
    const first = tracker.observe("s", many, counter);
    assert.equal(first.comparable, false, "首轮没有可比对象");

    const second = tracker.observe("s", many, counter);
    // 上一轮只留了 4 条，本轮 10 条 —— 尾部无从比对，如实报「不可比较」，
    // 而不是拿 4 条算出一个看起来正常的 reuseRatio。
    assert.equal(second.comparable, false);
    assert.equal(second.reuseRatio, 0);
  });

  it("未超上限时照常判纯追加（上限不改变正常语义）", () => {
    const tracker = new PrefixTracker();
    const first = [{ role: "user", content: "a" }];
    tracker.observe("s", first, counter);
    const second = tracker.observe(
      "s",
      [...first, { role: "assistant", content: "b" }],
      counter,
    );
    assert.equal(second.comparable, true);
    assert.equal(second.firstDivergenceIndex, -1);
    assert.equal(second.reuseRatio, 1);
  });
});

/* ------------------------------------------------------------------ */
/* G-13 分位数与告警分类                                                */
/* ------------------------------------------------------------------ */

describe("G-13 直方图 / 分位数 / 告警分类", () => {
  it("Histogram 分位数单调，且被夹在真实观测范围内", () => {
    const h = new Histogram([1, 2, 5, 10, 100]);
    for (const v of [1, 1, 1, 1, 1, 1, 1, 1, 1, 100]) h.observe(v);
    assert.equal(h.count, 10);
    assert.equal(h.total, 109);
    assert.equal(h.min(), 1);
    assert.equal(h.max(), 100);
    const p50 = h.quantile(0.5);
    const p90 = h.quantile(0.9);
    const p99 = h.quantile(0.99);
    assert.ok(p50 <= p90 && p90 <= p99, `分位数必须单调：${p50}/${p90}/${p99}`);
    assert.ok(p50 >= h.min() && p99 <= h.max(), "分位数不得超出观测范围");
    // 9 个 1 + 1 个 100：中位数就是 1。裸的桶插值会给出 0.56（桶下界是 0），
    // 夹到 [min,max] 后才是可信任的答案。
    assert.equal(p50, 1);
  });

  it("所有样本相同时，分位数等于该值（桶插值会算错，夹取修正）", () => {
    const h = new Histogram([1, 2, 5, 10, 100]);
    for (let i = 0; i < 12; i += 1) h.observe(5);
    assert.equal(h.quantile(0.5), 5);
    assert.equal(h.quantile(0.95), 5);
    assert.equal(h.quantile(0.99), 5);
  });

  it("空直方图返回 0 而不是 NaN", () => {
    const h = new Histogram([1, 2]);
    assert.equal(h.quantile(0.95), 0);
    assert.equal(h.mean(), 0);
  });

  it("warningClass 剥掉 degraded 前缀与详情", () => {
    assert.equal(warningClass("degraded:assemble-failed:boom"), "assemble-failed");
    assert.equal(warningClass("lore-capped:12"), "lore-capped");
    assert.equal(warningClass("watermark-off-active-path"), "watermark-off-active-path");
    assert.equal(warningClass(""), "unknown");
  });

  it("遥测跑真实回合后给出分位数、告警分类、计数器身份", () => {
    const telemetry = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry, host: { id: "t", name: "测试宿主" } });
    for (let i = 0; i < 5; i += 1) {
      engine.prepare(prepareInput() as never);
    }
    const m = telemetry.metrics();
    assert.equal(m.turns_total, 5);
    assert.equal(m.duration_ms_p50 > 0, true);
    assert.equal(m.duration_ms_p95 >= m.duration_ms_p50, true);
    assert.equal(m.prompt_tokens_p50 > 0, true);
    assert.deepEqual(m.counter_ids, { "char-exact(test-only)": 5 });

    const text = telemetry.toPrometheusText();
    assert.match(text, /cognistack_duration_ms_bucket\{le="\+Inf"\} 5/);
    assert.match(text, /cognistack_duration_ms_count 5/);
    assert.match(text, /cognistack_turns_by_counter_id\{id="char-exact\(test-only\)"\} 5/);
    assert.match(text, /cognistack_duration_ms_quantile\{quantile="0.95"\}/);
  });

  it("告警按 class 计数，而不是每个详情一个桶", () => {
    const telemetry = new CogniStackTelemetry();
    const host = { id: "h", name: "h" };
    const base = {
      host,
      mode: "generate" as const,
      messages: 2,
      systemSections: 1,
      promptTokens: 10,
      promptChars: 10,
      loreCount: 0,
      vectorHits: 0,
      budget: {
        contextLimit: 4096,
        completionReserve: 0,
        softTrimTokenCap: 4000,
        softTrimEnabled: true,
        hardFit: 4096,
        policy: {},
      } as never,
      memory: {
        shouldSummarize: false,
        compressReason: null,
        pendingPairs: 0,
        contextUsed: 0,
        contextTriggerAt: 0,
        watermarkEnd: 0,
        summarizedCount: 0,
      },
      toSummarizePairCount: 0,
      warnings: ["degraded:assemble-failed:boom1", "degraded:assemble-failed:boom2", "lore-capped:3"],
      degraded: true,
      cacheHit: false,
      emergencyDropped: 0,
      softTrimmed: false,
      durationMs: 5,
      timings: {},
      counter: { hits: 0, misses: 0, distinct: 0, evictions: 0 },
      ports: [],
    };
    telemetry.record(base as never);
    const classes = telemetry.metrics().warnings_by_class;
    assert.equal(classes["assemble-failed"], 2, "两条同 class 合并计数");
    assert.equal(classes["lore-capped"], 1);
  });

  it("reset 会清掉新增的直方图与分类计数", () => {
    const telemetry = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry });
    engine.prepare(prepareInput() as never);
    assert.ok(telemetry.metrics().duration_ms_p50 > 0);
    telemetry.reset();
    const m = telemetry.metrics();
    assert.equal(m.duration_ms_p50, 0);
    assert.deepEqual(m.counter_ids, {});
    assert.deepEqual(m.warnings_by_class, {});
    assert.equal(m.prefix_comparable_turns, 0);
  });

  it("前缀复用汇总进入 metrics", () => {    const telemetry = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry, host: { id: "p", name: "p" } });
    const base = {
      card: { name: "阿铁" },
      contextTokenLimit: 4096,
      tokenCounter: counter,
      cacheScope: "pfx",
    };
    engine.prepare({ ...base, dialogue: [{ id: "m1", role: "user", content: "你好" }] } as never);
    engine.prepare({
      ...base,
      dialogue: [
        { id: "m1", role: "user", content: "你好" },
        { id: "m2", role: "assistant", content: "在。" },
      ],
    } as never);
    const m = telemetry.metrics();
    assert.equal(m.prefix_comparable_turns, 1);
    assert.equal(m.prefix_reuse_ratio_mean, 1);
    assert.equal(m.prefix_mid_drift_total, 0);
    assert.ok(m.prefix_fresh_tokens_sum > 0);
  });
});

/* ------------------------------------------------------------------ */
/* G-12 回放导入的语义（历史不得混入指标）                                */
/* ------------------------------------------------------------------ */

describe("G-12 回放导入", () => {
  function fakeTurn(seq: number) {
    return {
      seq,
      at: 1_700_000_000_000 + seq,
      hostId: "restored",
      hostName: "还原宿主",
      mode: "generate",
      messages: 2,
      systemSections: 1,
      promptTokens: 500,
      promptChars: 900,
      loreCount: 0,
      vectorHits: 0,
      softTrimCap: 4000,
      contextLimit: 8192,
      completionReserve: 512,
      softTrimEnabled: true,
      fill: 0.125,
      memory: {
        shouldSummarize: false,
        compressReason: null,
        pendingPairs: 0,
        contextUsed: 0,
        contextTriggerAt: 0,
        watermarkEnd: 0,
        summarizedCount: 0,
      },
      toSummarizePairCount: 0,
      warnings: [],
      degraded: false,
      cacheHit: false,
      emergencyDropped: 0,
      softTrimmed: false,
      durationMs: 4,
      timings: {},
      counter: { hits: 0, misses: 1, distinct: 1, evictions: 0 },
      ports: [],
    };
  }

  it("导入的回合进 ring、带 replayed 标记，且不改变任何指标", () => {
    const telemetry = new CogniStackTelemetry();
    const before = telemetry.metrics();
    const imported = telemetry.importTurns([fakeTurn(1), fakeTurn(2)] as never);
    assert.equal(imported, 2);

    const snap = telemetry.snapshot();
    assert.equal(snap.turns.length, 2);
    assert.ok(
      snap.turns.every((t) => t.replayed === true),
      "回放记录必须自证身份，否则与实时数据无从区分",
    );

    const after = telemetry.metrics();
    assert.equal(after.turns_total, before.turns_total, "turns_total 不应被回放污染");
    assert.equal(after.duration_ms_p50, 0, "分位数不应被回放污染");
    assert.equal(after.prompt_tokens_sum, 0, "token 总量不应被回放污染");
    assert.deepEqual(after.counter_ids, {}, "计数器身份统计不应被回放污染");
  });

  it("导入条数受 ring 容量约束，不会无限增长", () => {
    const telemetry = new CogniStackTelemetry({ ringSize: 3 });
    telemetry.importTurns([1, 2, 3, 4, 5].map(fakeTurn) as never);
    assert.equal(telemetry.snapshot().turns.length, 3);
  });

  it("坏输入被跳过而不是抛错", () => {
    const telemetry = new CogniStackTelemetry();
    const imported = telemetry.importTurns([
      null,
      { seq: 1 },
      fakeTurn(2),
      "nope",
    ] as never);
    assert.equal(imported, 1);
  });

  it("实时回合不带 replayed 标记（两者可区分）", () => {
    const telemetry = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry });
    engine.prepare(prepareInput() as never);
    const turn = telemetry.snapshot().turns[0]!;
    assert.equal(turn.replayed, undefined);
  });
});
