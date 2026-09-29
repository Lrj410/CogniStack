/**
 * Gateway sanitize tests — run with the rest of the suite via npm test.
 *   node --test dist-test/test/*.test.js test/prepare-api.test.cjs
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/*
 * Load the TEST build, not `dist/`.
 *
 * `npm test` runs `build:test` (→ dist-test) and never rebuilds `dist/`, so
 * requiring `dist/index.js` here silently tested whatever stale artifact happened
 * to be on disk — the gateway could regress against a fresh `src` and this suite
 * would still be green. prepublishOnly runs `npm test` *before* `npm run build`,
 * so in a clean checkout there would be no `dist/` at all.
 */
const S = require(path.join(ROOT, "dist-test", "src", "index.js"));
const { createPrepareGateway } = require(path.join(ROOT, "tools", "lib", "prepare-api.cjs"));

describe("prepare-api — summaryBlocks mapping", () => {
  it("maps text + throughMessageId (docs shape) into the engine", async () => {
    const tel = new S.CogniStackTelemetry();
    const gw = createPrepareGateway(S, { telemetry: tel });
    const out = await gw.prepare({
      profile: { name: "阿铁" },
      dialogue: [
        { id: "1", role: "user", content: "你好" },
        { id: "2", role: "assistant", content: "你好。" },
        { id: "3", role: "user", content: "显卡？" },
      ],
      summaryBlocks: [
        {
          id: "b1",
          text: "【硬事实】显卡是 RTX 5070\n【时间线】无\n【关系与称呼】无\n【未决】无\n【近期情节】无",
          throughMessageId: "2",
          pairCount: 1,
          kind: "full",
        },
      ],
      summarizedThroughMessageId: "2",
      contextTokenLimit: 4096,
      tokenCounter: undefined,
    });
    assert.equal(out.ok, true);
    const sys = out.messages.find((m) => m.role === "system")?.content || "";
    assert.ok(sys.includes("RTX 5070"), "memory body must reach the prompt");
    assert.ok((out.summaryBlocks || []).length >= 1);
    assert.ok(out.summaryBlocks[0].text.includes("RTX 5070"));
  });

  it("accepts legacy content alias for summary block body", async () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    const input = gw.buildInput({
      dialogue: [{ id: "1", role: "user", content: "hi" }],
      summaryBlocks: [{ id: "x", content: "【硬事实】别名字段", throughMessageId: "1" }],
    });
    assert.equal(input.summaryBlocks[0].text, "【硬事实】别名字段");
    assert.equal(input.summaryBlocks[0].throughMessageId, "1");
  });

  it("maps insertionOrder from order and rejects status without prior tokens", () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    const input = gw.buildInput({
      dialogue: [{ id: "1", role: "user", content: "显卡" }],
      loreEntries: [{ id: "g", name: "显卡", keys: ["显卡"], content: "5070", order: 7 }],
    });
    assert.equal(input.loreEntries[0].insertionOrder, 7);
    assert.throws(
      () =>
        gw.buildInput({
          mode: "status",
          dialogue: [{ id: "1", role: "user", content: "x" }],
        }),
      /priorAssembledPromptTokens/,
    );
  });
});

describe("prepare-api — diagnostics + budget wire contract", () => {
  it("forwards the whole engine diagnostics object, not a hand-picked subset", async () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    const out = await gw.prepare({
      profile: { name: "阿铁" },
      dialogue: [
        { id: "1", role: "user", content: "你好" },
        { id: "2", role: "assistant", content: "你好。" },
      ],
      contextTokenLimit: 4096,
    });
    const d = out.diagnostics;
    assert.ok(d, "diagnostics must be present");
    // Field-parity guard: the response must carry every key the engine produced.
    // The old hand-written allowlist dropped whole families of fields, and each
    // new engine field had to be remembered here — this is the regression net.
    for (const k of [
      "severity",
      "counter",
      "counterId",
      "timings",
      "cacheHit",
      "prefixStability",
      "stages",
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(d, k), `diagnostics.${k} missing from HTTP response`);
    }
    // These two are what the console's prefix / budget-attribution panels read.
    assert.ok(d.prefixStability, "diagnostics.prefixStability must survive the wire");
    // Top-level copy: a local runtime's prefix cache reads it, and it used to be absent.
    assert.ok(out.prefixStability, "top-level prefixStability must be present");
  });

  it("honours budget.completionReserveTokens instead of overwriting it with undefined", async () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    const out = await gw.prepare({
      profile: { name: "阿铁" },
      dialogue: [{ id: "1", role: "user", content: "你好" }],
      contextTokenLimit: 4096,
      budget: { completionReserveTokens: 512 },
    });
    // Before the fix the nested value was clobbered by `input.completionReserveTokens
    // === undefined`, resolved to 0, and hardFit silently grew past the completion.
    assert.equal(out.budget.completionReserve, 512);
  });
});

describe("prepare-api — optional keyword lore", () => {
  it("injects keyword-matched lore when keywordLore is enabled", async () => {
    const gw = createPrepareGateway(S, {
      telemetry: new S.CogniStackTelemetry(),
      keywordLore: true,
    });
    const out = await gw.prepare({
      profile: { name: "阿铁" },
      dialogue: [
        { id: "1", role: "user", content: "显卡型号？" },
        { id: "2", role: "assistant", content: "稍等。" },
      ],
      loreEntries: [
        {
          id: "gpu",
          name: "显卡",
          keys: ["显卡"],
          content: "RTX 5070 Laptop 8GB",
          enabled: true,
          constant: false,
          insertionOrder: 0,
        },
      ],
      contextTokenLimit: 4096,
    });
    assert.ok(out.loreInjected.some((x) => x.id === "gpu" || x.name === "显卡"));
    const sys = out.messages.find((m) => m.role === "system")?.content || "";
    assert.ok(sys.includes("5070"));
  });
});

/**
 * 输入契约错误必须能自我诊断。
 *
 * 背景：网关把这些错误一律折成 `{"error":"invalid request","code":"bad_request"}`，
 * 客户端的「测试连接」探针拿到后无从判断缺了什么，而面板上又不留痕迹 ——
 * 「测试连接成功、系统里什么都没有」于是无法自查。网关自己写的契约说明带 `expose`
 * 标记（引擎/端口抛出的错误**没有**该标记，仍然不外传）。
 */
describe("prepare-api — 输入契约错误的可诊断性", () => {
  it("缺 dialogue：报出原因并可回传", async () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    await assert.rejects(
      () => gw.prepare({ profile: { name: "阿铁" } }),
      (err) => {
        assert.equal(err.expose, "dialogue[] required (at least 1 message)");
        assert.equal(err.code, "missing_dialogue");
        return true;
      },
    );
  });

  it("mode=status 缺 priorAssembledPromptTokens：报出字段名", async () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    await assert.rejects(
      () =>
        gw.prepare({
          profile: { name: "阿铁" },
          mode: "status",
          dialogue: [{ id: "1", role: "user", content: "ping" }],
        }),
      (err) => {
        assert.equal(err.code, "missing_prior_tokens");
        assert.match(err.expose, /priorAssembledPromptTokens/);
        return true;
      },
    );
  });

  it("非对象 body：报出 invalid_body 而不是崩溃", async () => {
    const gw = createPrepareGateway(S, { telemetry: new S.CogniStackTelemetry() });
    await assert.rejects(
      () => gw.prepare(null),
      (err) => {
        assert.equal(err.expose, "JSON body required");
        assert.equal(err.code, "invalid_body");
        return true;
      },
    );
  });
});
