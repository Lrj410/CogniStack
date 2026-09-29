/**
 * CogniStack Visualization & Gateway Zones Engine (viz-zones.cjs)
 * 零运行时依赖，纯函数模块。
 *
 * 负责三段监听（local / lan / wan）的接口面契约、路由 ACL、代理密钥校验、
 * 客户端 IP 提取与多段配置合法性审查。
 */
"use strict";

const net = require("node:net");
const crypto = require("node:crypto");

const ZONES = Object.freeze(["local", "lan", "wan"]);

/**
 * 接口面唯一真源契约表 (SURFACE)
 * 供 ACL 拦截、GET /v1 发现文档、控制台拓扑/设置、自动化测试使用。
 */
const SURFACE = Object.freeze([
  { method: "GET",  path: "/v1",                  zones: ["local", "lan", "wan"] },
  { method: "GET",  path: "/v1/health",           zones: ["local", "lan", "wan"] },
  { method: "POST", path: "/v1/prepare",          zones: ["local", "lan", "wan"] },
  { method: "GET",  path: "/api/snapshot",        zones: ["local", "lan"] },
  { method: "GET",  path: "/api/metrics",         zones: ["local", "lan"] },
  { method: "GET",  path: "/metrics",             zones: ["local"] },
  { method: "GET",  path: "/api/stream",          zones: ["local", "lan"] },
  { method: "POST", path: "/api/stream-ticket",   zones: ["local", "lan"] },
  { method: "POST", path: "/api/host",            zones: ["local", "lan"] },
  { method: "POST", path: "/api/turn",            zones: ["local", "lan"] },
  { method: "POST", path: "/api/ports",           zones: ["local", "lan"] },
  { method: "POST", path: "/api/reset",           zones: ["local"] },
  { method: "GET",  path: "/api/turn-log",        zones: ["local"] },
  { method: "POST", path: "/api/turn-log/replay", zones: ["local"] },
  { method: "POST", path: "/api/turn-log/clear",  zones: ["local"] },
  { method: "POST", path: "/api/zones/start",     zones: ["local"] },
  { method: "POST", path: "/api/zones/stop",      zones: ["local"] },
  { method: "POST", path: "/api/cluster/scale",   zones: ["local"] },
  { method: "POST", path: "/api/cluster/reload",  zones: ["local"] },
  { method: "POST", path: "/api/cluster/config",  zones: ["local"] },
  { method: "POST", path: "/api/cluster/bench",   zones: ["local"] },
  { method: "POST", path: "/api/gateway/block",         zones: ["local"] },
  { method: "POST", path: "/api/gateway/unblock",       zones: ["local"] },
  { method: "POST", path: "/api/gateway/clear-clients", zones: ["local"] },
  { method: "POST", path: "/api/gateway/clear-rejects", zones: ["local"] },
]);

const ALL_SURFACE_PATHS = new Set(SURFACE.map((e) => e.path));

/**
 * 规范化段标识
 */
function normalizeZoneName(s) {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim().toLowerCase();
  return ZONES.includes(trimmed) ? trimmed : null;
}

/**
 * 解析 host:port 配置字符串，如 "127.0.0.1:7331", "[::1]:7331", "0.0.0.0"
 */
function parseZoneSpec(spec, defaults = {}) {
  const dHost = defaults.defaultHost || "127.0.0.1";
  const dPort = Number(defaults.defaultPort) || 7331;
  if (!spec || typeof spec !== "string" || !spec.trim()) {
    return { host: dHost, port: dPort };
  }
  const s = spec.trim();
  // IPv6: [::1]:7331
  if (s.startsWith("[")) {
    const closeIdx = s.indexOf("]");
    if (closeIdx === -1) return null;
    const host = s.slice(1, closeIdx);
    const rest = s.slice(closeIdx + 1);
    let port = dPort;
    if (rest.startsWith(":")) {
      const p = Number(rest.slice(1));
      if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
      port = p;
    }
    return { host, port };
  }
  // IPv4 or hostname
  const parts = s.split(":");
  if (parts.length === 1) {
    // 只有 host，使用默认端口；或者只有纯数字（只有 port）
    if (/^\d+$/.test(parts[0])) {
      const p = Number(parts[0]);
      if (p < 1 || p > 65535) return null;
      return { host: dHost, port: p };
    }
    return { host: parts[0], port: dPort };
  }
  if (parts.length === 2) {
    const host = parts[0] || dHost;
    const p = Number(parts[1]);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
    return { host, port: p };
  }
  return null;
}

/**
 * ACL 路径判定：
 * local 段恒为 true（由既有 handler 自行处理 404/405）；
 * 其他段必须在 SURFACE 声明中包含该 zone。
 */
function zoneAllowsPath(zone, pathname) {
  if (zone === "local") return true;
  for (const entry of SURFACE) {
    if (entry.path === pathname && entry.zones.includes(zone)) {
      return true;
    }
  }
  return false;
}

/**
 * 获取指定段允许的接口方法+路径列表，如 ["GET /v1", "POST /v1/prepare"]
 */
