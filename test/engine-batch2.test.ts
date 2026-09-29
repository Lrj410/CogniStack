import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessSummaryQuality,
  attributeBudget,
  auditMemory,
  CogniStackEngine,
  CogniStackTelemetry,
  exactCharTokenCounter,
  memoryAuditWarnings,
  PortRegistry,
  SECTION_PRIORITY,
  SummaryEngine,
  type PromptSection,
} from "../src/index";

const counter = exactCharTokenCounter();

/* ------------------------------------------------------------------ */
/* G-2 plan()                                                          */
/* ------------------------------------------------------------------ */

describe("G-2 plan() 预检", () => {
  const engine = new CogniStackEngine();
  const base = {
    card: { name: "阿铁", description: "技术搭子" },
    dialogue: [
      { id: "m1", role: "user", content: "你好" },
      { id: "m2", role: "assistant", content: "你好。" },
    ],
    contextTokenLimit: 4096,
    tokenCounter: counter,
  };

  it("缺 tokenCounter 直接抛错（沿用 prepare 的契约）", () => {
    assert.throws(() => engine.plan({ ...base, tokenCounter: undefined } as never), /tokenCounter/);
  });

  it("dialogueTokens 是真实计数，且不返回任何 messages（未装配）", () => {
    const plan = engine.plan(base as never);
    assert.equal(plan.dialogueTokens, "你好".length + "你好。".length);
    assert.equal(plan.dialogueMessages, 2);
    assert.ok(!("messages" in plan), "plan 不应产出 prompt");
  });

  it("budget 与 prepare 解出的完全一致（这是 plan 存在的意义）", () => {
    const plan = engine.plan(base as never);
    const result = engine.prepare(base as never);
    assert.deepEqual(plan.budget, result.budget, "plan 与 prepare 的预算必须逐字段一致");
  });

  it("对话本身就超硬顶时给出明确信号", () => {
    const huge = Array.from({ length: 40 }, (_, i) => ({
      id: `h${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "内容".repeat(50),
    }));
    const plan = engine.plan({ ...base, dialogue: huge, contextTokenLimit: 512 } as never);
    assert.equal(plan.dialogueExceedsHardFit, true);
    assert.ok(plan.overByTokens > 0);
  });

  it("对话装得下时不误报", () => {
    const plan = engine.plan(base as never);
    assert.equal(plan.dialogueExceedsHardFit, false);
    assert.equal(plan.overByTokens, 0);
  });

  it("plan 真的比 prepare 便宜（不做装配）", () => {
    let calls = 0;
    const counting = {
      id: "counting",
      count: (t: string) => {
        calls += 1;
        return t ? t.length : 0;
      },
    };
    const e = new CogniStackEngine();
    calls = 0;
    e.plan({ ...base, tokenCounter: counting } as never);
    const planCalls = calls;
    calls = 0;
    e.prepare({ ...base, tokenCounter: counting } as never);
    assert.ok(
      planCalls < calls,
      `plan 的分词次数(${planCalls})应少于 prepare(${calls})`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* G-5 摘要质量（纯结构性，不调 LLM）                                     */
/* ------------------------------------------------------------------ */

describe("G-5 摘要结构质量", () => {
  it("完整文档：无缺栏目、有硬事实", () => {
    const q = assessSummaryQuality(
      "【硬事实】\n用户是阿铁\n\n【时间线】\n今天\n\n【关系与称呼】\n搭档\n\n【未决】\n显卡驱动\n\n【近期情节】\n在调参数",
    );
    assert.equal(q.looksStructured, true);
    assert.deepEqual(q.missingColumns, []);
    assert.equal(q.hasHardFact, true);
    assert.equal(q.isEmpty, false);
    assert.deepEqual(q.unknownColumns, []);
  });

  it("模型只回了一段散文：被识别为「不像结构化」且所有栏目都缺", () => {
    const q = assessSummaryQuality("好的，他们的关系变得更亲密了，之后又发生了一些事。");
    assert.equal(q.looksStructured, false);
    assert.equal(q.missingColumns.length, 5);
    assert.equal(q.hasHardFact, false);
  });

  it("栏目在但硬事实是「无」→ hasHardFact 为 false（这才是要 retry 的情况）", () => {
    const q = assessSummaryQuality("【硬事实】\n无\n\n【时间线】\n无\n\n【关系与称呼】\n无\n\n【未决】\n无\n\n【近期情节】\n无");
    assert.equal(q.looksStructured, true);
    assert.equal(q.hasHardFact, false);
  });

  it("未知栏目被记录（格式漂移的入口）", () => {
    const q = assessSummaryQuality("【硬事实】\nx\n\n【外星栏目】\ny");
    assert.deepEqual(q.unknownColumns, ["【外星栏目】"]);
  });

  it("给出与上一版的长度比，供宿主判断是否异常缩短", () => {
    const prev = "【硬事实】\n" + "内容".repeat(100);
    const q = assessSummaryQuality("【硬事实】\n短", { previous: prev });
    assert.ok(q.lengthRatioVsPrev !== undefined && q.lengthRatioVsPrev < 0.2);
    assert.equal(assessSummaryQuality("x").lengthRatioVsPrev, undefined);
  });

  it("SummaryEngine.parseStructuredCompress 带上 quality", () => {
    const s = new SummaryEngine();
    const ok = s.parseStructuredCompress("【硬事实】\n甲\n\n【未决】\n乙");
    assert.equal(ok.quality.looksStructured, true);
    assert.equal(ok.quality.hasHardFact, true);

    const bad = s.parseStructuredCompress("这是一段没有任何栏目的散文回复。");
    assert.equal(bad.quality.looksStructured, false);

    const empty = s.parseStructuredCompress("");
    assert.equal(empty.quality.isEmpty, true);
    assert.equal(empty.summaryText, "");
  });

  it("STATE_PATCH 仍被剥离，质量针对的是正文", () => {
    const s = new SummaryEngine();
    const r = s.parseStructuredCompress(
      "【硬事实】\n甲\n\n<<<STATE_PATCH>>>\n{\"entries\":[{\"key\":\"地点\",\"value\":\"家\"}]}\n<<<END>>>",
    );
    assert.deepEqual(r.statePatchRaw, { entries: [{ key: "地点", value: "家" }] });
    assert.ok(!r.summaryText.includes("STATE_PATCH"));
    assert.equal(r.quality.hasHardFact, true);
  });
});

/* ------------------------------------------------------------------ */
/* G-6 记忆审计                                                        */
/* ------------------------------------------------------------------ */

describe("G-6 记忆审计", () => {
  it("内容未变 → clean", () => {
    const doc = "【硬事实】\n用户是阿铁\n\n【未决】\n显卡驱动";
    const r = auditMemory(doc, doc);
    assert.equal(r.verdict, "clean");
    assert.deepEqual(r.lost, []);
    assert.deepEqual(memoryAuditWarnings(r), []);
  });

  it("硬事实丢失 → data-loss 并给出告警", () => {
    const before = "【硬事实】\n用户是阿铁\n火\n\n【未决】\n显卡驱动";
    const after = "【硬事实】\n用户是阿铁\n\n【未决】\n显卡驱动";
    const r = auditMemory(before, after);
    assert.equal(r.verdict, "data-loss");
    assert.equal(r.lostProtected.length, 1);
    assert.deepEqual(r.lostProtected[0]!.units, ["火"]);
    const warnings = memoryAuditWarnings(r);
    assert.ok(warnings.some((w) => w.startsWith("memory-lost-protected:【硬事实】")), warnings.join("|"));
  });

  it("只丢可牺牲栏目 → degraded，而不是 data-loss", () => {
    // 注意：这里必须用「有句读的成句」当 近期情节 内容 —— 无标点且过短的串会被
    // 既有的 stub 启发式丢掉（AUDIT 已记录该行为），那样就没有损失可检测了。
    const before = "【硬事实】\n甲\n\n【近期情节】\n他们在深夜聊了很久，然后一起检查了显卡驱动的版本。";
    const after = "【硬事实】\n甲";
    const r = auditMemory(before, after);
    assert.equal(r.verdict, "degraded");
    assert.deepEqual(r.lostProtected, []);
    assert.ok(memoryAuditWarnings(r).some((w) => w.startsWith("memory-lost-column:【近期情节】")));
  });

  it("散文输入 → not-structured（明确说无法审计，而不是报 clean）", () => {
    const r = auditMemory("他们聊了很久。", "他们聊了很久。");
    assert.equal(r.verdict, "not-structured");
    assert.deepEqual(memoryAuditWarnings(r), []);
  });

  it("未知栏目进入告警", () => {
    const r = auditMemory("【硬事实】\n甲", "【硬事实】\n甲\n\n【奇怪栏目】\n乙");
    assert.deepEqual(r.unknownColumns.after, ["【奇怪栏目】"]);
    assert.ok(memoryAuditWarnings(r).some((w) => w.startsWith("memory-unknown-column:")));
  });

  it("引擎开启 auditMemory 后，丢硬事实会产生 memory-* 告警（notice 级）", () => {
    const engine = new CogniStackEngine({ auditMemory: true });
    const result = engine.prepare({
      card: { name: "阿铁" },
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      contextTokenLimit: 4096,
      tokenCounter: counter,
      // 单块文本里同时给硬事实与未知栏目，审计会覆盖到
      summaryBlocks: [
        {
          id: "b1",
          text: "【硬事实】\n甲\n\n【奇怪栏目】\n乙",
          throughMessageId: "m1",
          pairCount: 1,
        },
      ],
    } as never);
    assert.ok(result.diagnostics.memoryAudit, "应带审计报告");
    assert.ok(
      result.diagnostics.severity.notices.some((w) => w.startsWith("memory-")),
      `应产生 notice 级 memory-* 告警，实际：${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.diagnostics.severity.isDegraded, false, "记忆告警不应把整轮标记为降级");
  });

  it("未开启时不做审计（默认零开销）", () => {
    const engine = new CogniStackEngine();
    const result = engine.prepare({
      card: { name: "阿铁" },
      dialogue: [{ id: "m1", role: "user", content: "你好" }],
      contextTokenLimit: 4096,
      tokenCounter: counter,
    } as never);
    assert.equal(result.diagnostics.memoryAudit, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* G-9 段落级预算归因                                                   */
/* ------------------------------------------------------------------ */

describe("G-9 段落预算归因", () => {
  function section(text: string, priority: number): PromptSection {
    return { text, priority };
  }

  it("按优先级分层统计，并算出被裁掉多少", () => {
    const before = [section("aaaa", SECTION_PRIORITY.systemRules), section("bbbbbbbb", SECTION_PRIORITY.card)];
    const after = [section("aaaa", SECTION_PRIORITY.systemRules), section("bb", SECTION_PRIORITY.card)];
    const a = attributeBudget(before, after, counter);
    const rules = a.tiers.find((t) => t.priority === SECTION_PRIORITY.systemRules)!;
    const card = a.tiers.find((t) => t.priority === SECTION_PRIORITY.card)!;
    assert.equal(rules.clippedTokens, 0);
    assert.equal(card.beforeTokens, 8);
    assert.equal(card.afterTokens, 2);
    assert.equal(card.clippedTokens, 6);
    assert.equal(a.clippedTokens, 6);
    assert.equal(a.untouched, false);
    assert.equal(a.tiers[0]!.priority, SECTION_PRIORITY.card, "重的层排前面");
  });

  it("没裁剪时 untouched 为 true", () => {
    const s = [section("abc", 10)];
    const a = attributeBudget(s, s.map((x) => ({ ...x })), counter);
    assert.equal(a.untouched, true);
    assert.equal(a.clippedTokens, 0);
  });

  it("整段消失时该层 after 为 0", () => {
    const before = [section("abc", SECTION_PRIORITY.mesExample), section("de", SECTION_PRIORITY.card)];
    const after = [section("de", SECTION_PRIORITY.card)];
    const a = attributeBudget(before, after, counter);
    const mes = a.tiers.find((t) => t.priority === SECTION_PRIORITY.mesExample)!;
    assert.equal(mes.afterTokens, 0);
    assert.equal(mes.sectionsAfter, 0);
    assert.equal(mes.sectionsBefore, 1);
  });

  it("真实 prepare 会带上 budgetAttribution", () => {
    const engine = new CogniStackEngine();
    const r = engine.prepare({
      card: { name: "阿铁", description: "设定".repeat(400) },
      dialogue: Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: "对白内容".repeat(20),
      })),
      contextTokenLimit: 2048,
      tokenCounter: counter,
    } as never);
    const attr = r.diagnostics.budgetAttribution;
    assert.ok(attr, "应带上归因");
    assert.ok(attr.tiers.length > 0);
    const totalBefore = attr.tiers.reduce((n, t) => n + t.beforeTokens, 0);
    assert.equal(totalBefore, attr.systemBeforeTokens);
  });
});

/* ------------------------------------------------------------------ */
/* G-14 输入快照（回放的前提）                                          */
/* ------------------------------------------------------------------ */

describe("G-14 输入快照与 captureInputs", () => {
  const base = {
    card: { name: "阿铁", description: "技术搭子" },
    dialogue: [{ id: "m1", role: "user", content: "你好" }],
    contextTokenLimit: 4096,
    tokenCounter: counter,
  };

  it("默认关闭：不产生快照（零开销）", () => {
    const telemetry = new CogniStackTelemetry();
    const engine = new CogniStackEngine({ telemetry });
    engine.prepare(base as never);
    assert.equal(telemetry.captureInputsEnabled, false);
    assert.equal(telemetry.snapshot().turns[0]!.inputSnapshot, undefined);
  });

  it("开启后快照进 TurnRecord，且不含无法序列化的 tokenCounter", () => {
    const telemetry = new CogniStackTelemetry({ captureInputs: true });
    const engine = new CogniStackEngine({ telemetry });
    engine.prepare(base as never);
    const turn = telemetry.snapshot().turns[0]!;
    assert.ok(turn.inputSnapshot, "应有快照");
    const snap = turn.inputSnapshot as Record<string, unknown>;
    assert.ok(!("tokenCounter" in snap), "tokenCounter 是函数，存下来只会得到一个跑不起来的假快照");
    assert.equal(snap.counterId, "char-exact(test-only)", "应改存计数器身份");
    assert.deepEqual(snap.dialogue, base.dialogue);
    // 真的能序列化（这是"可重放"的最低要求）
    assert.doesNotThrow(() => JSON.stringify(turn.inputSnapshot));
  });

  it("快照过大时被丢弃并标记，不破坏「内存有界」约束", () => {
    const telemetry = new CogniStackTelemetry({ captureInputs: true });
    const engine = new CogniStackEngine({ telemetry });
    engine.prepare({
      ...base,
      dialogue: [{ id: "m1", role: "user", content: "内容".repeat(40_000) }],
    } as never);
    const turn = telemetry.snapshot().turns[0]!;
    assert.equal(turn.inputSnapshot, undefined, "超限快照不应进入环形缓冲");
    assert.equal(turn.inputSnapshotDropped, true, "必须标记为被丢弃，而不是静默丢失");
  });

  it("status 模式不带快照字段也不报错", () => {
    const telemetry = new CogniStackTelemetry({ captureInputs: true });
    const engine = new CogniStackEngine({ telemetry });
    const r = engine.prepare({
      ...base,
      mode: "status",
      priorAssembledPromptTokens: 100,
    } as never);
    assert.equal(r.mode, "status");
  });
});

/* ------------------------------------------------------------------ */
/* G-10 端口冲突诊断                                                    */
/* ------------------------------------------------------------------ */

describe("G-10 端口诊断", () => {
  function provider(tag: string) {
    return tag;
  }

  it("端口没接入时 winner 为缺省，bound 为 false", () => {
    const reg = new PortRegistry<{ lore?: string; card?: string }>();
    const diag = reg.diagnostics({ lore: "未接入", card: "引擎缺省" });
    const lore = diag.find((d) => d.port === "lore")!;
    assert.equal(lore.bound, false);
    assert.equal(lore.winner.providerId, null);
    assert.equal(lore.winner.builtin, false, "「未接入」是缺失，不是内置实现");
    assert.deepEqual(lore.shadowed, []);

    const card = diag.find((d) => d.port === "card")!;
    assert.equal(card.winner.providerName, "引擎缺省");
    assert.equal(card.winner.builtin, true, "引擎缺省算内置");
  });

  it("两个提供方争抢：priority 小者生效，另一个进入 shadowed", () => {
    const reg = new PortRegistry<{ lore?: string }>();
    reg.register("high", "高优先级", { lore: provider("high") }, 50);
    reg.register("low", "低优先级", { lore: provider("low") }, 100);
    const diag = reg.diagnostics({ lore: "未接入" }).find((d) => d.port === "lore")!;
    assert.equal(diag.winner.providerId, "high");
    assert.equal(diag.bound, true);
    assert.deepEqual(diag.shadowed, [
      { providerId: "low", providerName: "低优先级", priority: 100 },
    ]);
  });

  it("同优先级先到先得，被压制方可见", () => {
    const reg = new PortRegistry<{ lore?: string }>();
    reg.register("first", "先到", { lore: provider("a") }, 100);
    reg.register("second", "后到", { lore: provider("b") }, 100);
    const diag = reg.diagnostics({ lore: "未接入" }).find((d) => d.port === "lore")!;
    assert.equal(diag.winner.providerId, "first");
    assert.equal(diag.shadowed.length, 1);
    assert.equal(diag.shadowed[0]!.providerId, "second");
  });

  it("断开后自动回退，且能接上缺省占位", () => {
    const reg = new PortRegistry<{ lore?: string }>();
    reg.register("a", "A", { lore: provider("a") }, 50);
    reg.register("b", "B", { lore: provider("b") }, 100);
    reg.unregister("a");
    const diag = reg.diagnostics({ lore: "未接入" }).find((d) => d.port === "lore")!;
    assert.equal(diag.winner.providerId, "b");
    assert.deepEqual(diag.shadowed, []);
  });

  it("引擎 portDiagnostics 与 portTable 对同一批端口给出一致结论", () => {
    const engine = new CogniStackEngine();
    engine.connect({
      id: "my-lore",
      name: "我的知识库",
      provides: { lore: { selectEntries: () => [] } },
    } as never);
    const table = engine.portTable().find((b) => b.port === "lore")!;
    const diag = engine.portDiagnostics().find((d) => d.port === "lore")!;
    assert.equal(diag.winner.providerId, table.providerId);
    assert.equal(diag.winner.providerName, table.providerName);
    assert.equal(diag.bound, true);
  });

  it("引擎缺省端口在内置与未接入之间区分正确", () => {
    const engine = new CogniStackEngine();
    const diag = engine.portDiagnostics();
    const card = diag.find((d) => d.port === "card")!;
    const lore = diag.find((d) => d.port === "lore")!;
    assert.equal(card.winner.builtin, true);
    assert.equal(card.source, "builtin");
    assert.equal(lore.winner.builtin, false);
    assert.equal(lore.bound, false);
    assert.equal(lore.source, "none");
  });

  it("构造注入 / wire() 优先于 connect，且必须如实报出来源", () => {
    /*
     * 回归：生效顺序是 构造注入/wire() > connect() > 缺省（rebuildContext 里
     * `{ ...registry.resolve(), ...collaborators }`）。此前 portDiagnostics 只读注册表，
     * 会把"构造注入的 lore 正在生效"报成"未接入"，把被压制的 connect 提供方报成赢家。
     */
    const injected = { selectEntries: () => [] };
    const engine = new CogniStackEngine({ collaborators: { lore: injected } as never });
    // 同时接一个 connect 提供方 —— 它被构造注入压制，但注册表里它是赢家
    engine.connect({
      id: "connected-lore",
      name: "connect 提供方",
      provides: { lore: { selectEntries: () => [] } },
    } as never);

    const lore = engine.portDiagnostics().find((d) => d.port === "lore")!;
    assert.equal(lore.source, "constructor", "先看来源：构造注入才是真正生效的");
    assert.equal(lore.winner.providerName, "构造注入 / wire()");
    assert.equal(lore.bound, true, "它是接上的，只是不通过注册表");
    assert.equal(
      lore.shadowed[0]?.providerId,
      "connected-lore",
      "被构造注入压制的 connect 提供方必须出现在 shadowed 里，否则这个问题无从自查",
    );
  });

  it("wire() 注入同样被识别为构造注入来源", () => {
    const engine = new CogniStackEngine();
    engine.wire({ state: { formatForPrompt: () => "" } } as never);
    const state = engine.portDiagnostics().find((d) => d.port === "state")!;
    assert.equal(state.source, "constructor");
  });

  it("纯 connect 场景来源标为 connection", () => {
    const engine = new CogniStackEngine();
    engine.connect({
      id: "kb",
      name: "知识库",
      provides: { lore: { selectEntries: () => [] } },
    } as never);
    const lore = engine.portDiagnostics().find((d) => d.port === "lore")!;
    assert.equal(lore.source, "connection");
    assert.equal(lore.winner.providerId, "kb");
  });
});
