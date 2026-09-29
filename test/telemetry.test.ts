import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CogniStackEngine,
  CogniStackTelemetry,
  exactCharTokenCounter,
  getGlobalTelemetry,
  resetGlobalTelemetry,
  UNKNOWN_HOST,
  type HostIdentity,
  type TurnRecord,
} from "../src/index";

const counter = exactCharTokenCounter();

const dialogue = [
  { id: "m1", role: "user", content: "你好" },
  { id: "m2", role: "assistant", content: "你好，我是阿铁。" },
  { id: "m3", role: "user", content: "看一下显卡" },
  { id: "m4", role: "assistant", content: "RTX 5070 Laptop 8GB。" },
];

const apiHost: HostIdentity = { id: "xoox-api", name: "xoox API 服务", kind: "service", version: "0.3.0" };
const webHost: HostIdentity = { id: "web-client", name: "Web 聊天端", kind: "client" };

function input(over: Record<string, unknown> = {}) {
  return {
    card: { name: "阿铁", description: "技术搭子" },
    dialogue,
    pairBatchSize: 1,
    tokenCounter: counter,
    ...over,
  } as never;
}

describe("telemetry — host registry", () => {
  it("records every system that drives the engine", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel });
    engine.forHost(apiHost).prepare(input({ cacheScope: "a" }));
    engine.forHost(webHost).prepare(input({ cacheScope: "b" }));

    const hosts = tel.listHosts();
    assert.equal(hosts.length, 2);
    assert.deepEqual(hosts.map((h) => h.id).sort(), ["web-client", "xoox-api"]);
  });

  it("attributes turns to the caller that issued them", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel });
    const api = engine.forHost(apiHost);
    const web = engine.forHost(webHost);

    for (let i = 0; i < 3; i += 1) api.prepare(input({ cacheScope: `a${i}` }));
    web.prepare(input({ cacheScope: "w" }));

    const byHost = new Map(tel.listHosts().map((h) => [h.id, h]));
    assert.equal(byHost.get("xoox-api")!.calls, 3);
    assert.equal(byHost.get("web-client")!.calls, 1);
    assert.deepEqual(tel.recent(4).map((t) => t.hostId), ["web-client", "xoox-api", "xoox-api", "xoox-api"]);
  });

  it("stamps an engine-level host when no per-call identity is given", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    engine.prepare(input({ cacheScope: "x" }));
    assert.equal(tel.recent(1)[0]!.hostId, "xoox-api");
  });

  it("falls back to an explicit unknown identity", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel });
    engine.prepare(input({ cacheScope: "y" }));
    assert.equal(tel.recent(1)[0]!.hostId, UNKNOWN_HOST.id);
  });

  it("a per-call identity overrides the engine default", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    engine.prepare(input({ host: webHost, cacheScope: "z" }));
    assert.equal(tel.recent(1)[0]!.hostId, "web-client");
  });

  it("registering the same id twice refreshes instead of duplicating", () => {
    const tel = new CogniStackTelemetry();
    tel.registerHost(apiHost);
    tel.registerHost({ ...apiHost, name: "改名后的服务" });
    assert.equal(tel.listHosts().length, 1);
    assert.equal(tel.listHosts()[0]!.name, "改名后的服务");
  });
});