function zoneAllowList(zone) {
  return SURFACE
    .filter((e) => e.zones.includes(zone))
    .map((e) => `${e.method} ${e.path}`);
}

/**
 * 判断是否为已知接口路径（用于过滤公网随机扫描器噪音）
 */
function isKnownInterfacePath(pathname) {
  return ALL_SURFACE_PATHS.has(pathname);
}

/**
 * 常数时间比对字符串，防止时序侧信道攻击。
 *
 * 长度不等时也要做一次等长比对再返回 false —— 否则响应时间会泄漏密钥长度
 * （短输入更快返回），这正是 timingSafeEqual 想消除的侧信道。
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA.length ? bufA : Buffer.alloc(1), bufA.length ? bufA : Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 校验代理共享密钥
 */
function checkProxyKey(headerValue, configuredKey) {
  if (!configuredKey) return { required: false, ok: true };
  if (!headerValue || typeof headerValue !== "string") {
    return { required: true, ok: false };
  }
  const ok = timingSafeEqualStr(headerValue.trim(), configuredKey.trim());
  return { required: true, ok };
}

/**
 * 提取真实客户端 IP（考虑反向代理信任与防伪造）
 */
function resolveClientIp(reqInfo, opts = {}) {
  let socketAddress = reqInfo?.socketAddress || "127.0.0.1";
  if (socketAddress.startsWith("::ffff:")) socketAddress = socketAddress.slice(7);
  if (socketAddress === "::1") socketAddress = "127.0.0.1";

  const trustForwarded = Boolean(opts?.trustForwarded);
  if (!trustForwarded) return socketAddress;

  const xff = reqInfo?.headers?.["x-forwarded-for"];
  if (!xff || typeof xff !== "string") return socketAddress;

  // 严格取最后一跳（离上游最近的一个代理添加的地址，防伪造注入）
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return socketAddress;

  let candidate = parts[parts.length - 1];
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (candidate === "::1") candidate = "127.0.0.1";
  if (net.isIP(candidate)) {
    return candidate;
  }
  return socketAddress;
}

/**
 * 验证多段配置合法性
 */
function validateZoneConfigs(cfgs, opts = {}) {
  const allowOpen = Boolean(opts.allowOpen);
  const fatal = [];
  const warn = [];
  const usedPorts = new Map();

  for (const cfg of cfgs) {
    // 1. 端口互斥检查
    if (usedPorts.has(cfg.port)) {
      fatal.push({
        zone: cfg.zone,
        message: `端口 ${cfg.port} 与 [${usedPorts.get(cfg.port)}] 冲突，各段端口必须互斥`,
      });
    } else {
      usedPorts.set(cfg.port, cfg.zone);
    }

    // 2. WAN 回环检查
    if (cfg.zone === "wan") {
      const isLoopback =
        cfg.host === "127.0.0.1" ||
        cfg.host === "::1" ||
        cfg.host === "localhost";
      if (!isLoopback) {
        fatal.push({
          zone: cfg.zone,
          message: `WAN zone must bind loopback (127.0.0.1 or ::1), received ${cfg.host}`,
        });
      }
    }

    // 3. 鉴权要求检查
    const isLoop =
      cfg.host === "127.0.0.1" || cfg.host === "::1" || cfg.host === "localhost";
    const needsKey = cfg.zone === "wan" || (cfg.zone === "lan" && !isLoop);
    if (needsKey && !cfg.apiKey && !allowOpen) {
      fatal.push({
        zone: cfg.zone,
        message: `[${cfg.zone}] 声明了网络开放监听 (${cfg.host}:${cfg.port}) 但未提供 API key，拒绝无保护启动（可通过 --${cfg.zone}-key 或 COGNISTACK_${cfg.zone.toUpperCase()}_KEY 设置）`,
      });
    }

    // 4. 代理与基址警告
    if (cfg.zone === "wan") {
      if (!cfg.proxy?.key) {
        warn.push({
          zone: cfg.zone,
          message: "[wan] 未配置 --wan-proxy-key，将无法验证反向代理注入的真实客户端 IP",
        });
      }
      if (!cfg.publicBase) {
        warn.push({
          zone: cfg.zone,
          message: "[wan] 未配置 --wan-public-url，公网发现文档将回退展示宿主自动 IP",
        });
      }
    }
  }

  return { fatal, warn };
}

/**
 * 计算用于对外展示的 base URL
 */
function zoneBaseForDisplay(cfg) {
  if (cfg.publicBase) return cfg.publicBase;
  if (cfg.zone === "local" || cfg.zone === "wan") {
    const h = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
    return `http://${h}:${cfg.port}`;
  }
  if (cfg.addresses && cfg.addresses.length > 0) {
    return `http://${cfg.addresses[0]}:${cfg.port}`;
  }
  return `http://${cfg.host}:${cfg.port}`;
}

module.exports = {
  ZONES,
  SURFACE,
  normalizeZoneName,
  parseZoneSpec,
  zoneAllowsPath,
  zoneAllowList,
  isKnownInterfacePath,
  checkProxyKey,
  resolveClientIp,
  validateZoneConfigs,
  zoneBaseForDisplay,
};
