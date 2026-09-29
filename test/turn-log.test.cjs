/**
 * Turn log unit tests (G-12).
 *
 * These run against a temp file so they lock the real behaviours that matter:
 * rotation, tail-bounded reads, malformed-line tolerance, and the guarantee that
 * the record is metadata-only (no prompt text).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach, afterEach } = require("node:test");

const { createTurnLog } = require("../tools/lib/turn-log.cjs");

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-turnlog-"));
  file = path.join(dir, "turns.jsonl");
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

function turn(n, over = {}) {
  return {
    seq: n,
    at: 1_700_000_000_000 + n,
    hostId: "h1",
    mode: "generate",
    promptTokens: 100 + n,
    ...over,
  };
}

describe("turn-log 基础写入与读取", () => {
  it("append 后能按新→旧读回，且计数正确", () => {
    const log = createTurnLog({ file });
    for (let i = 1; i <= 5; i += 1) assert.equal(log.append(turn(i)), true);
    const res = log.read({ limit: 10 });
    assert.equal(res.turns.length, 5);
    assert.equal(res.turns[0].seq, 5, "最新的在最前");
    assert.equal(res.turns[4].seq, 1);
    assert.equal(res.malformed, 0);
    assert.equal(res.scanned, 5);
    assert.equal(log.stats().written, 5);
  });

  it("limit 生效，并按需截断", () => {
    const log = createTurnLog({ file });
    for (let i = 1; i <= 50; i += 1) log.append(turn(i));
    const res = log.read({ limit: 10 });
    assert.equal(res.turns.length, 10);
    assert.equal(res.turns[0].seq, 50);
    assert.equal(res.turns[9].seq, 41);
  });

  it("按 hostId / 时间窗过滤", () => {
    const log = createTurnLog({ file });
    log.append(turn(1, { hostId: "a" }));
    log.append(turn(2, { hostId: "b" }));
    log.append(turn(3, { hostId: "a" }));
    const onlyA = log.read({ hostId: "a" });
    assert.deepEqual(onlyA.turns.map((t) => t.seq), [3, 1]);
    const windowed = log.read({ from: turn(2).at, to: turn(3).at });
    assert.deepEqual(windowed.turns.map((t) => t.seq), [3, 2]);
  });

  it("坏行被跳过并计数，不会让整个日志不可读", () => {
    const log = createTurnLog({ file });
    log.append(turn(1));
    fs.appendFileSync(file, "{这不是合法 JSON\n");
    log.append(turn(2));
    const res = log.read({ limit: 10 });
    assert.deepEqual(res.turns.map((t) => t.seq), [2, 1]);
    assert.equal(res.malformed, 1);
  });

  it("文件不存在时返回空而不是抛错", () => {
    const log = createTurnLog({ file: path.join(dir, "nope.jsonl") });
    const res = log.read({ limit: 5 });
    assert.deepEqual(res.turns, []);
    assert.equal(res.scanned, 0);
  });

  it("记录里不含 prompt 正文（只有计数字段）", () => {
    const log = createTurnLog({ file });
    log.append(turn(1, { messages: 3, systemSections: 1 }));
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("role"), "不应出现消息 role 字段");
    const parsed = JSON.parse(raw.trim());
    assert.equal(typeof parsed.messages, "number", "messages 应为计数");
  });
});

describe("turn-log 轮转与上限", () => {
  it("超过 maxBytes 触发轮转，旧文件保留为 .1", () => {
    const minBytes = 64 * 1024; // createTurnLog 的下限
    const log = createTurnLog({ file, maxBytes: minBytes, keep: 2 });
    const pad = "x".repeat(8 * 1024);
    for (let i = 0; i < 12; i += 1) log.append(turn(i, { pad }));
    assert.ok(log.stats().rotations >= 1, "应至少轮转一次");
    assert.ok(fs.existsSync(file + ".1"), "轮转文件应存在");
    const res = log.read({ limit: 500 });
    assert.ok(res.turns.length > 0, "轮转后仍应读到数据");
  });

  it("保留份数有上限，不会无限堆积", () => {
    const log = createTurnLog({ file, maxBytes: 64 * 1024, keep: 2 });
    const pad = "y".repeat(16 * 1024);
    for (let i = 0; i < 20; i += 1) log.append(turn(i, { pad }));
    // keep=2 → 最多 file + .1 + .2
    assert.ok(!fs.existsSync(file + ".3"), "不应产生超过 keep 的轮转文件");
    assert.ok(log.stats().files.length <= 3);
  });

  it("clear 会删掉所有相关文件", () => {
    const log = createTurnLog({ file, maxBytes: 64 * 1024, keep: 2 });
    const pad = "z".repeat(16 * 1024);
    for (let i = 0; i < 12; i += 1) log.append(turn(i, { pad }));
    log.clear();
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(file + ".1"), false);
    assert.equal(log.stats().written, 0);
  });
});

describe("turn-log 健壮性", () => {
  it("无法序列化的记录被计数而不是抛错", () => {
    const log = createTurnLog({ file });
    const circular = { seq: 1, at: 1, hostId: "h" };
    circular.self = circular;
    assert.equal(log.append(circular), false);
    assert.equal(log.stats().dropped, 1);
    assert.equal(log.append(turn(1)), true);
  });
});