describe("telemetry — turn records", () => {
  it("captures everything a dashboard needs", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    const r = engine.prepare(input({ contextTokenLimit: 1000, cacheScope: "full" }));
    const turn = tel.recent(1)[0]!;

    assert.equal(turn.hostId, "xoox-api");
    assert.equal(turn.mode, "generate");
    assert.equal(turn.promptTokens, r.promptTokens);
    assert.equal(turn.messages, r.messages.length);
    assert.equal(turn.systemSections, r.systemSections.length);
    assert.equal(turn.contextLimit, 1000);
    assert.equal(turn.softTrimCap, r.budget.softTrimTokenCap);
    assert.equal(turn.memory.pendingPairs, r.memory.pendingPairs);
    assert.equal(turn.toSummarizePairCount, r.toSummarizePairCount);
    assert.ok(turn.durationMs >= 0);
    assert.ok(turn.counter.distinct > 0);
    assert.ok(turn.ports.length > 0);
  });

  it("computes budget fill for the gauge", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    engine.prepare(input({ contextTokenLimit: 1000, cacheScope: "fill" }));
    const turn = tel.recent(1)[0]!;
    assert.equal(turn.fill, turn.promptTokens / turn.softTrimCap);
    assert.ok(turn.fill > 0 && turn.fill <= 1);
  });

  it("reports fill 0 when soft trim is off", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    engine.prepare(input({ memory: { softTrimOff: true }, contextTokenLimit: 1000, cacheScope: "off" }));
    assert.equal(tel.recent(1)[0]!.fill, 0);
  });

  it("flags degraded turns and counts them per host", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({
      telemetry: tel,
      host: apiHost,
      collaborators: {
        lore: {
          selectEntries() {
            throw new Error("boom");
          },
        },
      },
    });
    engine.prepare(input({ worldEntries: [], cacheScope: "deg" }));
    const turn = tel.recent(1)[0]!;
    assert.equal(turn.degraded, false, "lore failure alone is not degraded");
    assert.ok(turn.warnings.some((w) => w.includes("lore-failed") || w.includes("world-book-failed")));
  });

  it("keeps the ring buffer bounded", () => {
    const tel = new CogniStackTelemetry({ ringSize: 5 });
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    for (let i = 0; i < 50; i += 1) engine.prepare(input({ cacheScope: `r${i}` }));
    assert.equal(tel.recent(100).length, 5);
    assert.equal(tel.snapshot(100).totalTurns, 50, "total counter survives eviction");
  });

  it("lists the ports actually wired", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({
      telemetry: tel,
      host: apiHost,
      collaborators: { lore: { selectEntries: () => [] } },
    });
    engine.prepare(input({ cacheScope: "ports" }));
    assert.ok(engine.ports.includes("lore"));
    assert.ok(engine.ports.includes("card"), "defaults are wired too");
    assert.deepEqual(tel.snapshot().ports, [...tel.snapshot().ports].sort());
  });
});

describe("telemetry — live subscription", () => {
  it("pushes each turn to subscribers", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    const seen: TurnRecord[] = [];
    const off = tel.subscribe((t) => seen.push(t));

    engine.prepare(input({ cacheScope: "s1" }));
    engine.prepare(input({ cacheScope: "s2" }));
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.seq, 2);

    off();
    engine.prepare(input({ cacheScope: "s3" }));
    assert.equal(seen.length, 2, "unsubscribe must stop delivery");
  });

  it("a throwing listener cannot break the turn", () => {
    const tel = new CogniStackTelemetry();
    tel.subscribe(() => {
      throw new Error("bad listener");
    });
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    const r = engine.prepare(input({ cacheScope: "safe" }));
    assert.ok(r.messages.length > 0);
  });
});

