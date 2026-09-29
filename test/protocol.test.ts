import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CogniStackEngine,
  CogniStackTelemetry,
  PORT_NAMES,
  PortRegistry,
  type AssembleCollaborators,
  exactCharTokenCounter,
  type ConnectManifest,
  type HostIdentity,
  type LoreProvider,
} from "../src/index";

const counter = exactCharTokenCounter();

const dialogue = [
  { id: "m1", role: "user", content: "你好" },
  { id: "m2", role: "assistant", content: "你好，我是阿铁。" },
];

/** 宿主侧的世界书实现 —— 领域逻辑住在引擎外面，这就是协议的意义。 */
function hostLore(match: string): LoreProvider {
  return {
    selectEntries(entries) {
      return entries.filter((e) => e.enabled !== false && (e.constant || e.keys.includes(match)));
    },
  };
}

const ENTRIES = [
  { id: "w1", name: "命中", keys: ["显卡"], content: "RTX 5070", enabled: true, constant: false, insertionOrder: 0 },
  { id: "w2", name: "不命中", keys: ["没有"], content: "nope", enabled: true, constant: false, insertionOrder: 1 },
];

function input(over: Record<string, unknown> = {}) {
  return {
    card: { name: "阿铁" },
    dialogue,
    tokenCounter: counter,
    worldEntries: ENTRIES,
    ...over,
  } as never;
}

describe("PortRegistry — 竞争与回退", () => {
  it("priority 小者优先，同级先到者先得", () => {
    const reg = new PortRegistry<{ lore: LoreProvider }>();
    reg.register("a", "A", { lore: { selectEntries: () => [{ id: "a" }] as never } }, 100);
    reg.register("b", "B", { lore: { selectEntries: () => [{ id: "b" }] as never } }, 50);
    assert.equal(reg.providerOf("lore"), "b");

    reg.register("c", "C", { lore: { selectEntries: () => [] } }, 50);
    // 同级（50）：先到者 b 仍然胜出
    assert.equal(reg.providerOf("lore"), "b");
  });

  it("断开后自动回退到下一个提供方", () => {
    const reg = new PortRegistry<{ lore: LoreProvider }>();
    reg.register("a", "A", { lore: { selectEntries: () => [] } }, 100);
    reg.register("b", "B", { lore: { selectEntries: () => [] } }, 200);
    assert.equal(reg.providerOf("lore"), "a");

    reg.unregister("a");
    assert.equal(reg.providerOf("lore"), "b", "should fall back, not go empty");

    reg.unregister("b");
    assert.equal(reg.providerOf("lore"), null);
  });

  it("同一 connId 重复登记 = 刷新而不是叠加", () => {
    const reg = new PortRegistry<{ lore: LoreProvider }>();
    reg.register("a", "A", { lore: { selectEntries: () => [] } }, 100);
    reg.register("a", "A2", { lore: { selectEntries: () => [] } }, 100);
    assert.equal(reg.providerOf("lore"), "a");
    const binding = reg.table().find((b) => b.port === "lore");
    assert.equal(binding?.providerName, "A2");
  });

  it("归属表把未接端口标成缺省提供方", () => {
    const reg = new PortRegistry<AssembleCollaborators>();
    reg.register("a", "A", { lore: { selectEntries: () => [] } });
    const rows = reg.table({ card: "引擎缺省", lore: "未接入" });
    const lore = rows.find((r) => r.port === "lore")!;
    const card = rows.find((r) => r.port === "card")!;
    assert.equal(lore.providerId, "a");
    assert.equal(card.providerId, null);
    assert.equal(card.providerName, "引擎缺省");
  });
});

