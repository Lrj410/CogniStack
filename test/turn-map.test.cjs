/**
 * `/api/turn` 字段对齐 —— 跨进程编解码的回归网。
 *
 * 事故原型：宿主上报了 `counterId` / `prefixStability` / `budgetTiers`，网关那份
 * 手写的字段映射漏掉了它们，于是控制台的回合页永远显示"没有这项数据" ——
 * 面板看着正常，其实少了一整块。三处（引擎 `record()` 输入 / 网关映射 /
 * 控制台类型）各维护一遍时，没有任何东西能发现这种不对齐。
 *
 * 现在映射器的读者表**就是**覆盖面（`tools/lib/turn-map.cjs`），
 * 这里拿它与引擎侧的运行时清单求差集，任一方向非空即失败。
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { COVERED_KEYS, mapTurnPayload } = require("../tools/lib/turn-map.cjs");
// 直接加载本套件的产物（`npm test` 只建 dist-test，从不重建 dist）。
const { CogniStackTelemetry, TELEMETRY_RECORD_INPUT_KEYS } = require("../dist-test/src/telemetry.js");

const KNOWN_PORTS = new Set(["lore", "vector"]);

/** 一条"什么都有"的上报体：宿主能发的字段全覆盖。 */
function fullBody() {
  return {
    hostId: "h1",
    hostName: "宿主一",
    kind: "service",
    hostVersion: "1.2.3",
    hostMeta: { region: "cn" },
    mode: "status",
    label: "探针",
    meta: { action: "chat" },
    cacheScope: "c1",
    messages: 4,
    systemSections: 2,
    promptTokens: 1234,
    promptChars: 4321,
    loreCount: 3,
    vectorHits: 2,
    loreInjected: [{ id: "l1", name: "显卡" }],
    softTrimCap: 4096,
    hardFit: 3500,
    contextLimit: 8192,
    completionReserve: 512,
    memory: {
      shouldSummarize: true,
      compressReason: "context",
      pendingPairs: 2,
      contextUsed: 10,
      contextTriggerAt: 20,
      watermarkEnd: 30,
      summarizedCount: 1,
    },
    toSummarizePairCount: 3,
    warnings: ["soft-trim-applied"],
    degraded: true,
    cacheHit: true,
    emergencyDropped: 1,
    softTrimmed: true,
    steps: ["assemble", "trim"],
    durationMs: 42,
    timings: { assemble: 5 },
    counter: { hits: 7, misses: 2, distinct: 3, evictions: 0 },
    counterId: "char-exact(test-only)",
    prefixStability: {
      prefixTokens: 100,
      previousTokens: 200,
      freshTokens: 100,
      reuseRatio: 0.5,
      firstDivergenceIndex: 3,
      midPromptDrift: true,
    },
    budgetTiers: [{ priority: 10, before: 500, after: 300 }],
    inputSnapshot: { hello: "world" },
    ports: ["lore", "vector", "not-a-port"],
  };
}

describe("网关 /api/turn 字段映射", () => {
  it("覆盖面与引擎 record() 输入清单双向无差集", () => {
    const engineKeys = new Set(TELEMETRY_RECORD_INPUT_KEYS);
    const gatewayKeys = new Set(COVERED_KEYS);

    const lost = [...engineKeys].filter((k) => !gatewayKeys.has(k));
    const extra = [...gatewayKeys].filter((k) => !engineKeys.has(k));

    assert.deepEqual(lost, [], `宿主能上报、网关却没接的字段：${lost.join(", ")}`);
    assert.deepEqual(extra, [], `网关接了、引擎不认识的字段：${extra.join(", ")}`);
  });

  it("全字段上报后关键读数都在（counterId / 前缀 / 分层 / 预算）", () => {
    const tel = new CogniStackTelemetry();
    tel.record(mapTurnPayload(fullBody(), { knownPorts: KNOWN_PORTS }));
    const turn = tel.snapshot(1).turns[0];

    assert.equal(turn.hostId, "h1");
    assert.equal(turn.hostName, "宿主一");
    assert.equal(turn.mode, "status");
    assert.equal(turn.counterId, "char-exact(test-only)");
    // record() 把输入的 prefixStability 存成 TurnRecord.prefix（见 src/telemetry.ts）。
    assert.equal(turn.prefix.reuseRatio, 0.5);
    assert.equal(turn.budgetTiers[0].after, 300);
    assert.equal(turn.softTrimCap, 4096);
    assert.equal(turn.degraded, true);
    assert.equal(turn.messages, 4);
  });

  it("未知端口名被过滤，合法端口保留", () => {
    const mapped = mapTurnPayload(fullBody(), { knownPorts: KNOWN_PORTS });
    assert.deepEqual(mapped.ports, ["lore", "vector"]);
  });

  it("字段残缺的上报体不抛错，也不会凭空多出可选字段", () => {
    const mapped = mapTurnPayload({ hostId: "x" }, { knownPorts: KNOWN_PORTS });
    assert.ok(!("counterId" in mapped));
    assert.ok(!("prefixStability" in mapped));
    assert.ok(!("budgetTiers" in mapped));
    assert.equal(mapped.mode, "generate");

    const tel = new CogniStackTelemetry();
    tel.record(mapped);
    assert.equal(tel.snapshot(1).turns[0].hostId, "x");
  });
});