/**
 * CogniStack visualization + HTTP API server — zero dependencies, node:http only.
 *
 * Panel:
 *   GET  /                  dashboard
 *   GET  /api/snapshot      telemetry JSON
 *   GET  /api/metrics       Prometheus text (also /metrics)
 *   GET  /api/stream        SSE
 *   POST /api/host          register host
 *   POST /api/turn          ingest turn
 *   POST /api/ports         report engine.portDiagnostics() (who won / who is shadowed)
 *   POST /api/reset         clear telemetry
 *   POST /api/zones/start   dynamic start zone
 *   POST /api/zones/stop    dynamic stop zone
 *
 * Prepare API (other systems call this):
 *   GET  /v1                discovery
 *   GET  /v1/health         liveness
 *   POST /v1/prepare        run CogniStackEngine.prepare
 *
 * Multi-Zone & Network Isolation:
 *   --zones local,lan,wan
 *   --local 127.0.0.1:7331 --local-key KEY
 *   --lan 0.0.0.0:7332 --lan-key KEY
 *   --wan 127.0.0.1:7333 --wan-key KEY --wan-proxy-key PROXY --wan-public-url https://cs.example.com
 */
const http = require("node:http");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const cluster = require("node:cluster");
const { URL } = require("node:url");
const { createPrepareGateway } = require("./lib/prepare-api.cjs");
const { mapTurnPayload } = require("./lib/turn-map.cjs");
const { createTurnLog } = require("./lib/turn-log.cjs");
const {
  timingSafeEqualStr,
  isLoopbackHost,
  createStreamTicketStore,
} = require("./lib/viz-auth.cjs");
const {
  ZONES,
  normalizeZoneName,
  parseZoneSpec,
  zoneAllowsPath,
  zoneAllowList,
  isKnownInterfacePath,
  checkProxyKey,
  resolveClientIp,
  validateZoneConfigs,
  zoneBaseForDisplay,
} = require("./lib/viz-zones.cjs");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "console", "dist");
const CONSOLE_SRC = path.join(ROOT, "console", "src");
const DIST = path.join(ROOT, "dist");

function consoleStaleFile() {
  if (!fs.existsSync(WEB) || !fs.existsSync(CONSOLE_SRC)) return null;
  let builtAt = 0;
  try {
    builtAt = fs.statSync(path.join(WEB, "index.html")).mtimeMs;
  } catch {
    return null;
  }
  if (!builtAt) return null;
  const stack = [CONSOLE_SRC];
  let newest = null;
  let seen = 0;
  while (stack.length && seen < 4000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      seen += 1;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (!newest || m > newest.m) newest = { full, m };
      } catch {}
    }
  }
  if (newest && newest.m > builtAt) return path.relative(ROOT, newest.full).replace(/\\/g, "/");
  return null;
}

const S = require(DIST + "/index.js");

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? String(args[idx + 1]) : "";
}

const ALLOW_OPEN = process.env.COGNISTACK_ALLOW_OPEN === "1" || args.includes("--allow-open");
const OPEN_CORS = args.includes("--cors") || process.env.COGNISTACK_CORS === "1";
const ALLOW_QUERY_KEY =
  process.env.COGNISTACK_ALLOW_QUERY_KEY === "1" || args.includes("--allow-query-key");

/* Durable turn log (opt-in) */
const turnLogPath = getArg("--turn-log") || process.env.COGNISTACK_TURN_LOG || "";
const turnLogMaxMb = Number(getArg("--turn-log-max-mb") || process.env.COGNISTACK_TURN_LOG_MAX_MB) || 32;
const turnLogKeep = Number(getArg("--turn-log-keep") || process.env.COGNISTACK_TURN_LOG_KEEP) || 3;
const turnLog = turnLogPath
  ? createTurnLog({
      file: turnLogPath,
      maxBytes: turnLogMaxMb * 1024 * 1024,
      keep: turnLogKeep,
    })
  : null;

const loreMode = getArg("--lore") || process.env.COGNISTACK_LORE || "";
const keywordLore = loreMode === "keyword" || loreMode === "1" || loreMode === "true";

const telemetry = S.getGlobalTelemetry();
const gateway = createPrepareGateway(S, {
  telemetry,
  charsPerToken: Number(process.env.COGNISTACK_CHARS_PER_TOKEN) || 0,
  keywordLore: keywordLore || undefined,
});

const KNOWN_PORTS = new Set([
  "card",
  "macros",
  "lore",
  "state",
  "preset",
  "regex",
  "vector",
  "tools",
  "mcp",
]);

const MAX_SSE_CLIENTS_PER_ZONE = 8;
const MAX_BODY_BYTES = 256_000;
const MAX_PREPARE_BYTES = 2_000_000;
let MAX_PREPARE_QUEUE = Number(process.env.COGNISTACK_MAX_PREPARE_QUEUE) || 64;
let MAX_PREPARE_INFLIGHT_READS = Number(process.env.COGNISTACK_MAX_PREPARE_READS) || 32;
const STREAM_TICKET_TTL_MS = 60_000;
const RATE_LIMIT_PER_SEC = Number(process.env.COGNISTACK_RATE_LIMIT ?? 30);
const RATE_LIMIT_MAX_KEYS = 10_000;
const RATE_LIMIT_WINDOW_MS = 1000;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_HEADERS_COUNT = 100;

let clusterPrimaryPid = null;
let clusterWorkerList = [];

if (cluster.isWorker && typeof process.send === "function") {
  process.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "CLUSTER_STATE_UPDATE") {
      if (msg.primaryPid) clusterPrimaryPid = msg.primaryPid;
      if (Array.isArray(msg.workers)) clusterWorkerList = msg.workers;
      broadcast(true);
    } else if (msg.type === "BROADCAST_CONFIG" && msg.config) {
      if (typeof msg.config.queueLimit === "number") {
        MAX_PREPARE_QUEUE = Math.max(8, Math.min(2048, msg.config.queueLimit));
      }
      broadcast(true);
    } else if (msg.type === "RETIRE") {
      for (const rt of zoneRuntimes.values()) {
        for (const res of [...rt.clients]) {
          try {
            res.end();
          } catch {}
        }
        rt.clients.clear();
      }
    }
  });

  try {
    process.send({ type: "GET_CLUSTER_STATE" });
  } catch {}
}

