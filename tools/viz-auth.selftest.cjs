/**
 * Self-check for viz-auth helpers (shared with viz-server).
 * Run: node tools/viz-auth.selftest.cjs
 */
"use strict";
const assert = require("node:assert/strict");
const {
  timingSafeEqualStr,
  isLoopbackHost,
  isOpenBindHost,
  requiresApiKeyForBind,
  checkApiKeyHeaders,
  createStreamTicketStore,
} = require("./lib/viz-auth.cjs");

const KEY = "secret-test-key";
assert.equal(checkApiKeyHeaders("", {}, ""), true);
assert.equal(checkApiKeyHeaders(KEY, {}, ""), false);
assert.equal(checkApiKeyHeaders(KEY, { authorization: `Bearer ${KEY}` }, ""), true);
assert.equal(checkApiKeyHeaders(KEY, { "x-api-key": KEY }, ""), true);
assert.equal(checkApiKeyHeaders(KEY, {}, KEY), true);
assert.equal(checkApiKeyHeaders(KEY, {}, KEY, { allowQueryKey: false }), false);
assert.equal(checkApiKeyHeaders(KEY, { authorization: "Bearer wrong" }, ""), false);
assert.equal(timingSafeEqualStr(KEY, KEY), true);
assert.equal(timingSafeEqualStr(KEY, "x"), false);

assert.equal(isLoopbackHost("127.0.0.1"), true);
assert.equal(isLoopbackHost("::1"), true);
assert.equal(isLoopbackHost("localhost"), true);
assert.equal(isOpenBindHost("::"), true);
assert.equal(isOpenBindHost("0.0.0.0"), true);
assert.equal(isOpenBindHost("*"), true);
assert.equal(requiresApiKeyForBind("::"), true);
assert.equal(requiresApiKeyForBind("0.0.0.0"), true);
assert.equal(requiresApiKeyForBind("127.0.0.1"), false);
assert.equal(requiresApiKeyForBind("192.168.1.10"), true);

const store = createStreamTicketStore(60_000);
const { ticket } = store.mint();
assert.equal(store.peek(ticket), true);
assert.equal(store.consume(ticket), true);
assert.equal(store.consume(ticket), false, "ticket is one-shot");
assert.equal(store.peek(ticket), false);

console.log("viz-auth.selftest: ok");
