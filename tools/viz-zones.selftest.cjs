"use strict";

const assert = require("node:assert/strict");
const {
  ZONES,
  SURFACE,
  parseZoneSpec,
  zoneAllowsPath,
  zoneAllowList,
  isKnownInterfacePath,
  checkProxyKey,
  resolveClientIp,
  validateZoneConfigs,
} = require("./lib/viz-zones.cjs");

function run() {
  // 1. parseZoneSpec
  assert.deepEqual(parseZoneSpec("127.0.0.1:7331"), { host: "127.0.0.1", port: 7331 });
  assert.deepEqual(parseZoneSpec("[::1]:7332"), { host: "::1", port: 7332 });
  assert.deepEqual(parseZoneSpec("8080", { defaultHost: "0.0.0.0" }), { host: "0.0.0.0", port: 8080 });
  assert.deepEqual(parseZoneSpec("", { defaultHost: "127.0.0.1", defaultPort: 7331 }), { host: "127.0.0.1", port: 7331 });

  // 2. zoneAllowsPath 矩阵
  // local 恒为 true
  assert.equal(zoneAllowsPath("local", "/api/snapshot"), true);
  assert.equal(zoneAllowsPath("local", "/v1/prepare"), true);
  assert.equal(zoneAllowsPath("local", "/api/reset"), true);
  assert.equal(zoneAllowsPath("local", "/unknown-arbitrary-path"), true);

  // lan 允许遥测和对话，不允许 reset 和 turn-log
  assert.equal(zoneAllowsPath("lan", "/v1/prepare"), true);
  assert.equal(zoneAllowsPath("lan", "/api/snapshot"), true);
  assert.equal(zoneAllowsPath("lan", "/api/ports"), true);
  assert.equal(zoneAllowsPath("lan", "/api/reset"), false);
  assert.equal(zoneAllowsPath("lan", "/api/turn-log"), false);

  // wan 只允许 v1 发现、健康与装配
  assert.equal(zoneAllowsPath("wan", "/v1"), true);
  assert.equal(zoneAllowsPath("wan", "/v1/health"), true);
  assert.equal(zoneAllowsPath("wan", "/v1/prepare"), true);
  assert.equal(zoneAllowsPath("wan", "/api/snapshot"), false);
  assert.equal(zoneAllowsPath("wan", "/api/turn"), false);
  assert.equal(zoneAllowsPath("wan", "/api/ports"), false);

  // 3. 契约表 SURFACE 完整性
  assert.ok(SURFACE.length >= 15);
  const wanList = zoneAllowList("wan");
  assert.deepEqual(wanList.sort(), ["GET /v1", "GET /v1/health", "POST /v1/prepare"].sort());

  // 4. checkProxyKey
  assert.deepEqual(checkProxyKey("secret-123", "secret-123"), { required: true, ok: true });
  assert.deepEqual(checkProxyKey("wrong", "secret-123"), { required: true, ok: false });
  assert.deepEqual(checkProxyKey(undefined, "secret-123"), { required: true, ok: false });
  assert.deepEqual(checkProxyKey(undefined, ""), { required: false, ok: true });

  // 5. resolveClientIp
  assert.equal(resolveClientIp({ socketAddress: "10.0.0.1" }, { trustForwarded: false }), "10.0.0.1");
  assert.equal(
    resolveClientIp(
      { socketAddress: "10.0.0.1", headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } },
      { trustForwarded: true }
    ),
    "5.6.7.8"
  );
  // 伪造非 IP 回落 socket
  assert.equal(
    resolveClientIp(
      { socketAddress: "10.0.0.1", headers: { "x-forwarded-for": "malicious-string" } },
      { trustForwarded: true }
    ),
    "10.0.0.1"
  );

  // 6. validateZoneConfigs
  const validCfgs = [
    { zone: "local", host: "127.0.0.1", port: 7331, apiKey: "" },
    { zone: "lan", host: "0.0.0.0", port: 7332, apiKey: "lan-secret" },
    { zone: "wan", host: "127.0.0.1", port: 7333, apiKey: "wan-secret", proxy: { key: "px" } },
  ];
  const res1 = validateZoneConfigs(validCfgs);
  assert.equal(res1.fatal.length, 0);

  // 端口冲突
  const conflict = [
    { zone: "local", host: "127.0.0.1", port: 7331, apiKey: "" },
    { zone: "lan", host: "0.0.0.0", port: 7331, apiKey: "k" },
  ];
  assert.ok(validateZoneConfigs(conflict).fatal.length > 0);

  // WAN 绑公网 IP 报错
  const wanNonLoop = [
    { zone: "wan", host: "0.0.0.0", port: 7333, apiKey: "k" },
  ];
  assert.ok(validateZoneConfigs(wanNonLoop).fatal.length > 0);

  console.log("viz-zones.selftest: ok");
}

run();
