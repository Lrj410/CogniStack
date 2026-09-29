"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractSystemText,
  toCogniStackDialogue,
  toAnthropicMessages,
} = require("../tools/anthropic-compat.cjs");

test("Anthropic Bridge — extractSystemText", () => {
  assert.equal(extractSystemText("You are an AI"), "You are an AI");
  assert.equal(
    extractSystemText([
      { type: "text", text: "Rule 1" },
      { type: "text", text: "Rule 2" },
    ]),
    "Rule 1\n\nRule 2"
  );
  assert.equal(extractSystemText(null), "");
  assert.equal(extractSystemText(undefined), "");
});

test("Anthropic Bridge — toCogniStackDialogue", () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: [{ type: "text", text: "World" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "Result text" },
      ],
    },
  ];

  const dialogue = toCogniStackDialogue(messages);
  assert.equal(dialogue.length, 3);
  assert.equal(dialogue[0].role, "user");
  assert.equal(dialogue[0].content, "Hello");
  assert.equal(dialogue[1].role, "assistant");
  assert.equal(dialogue[1].content, "World");
  assert.equal(dialogue[2].role, "user");
  assert.equal(dialogue[2].content, "Result text");
});

test("Anthropic Bridge — toAnthropicMessages", () => {
  const cogniMessages = [
    { role: "system", content: "System text" },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello there" },
  ];

  const result = toAnthropicMessages(cogniMessages);
  assert.equal(result.length, 2);
  assert.deepEqual(result, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello there" },
  ]);
});

test("Anthropic Bridge — toAnthropicMessages preserves complex blocks", () => {
  const origMessages = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "fn", input: {} }] },
  ];
  const dialogue = toCogniStackDialogue(origMessages);
  const cogniMessages = [
    { role: "user", content: "ok" },
    { role: "assistant", content: '{"type":"tool_use","id":"t2","name":"fn","input":{}}' },
  ];
  const result = toAnthropicMessages(cogniMessages, dialogue);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].content, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
  assert.deepEqual(result[1].content, [{ type: "tool_use", id: "t2", name: "fn", input: {} }]);
});

test("Anthropic Bridge — HTTP E2E: /health & validation", async () => {
  const { server } = require("../tools/anthropic-compat.cjs");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.protocol, "anthropic-messages");

    // 2. Validation error: empty messages
    const emptyRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = await emptyRes.json();
    assert.equal(emptyJson.type, "error");
    assert.equal(emptyJson.error.type, "invalid_request_error");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
