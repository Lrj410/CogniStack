/**
 * Shared auth / bind helpers for viz-server + selftest.
 * Zero deps beyond node:crypto.
 */
"use strict";

const crypto = require("node:crypto");

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba.length ? ba : Buffer.alloc(1), ba.length ? ba : Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function isLoopbackHost(h) {
  const x = String(h || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    x === "127.0.0.1" ||
    x === "::1" ||
    x === "0:0:0:0:0:0:0:1" ||
    x === "localhost" ||
    x === "::ffff:127.0.0.1"
  );
}

function isOpenBindHost(h) {
  const x = String(h || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return !x || x === "0.0.0.0" || x === "::" || x === "*" || x === "[::]";
}

function requiresApiKeyForBind(h) {
  return isOpenBindHost(h) || !isLoopbackHost(h);
}

/**
 * @param {string} apiKey
 * @param {object} reqHeaders
 * @param {string} [queryKey]
 * @param {{ allowQueryKey?: boolean }} [opts]
 */
function checkApiKeyHeaders(apiKey, reqHeaders, queryKey, opts = {}) {
  if (!apiKey) return true;
  const allowQueryKey = opts.allowQueryKey !== false;
  const auth = String(reqHeaders.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const x = String(reqHeaders["x-api-key"] || "").trim();
  if (timingSafeEqualStr(bearer, apiKey) || timingSafeEqualStr(x, apiKey)) return true;
  if (allowQueryKey) {
    const q = String(queryKey || "");
    if (q.length > 0 && timingSafeEqualStr(q, apiKey)) return true;
  }
  return false;
}

function createStreamTicketStore(ttlMs = 60_000) {
  const tickets = new Map();
  function mint() {
    const ticket = crypto.randomBytes(24).toString("base64url");
    const exp = Date.now() + ttlMs;
    tickets.set(ticket, exp);
    if (tickets.size > 256) {
      const now = Date.now();
      for (const [k, e] of tickets) {
        if (e <= now) tickets.delete(k);
      }
    }
    return { ticket, expiresInMs: ttlMs };
  }
  /** One-shot: valid ticket is deleted on success. */
  function consume(ticket) {
    if (!ticket) return false;
    const exp = tickets.get(ticket);
    if (!exp) return false;
    tickets.delete(ticket);
    return exp > Date.now();
  }
  /** Peek without consuming (tests / diagnostics). */
  function peek(ticket) {
    if (!ticket) return false;
    const exp = tickets.get(ticket);
    if (!exp) return false;
    if (exp <= Date.now()) {
      tickets.delete(ticket);
      return false;
    }
    return true;
  }
  return { mint, consume, peek, _map: tickets };
}

module.exports = {
  timingSafeEqualStr,
  isLoopbackHost,
  isOpenBindHost,
  requiresApiKeyForBind,
  checkApiKeyHeaders,
  createStreamTicketStore,
};