describe("telemetry — snapshot", () => {
  it("is JSON-serializable and self-consistent", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: webHost });
    engine.prepare(input({ cacheScope: "snap" }));

    const snap = tel.snapshot(10);
    const round = JSON.parse(JSON.stringify(snap));
    assert.equal(round.engine, "CogniStackEngine");
    assert.equal(round.totalTurns, 1);
    assert.equal(round.hosts.length, 1);
    assert.equal(round.hosts[0].name, webHost.name);
    assert.ok(round.uptimeMs >= 0);
    assert.ok(Array.isArray(round.turns));
  });

  it("orders turns newest first", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    for (let i = 0; i < 5; i += 1) engine.prepare(input({ cacheScope: `o${i}` }));
    const seqs = tel.snapshot(5).turns.map((t) => t.seq);
    assert.deepEqual(seqs, [5, 4, 3, 2, 1]);
  });

  it("keeps tps accurate after ring eviction (CogniStack fix)", () => {
    // The old code counted "turns newer than now-10s" off the ring buffer, which
    // EVICTS — so a board busier than ringSize showed a *falling* tps the busier
    // it got. Timestamps are now tracked separately from the ring.
    const tel = new CogniStackTelemetry({ ringSize: 5 });
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    for (let i = 0; i < 60; i += 1) engine.prepare(input({ cacheScope: `ev${i}` }));

    const snap = tel.snapshot();
    assert.equal(snap.totalTurns, 60, "total counter survives eviction");
    // 60 turns inside the 10s window → 6.0 turns/sec, regardless of ringSize 5.
    assert.ok(Math.abs(snap.tps - 6) < 0.5, `tps=${snap.tps}, expected ~6`);
  });

  it("tracks a per-host sparkline for the dashboard", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    for (let i = 0; i < 40; i += 1) engine.prepare(input({ cacheScope: `sp${i}` }));
    const h = tel.listHosts()[0]!;
    assert.ok(h.spark.length > 0 && h.spark.length <= 32, `spark=${h.spark.length}`);
  });

  it("reset clears turns but keeps subscribers", () => {
    const tel = new CogniStackTelemetry();
    let pushes = 0;
    tel.subscribe(() => {
      pushes += 1;
    });
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    engine.prepare(input({ cacheScope: "pre-reset" }));
    assert.ok(pushes >= 1);
    const before = pushes;
    tel.reset();
    assert.equal(tel.recent().length, 0);
    engine.prepare(input({ cacheScope: "post-reset" }));
    assert.ok(pushes > before, "subscriber must still fire after reset");
  });

  it("non-finite promptTokens do not poison host aggregates", () => {
    const tel = new CogniStackTelemetry();
    tel.registerHost(apiHost);
    tel.record({
      host: apiHost,
      mode: "generate",
      messages: 1,
      systemSections: 1,
      promptTokens: Number.NaN as unknown as number,
      promptChars: Number.POSITIVE_INFINITY as unknown as number,
      loreCount: -3 as unknown as number,
      vectorHits: "x" as unknown as number,
      budget: {
        policy: {} as never,
        basePolicy: {} as never,
        contextLimit: 1000,
        completionReserve: 0,
        safetyPad: 64,
        templateOverhead: 0,
        hardFit: 900,
        softTrimTokenCap: 900,
        softTrimEnabled: true,
        warnings: [],
      },
      memory: {
        shouldSummarize: false,
        compressReason: null,
        pendingPairs: 0,
        contextUsed: 0,
        contextTriggerAt: 0,
        watermarkEnd: -1,
        summarizedCount: 0,
      },
      toSummarizePairCount: 0,
      warnings: [],
      degraded: false,
      cacheHit: false,
      emergencyDropped: 0,
      softTrimmed: false,
      durationMs: 1,
      timings: {},
      counter: { hits: 0, misses: 0, distinct: 0, evictions: 0 },
      ports: ["card"],
    });
    const h = tel.listHosts().find((x) => x.id === apiHost.id)!;
    assert.ok(Number.isFinite(h.avgPromptTokens));
    assert.ok(Number.isFinite(h.maxPromptTokens));
    assert.ok(h.spark.every((n) => Number.isFinite(n)));
  });
});

describe("global telemetry", () => {
  it("is shared across engine instances in one process", () => {
    resetGlobalTelemetry();
    const tel = getGlobalTelemetry();
    const a = new CogniStackEngine({ telemetry: tel, host: apiHost });
    const b = new CogniStackEngine({ telemetry: tel, host: webHost });
    a.prepare(input({ cacheScope: "ga" }));
    b.prepare(input({ cacheScope: "gb" }));

    assert.equal(getGlobalTelemetry(), tel);
    assert.equal(tel.listHosts().length, 2, "both systems visible from one place");
    resetGlobalTelemetry();
    assert.notEqual(getGlobalTelemetry(), tel);
  });
});

describe("telemetry — metrics export", () => {
  it("accumulates lifetime counters and renders prometheus text", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, host: apiHost });
    engine.prepare(input({ cacheScope: "m1" }));
    engine.prepare(input({ cacheScope: "m2" }));
    const m = tel.metrics();
    assert.equal(m.turns_total, 2);
    assert.ok(m.prompt_tokens_sum > 0);
    assert.ok(m.uptime_ms >= 0);
    const text = tel.toPrometheusText();
    assert.ok(text.includes("cognistack_turns_total 2"));
    assert.ok(text.includes("# TYPE cognistack_tps_10s gauge"));
    tel.reset();
    assert.equal(tel.metrics().turns_total, 0);
  });
});