describe("接入协议 — connect / disconnect", () => {
  it("connect 后端口立即生效，世界书内容进入 prompt", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const conn = engine.connect({
      id: "lore-svc",
      name: "设定库服务",
      kind: "service",
      provides: { lore: hostLore("显卡") },
    });

    assert.deepEqual(conn.wired, ["lore"]);
    const r = engine.prepare(input({ cacheScope: "p1" }));
    assert.deepEqual(r.loreInjected.map((e) => e.id), ["w1"]);
    assert.ok(r.messages[0]!.content.includes("RTX 5070"));
  });

  it("disconnect 后端口自动回退，prompt 恢复干净", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const conn = engine.connect({
      id: "lore-svc",
      name: "设定库服务",
      provides: { lore: hostLore("显卡") },
    });
    assert.ok(engine.prepare(input({ cacheScope: "d1" })).messages[0]!.content.includes("RTX 5070"));

    conn.close();
    assert.deepEqual(engine.connectionsList(), []);
    const r = engine.prepare(input({ cacheScope: "d2" }));
    assert.deepEqual(r.loreInjected, []);
    assert.ok(!r.messages[0]!.content.includes("RTX 5070"));
  });

  it("同一 id 重复 connect = 刷新，不产生重复连接", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    engine.connect({ id: "x", name: "X", provides: { lore: hostLore("显卡") } });
    engine.connect({ id: "x", name: "X2", provides: { lore: hostLore("显卡") } });
    assert.equal(engine.connectionsList().length, 1);
    assert.equal(engine.connectionsList()[0]!.manifest.name, "X2");
  });

  it("非法 priority 抛错后不留幽灵连接", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    assert.throws(
      () =>
        engine.connect({
          id: "bad",
          name: "坏接入",
          priority: Number.NaN,
          provides: { lore: hostLore("显卡") },
        }),
      /priority must be a non-negative finite number/,
    );
    // 注册被拒 → 句柄映射与端口表都必须干净（此前 connections 先 set 后 register，
    // 于是列表里残留一条 priority:null、永远拿不到调用的记录）。
    assert.deepEqual(engine.connectionsList(), []);
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerId, null);
  });

  it("连接句柄不暴露引擎实例（#engine 是运行时真私有）", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const conn = engine.connect({
      id: "leak",
      name: "L",
      provides: { lore: hostLore("显卡") },
    });
    const raw = conn as unknown as Record<string, unknown>;
    // TS 的 private 只在类型层生效；换成 # 之后运行时也读不到。
    assert.ok(!("engine" in raw));
    assert.equal(raw.engine, undefined);
    // 句柄自身仍然可用、可序列化。
    assert.equal(conn.id, "leak");
    assert.ok(JSON.stringify(conn).includes("leak"));
  });

  it("高优先级系统抢走端口，低优先级自动让位", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    engine.connect({ id: "low", name: "低优", priority: 200, provides: { lore: hostLore("显卡") } });
    engine.connect({ id: "high", name: "高优", priority: 10, provides: { lore: hostLore("显卡") } });

    const binding = engine.portTable().find((b) => b.port === "lore")!;
    assert.equal(binding.providerId, "high");

    // 高优断开 → 低优自动顶上
    engine.disconnect("high");
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerId, "low");
  });

  it("connect 的 handle 自动盖宿主戳", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, systemRules: "RULE" });
    const conn = engine.connect({
      id: "caller-a",
      name: "调用方A",
      kind: "service",
      provides: { lore: hostLore("显卡") },
    });
    conn.handle.prepare(input({ cacheScope: "h1" }));

    const turn = tel.recent(1)[0]!;
    assert.equal(turn.hostId, "caller-a");
    const host = tel.listHosts().find((h) => h.id === "caller-a")!;
    assert.deepEqual(host.provides, ["lore"]);
  });

  it("requires 只是声明，不影响接线（信息性）", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const conn = engine.connect({
      id: "needs-a-lot",
      name: "贪心的系统",
      provides: {},
      requires: ["lore", "state", "preset"],
    });
    assert.deepEqual(conn.wired, []);
    const host = engine.portTable();
    assert.ok(host.every((b) => b.providerId !== "needs-a-lot"));
  });

  it("缺 id 直接拒绝", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    assert.throws(() => engine.connect({ name: "没有 id" } as unknown as ConnectManifest), /id/);
  });

  it("全部端口都有归属（接的或缺省），面板拓扑不会出现孤儿", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const table = engine.portTable();
    assert.deepEqual(table.map((b) => b.port), [...PORT_NAMES].sort());
    for (const b of table) {
      assert.ok(b.providerId !== undefined);
      assert.ok(b.providerName !== undefined && b.providerName !== "", `${b.port} 缺提供方名`);
    }
  });
});

describe("基础服务边界 — 引擎不再内置领域逻辑", () => {
  it("不接任何系统时，世界书为空", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare(input({ cacheScope: "bare" }));
    assert.deepEqual(r.loreInjected, []);
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerName, "未接入");
  });

  it("机械缺省仍然可用：{{char}} 绑定不依赖任何接入", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const r = engine.prepare({
      card: { name: "阿铁", description: "我是{{char}}" },
      dialogue,
      tokenCounter: counter,
      cacheScope: "macro",
    } as never);
    assert.ok(r.messages[0]!.content.includes("我是阿铁"));
  });
});

describe("forHost 与 connect 共存", () => {
  it("forHost 不提供端口，只标记调用方", () => {
    const tel = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry: tel, systemRules: "RULE" });
    const h: HostIdentity = { id: "pure-caller", name: "纯调用方" };
    engine.forHost(h).prepare(input({ cacheScope: "fc" }));

    const host = tel.listHosts().find((x) => x.id === "pure-caller")!;
    assert.deepEqual(host.provides, []);
    assert.equal(host.calls, 1);
  });
});

describe("connection handle safety (CogniStack hardening)", () => {
  it("stale close after same-id reconnect does not drop the live provider", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const old = engine.connect({
      id: "c",
      name: "C1",
      provides: { lore: hostLore("显卡") },
    });
    const neu = engine.connect({
      id: "c",
      name: "C2",
      provides: { lore: hostLore("显卡") },
    });
    old.close();
    assert.equal(engine.connectionsList().length, 1);
    assert.equal(engine.connectionsList()[0], neu);
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerId, "c");
  });

  it("update({ provides: undefined }) does not wipe ports", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    const conn = engine.connect({
      id: "u",
      name: "U",
      provides: { lore: hostLore("显卡") },
    });
    conn.update({ name: "U2", provides: undefined });
    assert.equal(conn.manifest.name, "U2");
    assert.ok(conn.manifest.provides?.lore);
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerId, "u");
  });

  it("equal-priority refresh keeps FIFO winner", () => {
    const engine = new CogniStackEngine({ systemRules: "RULE" });
    engine.connect({
      id: "first",
      name: "First",
      priority: 50,
      provides: { lore: hostLore("显卡") },
    });
    engine.connect({
      id: "second",
      name: "Second",
      priority: 50,
      provides: { lore: hostLore("显卡") },
    });
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerId, "first");
    engine.connect({
      id: "first",
      name: "First refreshed",
      priority: 50,
      provides: { lore: hostLore("显卡") },
    });
    assert.equal(engine.portTable().find((b) => b.port === "lore")!.providerId, "first");
  });
});