function getHostAddresses() {
  const addrs = [];
  try {
    const ifaces = os.networkInterfaces();
    const scored = [];
    for (const name of Object.keys(ifaces)) {
      const isVirtualName = /meta|clash|veth|docker|vmnet|vbox|virtual|tailscale|tun|tap|wsl/i.test(name);
      for (const info of ifaces[name] || []) {
        if (info.internal) continue;
        if (info.family === "IPv4" || info.family === 4) {
          const ip = info.address;
          if (ip.startsWith("169.254.") || ip.startsWith("198.18.") || ip.startsWith("198.19.")) {
            // virtual / benchmark / link-local (e.g. Clash TUN, VMware): lowest priority
            scored.push({ ip, score: 0 });
          } else if (isVirtualName) {
            scored.push({ ip, score: 10 });
          } else if (ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
            // Physical standard private LAN (Wi-Fi / Ethernet): highest priority!
            scored.push({ ip, score: 100 });
          } else {
            scored.push({ ip, score: 50 });
          }
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.ip);
  } catch {}
  return addrs;
}

const rawZonesArg = getArg("--zones") || process.env.COGNISTACK_ZONES || "";
const hasExplicitZones = Boolean(rawZonesArg);
const hasExplicitLan =
  args.includes("--lan") ||
  Boolean(process.env.COGNISTACK_LAN_KEY) ||
  Boolean(process.env.COGNISTACK_LAN_HOST);
const hasExplicitWan =
  args.includes("--wan") ||
  Boolean(process.env.COGNISTACK_WAN_KEY) ||
  Boolean(process.env.COGNISTACK_WAN_HOST);

let initialDeclaredZones = [];
if (hasExplicitZones) {
  initialDeclaredZones = rawZonesArg
    .split(",")
    .map(normalizeZoneName)
    .filter(Boolean);
} else {
  initialDeclaredZones.push("local");
  if (hasExplicitLan) initialDeclaredZones.push("lan");
  if (hasExplicitWan) initialDeclaredZones.push("wan");
}
if (!initialDeclaredZones.includes("local")) {
  initialDeclaredZones.unshift("local");
}

function buildZoneConfigsMap() {
  const addresses = getHostAddresses();
  const map = new Map();

  // local
  {
    const localSpecArg = getArg("--local");
    const pArg = getArg("--port");
    const hArg = getArg("--host");
    const defaultPort = pArg ? Number(pArg) || 7331 : Number(process.env.PORT || 7331);
    const defaultHost = hArg || process.env.HOST || "127.0.0.1";
    const spec = parseZoneSpec(localSpecArg, { defaultHost, defaultPort }) || {
      host: defaultHost,
      port: defaultPort,
    };
    const key =
      getArg("--local-key") ||
      getArg("--key") ||
      process.env.COGNISTACK_LOCAL_KEY ||
      process.env.COGNISTACK_API_KEY ||
      "";
    const rateLimit = Number(
      getArg("--local-rate-limit") ||
        process.env.COGNISTACK_LOCAL_RATE_LIMIT ||
        process.env.COGNISTACK_RATE_LIMIT ||
        30,
    );
    const corsStr =
      getArg("--local-cors-origins") ||
      process.env.COGNISTACK_LOCAL_CORS_ORIGINS ||
      process.env.COGNISTACK_CORS_ORIGINS ||
      "";
    const corsOrigins = corsStr.split(",").map((s) => s.trim()).filter(Boolean);
    const baseSource =
      localSpecArg || pArg || hArg || args.includes("--key") || args.includes("--local-key")
        ? "flag"
        : (process.env.PORT || process.env.HOST ? "env" : "default");

    const hostStr = spec.host;
    const urlHost = hostStr === "0.0.0.0" || hostStr === "::" ? "127.0.0.1" : (hostStr.includes(":") ? `[${hostStr}]` : hostStr);

    map.set("local", {
      zone: "local",
      host: spec.host,
      port: spec.port,
      apiKey: key,
      rateLimit,
      corsOrigins,
      baseSource,
      addresses,
      publicBase: "",
      reachable: isLoopbackHost(spec.host) ? "loopback" : "lan",
      proxy: { required: false, key: "", header: "", trustForwarded: false },
      maxPrepareInflight: Infinity,
      urlBase: `http://${urlHost}:${spec.port}`,
    });
  }

  // lan
  {
    const lanSpecArg = getArg("--lan") || process.env.COGNISTACK_LAN_HOST || "";
    const spec = parseZoneSpec(lanSpecArg, { defaultHost: "0.0.0.0", defaultPort: 7332 }) || {
      host: "0.0.0.0",
      port: 7332,
    };
    const key = getArg("--lan-key") || process.env.COGNISTACK_LAN_KEY || "";
    const rateLimit = Number(
      getArg("--lan-rate-limit") ||
        process.env.COGNISTACK_LAN_RATE_LIMIT ||
        process.env.COGNISTACK_RATE_LIMIT ||
        30,
    );
    const corsStr =
      getArg("--lan-cors-origins") || process.env.COGNISTACK_LAN_CORS_ORIGINS || "";
    const corsOrigins = corsStr.split(",").map((s) => s.trim()).filter(Boolean);
    const baseSource = args.includes("--lan")
      ? "flag"
      : (process.env.COGNISTACK_LAN_HOST ? "env" : (addresses.length > 0 ? "auto" : "default"));

    const hostStr = spec.host;
    const urlHost = hostStr === "0.0.0.0" || hostStr === "::" ? "127.0.0.1" : (hostStr.includes(":") ? `[${hostStr}]` : hostStr);

    map.set("lan", {
      zone: "lan",
      host: spec.host,
      port: spec.port,
      apiKey: key,
      rateLimit,
      corsOrigins,
      baseSource,
      addresses,
      publicBase: "",
      reachable: "lan",
      proxy: { required: false, key: "", header: "", trustForwarded: false },
      maxPrepareInflight: Infinity,
      urlBase: `http://${urlHost}:${spec.port}`,
    });
  }

  // wan
  {
    const wanSpecArg = getArg("--wan") || process.env.COGNISTACK_WAN_HOST || "";
    const spec = parseZoneSpec(wanSpecArg, { defaultHost: "127.0.0.1", defaultPort: 7333 }) || {
      host: "127.0.0.1",
      port: 7333,
    };
    const key = getArg("--wan-key") || process.env.COGNISTACK_WAN_KEY || "";
    const proxyKey = getArg("--wan-proxy-key") || process.env.COGNISTACK_WAN_PROXY_KEY || "";
    let publicUrl = getArg("--wan-public-url") || process.env.COGNISTACK_WAN_PUBLIC_URL || "";
    if (publicUrl) {
      try {
        const parsed = new URL(publicUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          console.error("  FATAL: [wan] --wan-public-url must have http: or https: protocol");
          process.exit(1);
        }
        if (parsed.pathname && parsed.pathname !== "/" && parsed.pathname !== "") {
          console.error("  FATAL: [wan] --wan-public-url cannot contain subpath");
          process.exit(1);
        }
        publicUrl = parsed.origin;
      } catch {
        console.error("  FATAL: [wan] --wan-public-url is not a valid URL");
        process.exit(1);
      }
    }
    const rateLimit = Number(
      getArg("--wan-rate-limit") ||
        process.env.COGNISTACK_WAN_RATE_LIMIT ||
        10,
    );
    const corsStr =
      getArg("--wan-cors-origins") || process.env.COGNISTACK_WAN_CORS_ORIGINS || "";
    const corsOrigins = corsStr.split(",").map((s) => s.trim()).filter(Boolean);
    const baseSource = (args.includes("--wan-public-url") || process.env.COGNISTACK_WAN_PUBLIC_URL)
      ? "flag"
      : (addresses.length > 0 ? "auto" : "default");
    const maxPrepareInflight = Number(process.env.COGNISTACK_WAN_MAX_PREPARE) || 4;

    const hostStr = spec.host;
    const urlHost = hostStr === "0.0.0.0" || hostStr === "::" ? "127.0.0.1" : (hostStr.includes(":") ? `[${hostStr}]` : hostStr);

    map.set("wan", {
      zone: "wan",
      host: spec.host,
      port: spec.port,
      apiKey: key,
      rateLimit,
      corsOrigins,
      baseSource,
      addresses,
      publicBase: publicUrl,
      reachable: "proxy",
      proxy: {
        required: Boolean(proxyKey),
        key: proxyKey,
        header: "x-cognistack-proxy-key",
        trustForwarded: Boolean(proxyKey),
      },
      maxPrepareInflight,
      urlBase: `http://${urlHost}:${spec.port}`,
    });
  }

  return map;
}

const zoneConfigsMap = buildZoneConfigsMap();

// 校验即将自启动的网段
const bootConfigs = ZONES.filter((z) => {
  if (hasExplicitZones) return initialDeclaredZones.includes(z);
  if (z === "local") return true;
  if (z === "lan") return hasExplicitLan;
  if (z === "wan") return hasExplicitWan;
  return false;
}).map((z) => zoneConfigsMap.get(z));

const validation = validateZoneConfigs(bootConfigs, { allowOpen: ALLOW_OPEN });

if (validation.fatal.length > 0) {
  console.error("");
  for (const f of validation.fatal) {
    console.error(`  FATAL: [${f.zone}] ${f.message}`);
  }
  console.error("");
  process.exit(1);
}
if (validation.warn.length > 0) {
  console.warn("");
  for (const w of validation.warn) {
    console.warn(`  WARN:  [${w.zone}] ${w.message}`);
  }
  console.warn("");
}

/**
 * 段独立运行时（限流桶、SSE 客户端、票据等隔离）
 */
const zoneRuntimes = new Map();
for (const z of ZONES) {
  zoneRuntimes.set(z, {
    cfg: zoneConfigsMap.get(z),
    rateBuckets: new Map(), // ip -> { count, resetAt }
    clients: new Set(),     // res Set
    streamTickets: createStreamTicketStore(STREAM_TICKET_TTL_MS),
    prepareInflight: 0,
    server: null,
  });
}

function getZoneSummaries() {
  const list = [];
  for (const z of ZONES) {
    const rt = zoneRuntimes.get(z);
    if (!rt) continue;
    const c = rt.cfg;
    const isRunning = Boolean(rt.server && rt.server.listening);
    list.push({
      zone: c.zone,
      status: isRunning ? "running" : "stopped",
      host: c.host,
      port: c.port,
      base: zoneBaseForDisplay(c),
      ...(c.publicBase ? { publicBase: c.publicBase } : {}),
      ...(c.addresses && c.addresses.length > 0 ? { addresses: c.addresses } : {}),
      baseSource: c.baseSource,
      auth: c.apiKey ? "key" : "none",
      apiKey: c.apiKey || "",
      proxyKey: (c.proxy && c.proxy.key) || "",
      rateLimit: c.rateLimit,
      proxy: {
        required: Boolean(c.proxy?.required),
        trustForwardedFor: Boolean(c.proxy?.trustForwarded),
        ...(c.proxy?.header ? { header: c.proxy.header } : {}),
      },
      allow: zoneAllowList(c.zone),
      console: c.zone === "local",
    });
  }
  return list;
}

// 独立的限流扫桶器
setInterval(() => {
  const now = Date.now();
  for (const rt of zoneRuntimes.values()) {
    for (const [ip, b] of rt.rateBuckets) {
      if (b.resetAt <= now) rt.rateBuckets.delete(ip);
    }
  }
}, 10_000).unref();

function isRateLimited(runtime, req) {
  if (req?.headers?.["x-cognistack-bench"] === "1") {
    const isLoopback = isLoopbackHost(req.__clientIp || "");
    const isLocalZone = runtime.cfg.zone === "local";
    const proxyKey = runtime.cfg.proxy?.key || "";
    const proxyHeaderName = runtime.cfg.proxy?.header || "x-cognistack-proxy-key";
    const hasValidProxy = proxyKey
      ? checkProxyKey(req?.headers?.[proxyHeaderName], proxyKey).ok
      : false;
    if ((isLocalZone && isLoopback) || hasValidProxy) return false;
  }
  const limit = runtime.cfg.rateLimit;
  if (!(limit > 0)) return false;
  const now = Date.now();
  const ip = req.__clientIp || "unknown";
  let b = runtime.rateBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    if (!b && runtime.rateBuckets.size >= RATE_LIMIT_MAX_KEYS) {
      const oldest = runtime.rateBuckets.keys().next().value;
      if (oldest !== undefined) runtime.rateBuckets.delete(oldest);
    }
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    runtime.rateBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count > limit;
}

/* ------------------------------------------------------------------ */
/* Rejects & HostZones Telemetry                                       */
/* ------------------------------------------------------------------ */

const REJECT_MAX_REASONS = 16;
const REJECT_MAX_ZONES = 8;
const REJECT_LAST_TTL_MS = 60 * 60 * 1000;
const MAX_REJECT_EVENTS = 120;
let rejectsTotal = 0;
const rejectsByReason = new Map();
const rejectsByZone = new Map();
let rejectsLast = null;
const rejectEvents = []; // Array<{ id, at, zone, reason, detail, method, path, clientIp, status }>

/*
 * 拒绝原因 → 实际回给客户端的 HTTP 状态码。
 * 必须和各自的响应保持一致：旧版是「非 401/429/503 一律记 403」，
 * 于是 bad_request(400) / too_large(413) / unsupported_media_type(415) /
 * zone_denied(404) 在审计里全被记成 403 —— 面板上的状态码是错的。
 */
const REJECT_STATUS = {
  unauthorized: 401,
  wrong_zone_key: 401,
  ip_blocked: 403,
  host_blocked: 403,
  proxy_untrusted: 403,
  zone_denied: 404,
  bad_request: 400,
  too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  queue_full: 503,
  sse_full: 503,
};

function rejectStatus(key) {
  return REJECT_STATUS[key] ?? 403;
}

function noteReject(reason, detail, req) {
  const key = String(reason || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "unknown";
  rejectsTotal += 1;
  rejectsByReason.set(key, (rejectsByReason.get(key) ?? 0) + 1);
  while (rejectsByReason.size > REJECT_MAX_REASONS) {
    const oldest = rejectsByReason.keys().next().value;
    if (oldest === undefined) break;
    rejectsByReason.delete(oldest);
  }

  const zone = req?.__zone?.zone || "unknown";
  rejectsByZone.set(zone, (rejectsByZone.get(zone) ?? 0) + 1);
  while (rejectsByZone.size > REJECT_MAX_ZONES) {
    const oldest = rejectsByZone.keys().next().value;
    if (oldest === undefined) break;
    rejectsByZone.delete(oldest);
  }

  let path;
  try {
    path = req && req.url ? new URL(req.url, "http://localhost").pathname : undefined;
  } catch {
    path = undefined;
  }

  // 只有已通过代理鉴权、或本段本就信任代理的请求才认 XFF。zone_denied / proxy_untrusted
  // 这两类拒绝发生在 __clientIp 赋值之前，此时 XFF 完全由客户端控制 —— 若在这里
  // trustForwarded: true，审计里的来源 IP 就能被伪造。所以回退一律不信任 XFF。
  const clientIp =
    req?.__clientIp ||
    (req
      ? resolveClientIp(
          { socketAddress: req.socket?.remoteAddress, headers: req.headers },
          { trustForwarded: false },
        )
      : "127.0.0.1");
  const status = rejectStatus(key);

  rejectsLast = {
    at: Date.now(),
    zone,
    reason: key,
    detail: detail ? String(detail).slice(0, 240) : undefined,
    method: req && req.method ? String(req.method) : undefined,
    path,
  };

  rejectEvents.unshift({
    id: `rej_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    zone,
    reason: key,
    detail: detail ? String(detail).slice(0, 240) : undefined,
    method: req && req.method ? String(req.method) : "POST",
    path: path || "/v1/prepare",
    clientIp,
    status,
  });
  if (rejectEvents.length > MAX_REJECT_EVENTS) {
    rejectEvents.pop();
  }

  broadcast();
}

function rejectsSnapshot() {
  if (rejectsLast && Date.now() - rejectsLast.at > REJECT_LAST_TTL_MS) rejectsLast = null;
  return {
    total: rejectsTotal,
    byReason: Object.fromEntries(rejectsByReason),
    byZone: Object.fromEntries(rejectsByZone),
    last: rejectsLast,
    events: rejectEvents,
  };
}

const MAX_HOST_ZONES = 256;
const hostZones = new Map(); // hostId -> { zone, at }

function noteHostZone(zoneName, hostId) {
  if (!hostId) return;
  const id = String(hostId).slice(0, 128);
  if (hostZones.size >= MAX_HOST_ZONES && !hostZones.has(id)) {
    let evictKey = null;
    let evictZonePriority = -1; // 3: wan, 2: lan, 1: local
    let oldestAt = Infinity;

    for (const [k, v] of hostZones) {
      const prio = v.zone === "wan" ? 3 : v.zone === "lan" ? 2 : 1;
      if (prio > evictZonePriority || (prio === evictZonePriority && v.at < oldestAt)) {
        evictZonePriority = prio;
        oldestAt = v.at;
        evictKey = k;
      }
    }
    if (evictKey) {
      hostZones.delete(evictKey);
    }
  }
  hostZones.set(id, { zone: zoneName, at: Date.now() });
}

/**
 * 封禁模型：IP 级黑名单 + 接入端（hostId）级黑名单，两套独立。
 * 语义：封禁此 IP —— 该 IP 发起的全部接入端一起失效；封禁此接入端 —— 仅该 hostId 失效，
 * 同一 IP 下的其他接入端不受影响。
 * 两个集合的记录都带 { scope, key, reason, at }，控制台合并展示。
 */
const blockedIps = new Map(); // ip -> { scope:"ip", key, reason, at }
const blockedHosts = new Map(); // hostId -> { scope:"host", key, reason, at }
const MAX_BLOCKED_ENTRIES = 512;

function normalizeIp(s) {
  if (!s || typeof s !== "string") return null;
  let v = s.trim();
  if (v.startsWith("::ffff:")) v = v.slice(7);
  if (v === "::1") v = "127.0.0.1";
  if (!net.isIP(v)) return null;
  return v;
}

function addBlocked({ ip, host, reason }) {
  const at = Date.now();
  const r = String(reason || "管理员手动封禁").trim() || "管理员手动封禁";
  if (ip) {
    const key = normalizeIp(ip);
    if (!key) throw new Error("待封禁 IP 不是合法地址");
    if (blockedIps.size >= MAX_BLOCKED_ENTRIES && !blockedIps.has(key)) {
      const oldest = blockedIps.keys().next().value;
      if (oldest !== undefined) blockedIps.delete(oldest);
    }
    blockedIps.set(key, { scope: "ip", key, reason: r, at });
    return { scope: "ip", key };
  }
  if (host) {
    const key = String(host).trim().slice(0, 128);
    if (!key) throw new Error("缺少待封禁接入端标识");
    if (blockedHosts.size >= MAX_BLOCKED_ENTRIES && !blockedHosts.has(key)) {
      const oldest = blockedHosts.keys().next().value;
      if (oldest !== undefined) blockedHosts.delete(oldest);
    }
    blockedHosts.set(key, { scope: "host", key, reason: r, at });
    return { scope: "host", key };
  }
  throw new Error("缺少待封禁参数（ip 或 host 至少其一）");
}

function removeBlocked({ ip, host }) {
  if (ip) {
    const key = normalizeIp(ip);
    return key ? blockedIps.delete(key) : false;
  }
  if (host) {
    const key = String(host || "").trim().slice(0, 128);
    return key ? blockedHosts.delete(key) : false;
  }
  return false;
}

/*
 * 接入客户端明细按 (ip, hostId) 复合键记录。
 * 只按 IP 记会把「同一 IP 上的三个系统」压成一条（后者覆盖前者的 hostId）——
 * 那恰恰是「封禁此接入端」要能分辨的东西，所以键必须带上 hostId。
 * 未声明 host 的调用方归到 `${ip}|-`，由面板兜底显示为「未声明宿主」。
 */
const clientRecords = new Map(); // `${ip}|${hostId||"-"}` -> { ip, zone, firstAt, lastAt, calls, hostId }
const MAX_CLIENT_RECORDS = 512;

function noteClientAccess(ip, zoneName, hostId) {
  if (!ip) return;
  const id = hostId ? String(hostId).slice(0, 128) : undefined;
  const key = `${ip}|${id || "-"}`;
  const now = Date.now();
  let rec = clientRecords.get(key);
  let isNew = false;
  if (!rec) {
    isNew = true;
    if (clientRecords.size >= MAX_CLIENT_RECORDS) {
      // 淘汰最久未活跃的一条：Map 的插入顺序不等于活跃顺序
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of clientRecords) {
        if (v.lastAt < oldestAt) {
          oldestAt = v.lastAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) clientRecords.delete(oldestKey);
    }
    rec = { ip, zone: zoneName, firstAt: now, lastAt: now, calls: 1, hostId: id };
  } else {
    rec.zone = zoneName;
    rec.lastAt = now;
    rec.calls += 1;
    if (id) rec.hostId = id;
  }
  clientRecords.set(key, rec);
  if (isNew) broadcast(false);
}

const portReports = new Map();
const MAX_PORT_REPORTS = 256;

function snapshotWithPorts(turnLimit = 40) {
  const snap = telemetry.snapshot(turnLimit);
  return {
    ...snap,
    portDiagnostics: [...portReports.values()].sort((a, z) => z.at - a.at),
      system: {
        cpus: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
        cpuModel: os.cpus()[0]?.model || "Unknown CPU",
        isCluster: cluster.isWorker || Boolean(process.env.COGNISTACK_WORKER),
        workerId: cluster.worker ? cluster.worker.id : 1,
        pid: process.pid,
        primaryPid: clusterPrimaryPid || (cluster.isWorker ? undefined : process.pid),
        activeWorkers: clusterWorkerList.length > 0 ? clusterWorkerList : [
          { id: cluster.worker ? cluster.worker.id : 1, pid: process.pid, state: "online" }
        ],
        workersCount: clusterWorkerList.length > 0 ? clusterWorkerList.length : (cluster.isWorker ? 1 : 1),
        nodeVersion: process.version,
        platform: process.platform,
      },
    gateway: {
      rejects: rejectsSnapshot(),
      zones: getZoneSummaries(),
      hostZones: Object.fromEntries(hostZones),
      clients: [...clientRecords.values()].sort((a, b) => b.lastAt - a.lastAt),
      blockedIps: Object.fromEntries(blockedIps),
      blockedHosts: Object.fromEntries(blockedHosts),
    },
  };
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

let lastPush = 0;
const PUSH_THROTTLE_MS = 120;

function writeSse(rt, res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    rt.clients.delete(res);
  }
}

function broadcast(force = false) {
  let anyClient = false;
  for (const rt of zoneRuntimes.values()) {
    if (rt.clients.size > 0) {
      anyClient = true;
      break;
    }
  }
  if (!anyClient) return;

  const now = Date.now();
  if (!force && now - lastPush < PUSH_THROTTLE_MS) return;
  lastPush = now;
  const snap = snapshotWithPorts(40);
  for (const rt of zoneRuntimes.values()) {
    for (const res of [...rt.clients]) {
      if (res.writableLength > 1_000_000 || res.destroyed) {
        rt.clients.delete(res);
        try {
          res.destroy();
        } catch {}
        continue;
      }
      writeSse(rt, res, "snapshot", snap);
    }
  }
}

let progressTimer = null;
let pendingProgress = null;

function writeClientsTo(event, data) {
  for (const rt of zoneRuntimes.values()) {
    for (const res of [...rt.clients]) {
      if (res.writableLength > 1_000_000 || res.destroyed) {
        rt.clients.delete(res);
        try {
          res.destroy();
        } catch {}
        continue;
      }
      writeSse(rt, res, event, data);
    }
  }
}

function flushProgress() {
  progressTimer = null;
  const ev = pendingProgress;
  pendingProgress = null;
  if (ev) writeClientsTo("progress", ev);
}

function broadcastProgress(ev) {
  let anyClient = false;
  for (const rt of zoneRuntimes.values()) {
    if (rt.clients.size > 0) {
      anyClient = true;
      break;
    }
  }
  if (!anyClient) return;

  if (ev && ev.stage === "_run" && ev.phase === "end") {
    pendingProgress = null;
    writeClientsTo("progress", ev);
    return;
  }
  pendingProgress = ev;
  if (progressTimer) return;
  progressTimer = setTimeout(flushProgress, PUSH_THROTTLE_MS);
  if (typeof progressTimer.unref === "function") progressTimer.unref();
}

telemetry.subscribeTurn(() => broadcast(false));
if (turnLog) {
  telemetry.subscribeTurn((turn) => {
    turnLog.append(turn);
  });
}
if (typeof telemetry.subscribeProgress === "function") {
  telemetry.subscribeProgress((ev) => broadcastProgress(ev));
}

// 逐段心跳
setInterval(() => {
  for (const rt of zoneRuntimes.values()) {
    for (const res of [...rt.clients]) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        rt.clients.delete(res);
      }
    }
  }
}, 1000).unref();

/* ------------------------------------------------------------------ */
/* Static & Utilities                                                  */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
}

function safeWebPath(rel) {
  if (rel.includes(":") || rel.includes("\0")) return null;
  const target = path.normalize(path.join(WEB, rel));
  const relToWeb = path.relative(WEB, target);
  if (!relToWeb || relToWeb.startsWith("..") || path.isAbsolute(relToWeb)) return null;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  return null;
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        reject(new Error("payload too large"));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function str(v, max = 128, fallback = "") {
  if (typeof v !== "string") return fallback;
  const t = v.trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

function strList(v, allowed, max = 32) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== "string" || !x) continue;
    if (allowed && !allowed.has(x)) continue;
    out.push(x.slice(0, 64));
    if (out.length >= max) break;
  }
  return out;
}

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; " +
      "connect-src 'self'; " +
      "font-src 'self'; " +
      "frame-ancestors 'none'",
  );
}

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PRIVATE_LAN_ORIGIN_RE =
  /^https?:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

function setCors(req, res, zone) {
  setSecurityHeaders(res);
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && origin.length < 512) {
    let allowed = false;
    if (OPEN_CORS) {
      allowed = true;
    } else if (zone.corsOrigins && zone.corsOrigins.length > 0) {
      allowed = zone.corsOrigins.includes(origin);
    } else if (LOCALHOST_ORIGIN_RE.test(origin)) {
      // 允许本机运行的任何客户端（如 xoox、SillyTavern、OpenWebUI）跨段直连
      allowed = true;
    } else if (zone.zone === "lan" && PRIVATE_LAN_ORIGIN_RE.test(origin)) {
      // 局域网段允许私有内网前端直接发起调用
      allowed = true;
    }
    if (allowed) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
  }
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, x-api-key, x-cognistack-proxy-key, x-cognistack-base, x-cognistack-key, accept, x-cognistack-bench, *",
  );
  res.setHeader(
    "access-control-expose-headers",
    "x-worker-id, x-cognistack-bench, content-length",
  );
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function requireJsonContentType(req, res) {
  const ct = req.headers["content-type"];
  if (/^\s*application\/json\s*(;|$)/i.test(String(ct ?? ""))) return true;
  noteReject("unsupported_media_type", `content-type: ${String(ct ?? "(missing)")}`, req);
  json(res, 415, { ok: false, error: "unsupported media type", code: "unsupported_media_type" });
  return false;
}

const API_PROTECTED_PATHS = new Set(["/metrics", "/v1/prepare"]);

function requiresApiAuth(p, method) {
  if (p.startsWith("/api/")) return true;
  if (!API_PROTECTED_PATHS.has(p)) return false;
  return p === "/v1/prepare" ? method === "POST" : true;
}

function checkApiKey(
  runtime,
  req,
  url,
  { allowQueryKey = ALLOW_QUERY_KEY, allowTicket = false } = {},
) {
  const currentKey = runtime.cfg.apiKey;
  if (!currentKey) return { ok: true };

  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const x = String(req.headers["x-api-key"] || "").trim();
  const providedKey = bearer || x;

  if (providedKey && timingSafeEqualStr(providedKey, currentKey)) return { ok: true };

  if (allowTicket && url && typeof url.searchParams?.get === "function") {
    const ticket = String(url.searchParams.get("ticket") || "");
    if (ticket && runtime.streamTickets.consume(ticket)) return { ok: true };
  }
  if (allowQueryKey && url && typeof url.searchParams?.get === "function") {
    const q = String(url.searchParams.get("key") || "");
    if (q.length > 0 && timingSafeEqualStr(q, currentKey)) return { ok: true };
  }

  // 跨段 key 诊断：检查 providedKey 是否是其他段的 key
  let wrongZone = null;
  if (providedKey) {
    for (const [otherZoneName, otherRt] of zoneRuntimes) {
      if (otherZoneName !== runtime.cfg.zone && otherRt.cfg.apiKey) {
        if (timingSafeEqualStr(providedKey, otherRt.cfg.apiKey)) {
          wrongZone = otherZoneName;
          break;
        }
      }
    }
  }

  return { ok: false, wrongZone };
}

function requireApiKey(runtime, req, res, url, opts) {
  const authRes = checkApiKey(runtime, req, url, opts);
  if (authRes.ok) return true;
  if (authRes.wrongZone) {
    noteReject(
      "wrong_zone_key",
      `zone=${runtime.cfg.zone} received key of zone=${authRes.wrongZone}`,
      req,
    );
  } else {
    noteReject("unauthorized", "missing or wrong API key", req);
  }
  json(res, 401, { ok: false, error: "unauthorized" });
  return false;
}

let prepareTail = Promise.resolve();
let prepareQueued = 0;
let prepareBodyReads = 0;

function enqueuePrepare(fn, isBench = false) {
  if (isBench) {
    return Promise.resolve().then(() => fn());
  }
  if (prepareQueued >= MAX_PREPARE_QUEUE) {
    const err = new Error("prepare queue full");
    err.code = "QUEUE_FULL";
    return Promise.reject(err);
  }
  prepareQueued += 1;
  const run = prepareTail.then(
    () =>
      new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            Promise.resolve(fn()).then(resolve, reject);
          } catch (e) {
            reject(e);
          }
        });
      }),
  );
  prepareTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => {
    prepareQueued = Math.max(0, prepareQueued - 1);
  });
}

function json(res, code, obj) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  setSecurityHeaders(res);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function safeEndJson(res, code, obj) {
  json(res, code, obj);
}

function respondPrepareError(res, e, req) {
  const msg = String(e && e.message ? e.message : e);
  console.error("[prepare] rejected:", msg);
  if (e && e.code === "QUEUE_FULL") {
    noteReject("queue_full", msg, req);
    json(res, 503, { ok: false, error: "prepare queue full", code: "queue_full" });
    return;
  }
  if (msg === "payload too large") {
    noteReject("too_large", msg, req);
    json(res, 413, { ok: false, error: "payload too large", code: "too_large" });
    return;
  }
  const expose = typeof e?.expose === "string" && e.expose ? e.expose : null;
  noteReject("bad_request", expose || msg, req);
  json(res, 400, {
    ok: false,
    error: expose || "invalid request",
    code: (expose && e.code) || "bad_request",
  });
}

function sendNotFound(res, zone) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end(
    zone.zone === "local" && WEB && !fs.existsSync(WEB)
      ? "console not built — run: npm run console:build  (or start.bat / npm start)"
      : "not found",
  );
}

function denyZone(req, res, zone) {
  const url = new URL(req.url || "/", zone.urlBase);
  const p = url.pathname;
  if (isKnownInterfacePath(p)) {
    noteReject("zone_denied", `${req.method} ${p} denied for zone ${zone.zone}`, req);
  }
  sendNotFound(res, zone);
}

function denyProxy(req, res, zone) {
  noteReject("proxy_untrusted", "proxy key mismatch or missing", req);
  json(res, 403, { ok: false, error: "forbidden", code: "proxy_untrusted" });
}

/* ------------------------------------------------------------------ */
/* Dynamic Zone Management                                            */
/* ------------------------------------------------------------------ */

function startSingleZone(zoneName, custom = {}) {
  return new Promise((resolve, reject) => {
    const z = normalizeZoneName(zoneName);
    if (!z) return reject(new Error(`未知网段: ${zoneName}`));
    const rt = zoneRuntimes.get(z);
    if (!rt) return reject(new Error(`网段未注册: ${z}`));
    if (rt.server && rt.server.listening) {
      return resolve({
        ok: true,
        message: "already running",
        zone: getZoneSummaries().find((item) => item.zone === z),
      });
    }

    const currentCfg = rt.cfg;
    const newPort = custom.port ? Number(custom.port) : currentCfg.port;
    const newHost = custom.host ? String(custom.host) : currentCfg.host;
    const newApiKey = custom.apiKey !== undefined ? String(custom.apiKey) : currentCfg.apiKey;
    const newProxyKey =
      custom.proxyKey !== undefined
        ? String(custom.proxyKey)
        : (currentCfg.proxy?.key || "");
    const newPublicUrl =
      custom.publicUrl !== undefined ? String(custom.publicUrl) : currentCfg.publicBase;
    const newRateLimit =
      custom.rateLimit !== undefined ? Number(custom.rateLimit) : currentCfg.rateLimit;

    // 端口冲突检查
    for (const [otherZ, otherRt] of zoneRuntimes) {
      if (
        otherZ !== z &&
        otherRt.server &&
        otherRt.server.listening &&
        otherRt.cfg.port === newPort
      ) {
        return reject(new Error(`端口 ${newPort} 已被网段 [${otherZ}] 监听占用`));
      }
    }

    // WAN 段限制
    if (z === "wan") {
      const isLoop =
        newHost === "127.0.0.1" || newHost === "::1" || newHost === "localhost";
      if (!isLoop) {
        return reject(
          new Error(`WAN 段必须绑定回环（127.0.0.1 或 ::1），不能直接绑定 ${newHost}`),
        );
      }
    }

    currentCfg.host = newHost;
    currentCfg.port = newPort;
    currentCfg.apiKey = newApiKey;
    currentCfg.rateLimit = newRateLimit;
    currentCfg.publicBase = newPublicUrl || "";
    currentCfg.proxy = {
      required: Boolean(newProxyKey),
      key: newProxyKey,
      header: "x-cognistack-proxy-key",
      trustForwarded: Boolean(newProxyKey),
    };
    const hostStr = newHost;
    const urlHost =
      hostStr === "0.0.0.0" || hostStr === "::"
        ? "127.0.0.1"
        : (hostStr.includes(":") ? `[${hostStr}]` : hostStr);
    currentCfg.urlBase = `http://${urlHost}:${newPort}`;

    const server = http.createServer((req, res) => handle(rt, req, res));
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.maxHeadersCount = MAX_HEADERS_COUNT;

    server.once("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        reject(new Error(`端口 ${newPort} 已被系统其它程序占用`));
      } else {
        reject(err);
      }
    });

    server.listen(newPort, newHost, () => {
      rt.server = server;
      server.removeAllListeners("error");
      server.on("error", (err) => {
        console.error(`[${z}] runtime server error:`, err.message);
      });
      console.log(`  \u25cf [${z.padEnd(5)}] 监听启动成功 \u2192 ${zoneBaseForDisplay(currentCfg)}`);
      broadcast(true);
      resolve({
        ok: true,
        zone: getZoneSummaries().find((item) => item.zone === z),
      });
    });
  });
}

function stopSingleZone(zoneName) {
  return new Promise((resolve, reject) => {
    const z = normalizeZoneName(zoneName);
    if (!z) return reject(new Error(`未知网段: ${zoneName}`));
    if (z === "local") {
      return reject(new Error("控制台管理主服务所在网段不可停止"));
    }
    const rt = zoneRuntimes.get(z);
    if (!rt || !rt.server) {
      return resolve({ ok: true, message: "not running" });
    }

    for (const res of [...rt.clients]) {
      try {
        res.destroy();
      } catch {}
    }
    rt.clients.clear();
    rt.rateBuckets.clear();

    rt.server.close((err) => {
      rt.server = null;
      console.log(`  \u25cb [${z.padEnd(5)}] 监听已停止`);
      broadcast(true);
      if (err) resolve({ ok: true, warning: err.message });
      else resolve({ ok: true });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Core HTTP Handler                                                  */
/* ------------------------------------------------------------------ */

function handle(runtime, req, res) {
  const zone = runtime.cfg;
  req.__zone = zone;
  req.__runtime = runtime;

  const url = new URL(req.url || "/", zone.urlBase);
  const p = url.pathname;

  setCors(req, res, zone);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ACL: 检查路径是否允许当前段访问
  if (!zoneAllowsPath(zone.zone, p)) {
    denyZone(req, res, zone);
    return;
  }

  // WAN 代理鉴权
  if (zone.proxy?.required) {
    const proxyKeyVal = req.headers[zone.proxy.header || "x-cognistack-proxy-key"];
    const proxyCheck = checkProxyKey(proxyKeyVal, zone.proxy.key);
    if (!proxyCheck.ok) {
      denyProxy(req, res, zone);
      return;
    }
  }

  // 客户端 IP 解析
  req.__clientIp = resolveClientIp(
    { socketAddress: req.socket?.remoteAddress, headers: req.headers },
    { trustForwarded: zone.proxy?.trustForwarded },
  );

  // IP 黑名单拦截（控制台核心管控路由与本地静态资源豁免，防止封禁 127.0.0.1 时控制台自锁死）
  const isMgmtExempt =
    p.startsWith("/api/gateway/") ||
    (zone.zone === "local" && (p === "/" || p.startsWith("/assets/") || p === "/api/snapshot" || p === "/api/stream"));
  if (!isMgmtExempt && blockedIps.has(req.__clientIp)) {
    const blockInfo = blockedIps.get(req.__clientIp);
    noteReject("ip_blocked", `IP ${req.__clientIp} 被黑名单拦截: ${blockInfo?.reason || "禁止访问"}`, req);
    json(res, 403, { ok: false, error: "forbidden: ip blocked", code: "ip_blocked", reason: blockInfo?.reason });
    return;
  }

  // 板上钉钉的 IP 黑名单拦截在此段发生（见 isMgmtExempt 上方）。
  // 接入客户端明细只在真正的 prepare 里记一次 —— 见 /v1/prepare 分支。

  // 轻量固定窗口限流
  if ((p === "/v1/prepare" || p.startsWith("/api/")) && isRateLimited(runtime, req)) {
    noteReject("rate_limited", `over ${zone.rateLimit}/s from ${req.__clientIp}`, req);
    json(res, 429, { ok: false, error: "too many requests", code: "rate_limited" });
    return;
  }

  // 接口鉴权
  const needsApiAuth = Boolean(zone.apiKey) && requiresApiAuth(p, req.method);
  if (needsApiAuth && p === "/api/stream") {
    if (
      !requireApiKey(runtime, req, res, url, {
        allowQueryKey: ALLOW_QUERY_KEY,
        allowTicket: true,
      })
    ) {
      return;
    }
  } else if (needsApiAuth && !requireApiKey(runtime, req, res, url, { allowQueryKey: false })) {
    return;
  }

  // CSRF 防护
  if (
    req.method === "POST" &&
    (p === "/v1/prepare" || p.startsWith("/api/")) &&
    !requireJsonContentType(req, res)
  ) {
    return;
  }

  /* ---- Dynamic Zone Management Endpoints ---- */
  if (p === "/api/zones/start" && req.method === "POST") {
    readBody(req)
      .then((body) => startSingleZone(body?.zone, body))
      .then((out) => safeEndJson(res, 200, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (p === "/api/zones/stop" && req.method === "POST") {
    readBody(req)
      .then((body) => stopSingleZone(body?.zone))
      .then((out) => safeEndJson(res, 200, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  /* ---- Dynamic Cluster Management Endpoints ---- */
  if (p === "/api/cluster/scale" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        const count = Number(body?.workers);
        if (!count || count < 1) throw new Error("workers 参数不合法 (需 >= 1)");
        if (cluster.isWorker && typeof process.send === "function") {
          process.send({ type: "SET_WORKERS", count });
          return { ok: true, workers: count, message: `已向主集群下发热伸缩指令（目标 ${count} 个 Worker）` };
        }
        return { ok: false, error: "当前处于单进程模式。请使用 npm run start:cluster 启动多进程集群以启用进程级热伸缩。" };
      })
      .then((out) => safeEndJson(res, out.ok ? 200 : 400, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (p === "/api/cluster/reload" && req.method === "POST") {
    if (cluster.isWorker && typeof process.send === "function") {
      process.send({ type: "ROLLING_RELOAD" });
      safeEndJson(res, 200, { ok: true, message: "已向主集群触发平滑滚动重载（Zero-Downtime Rolling Reload）" });
    } else {
      safeEndJson(res, 200, { ok: true, message: "单进程模式：缓存与配置已刷新重置" });
    }
    return;
  }

  if (p === "/api/cluster/config" && req.method === "POST") {
    readBody(req)
      .then((cfg) => {
        if (cfg && typeof cfg.queueLimit === "number") {
          MAX_PREPARE_QUEUE = Math.max(8, Math.min(2048, cfg.queueLimit));
        }
        if (cluster.isWorker && typeof process.send === "function") {
          process.send({ type: "BROADCAST_CONFIG", config: cfg });
        }
        broadcast(true);
        return { ok: true, message: "集群调度与缓存参数已在所有 Worker 中热同步生效", config: cfg };
      })
      .then((out) => safeEndJson(res, 200, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  /* ---- Native High-Concurrency Cluster Benchmark ---- */
  if (p === "/api/cluster/bench" && req.method === "POST") {
    readBody(req)
      .then(async (body) => {
        const concurrency = Math.max(1, Math.min(2000, Number(body?.concurrency) || 50));
        const rounds = Math.max(1, Math.min(20, Number(body?.rounds) || 4));
        const port = zone.port || 7331;
        const cp = require("node:child_process");
        const runnerPath = path.join(__dirname, "..", "scripts", "run-bench.cjs");

        return new Promise((resolve, reject) => {
          const child = cp.fork(
            runnerPath,
            ["--concurrency", String(concurrency), "--rounds", String(rounds), "--port", String(port)],
            {
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            },
          );

          let resultReceived = false;
          child.on("message", (data) => {
            resultReceived = true;
            // 子进程跑完就会有 result：正常完成（哪怕有失败请求，ok=false）也 resolve，
            // 让调用方看到 failedCount；只有真正抛错（带 error 字段）才 reject。
            if (data && data.ok === false && data.error) {
              reject(new Error(data.error));
            } else {
              resolve(data);
            }
          });

          let stderr = "";
          if (child.stderr) {
            child.stderr.on("data", (d) => {
              stderr += d.toString();
            });
          }

          child.on("exit", (code) => {
            if (!resultReceived) {
              if (code === 0) {
                resolve({ ok: true, message: "压测完成" });
              } else {
                reject(new Error(`压测子进程异常退出 (退出码 ${code}): ${stderr || "未知错误"}`));
              }
            }
          });

          child.on("error", (err) => {
            if (!resultReceived) reject(err);
          });
        });
      })
      .then((out) => safeEndJson(res, 200, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  /* ---- Gateway Access & Block Management Endpoints ---- */
  /*
   * 封禁契约：{ scope: "ip" | "host", ip?, host?, reason? }
   * 兼容旧调用方（只给 ip 视为封 IP）。scope 与目标必须自洽 ——
   * 「封禁此接入端」绝不允许退化成封 IP（那会连累同一 IP 上的其它系统）。
   */
  if (p === "/api/gateway/block" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        const reason = String(body?.reason || "管理员手动封禁").trim();
        const scopeRaw = String(body?.scope || "").trim().toLowerCase();
        const hostRaw = String(body?.host || body?.hostId || "").trim();
        const ipRaw = String(body?.ip || "").trim();
        const scope = scopeRaw === "host" || scopeRaw === "ip" ? scopeRaw : hostRaw && !ipRaw ? "host" : "ip";
        if (scope === "ip" && !ipRaw) throw new Error("缺少待封禁 IP 参数");
        if (scope === "host" && !hostRaw) throw new Error("缺少待封禁接入端标识（host）");

        const added = addBlocked({
          ip: scope === "ip" ? ipRaw : undefined,
          host: scope === "host" ? hostRaw : undefined,
          reason,
        });

        // 封 IP 时把该 IP 已建立的 SSE 长连接一并踢掉，避免它继续读遥测
        if (added.scope === "ip") {
          for (const rt of zoneRuntimes.values()) {
            for (const clientRes of [...rt.clients]) {
              if (clientRes.__clientIp === added.key) {
                rt.clients.delete(clientRes);
                try { clientRes.destroy(); } catch {}
              }
            }
          }
        }
        broadcast(true);
        return { ok: true, scope: added.scope, key: added.key, reason };
      })
      .then((out) => safeEndJson(res, 200, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (p === "/api/gateway/unblock" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        const hostRaw = String(body?.host || body?.hostId || "").trim();
        const ipRaw = String(body?.ip || "").trim();
        if (!hostRaw && !ipRaw) throw new Error("缺少待解封目标参数（ip 或 host 至少其一）");
        // 两张表都试一遍：调用方少传 scope 时也要能解开
        const existedIp = ipRaw ? removeBlocked({ ip: ipRaw }) : false;
        const existedHost = hostRaw ? removeBlocked({ host: hostRaw }) : false;
        broadcast(true);
        return { ok: true, ip: ipRaw || undefined, host: hostRaw || undefined, existed: existedIp || existedHost };
      })
      .then((out) => safeEndJson(res, 200, out))
      .catch((err) => safeEndJson(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (p === "/api/gateway/clear-clients" && req.method === "POST") {
    clientRecords.clear();
    broadcast(true);
    safeEndJson(res, 200, { ok: true });
    return;
  }

  if (p === "/api/gateway/clear-rejects" && req.method === "POST") {
    rejectsTotal = 0;
    rejectsByReason.clear();
    rejectsByZone.clear();
    rejectsLast = null;
    rejectEvents.length = 0;
    broadcast(true);
    safeEndJson(res, 200, { ok: true });
    return;
  }

  /* ---- Prepare HTTP API ---- */
  if (p === "/v1" && req.method === "GET") {
    const endpoints = {
      health: { method: "GET", path: "/v1/health" },
      prepare: { method: "POST", path: "/v1/prepare" },
    };
    // local 与 lan 暴露的附属端点相同；wan 只保留 health/prepare 两个核心端点。
    if (zone.zone === "local" || zone.zone === "lan") {
      endpoints.metrics = { method: "GET", path: "/api/metrics" };
      endpoints.streamTicket = { method: "POST", path: "/api/stream-ticket" };
    }
    json(res, 200, {
      name: "CogniStack HTTP API",
      version: S.COGNISTACK_VERSION || "1.0.0",
      zone: zone.zone,
      base: zoneBaseForDisplay(zone),
      endpoints,
      auth: zone.apiKey ? "required (Authorization: Bearer <key> or X-Api-Key)" : "none",
      lore: keywordLore ? "keyword" : "off (pass --lore keyword or inject via SDK)",
      note: "Fill this base URL in your system. POST JSON to /v1/prepare; use result.messages for the LLM.",
    });
    return;
  }

  if (p === "/v1/health" && req.method === "GET") {
    if (zone.zone === "wan") {
      json(res, 200, {
        ok: true,
        zone: "wan",
      });
      return;
    }
    json(res, 200, {
      ok: true,
      zone: zone.zone,
      engine: S.COGNISTACK_ENGINE_ID,
      version: S.COGNISTACK_VERSION,
      uptimeMs: telemetry.snapshot(0).uptimeMs,
      auth: Boolean(zone.apiKey),
      prepareQueue: prepareQueued,
      prepareQueueMax: MAX_PREPARE_QUEUE,
    });
    return;
  }

  if (p === "/v1/prepare" && req.method === "POST") {
    const isBench = req.headers["x-cognistack-bench"] === "1";
    if (!isBench) {
      if (zone.zone !== "local" && runtime.prepareInflight >= zone.maxPrepareInflight) {
        noteReject("queue_full", `wan_queued=${runtime.prepareInflight}/${zone.maxPrepareInflight}`, req);
        json(res, 503, { ok: false, error: "prepare queue full", code: "queue_full" });
        return;
      }
      if (prepareBodyReads >= MAX_PREPARE_INFLIGHT_READS || prepareQueued >= MAX_PREPARE_QUEUE) {
        noteReject("queue_full", `queued=${prepareQueued}/${MAX_PREPARE_QUEUE} reads=${prepareBodyReads}`, req);
        json(res, 503, { ok: false, error: "prepare queue full", code: "queue_full" });
        return;
      }
    }
    prepareBodyReads += 1;
    runtime.prepareInflight += 1;
    readBody(req, MAX_PREPARE_BYTES)
      .then((body) => {
        let hostId;
        try {
          const hostObj = gateway.asHost(body);
          if (hostObj && hostObj.id) {
            hostId = String(hostObj.id).slice(0, 128);
            noteHostZone(zone.zone, hostId);
          }
        } catch {}
        // 一次 prepare 只记一次，否则 calls 会被重复累计（此前这里加了一次、入口又加了一次）
        noteClientAccess(req.__clientIp, zone.zone, hostId);
        // 接入端级封禁：只拦这一个 host.id，同一 IP 上的其它接入端照常放行
        if (hostId && blockedHosts.has(hostId)) {
          const info = blockedHosts.get(hostId);
          noteReject("host_blocked", `接入端 ${hostId} 被黑名单拦截: ${info?.reason || "禁止访问"}`, req);
          json(res, 403, {
            ok: false,
            error: "forbidden: client blocked",
            code: "host_blocked",
            host: hostId,
            reason: info?.reason,
          });
          return null;
        }
        return enqueuePrepare(() => gateway.prepare(body), isBench);
      })
      .then((out) => {
        if (out !== null) {
          const wId = cluster.worker ? cluster.worker.id : 1;
          res.setHeader("x-worker-id", String(wId));
          json(res, 200, out);
        }
      })
      .catch((e) => respondPrepareError(res, e, req))
      .finally(() => {
        prepareBodyReads = Math.max(0, prepareBodyReads - 1);
        runtime.prepareInflight = Math.max(0, runtime.prepareInflight - 1);
      });
    return;
  }

  if (p === "/api/stream-ticket" && req.method === "POST") {
    if (!zone.apiKey) {
      json(res, 200, { ok: true, ticket: null, note: "auth off — EventSource needs no ticket" });
      return;
    }
    const minted = runtime.streamTickets.mint();
    json(res, 200, { ok: true, ...minted });
    return;
  }

  if (p === "/api/metrics" || p === "/metrics" || p === "/api/snapshot") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("method not allowed");
      return;
    }
  }

  if (p === "/api/metrics" || p === "/metrics") {
    const base =
      typeof telemetry.toPrometheusText === "function"
        ? telemetry.toPrometheusText()
        : "# no metrics\n";
    const rej = rejectsSnapshot();
    const rejectLines = [
      "# HELP cognistack_gateway_rejects_total Requests rejected by the HTTP gateway, by reason.",
      "# TYPE cognistack_gateway_rejects_total counter",
      ...Object.entries(rej.byReason).map(
        ([reason, count]) =>
          `cognistack_gateway_rejects_total{reason="${reason.replace(/[^a-z0-9_-]/gi, "_")}"} ${count}`,
      ),
      "# HELP cognistack_gateway_rejects_by_zone_total Requests rejected by the HTTP gateway, by zone.",
      "# TYPE cognistack_gateway_rejects_by_zone_total counter",
      `cognistack_gateway_rejects_by_zone_total{zone="local"} ${rej.byZone?.local || 0}`,
      `cognistack_gateway_rejects_by_zone_total{zone="lan"} ${rej.byZone?.lan || 0}`,
      `cognistack_gateway_rejects_by_zone_total{zone="wan"} ${rej.byZone?.wan || 0}`,
    ];
    const body = `${base.trimEnd()}\n${rejectLines.join("\n")}\n`;
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  if (p === "/api/snapshot") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshotWithPorts(40)));
    return;
  }

  if (p === "/api/stream") {
    // SSE 只能由 EventSource（GET）建立。没有这道校验，POST /api/stream 也会挂起一条
    // 长连接并占用 SSE 配额。
    if (req.method !== "GET") {
      res.writeHead(405, {
        allow: "GET",
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("method not allowed");
      return;
    }
    if (runtime.clients.size >= MAX_SSE_CLIENTS_PER_ZONE) {
      noteReject("sse_full", `clients=${runtime.clients.size}/${MAX_SSE_CLIENTS_PER_ZONE}`, req);
      safeEndJson(res, 503, { ok: false, error: "too many sse clients", code: "sse_full" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 86400000\n\n`);
    res.__clientIp = req.__clientIp;
    runtime.clients.add(res);
    writeSse(runtime, res, "snapshot", snapshotWithPorts(40));
    req.on("close", () => runtime.clients.delete(res));
    return;
  }

  if (p === "/api/host" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        const id = str(body?.id, 128);
        if (!id) throw new Error("host.id required");
        noteHostZone(zone.zone, id);
        telemetry.registerHost({
          id,
          name: str(body.name, 128, id),
          kind: str(body.kind, 32, "external"),
          version: str(body.version, 64) || undefined,
          provides: strList(body.provides, KNOWN_PORTS),
          requires: strList(body.requires, KNOWN_PORTS),
        });
        safeEndJson(res, 200, { ok: true });
        broadcast(true);
      })
      .catch((e) => {
        console.error("[api/host] rejected:", String(e && e.message));
        noteReject("bad_request", String(e && e.message), req);
        safeEndJson(res, 400, { ok: false, error: "invalid request", code: "bad_request" });
      });
    return;
  }

  if (p === "/api/turn" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        const hostId = str(body?.hostId, 128);
        if (!hostId) throw new Error("hostId required");
        noteHostZone(zone.zone, hostId);
        const hostName = str(body.hostName, 128, hostId);
        const kind = str(body.kind, 32, "external");
        const provides = strList(body.provides, KNOWN_PORTS);
        telemetry.registerHost({ id: hostId, name: hostName, kind, provides });
        telemetry.record(mapTurnPayload(body, { knownPorts: KNOWN_PORTS }));
        safeEndJson(res, 200, { ok: true });
      })
      .catch((e) => {
        console.error("[api/turn] rejected:", String(e && e.message));
        noteReject("bad_request", String(e && e.message), req);
        safeEndJson(res, 400, { ok: false, error: "invalid request", code: "bad_request" });
      });
    return;
  }

  if (p === "/api/ports" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        const hostId = str(body?.hostId, 128);
        if (!hostId) throw new Error("hostId required");
        noteHostZone(zone.zone, hostId);
        const ports = Array.isArray(body?.ports) ? body.ports : null;
        if (!ports) throw new Error("ports[] required");
        if (portReports.size >= MAX_PORT_REPORTS && !portReports.has(hostId)) {
          const oldest = portReports.keys().next().value;
          if (oldest !== undefined) portReports.delete(oldest);
        }
        portReports.set(hostId, {
          hostId,
          hostName: str(body.hostName, 128, hostId),
          at: Date.now(),
          ports: ports.slice(0, 64).map((d) => ({
            port: String(d?.port ?? "").slice(0, 32),
            bound: d?.bound === true,
            source: ["connection", "constructor", "builtin", "none"].includes(d?.source)
              ? d.source
              : undefined,
            winner: {
              providerId: d?.winner?.providerId == null ? null : String(d.winner.providerId).slice(0, 128),
              providerName:
                d?.winner?.providerName == null ? null : String(d.winner.providerName).slice(0, 128),
              priority: Number.isFinite(d?.winner?.priority) ? Number(d.winner.priority) : null,
              builtin: d?.winner?.builtin === true,
            },
            shadowed: Array.isArray(d?.shadowed)
              ? d.shadowed.slice(0, 32).map((s) => ({
                  providerId: String(s?.providerId ?? "").slice(0, 128),
                  providerName: String(s?.providerName ?? "").slice(0, 128),
                  priority: Number.isFinite(s?.priority) ? Number(s.priority) : 0,
                }))
              : [],
          })),
        });
        safeEndJson(res, 200, { ok: true, hosts: portReports.size });
      })
      .catch((err) => safeEndJson(res, 400, { error: err.message }));
    return;
  }

  if (p === "/api/reset" && req.method === "POST") {
    telemetry.reset();
    portReports.clear();
    safeEndJson(res, 200, {
      ok: true,
      turnLog: turnLog ? "kept (use POST /api/turn-log/clear to delete)" : "not configured",
    });
    broadcast(true);
    return;
  }

  if (p === "/api/turn-log" && req.method === "GET") {
    if (!turnLog) {
      safeEndJson(res, 404, {
        error: "turn log not configured",
        hint: "start with --turn-log <path> (or set COGNISTACK_TURN_LOG)",
      });
      return;
    }
    const q = url.searchParams;
    const result = turnLog.read({
      limit: Number(q.get("limit")) || 200,
      hostId: q.get("hostId") || undefined,
      from: q.get("from") || undefined,
      to: q.get("to") || undefined,
    });
    safeEndJson(res, 200, { ...result, stats: turnLog.stats() });
    return;
  }

  if (p === "/api/turn-log/replay" && req.method === "POST") {
    if (!turnLog) {
      safeEndJson(res, 404, { error: "turn log not configured" });
      return;
    }
    readBody(req)
      .then((body) => {
        const result = turnLog.read({ limit: Number(body?.limit) || 200 });
        const imported = telemetry.importTurns([...result.turns].reverse());
        broadcast(true);
        safeEndJson(res, 200, {
          ok: true,
          imported,
          scanned: result.scanned,
          malformed: result.malformed,
          note: "imported turns are marked replayed=true and do NOT affect metrics",
        });
      })
      .catch((err) => safeEndJson(res, 400, { error: err.message }));
    return;
  }

  if (p === "/api/turn-log/clear" && req.method === "POST") {
    if (!turnLog) {
      safeEndJson(res, 404, { error: "turn log not configured" });
      return;
    }
    readBody(req)
      .then((body) => {
        if (body?.confirm !== true) {
          safeEndJson(res, 400, { error: "confirm: true required to delete the turn log" });
          return;
        }
        turnLog.clear();
        safeEndJson(res, 200, { ok: true });
      })
      .catch((err) => safeEndJson(res, 400, { error: err.message }));
    return;
  }

  // 静态文件与 SPA 回退：仅 local 段开放
  if (zone.zone === "local") {
    const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const target = safeWebPath(rel);
    if (target) {
      sendFile(res, target);
      return;
    }
    if (req.method === "GET" && !p.startsWith("/api") && !p.startsWith("/v1") && !path.extname(p)) {
      const index = safeWebPath("index.html");
      if (index) {
        sendFile(res, index);
        return;
      }
    }
  }

  sendNotFound(res, zone);
}

/* ------------------------------------------------------------------ */
/* Start Servers                                                      */
/* ------------------------------------------------------------------ */

function startInitialZones() {
  const startupPromises = [];

  for (const cfg of bootConfigs) {
    startupPromises.push(startSingleZone(cfg.zone, cfg));
  }

  Promise.all(startupPromises)
    .then(() => {
      const localCfg = zoneConfigsMap.get("local");
      const base = zoneBaseForDisplay(localCfg);

      console.log("");
      console.log("  CogniStack — console + HTTP API (Multi-Zone Gateway)");
      console.log(`  Console: ${base}`);
      console.log(`  API:     ${base}/v1/prepare`);
      console.log(`  Discover:${base}/v1`);
      console.log(`  Static:  ${WEB}`);
      const staleSrc = consoleStaleFile();
      if (staleSrc) {
        console.log(`           \u26a0 console/dist 早于 console/src（例：${staleSrc}）`);
        console.log("             你看到的是**旧界面**。重新构建：npm run console:build");
      }

      console.log("");
      console.log("  Zones Status:");
      for (const summary of getZoneSummaries()) {
        const isRun = summary.status === "running";
        const icon = isRun ? "\u25cf" : "\u25cb";
        const statusText = isRun ? "RUNNING" : "STOPPED (可在控制台按需启动)";
        console.log(`    ${icon} [${summary.zone.padEnd(5)}] ${statusText} \u2192 ${summary.base}`);
        if (isRun) {
          console.log(`              auth: ${summary.auth} | rate-limit: ${summary.rateLimit}/s`);
        }
      }

      if (OPEN_CORS) {
        console.warn(
          "  NOTE:  --cors does not change the cross-origin decision. To allow a non-localhost" +
            " frontend set COGNISTACK_CORS_ORIGINS=<origin[,origin]>. See INTEGRATION.md §8.1.",
        );
      }
      console.log(`  prepare queue max: ${MAX_PREPARE_QUEUE}`);
      if (turnLog) {
        const st = turnLog.stats();
        console.log(
          `  turn log: ${turnLog.file} (${(st.bytes / 1048576).toFixed(1)} MiB, rotate at ${turnLogMaxMb} MiB, keep ${turnLogKeep})`,
        );
      } else {
        console.log("  turn log: off (--turn-log <path> to persist turns across restarts)");
      }
      console.log(`  示例:  node examples/http-call.cjs --url ${base}`);
      console.log("");
    })
    .catch((err) => {
      console.error(`\n  FATAL: ${err.message}\n`);
      for (const rt of zoneRuntimes.values()) {
        if (rt.server) {
          try {
            rt.server.close();
          } catch {}
        }
      }
      process.exit(1);
    });
}

startInitialZones();
