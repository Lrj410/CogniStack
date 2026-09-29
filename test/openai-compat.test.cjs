"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  server,
  toDialogue,
  collectSystemText,
} = require("../tools/openai-compat.cjs");

test("OpenAI Bridge — toDialogue", () => {
  const messages = [
    { role: "system", content: "ignore me" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ];
  const d = toDialogue(messages);
  assert.equal(d.length, 2);
  assert.equal(d[0].role, "user");
  assert.equal(d[0].content, "hello");
  assert.equal(d[1].role, "assistant");
  assert.equal(d[1].content, "world");
});

test("OpenAI Bridge — toDialogue with tool and tool_calls", () => {
  const messages = [
    { role: "user", content: "call weather" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "weather" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "22C" },
  ];
  const d = toDialogue(messages);
  assert.equal(d.length, 3);
  assert.equal(d[0].role, "user");
  assert.equal(d[1].role, "assistant");
  assert.ok(d[1].content.includes("weather"));
  assert.equal(d[2].role, "user"); // mapped to user for dialogue budget
  assert.equal(d[2]._raw.role, "tool");
  assert.equal(d[2]._raw.tool_call_id, "c1");
});

test("OpenAI Bridge — collectSystemText", () => {
  const messages = [
    { role: "system", content: "sys1" },
    { role: "developer", content: "sys2" },
    { role: "user", content: "hi" },
  ];
  const sys = collectSystemText(messages);
  assert.equal(sys, "sys1\n\nsys2");
});

test("OpenAI Bridge — HTTP E2E: /health & validation", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);

    // 2. Validation error: empty messages
    const emptyRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = await emptyRes.json();
    assert.ok(emptyJson.error);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
