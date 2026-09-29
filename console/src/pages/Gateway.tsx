import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  BookOpen,
  Check,
  Copy,
  Eye,
  Globe,
  Key,
  Play,
  Plus,
  Radio,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
  Unlock,
  Users,
  Wifi,
} from "lucide-react";
import { useTelemetry } from "@/hooks/useTelemetry";
import { getApiKey } from "@/lib/apiKey";
import { clock, dur } from "@/lib/format";
import { rejectReasonLabel, zoneLabel } from "@/lib/i18n";
import type { GatewayClient, GatewayRejectEvent, GatewayZone, HostStat } from "@/lib/types";
import {
  Badge,
  Button,
  Code,
  DataTable,
  Modal,
  Panel,
  PanelBody,
  PanelHead,
  Row,
  Segmented,
  Stack,
  Stat,
  TextInput,
  useToast,
} from "@/ui";
import type { Tone } from "@/ui";
import { PageFlush } from "@/app/Page";
import "./gateway.css";

/* ===========================================================================
 * 领域模型
 * ======================================================================== */

/** 黑名单作用域：ip = 该地址上全部接入端；host = 仅该接入端。 */
type BlockScope = "ip" | "host";

type BlockEntry = {
  scope: BlockScope;
  /** ip 时是地址，host 时是 hostId */
  key: string;
  /** host 作用域下用于显示的可读名 */
  label?: string;
  reason: string;
  at: number;
};

/** 归一化后的接入客户端行：一个「系统」一行，而不是一个 IP 一行。 */
type ClientRow = {
  key: string;
  hostId?: string;
  name: string;
  kind: string;
  version?: string;
  zone: string;
  callerIp: string;
  callerType: string;
  targetPort: number;
  calls: number;
  avgTokens?: number;
  maxTokens?: number;
  cacheHitRate: number;
  lastDurationMs?: number;
  lastAt: number;
  /** 是否已被 telemetry 登记为宿主（探测型调用不会登记） */
  registered: boolean;
};

type DiagState = {
  busy: boolean;
  zone: string;
  status: number | null;
  ms: number | null;
  healthOk: boolean | null;
  probeTokens: number | null;
  msg: string;
};

const REJECT_META: Record<
  string,
  { level: string; tone: Tone; endpoint: string; code: number; label: string; suggestion: string }
> = {
  unauthorized: {
    level: "鉴权失败",
    tone: "warn",
    endpoint: "/v1/prepare",
    code: 401,
    label: "API Key 缺失或不匹配",
    suggestion: "在该接入端配置 Authorization: Bearer <key>，或让引擎以 --key 启动",
  },
  ip_blocked: {
    level: "安全拦截",
    tone: "bad",
    endpoint: "/v1/prepare",
    code: 403,
    label: "来源 IP 在封禁名单中",
    suggestion: "该 IP 上的全部接入端都会被拒；确认无误后到「封禁名单」解封",
  },
  host_blocked: {
    level: "安全拦截",
    tone: "bad",
    endpoint: "/v1/prepare",
    code: 403,
    label: "接入端在封禁名单中",
    suggestion: "只影响该接入端；同一 IP 上的其它系统不受影响",
  },
  proxy_untrusted: {
    level: "安全拦截",
    tone: "bad",
    endpoint: "/v1/health",
    code: 403,
    label: "公网代理密钥缺失或错误",
    suggestion: "反向代理需注入 x-cognistack-proxy-key，否则公网入口一律拒绝",
  },
  rate_limited: {
    level: "容量保护",
    tone: "warn",
    endpoint: "/v1/prepare",
    code: 429,
    label: "触发固定窗口限流",
    suggestion: "降低调用频率，或调高该段的 rateLimit 配置",
  },
  queue_full: {
    level: "容量保护",
    tone: "warn",
    endpoint: "/v1/prepare",
    code: 503,
    label: "装配队列已满",
    suggestion: "上游并发过高；等队列消化，或减少并发接入端",
  },
  too_large: {
    level: "容量保护",
    tone: "warn",
    endpoint: "/v1/prepare",
    code: 413,
    label: "请求体超过上限",
    suggestion: "裁剪 dialogue 或压缩知识条目后重试",
  },
  sse_full: {
    level: "容量保护",
    tone: "warn",
    endpoint: "/api/stream",
    code: 503,
    label: "遥测流连接数已满",
    suggestion: "关闭多余的观测面板",
  },
  unsupported_media_type: {
    level: "契约错误",
    tone: "neutral",
    endpoint: "/v1/prepare",
    code: 415,
    label: "缺少 application/json 头",
    suggestion: "POST 请求必须带 content-type: application/json",
  },
  bad_request: {
    level: "契约错误",
    tone: "neutral",
    endpoint: "/v1/prepare",
    code: 400,
    label: "请求不满足输入契约",
    suggestion: "按 /v1 发现文档核对字段名与类型",
  },
  zone_denied: {
    level: "契约错误",
    tone: "neutral",
    endpoint: "任意",
    code: 404,
    label: "该段不提供此接口",
    suggestion: "跨段调用被 ACL 拒绝；该段对未声明接口一律回 404，不暴露构建状态",
  },
  wrong_zone_key: {
    level: "契约错误",
    tone: "neutral",
    endpoint: "任意",
    code: 401,
    label: "密钥属于另一段",
    suggestion: "各段 API Key 互不通用，换成该段的 Key",
  },
};

const FALLBACK_REASON_META = {
  level: "其他",
  tone: "neutral" as Tone,
  endpoint: "/v1/prepare",
  code: 400,
  label: "未分类的拒绝原因",
  suggestion: "到「拦截明细」查看完整 detail",
};

/* ===========================================================================
 * 纯函数工具
 * ======================================================================== */

function randomKey(prefix = "key_"): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = prefix;
  for (let i = 0; i < 20; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function relTime(ts: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

function defaultPortOf(zone: string): number {
  return zone === "lan" ? 7332 : zone === "wan" ? 7333 : 7331;
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

function zoneIcon(zone: string): ReactNode {
  if (zone === "local") return <Radio size={16} aria-hidden />;
  if (zone === "lan") return <Wifi size={16} aria-hidden />;
  return <Globe size={16} aria-hidden />;
}

function zoneTone(zone: string): Tone {
  return zone === "wan" ? "warn" : zone === "lan" ? "ok" : "neutral";
}

function zoneText(zone: string): string {
  return `${zoneLabel(zone)}段 (${zone.toUpperCase()})`;
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { ok: res.ok };
  } catch {
    return { ok: res.ok, error: text || `HTTP ${res.status}` };
  }
}

function guideSnippet(base: string, apiKey: string, zone: string): string {
  const auth = apiKey ? ` \\\n  -H "authorization: Bearer ${apiKey}"` : "";
  return `# ${zoneText(zone)} 的最小可用调用（带 host 声明才会被登记为接入端）
curl -s ${base}/v1/prepare \\
  -H "content-type: application/json"${auth} \\
  -d '{
    "host": { "id": "your-system", "name": "你的系统名", "kind": "client" },
    "mode": "generate",
    "dialogue": [{ "id": "m1", "role": "user", "content": "你好" }],
    "contextTokenLimit": 8192
  }'`;
}

/* ===========================================================================
 * 页面
 * ======================================================================== */

const EMPTY_ZONES: GatewayZone[] = [];
const EMPTY_CLIENTS: GatewayClient[] = [];
const EMPTY_HOSTS: HostStat[] = [];

export function GatewayPage() {
  const { snap, viewSnap } = useTelemetry();
  const board = viewSnap ?? snap;
  const toast = useToast();

  const zones: GatewayZone[] = board?.gateway?.zones ?? EMPTY_ZONES;
  const rejects = board?.gateway?.rejects;
  const clients: GatewayClient[] = board?.gateway?.clients ?? EMPTY_CLIENTS;
  const hosts: HostStat[] = board?.hosts ?? EMPTY_HOSTS;
  const hostZones = board?.gateway?.hostZones;

  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"clients" | "blacklist" | "audit" | "guide" | "bridges">("clients");
  const [auditSubTab, setAuditSubTab] = useState<"stream" | "reasons">("stream");

  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null);
  const [configZone, setConfigZone] = useState<string | null>(null);
  const [cfgPort, setCfgPort] = useState("");
  const [cfgApiKey, setCfgApiKey] = useState("");
  const [cfgProxyKey, setCfgProxyKey] = useState("");
  const [cfgPublicUrl, setCfgPublicUrl] = useState("");
  const [cfgRateLimit, setCfgRateLimit] = useState("");

  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState<DiagState>({
    busy: false,
    zone: "lan",
    status: null,
    ms: null,
    healthOk: null,
    probeTokens: null,
    msg: "",
  });

  const [blockOpen, setBlockOpen] = useState(false);
  const [blockScope, setBlockScope] = useState<BlockScope>("host");
  const [blockHost, setBlockHost] = useState("");
  const [blockHostLabel, setBlockHostLabel] = useState("");
  const [blockIp, setBlockIp] = useState("");
  const [blockReason, setBlockReason] = useState("");

  /* ---- 黑名单（唯一真源是网关快照，不再有本地伪条目） ---- */
  const blocks = useMemo<BlockEntry[]>(() => {
    const out: BlockEntry[] = [];
    for (const [key, v] of Object.entries(board?.gateway?.blockedIps ?? {})) {
      out.push({
        scope: "ip",
        key: v.key || v.ip || key,
        reason: v.reason,
        at: v.at,
      });
    }
    for (const [key, v] of Object.entries(board?.gateway?.blockedHosts ?? {})) {
      const hostId = v.key || v.hostId || key;
      const label = hosts.find((h) => h.id === hostId)?.name;
      out.push({
        scope: "host",
        key: hostId,
        ...(label ? { label } : {}),
        reason: v.reason,
        at: v.at,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [board?.gateway?.blockedIps, board?.gateway?.blockedHosts, hosts]);

  const ipBlocks = useMemo(
    () => new Map(blocks.filter((b) => b.scope === "ip").map((b) => [b.key, b])),
    [blocks],
  );
  const hostBlocks = useMemo(
    () => new Map(blocks.filter((b) => b.scope === "host").map((b) => [b.key, b])),
    [blocks],
  );

  /* ---- 接入客户端：一个系统一行（同一 IP 上的多个系统各自成行） ---- */
  const clientRows = useMemo<ClientRow[]>(() => {
    const rows = new Map<string, ClientRow>();

    const zoneOfHost = (id: string): string => hostZones?.[id]?.zone ?? "lan";

    // 1) 宿主登记：真实调用过 prepare 的系统
    for (const h of hosts) {
      const zone = zoneOfHost(h.id);
      const rec = clients.find((c) => c.hostId === h.id);
      rows.set(`host:${h.id}`, {
        key: `host:${h.id}`,
        hostId: h.id,
        name: h.name || h.id,
        kind: h.kind || "service",
        ...(h.version ? { version: h.version } : {}),
        zone: rec?.zone || zone,
        callerIp: rec?.ip || (isLoopbackHost(zone) ? "127.0.0.1" : "未知来源"),
        callerType: rec ? (isLoopback(rec.ip) ? "本机发起" : "网络接入") : "按段推定",
        targetPort: zones.find((z) => z.zone === (rec?.zone || zone))?.port || defaultPortOf(rec?.zone || zone),
        calls: rec ? Math.max(rec.calls, h.calls) : h.calls,
        ...(h.avgPromptTokens ? { avgTokens: h.avgPromptTokens } : {}),
        ...(h.maxPromptTokens ? { maxTokens: h.maxPromptTokens } : {}),
        cacheHitRate: h.calls > 0 ? Math.round((h.cacheHits / h.calls) * 100) : 0,
        ...(h.lastDurationMs ? { lastDurationMs: h.lastDurationMs } : {}),
        lastAt: Math.max(h.lastSeen || 0, rec?.lastAt || 0),
        registered: true,
      });
    }

    // 2) 只有网络足迹的调用方：声明了 host 却还没登记、以及完全未声明 host 的
    for (const c of clients) {
      const existing = c.hostId ? rows.get(`host:${c.hostId}`) : undefined;
      if (existing) {
        existing.callerIp = c.ip;
        existing.zone = c.zone || existing.zone;
        existing.callerType = isLoopback(c.ip) ? "本机发起" : "网络接入";
        existing.lastAt = Math.max(existing.lastAt, c.lastAt);
        continue;
      }
      const key = c.hostId ? `pending:${c.hostId}` : `anon:${c.ip}`;
      rows.set(key, {
        key,
        ...(c.hostId ? { hostId: c.hostId } : {}),
        name: c.hostId || "未声明宿主",
        kind: "client",
        zone: c.zone || "lan",
        callerIp: c.ip,
        callerType: isLoopback(c.ip) ? "本机发起" : "网络接入",
        targetPort: zones.find((z) => z.zone === (c.zone || "lan"))?.port || defaultPortOf(c.zone || "lan"),
        calls: c.calls,
        cacheHitRate: 0,
        lastAt: c.lastAt,
        registered: false,
      });
    }

    return [...rows.values()].sort((a, b) => b.lastAt - a.lastAt);
  }, [hosts, clients, zones, hostZones]);

  const blockedClientCount = clientRows.filter(
    (r) => (r.hostId && hostBlocks.has(r.hostId)) || ipBlocks.has(r.callerIp),
  ).length;

  /* ---- 审计 ---- */
  const auditEvents = useMemo<GatewayRejectEvent[]>(
    () => board?.gateway?.rejects?.events ?? [],
    [board?.gateway?.rejects?.events],
  );

  const topReason = useMemo(() => {
    let top = "—";
    let max = 0;
    for (const [k, v] of Object.entries(rejects?.byReason ?? {})) {
      if (v > max) {
        max = v;
        top = k;
      }
    }
    return { key: top, label: top === "—" ? top : rejectReasonLabel(top), count: max };
  }, [rejects?.byReason]);

  const reasonRows = useMemo(() => {
    const byReason = rejects?.byReason ?? {};
    const total = Object.values(byReason).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => {
        const meta = REJECT_META[reason] ?? FALLBACK_REASON_META;
        return { reason, count, percent: Math.round((count / total) * 100), ...meta };
      });
  }, [rejects?.byReason]);

  const runningZones = zones.filter((z) => z.status === "running");

  /* ---- 请求封装 ---- */
  const authHeaders = (): Record<string, string> => {
    const key = getApiKey();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) {
      headers["authorization"] = `Bearer ${key}`;
      headers["x-api-key"] = key;
    }
    return headers;
  };

  const copy = async (text: string, label = "已复制") => {
    try {
      await navigator.clipboard.writeText(text);
      toast(label, "ok");
    } catch {
      toast("当前环境不允许写剪贴板", "bad");
    }
  };

  const postJson = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
      const data = await parseJson(res);
      if (!res.ok) throw new Error(String(data.error || `HTTP ${res.status}`));
      return data;
    } finally {
      setBusy(false);
    }
  };

  const startZone = async (zoneName: string) => {
    try {
      await postJson("/api/zones/start", { zone: zoneName });
      toast(`[${zoneName.toUpperCase()}] 已启动监听`, "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "启动失败", "bad");
    }
  };

  const stopZone = async (zoneName: string) => {
    try {
      await postJson("/api/zones/stop", { zone: zoneName });
      toast(`[${zoneName.toUpperCase()}] 已停止监听`, "neutral");
    } catch (err) {
      toast(err instanceof Error ? err.message : "停止失败", "bad");
    }
  };

  const saveConfig = async (zoneName: string) => {
    try {
      const payload: Record<string, unknown> = {
        zone: zoneName,
        port: Number(cfgPort),
        apiKey: cfgApiKey.trim(),
        rateLimit: Number(cfgRateLimit) || 30,
      };
      if (zoneName === "wan") {
        payload.proxyKey = cfgProxyKey.trim();
        payload.publicUrl = cfgPublicUrl.trim();
      }
      await postJson("/api/zones/start", payload);
      toast(`[${zoneName.toUpperCase()}] 配置已应用并重启监听`, "ok");
      setConfigZone(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存配置失败", "bad");
    }
  };

  const runDiagnostic = async (zone: string) => {
    const target = zones.find((z) => z.zone === zone);
    setDiagOpen(true);
    setDiag({
      busy: true,
      zone,
      status: null,
      ms: null,
      healthOk: null,
      probeTokens: null,
      msg: "正在探活（GET /v1/health）并打一发最小装配探针…",
    });
    if (!target) {
      setDiag((d) => ({ ...d, busy: false, msg: "该段未在快照中，无法探活" }));
      return;
    }

    const base = isLoopback(target.host) ? `http://127.0.0.1:${target.port}` : target.publicBase || target.base;
    const headers: Record<string, string> = { accept: "application/json" };
    if (target.apiKey) {
      headers["authorization"] = `Bearer ${target.apiKey}`;
      headers["x-api-key"] = target.apiKey;
    }
    if (target.proxyKey) headers["x-cognistack-proxy-key"] = target.proxyKey;

    const t0 = performance.now();
    try {
      const health = await fetch(`${base}/v1/health`, { method: "GET", headers });
      const elapsed = Math.round(performance.now() - t0);
      if (!health.ok) {
        setDiag({
          busy: false,
          zone,
          status: health.status,
          ms: elapsed,
          healthOk: false,
          probeTokens: null,
          msg: `探活失败 HTTP ${health.status}`,
        });
        return;
      }
      // 联通探测必须打带 host 的最小 prepare 探针：只探活不会留下任何接入记录
      const probe = await fetch(`${base}/v1/prepare`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          host: { id: "console-gateway-probe", name: "控制台联通探测", kind: "client" },
          mode: "generate",
          dialogue: [{ id: "gw-probe", role: "user", content: "ping" }],
          contextTokenLimit: 4096,
          meta: { probe: true, label: "联通探测" },
        }),
      });
      const probeData = await parseJson(probe);
      setDiag({
        busy: false,
        zone,
        status: 200,
        ms: elapsed,
        healthOk: true,
        probeTokens: typeof probeData.promptTokens === "number" ? probeData.promptTokens : null,
        msg: probe.ok
          ? "探活与最小装配探针均通过；该段已可用"
          : `探活通过，但装配探针返回 HTTP ${probe.status}：${String(probeData.error ?? "")}`,
      });
    } catch (err) {
      setDiag({
        busy: false,
        zone,
        status: 0,
        ms: Math.round(performance.now() - t0),
        healthOk: false,
        probeTokens: null,
        msg: err instanceof Error ? err.message : "网络不可达",
      });
    }
  };

  /* ---- 封禁 ---- */
  const openBlock = (scope: BlockScope, target: { hostId?: string; ip: string; name: string }) => {
    setBlockScope(scope);
    setBlockHost(target.hostId || "");
    setBlockHostLabel(target.name);
    setBlockIp(target.ip);
    setBlockReason(scope === "ip" ? "管理员手动封禁：来源 IP" : "管理员手动封禁：接入端");
    setBlockOpen(true);
  };

  const confirmBlock = async () => {
    if (blockScope === "ip" && !blockIp.trim()) {
      toast("请先填写待封禁的 IP 地址", "bad");
      return;
    }
    if (blockScope === "host" && !blockHost.trim()) {
      toast("该接入端没有 host 标识，无法按接入端封禁；可改用「封禁此 IP」", "bad");
      return;
    }
    try {
      const body: Record<string, unknown> =
        blockScope === "ip"
          ? { scope: "ip", ip: blockIp.trim(), reason: blockReason.trim() }
          : { scope: "host", host: blockHost.trim(), reason: blockReason.trim() };
      const out = await postJson("/api/gateway/block", body);
      const key = String(out.key ?? "");
      toast(
        blockScope === "ip" ? `已封禁该 IP：${key}` : `已封禁该接入端：${key || blockHost.trim()}`,
        "ok",
      );
      setBlockOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "封禁失败", "bad");
    }
  };

  const unblock = async (entry: BlockEntry) => {
    try {
      const body: Record<string, unknown> =
        entry.scope === "ip" ? { ip: entry.key } : { host: entry.key };
      await postJson("/api/gateway/unblock", body);
      toast(entry.scope === "ip" ? `已解封 IP：${entry.key}` : `已解封接入端：${entry.key}`, "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "解封失败", "bad");
    }
  };

  const clearClients = async () => {
    try {
      await postJson("/api/gateway/clear-clients", {});
      toast("已清空网关侧网络足迹（宿主登记来自引擎遥测，仍然保留）", "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "清空失败", "bad");
    }
  };

  const clearRejects = async () => {
    try {
      await postJson("/api/gateway/clear-rejects", {});
      toast("拦截计数与明细已清空", "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "清空失败", "bad");
    }
  };

  const openConfig = (z: GatewayZone) => {
    setConfigZone(z.zone);
    setCfgPort(String(z.port || defaultPortOf(z.zone)));
    setCfgApiKey(z.apiKey || randomKey(`key_${z.zone}_`));
    setCfgProxyKey(z.proxyKey || "");
    setCfgPublicUrl(z.publicBase || "");
    setCfgRateLimit(String(z.rateLimit || (z.zone === "wan" ? 10 : 30)));
  };

  const blockScopeHint =
    blockScope === "ip"
      ? `该 IP 上的全部接入端都会被拒。检测到同一 IP 下还有 ${
          clientRows.filter((r) => r.callerIp === blockIp.trim() && r.hostId !== blockHost).length
        } 个接入端。`
      : "只拦这一个接入端；同一 IP 下的其它系统不受影响。";

  /* ---- 渲染 ---- */
  return (
    <PageFlush>
      <div className="gw-layout">
        <div className="gw-stats-grid">
          <Stat
            label="运行中监听段"
            value={`${runningZones.length} / ${zones.length || 3}`}
            foot="三段网络隔离"
          />
          <Stat
            label="接入客户端"
            value={`${clientRows.length} 个系统`}
            foot="按接入端分列"
          />
          <Stat
            label="封禁名单"
            value={`${blocks.length} 条`}
            tone={blocks.length > 0 ? "warn" : "neutral"}
            foot={`${ipBlocks.size} IP · ${hostBlocks.size} 接入端`}
          />
          <Stat
            label="安全拦截总次数"
            value={String(rejects?.total ?? 0)}
            tone={(rejects?.total ?? 0) > 0 ? "bad" : "ok"}
            foot="被引擎拒收"
          />
        </div>

        <div className="gw-split-layout">
          {/* 左：三段监听卡 */}
          <div className="gw-split-left">
            {zones.map((z) => {
              const running = z.status === "running";
              const displayUrl = z.publicBase || z.base;
              return (
                <div key={z.zone} className="gw-card" data-active={running ? "true" : undefined}>
                  <div className="gw-card-head">
                    <div className="gw-card-title">
                      {zoneIcon(z.zone)}
                      <span>{zoneText(z.zone)}</span>
                    </div>
                    <Badge tone={running ? "ok" : "neutral"}>{running ? "监听中" : "已停止"}</Badge>
                  </div>

                  <div className="gw-card-body">
                    <div className="gw-row">
                      <span className="gw-label">监听地址</span>
                      <span className="gw-val">
                        <Code>{`${z.host}:${z.port}`}</Code>
                      </span>
                    </div>
                    <div className="gw-row">
                      <span className="gw-label">调用基址</span>
                      <span className="gw-val">
                        <Code>{displayUrl}</Code>
                      </span>
                    </div>
                    <div className="gw-row">
                      <span className="gw-label">接口鉴权</span>
                      <span className="gw-val">
                        {z.apiKey ? <Code>{z.apiKey}</Code> : <span className="gw-hint">未启用</span>}
                      </span>
                    </div>
                    {z.zone === "wan" && z.proxyKey ? (
                      <div className="gw-row">
                        <span className="gw-label">代理密钥</span>
                        <span className="gw-val">
                          <Code>{z.proxyKey}</Code>
                        </span>
                      </div>
                    ) : null}
                    <div className="gw-row">
                      <span className="gw-label">限流上限</span>
                      <span className="gw-val">
                        <span className="num">{z.rateLimit || 30}</span> 次 / 秒
                      </span>
                    </div>
                  </div>

                  <Row gap="var(--sp-2)">
                    {running ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          icon={<Square size={12} aria-hidden />}
                          onClick={() => void stopZone(z.zone)}
                        >
                          停止
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Copy size={12} aria-hidden />}
                          onClick={() => void copy(displayUrl, "已复制调用基址")}
                        >
                          复制基址
                        </Button>
                        {z.apiKey ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Key size={12} aria-hidden />}
                            onClick={() => void copy(z.apiKey || "", "已复制 Key")}
                          >
                            复制 Key
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={diag.busy}
                          icon={<Activity size={12} aria-hidden />}
                          onClick={() => void runDiagnostic(z.zone)}
                        >
                          探活自检
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => openConfig(z)}>
                          配置
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="solid"
                          size="sm"
                          disabled={busy}
                          icon={<Play size={12} aria-hidden />}
                          onClick={() => void startZone(z.zone)}
                        >
                          一键启动
                        </Button>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => openConfig(z)}>
                          配置
                        </Button>
                      </>
                    )}
                  </Row>
                </div>
              );
            })}
          </div>

          {/* 右：接入客户端 / 封禁名单 / 拦截审计 / 接入指引 */}
          <div className="gw-split-right">
            <Panel className="gw-tab-panel">
              <PanelHead
                title={
                  <Segmented
                    value={tab}
                    onChange={setTab}
                    label="网关工作台视图"
                    options={[
                      {
                        value: "clients",
                        label: `客户端 ${clientRows.length}`,
                        icon: <Users size={14} aria-hidden />,
                      },
                      {
                        value: "blacklist",
                        label: `封禁 ${blocks.length}`,
                        icon: <ShieldAlert size={14} aria-hidden />,
                      },
                      {
                        value: "audit",
                        label: `审计 ${rejects?.total ?? 0}`,
                        icon: <Activity size={14} aria-hidden />,
                      },
                      {
                        value: "guide",
                        label: "指引",
                        icon: <BookOpen size={14} aria-hidden />,
                      },
                      {
                        value: "bridges",
                        label: "协议桥",
                        icon: <Radio size={14} aria-hidden />,
                      },
                    ]}
                  />
                }
                right={
                  tab === "clients" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || clientRows.length === 0}
                      icon={<Trash2 size={12} aria-hidden />}
                      title="只清掉网关侧的来源 IP / 活跃足迹；宿主登记由引擎遥测持有，清了这里也不会消失"
                      onClick={() => void clearClients()}
                    >
                      清空网络足迹
                    </Button>
                  ) : tab === "blacklist" ? (
                    <Button
                      variant="solid"
                      size="sm"
                      icon={<Plus size={12} aria-hidden />}
                      onClick={() => openBlock("ip", { ip: "", name: "" })}
                    >
                      手动添加封禁
                    </Button>
                  ) : tab === "audit" ? (
                    <Row gap="var(--sp-2)">
                      <Badge tone={(rejects?.total ?? 0) > 0 ? "warn" : "ok"}>
                        累计 {rejects?.total ?? 0} 次
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || (rejects?.total ?? 0) === 0}
                        icon={<Trash2 size={12} aria-hidden />}
                        onClick={() => void clearRejects()}
                      >
                        清空记录
                      </Button>
                    </Row>
                  ) : null
                }
              />

              <PanelBody flush scroll>
                {/* ---------- 接入客户端 ---------- */}
                {tab === "clients" ? (
                  clientRows.length === 0 ? (
                    <div className="gw-empty-state">
                      还没有接入客户端。主机只来自真实调用：客户端第一次 POST /v1/prepare（或显式 POST
                      /api/host）后才注册；只做 GET /v1/health 的「测试连接」是纯探活，不会在这里留记录。
                    </div>
                  ) : (
                    <>
                      <div className="gw-hintbar">
                        每个「系统」一行 —— 同一 IP 上的多个接入端分别列出，因此可以只封掉其中一个。
                        {blockedClientCount > 0 ? (
                          <Badge tone="bad" className="gw-hintbar-badge">
                            已封禁 {blockedClientCount} 个
                          </Badge>
                        ) : null}
                      </div>
                      <DataTable label="接入客户端列表" minWidth={800} className="gw-sticky-actions">
                        <thead>
                          <tr>
                            <th scope="col">接入系统 / 客户端</th>
                            <th scope="col">来源 IP / 目标网关</th>
                            <th scope="col">调用用量</th>
                            <th scope="col">性能 / 缓存</th>
                            <th scope="col">最近活跃</th>
                            <th scope="col">管控操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {clientRows.map((c) => {
                            const byHost = c.hostId ? hostBlocks.get(c.hostId) : undefined;
                            const byIp = ipBlocks.get(c.callerIp);
                            const sharedIpCount = clientRows.filter((r) => r.callerIp === c.callerIp).length;
                            return (
                              <tr key={c.key}>
                                <td>
                                  <Stack gap="2px">
                                    <Row gap="var(--sp-2)" justify="center" wrap={false}>
                                      <strong className="truncate" title={c.name}>
                                        {c.name}
                                      </strong>
                                      {byHost ? <Badge tone="bad">接入端已封</Badge> : null}
                                      {byIp ? <Badge tone="bad">IP 已封</Badge> : null}
                                    </Row>
                                    <span className="gw-hint">
                                      {c.hostId ? <Code>{c.hostId}</Code> : "未声明 host"}
                                      {` · ${c.kind}`}
                                      {c.version ? ` · v${c.version}` : ""}
                                      {c.registered ? "" : " · 未登记"}
                                    </span>
                                  </Stack>
                                </td>
                                <td>
                                  <Stack gap="2px">
                                    <Row gap="var(--sp-2)" justify="center" wrap={false}>
                                      <Code>{c.callerIp}</Code>
                                      <Badge tone={zoneTone(c.zone)}>{`${c.zone.toUpperCase()}:${c.targetPort}`}</Badge>
                                    </Row>
                                    <span className="gw-hint">
                                      {c.callerType}
                                      {sharedIpCount > 1 ? ` · 同址 ${sharedIpCount} 个系统` : ""}
                                    </span>
                                  </Stack>
                                </td>
                                <td>
                                  <Stack gap="2px">
                                    <span className="num">{c.calls} 次</span>
                                    <span className="gw-hint">
                                      {c.avgTokens ? `均 ${Math.round(c.avgTokens)} tk` : "均 —"} ·{" "}
                                      {c.maxTokens ? `峰 ${Math.round(c.maxTokens)} tk` : "峰 —"}
                                    </span>
                                  </Stack>
                                </td>
                                <td>
                                  <Stack gap="2px">
                                    <span className="num">{c.lastDurationMs ? dur(c.lastDurationMs) : "—"}</span>
                                    <span className="gw-hint">{c.cacheHitRate}% 缓存</span>
                                  </Stack>
                                </td>
                                <td>
                                  <Stack gap="2px">
                                    <span>{relTime(c.lastAt)}</span>
                                    <span className="gw-hint">{c.lastAt ? clock(c.lastAt) : "—"}</span>
                                  </Stack>
                                </td>
                                <td>
                                  <Row gap="var(--sp-2)" justify="center">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      icon={<Eye size={12} aria-hidden />}
                                      onClick={() => setSelectedClient(c)}
                                    >
                                      详情
                                    </Button>
                                    {byHost ? (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        icon={<Unlock size={12} aria-hidden />}
                                        title={`解除接入端封禁：${c.hostId}`}
                                        onClick={() => void unblock(byHost)}
                                      >
                                        解接入端
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy || !c.hostId}
                                        icon={<Ban size={12} aria-hidden />}
                                        title={
                                          c.hostId
                                            ? `封禁此接入端：只拦 ${c.hostId}，同一 IP 上的其它系统不受影响`
                                            : "该行没有 host 标识，无法按接入端封禁"
                                        }
                                        onClick={() => openBlock("host", { hostId: c.hostId, ip: c.callerIp, name: c.name })}
                                      >
                                        封接入端
                                      </Button>
                                    )}
                                    {byIp ? (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        icon={<Unlock size={12} aria-hidden />}
                                        title={`解除 IP 封禁：${c.callerIp}`}
                                        onClick={() => void unblock(byIp)}
                                      >
                                        解 IP
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy || !c.callerIp || c.callerIp === "未知来源"}
                                        icon={<ShieldAlert size={12} aria-hidden />}
                                        title={`封禁此 IP：该地址上全部 ${sharedIpCount} 个系统都会被拒`}
                                        onClick={() => openBlock("ip", { hostId: c.hostId, ip: c.callerIp, name: c.name })}
                                      >
                                        封 IP
                                      </Button>
                                    )}
                                  </Row>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </DataTable>
                    </>
                  )
                ) : null}

                {/* ---------- 封禁名单 ---------- */}
                {tab === "blacklist" ? (
                  blocks.length === 0 ? (
                    <div className="gw-empty-state">
                      封禁名单为空。在「接入客户端」里可以按接入端或按 IP 封禁；被拒的请求会记在「拦截审计」。
                    </div>
                  ) : (
                    <>
                      <div className="gw-hintbar">
                        「接入端」只拦该 host.id；「IP」拦该地址上全部接入端。两者相互独立，解封互不影响。
                      </div>
                      <DataTable label="封禁名单" minWidth={760}>
                        <thead>
                          <tr>
                            <th scope="col">封禁目标</th>
                            <th scope="col">作用域</th>
                            <th scope="col">封禁原因</th>
                            <th scope="col">封禁时间</th>
                            <th scope="col">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {blocks.map((item) => (
                            <tr key={`${item.scope}:${item.key}`}>
                              <td>
                                <Stack gap="2px">
                                  <Code>{item.key}</Code>
                                  {item.label ? <span className="gw-hint">{item.label}</span> : null}
                                </Stack>
                              </td>
                              <td>
                                <Badge tone={item.scope === "ip" ? "bad" : "warn"}>
                                  {item.scope === "ip" ? "整段 IP" : "单个接入端"}
                                </Badge>
                              </td>
                              <td>{item.reason || "管理员手动封禁"}</td>
                              <td>
                                <Stack gap="2px">
                                  <span>{clock(item.at)}</span>
                                  <span className="gw-hint">{relTime(item.at)}</span>
                                </Stack>
                              </td>
                              <td>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  icon={<Unlock size={12} aria-hidden />}
                                  onClick={() => void unblock(item)}
                                >
                                  解除封禁
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </DataTable>
                    </>
                  )
                ) : null}

                {/* ---------- 拦截审计 ---------- */}
                {tab === "audit" ? (
                  (rejects?.total ?? 0) === 0 ? (
                    <div className="gw-empty-state">
                      暂无拦截记录。这一块存在的唯一理由：把「客户端说它连上了、这里却什么都没有」拆成两种可区分的情况
                      —— 它根本没调，与它调了但被挡在门外。
                    </div>
                  ) : (
                    <div className="gw-audit-container">
                      <div className="gw-audit-kpis">
                        <div className="gw-audit-kpi-item">
                          <span className="gw-audit-kpi-label">拦截总数</span>
                          <span className="gw-audit-kpi-val num">{rejects?.total ?? 0} 次</span>
                        </div>
                        <div className="gw-audit-kpi-item">
                          <span className="gw-audit-kpi-label">按段分布</span>
                          <span className="gw-audit-kpi-val">
                            LAN {rejects?.byZone?.lan ?? 0} · WAN {rejects?.byZone?.wan ?? 0} · LOCAL{" "}
                            {rejects?.byZone?.local ?? 0}
                          </span>
                        </div>
                        <div className="gw-audit-kpi-item">
                          <span className="gw-audit-kpi-label">首要原因</span>
                          <span className="gw-audit-kpi-val">
                            {topReason.label} ({topReason.count} 次)
                          </span>
                        </div>
                        <div className="gw-audit-kpi-item">
                          <span className="gw-audit-kpi-label">最近一次</span>
                          <span className="gw-audit-kpi-val">
                            {rejects?.last ? relTime(rejects.last.at) : "—"}
                          </span>
                        </div>
                      </div>

                      <div className="gw-audit-toolbar">
                        <Segmented
                          value={auditSubTab}
                          onChange={setAuditSubTab}
                          label="审计视图"
                          options={[
                            { value: "stream", label: `拦截明细 (${auditEvents.length})` },
                            { value: "reasons", label: `原因归类 (${reasonRows.length})` },
                          ]}
                        />
                        <span className="gw-hint">
                          {auditSubTab === "stream"
                            ? "最近 120 条拒绝事件；clientIp 为网关解析出的真实来源"
                            : "按原因聚合，附建议处理方式"}
                        </span>
                      </div>

                      {auditSubTab === "stream" ? (
                        auditEvents.length === 0 ? (
                          <div className="gw-empty-state">计数已累计，但明细缓冲为空（可能刚被清空）。</div>
                        ) : (
                          <DataTable label="拦截明细" minWidth={880} className="gw-sticky-actions">
                            <thead>
                              <tr>
                                <th scope="col">拦截时间</th>
                                <th scope="col">来源 IP</th>
                                <th scope="col">监听段</th>
                                <th scope="col">请求端点</th>
                                <th scope="col">拒绝原因</th>
                                <th scope="col">明细</th>
                                <th scope="col">操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {auditEvents.map((ev) => {
                                const meta = REJECT_META[ev.reason] ?? FALLBACK_REASON_META;
                                const ip = ev.clientIp || "127.0.0.1";
                                const ipBlocked = ipBlocks.get(ip);
                                return (
                                  <tr key={ev.id}>
                                    <td>
                                      <Stack gap="2px">
                                        <span>{clock(ev.at)}</span>
                                        <span className="gw-hint">{relTime(ev.at)}</span>
                                      </Stack>
                                    </td>
                                    <td>
                                      <Code>{ip}</Code>
                                    </td>
                                    <td>
                                      <Badge tone={zoneTone(ev.zone)}>{(ev.zone || "unknown").toUpperCase()}</Badge>
                                    </td>
                                    <td>
                                      <Row gap="var(--sp-2)" justify="center" wrap={false}>
                                        <Badge tone="neutral">{ev.method || "POST"}</Badge>
                                        <Code>{ev.path || "/v1/prepare"}</Code>
                                      </Row>
                                    </td>
                                    <td>
                                      <Stack gap="2px">
                                        <Badge tone={meta.tone}>{rejectReasonLabel(ev.reason)}</Badge>
                                        <span className="gw-hint">{`HTTP ${ev.status ?? meta.code}`}</span>
                                      </Stack>
                                    </td>
                                    <td>
                                      <span className="gw-detail-clip" title={ev.detail || "无明细"}>
                                        {ev.detail || "—"}
                                      </span>
                                    </td>
                                    <td>
                                      {ipBlocked ? (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          disabled={busy}
                                          icon={<Unlock size={12} aria-hidden />}
                                          title={`解除 IP 封禁：${ip}`}
                                          onClick={() => void unblock(ipBlocked)}
                                        >
                                          解 IP
                                        </Button>
                                      ) : (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={busy || ev.reason !== "ip_blocked"}
                                          icon={<ShieldAlert size={12} aria-hidden />}
                                          title={
                                            ev.reason === "ip_blocked"
                                              ? `封禁此 IP：${ip}`
                                              : "只有 ip_blocked 事件才能从明细直接封 IP"
                                          }
                                          onClick={() => openBlock("ip", { ip, name: "拦截来源" })}
                                        >
                                          封 IP
                                        </Button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </DataTable>
                        )
                      ) : (
                        <DataTable label="拒绝原因归类" minWidth={820}>
                          <thead>
                            <tr>
                              <th scope="col">原因键</th>
                              <th scope="col">分级</th>
                              <th scope="col">端点 / 状态</th>
                              <th scope="col">说明与建议</th>
                              <th scope="col">次数</th>
                              <th scope="col">占比</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reasonRows.map((item) => (
                              <tr key={item.reason}>
                                <td>
                                  <Code>{item.reason}</Code>
                                </td>
                                <td>
                                  <Badge tone={item.tone}>{item.level}</Badge>
                                </td>
                                <td>
                                  <Badge tone="neutral">{`${item.endpoint} · ${item.code}`}</Badge>
                                </td>
                                <td>
                                  <Stack gap="2px">
                                    <strong>{item.label}</strong>
                                    <span className="gw-hint">{item.suggestion}</span>
                                  </Stack>
                                </td>
                                <td className="num">{item.count}</td>
                                <td className="num">{item.percent}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </DataTable>
                      )}
                    </div>
                  )
                ) : null}

                {/* ---------- 接入指引 ---------- */}
                {tab === "guide" ? (
                  <div className="gw-guide">
                    <p className="gw-hint">
                      接入是两件事：<b>探活</b>（GET /v1/health，不留记录）与<b>接入</b>（POST
                      /v1/prepare，带 host 声明后才登记为接入端）。只做前者，面板上永远看不到你的系统。
                    </p>
                    {zones.length === 0 ? (
                      <div className="gw-empty-state">还没有任何监听段，先在左侧启动一段。</div>
                    ) : (
                      zones.map((z) => {
                        const base = z.publicBase || z.base;
                        return (
                          <div key={z.zone} className="gw-guide-card">
                            <div className="gw-guide-head">
                              <Row gap="var(--sp-2)">
                                {zoneIcon(z.zone)}
                                <strong>{zoneText(z.zone)}</strong>
                                <Badge tone={z.status === "running" ? "ok" : "neutral"}>
                                  {z.status === "running" ? "监听中" : "已停止"}
                                </Badge>
                              </Row>
                              <Row gap="var(--sp-2)">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={<Copy size={12} aria-hidden />}
                                  onClick={() => void copy(base, "已复制基址")}
                                >
                                  复制基址
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={<Copy size={12} aria-hidden />}
                                  onClick={() => void copy(guideSnippet(base, z.apiKey || "", z.zone), "已复制调用示例")}
                                >
                                  复制示例
                                </Button>
                              </Row>
                            </div>
                            <div className="gw-guide-row">
                              <span className="gw-label">基址</span>
                              <Code>{base}</Code>
                            </div>
                            <div className="gw-guide-row">
                              <span className="gw-label">鉴权</span>
                              <span className="gw-val">
                                {z.apiKey ? (
                                  <>
                                    <Code>{`Authorization: Bearer ${z.apiKey}`}</Code>
                                  </>
                                ) : (
                                  <span className="gw-hint">未启用（该段仅回环可达时才是安全的）</span>
                                )}
                              </span>
                            </div>
                            <pre className="gw-guide-code">{guideSnippet(base, z.apiKey || "", z.zone)}</pre>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}

                {/* ---------- 协议兼容桥 (OpenAI / Anthropic) ---------- */}
                {tab === "bridges" ? (
                  <div className="gw-guide">
                    <div className="gw-hintbar">
                      协议桥接器将 CogniStack 上下文装配与预算控制引擎插在「第三方客户端」与「真实大模型」之间，保持第三方生态无缝兼容。
                    </div>

                    {/* OpenAI 兼容网关 */}
                    <div className="gw-guide-card">
                      <div className="gw-guide-head">
                        <Row gap="var(--sp-2)">
                          <Radio size={16} aria-hidden />
                          <strong>OpenAI Chat Completions 协议网关</strong>
                        </Row>
                        <Row gap="var(--sp-2)">
                          <Badge tone="ok">端口 8790</Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Copy size={12} aria-hidden />}
                            onClick={() =>
                              void copy(
                                `node tools/openai-compat.cjs --upstream http://127.0.0.1:8080 --port 8790 --system-mode prefix`,
                                "已复制启动命令",
                              )
                            }
                          >
                            复制启动命令
                          </Button>
                        </Row>
                      </div>
                      <div className="gw-guide-row">
                        <span className="gw-label">端点 URL</span>
                        <Code>http://127.0.0.1:8790/v1/chat/completions</Code>
                      </div>
                      <div className="gw-guide-row">
                        <span className="gw-label">适用生态</span>
                        <span className="gw-val">Chatbox、NextChat、Cursor、LangChain、Open-WebUI、沉浸式翻译等任意标准 OpenAI 客户端</span>
                      </div>
                      <div className="gw-guide-row">
                        <span className="gw-label">系统词模式</span>
                        <span className="gw-val">
                          <Code>--system-mode drop</Code> (由 CogniStack 全权接管) 或 <Code>--system-mode prefix</Code> (保留客户端 system 文本)
                        </span>
                      </div>
                      <pre className="gw-guide-code">{`# 1) 启动中间件（指定上游模型基址，如本地 llama-server 或云端 API）
node tools/openai-compat.cjs --upstream http://127.0.0.1:8080 --port 8790

# 2) 客户端调用验证
curl http://127.0.0.1:8790/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"local","messages":[{"role":"user","content":"你好"}]}'`}</pre>
                    </div>

                    {/* Anthropic Claude 兼容网关 */}
                    <div className="gw-guide-card">
                      <div className="gw-guide-head">
                        <Row gap="var(--sp-2)">
                          <Radio size={16} aria-hidden />
                          <strong>Anthropic Claude Messages 协议网关</strong>
                        </Row>
                        <Row gap="var(--sp-2)">
                          <Badge tone="ok">端口 8792</Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Copy size={12} aria-hidden />}
                            onClick={() =>
                              void copy(
                                `node tools/anthropic-compat.cjs --upstream https://api.anthropic.com --port 8792`,
                                "已复制启动命令",
                              )
                            }
                          >
                            复制启动命令
                          </Button>
                        </Row>
                      </div>
                      <div className="gw-guide-row">
                        <span className="gw-label">端点 URL</span>
                        <Code>http://127.0.0.1:8792/v1/messages</Code>
                      </div>
                      <div className="gw-guide-row">
                        <span className="gw-label">顶层特性</span>
                        <span className="gw-val">自动映射顶层 system 文本与 content blocks，原生支持流式 SSE 反压与客户端断开中止</span>
                      </div>
                      <pre className="gw-guide-code">{`# 1) 启动 Anthropic 消息协议网关
node tools/anthropic-compat.cjs --upstream https://api.anthropic.com --port 8792

# 2) 客户端调用验证
curl http://127.0.0.1:8792/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: your-claude-key" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'`}</pre>
                    </div>
                  </div>
                ) : null}
              </PanelBody>
            </Panel>
          </div>
        </div>

        {/* 客户端详情 */}
        <Modal
          open={Boolean(selectedClient)}
          onClose={() => setSelectedClient(null)}
          title={`接入客户端详情 · ${selectedClient?.name ?? ""}`}
        >
          {selectedClient ? (
            <Stack gap="var(--sp-4)">
              <div className="gw-diag-box">
                <div className="gw-row">
                  <span className="gw-label">系统名 / 标识</span>
                  <span className="gw-val">
                    <b>{selectedClient.name}</b> ({selectedClient.hostId || "未声明 host"})
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">来源 IP</span>
                  <span className="gw-val">
                    <Code>{selectedClient.callerIp}</Code> ({selectedClient.callerType})
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">访问网关</span>
                  <span className="gw-val">
                    <Badge tone={zoneTone(selectedClient.zone)}>
                      {`${zoneText(selectedClient.zone)} · 端口 ${selectedClient.targetPort}`}
                    </Badge>
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">客户端类型</span>
                  <span className="gw-val">
                    {selectedClient.kind}
                    {selectedClient.version ? ` (v${selectedClient.version})` : ""}
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">调用次数</span>
                  <span className="gw-val num">{selectedClient.calls}</span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">Prompt Token 均值 / 峰值</span>
                  <span className="gw-val">
                    均{" "}
                    <span className="num">
                      {selectedClient.avgTokens ? Math.round(selectedClient.avgTokens) : "—"}
                    </span>{" "}
                    · 峰{" "}
                    <span className="num">
                      {selectedClient.maxTokens ? Math.round(selectedClient.maxTokens) : "—"}
                    </span>
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">最近耗时 / 缓存</span>
                  <span className="gw-val">
                    <span className="num">
                      {selectedClient.lastDurationMs ? dur(selectedClient.lastDurationMs) : "—"}
                    </span>{" "}
                    (缓存命中 <span className="num">{selectedClient.cacheHitRate}%</span>)
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">最近活跃</span>
                  <span className="gw-val">
                    {relTime(selectedClient.lastAt)} ({clock(selectedClient.lastAt)})
                  </span>
                </div>
                <div className="gw-row">
                  <span className="gw-label">封禁状态</span>
                  <span className="gw-val">
                    {selectedClient.hostId && hostBlocks.has(selectedClient.hostId) ? (
                      <Badge tone="bad">接入端已封</Badge>
                    ) : null}
                    {ipBlocks.has(selectedClient.callerIp) ? <Badge tone="bad">IP 已封</Badge> : null}
                    {!(selectedClient.hostId && hostBlocks.has(selectedClient.hostId)) &&
                    !ipBlocks.has(selectedClient.callerIp) ? (
                      <Badge tone="ok">正常</Badge>
                    ) : null}
                  </span>
                </div>
              </div>
              <Row gap="var(--sp-3)" justify="flex-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !selectedClient.hostId}
                  icon={<Ban size={12} aria-hidden />}
                  onClick={() => {
                    const target = {
                      hostId: selectedClient.hostId,
                      ip: selectedClient.callerIp,
                      name: selectedClient.name,
                    };
                    setSelectedClient(null);
                    openBlock("host", target);
                  }}
                >
                  封禁此接入端
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy || !selectedClient.callerIp}
                  icon={<ShieldAlert size={12} aria-hidden />}
                  onClick={() => {
                    const target = {
                      hostId: selectedClient.hostId,
                      ip: selectedClient.callerIp,
                      name: selectedClient.name,
                    };
                    setSelectedClient(null);
                    openBlock("ip", target);
                  }}
                >
                  封禁此 IP
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedClient(null)}>
                  关闭
                </Button>
              </Row>
            </Stack>
          ) : null}
        </Modal>

        {/* 探活自检 */}
        <Modal open={diagOpen} onClose={() => setDiagOpen(false)} title={`联通自检 · ${zoneText(diag.zone)}`}>
          <div className="gw-diag-box">
            <Row gap="var(--sp-4)">
              <span>
                HTTP 状态：<b>{diag.status || (diag.busy ? "请求中…" : "未返回")}</b>
              </span>
              <span>
                往返耗时：<b>{diag.ms ?? 0} ms</b>
              </span>
              {diag.probeTokens !== null ? (
                <span>
                  探针 Prompt：<b>{diag.probeTokens} tokens</b>
                </span>
              ) : null}
              {diag.healthOk !== null ? (
                diag.healthOk ? (
                  <Badge tone="ok">
                    <Check size={12} aria-hidden /> 探活通过
                  </Badge>
                ) : (
                  <Badge tone="bad">
                    <AlertTriangle size={12} aria-hidden /> 异常
                  </Badge>
                )
              ) : null}
            </Row>
            <p className="gw-hint">{diag.msg}</p>
            <Row gap="var(--sp-3)">
              <Button
                variant="solid"
                size="sm"
                disabled={diag.busy}
                icon={<RefreshCw size={12} aria-hidden />}
                onClick={() => void runDiagnostic(diag.zone)}
              >
                重新自检
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDiagOpen(false)}>
                关闭
              </Button>
            </Row>
          </div>
        </Modal>

        {/* 段配置 */}
        <Modal
          open={Boolean(configZone)}
          onClose={() => setConfigZone(null)}
          title={`监听段配置 · ${configZone ? zoneText(configZone) : ""}`}
        >
          <Stack gap="var(--sp-4)">
            <Row gap="var(--sp-3)">
              <TextInput
                label="监听端口"
                value={cfgPort}
                onChange={(e) => setCfgPort(e.target.value)}
                placeholder="例如 7332 或 7333"
              />
              <TextInput
                label="该段 API Key"
                value={cfgApiKey}
                onChange={(e) => setCfgApiKey(e.target.value)}
                placeholder="留空表示不启用鉴权"
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={12} aria-hidden />}
                onClick={() => setCfgApiKey(randomKey(`key_${configZone ?? "zone"}_`))}
              >
                重新生成
              </Button>
            </Row>

            {configZone === "wan" ? (
              <Row gap="var(--sp-3)">
                <TextInput
                  label="反向代理共享密钥（可选；Nginx 注入的代理密钥）"
                  value={cfgProxyKey}
                  onChange={(e) => setCfgProxyKey(e.target.value)}
                  placeholder="留空则不校验代理来源"
                />
                <TextInput
                  label="公网对外地址 / URL（可选）"
                  value={cfgPublicUrl}
                  onChange={(e) => setCfgPublicUrl(e.target.value)}
                  placeholder="https://api.yourdomain.com"
                />
              </Row>
            ) : null}

            <Row gap="var(--sp-3)">
              <TextInput
                label="限流上限（次 / 秒）"
                value={cfgRateLimit}
                onChange={(e) => setCfgRateLimit(e.target.value)}
                placeholder="默认 30"
              />
            </Row>

            <Row gap="var(--sp-3)">
              <Button variant="solid" disabled={busy} onClick={() => void saveConfig(configZone ?? "")}>
                保存并应用
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfigZone(null)}>
                取消
              </Button>
            </Row>
          </Stack>
        </Modal>

        {/* 封禁确认 */}
        <Modal
          open={blockOpen}
          onClose={() => setBlockOpen(false)}
          title={blockScope === "ip" ? "封禁此 IP" : "封禁此接入端"}
        >
          <Stack gap="var(--sp-4)">
            <Segmented
              value={blockScope}
              onChange={setBlockScope}
              label="封禁作用域"
              options={[
                { value: "host", label: "封禁此接入端" },
                { value: "ip", label: "封禁此 IP" },
              ]}
            />
            <p className="gw-hint">{blockScopeHint}</p>

            {blockScope === "host" ? (
              <TextInput
                label="接入端标识（host.id）"
                value={blockHost}
                onChange={(e) => setBlockHost(e.target.value)}
                placeholder="例如 xoox-web-client"
              />
            ) : (
              <TextInput
                label="来源 IP 地址"
                value={blockIp}
                onChange={(e) => setBlockIp(e.target.value)}
                placeholder="例如 192.168.31.163"
              />
            )}

            <TextInput
              label="封禁原因 / 备注"
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              placeholder="例如：共享密钥泄露 / 未授权抓取"
            />

            {blockScope === "host" && blockHostLabel ? (
              <p className="gw-hint">
                目标系统：<b>{blockHostLabel}</b>
              </p>
            ) : null}
            {blockScope === "ip" && isLoopback(blockIp.trim()) ? (
              <p className="gw-warn">
                注意：{blockIp.trim()} 是本机回环地址，封禁后本机上所有接入端都会失效（控制台自身的管控与遥测不受影响）。
              </p>
            ) : null}

            <Row gap="var(--sp-3)" justify="flex-end">
              <Button
                variant="danger"
                disabled={busy}
                icon={<Ban size={12} aria-hidden />}
                onClick={() => void confirmBlock()}
              >
                {blockScope === "ip" ? "确认封禁该 IP" : "确认封禁该接入端"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setBlockOpen(false)}>
                取消
              </Button>
            </Row>
          </Stack>
        </Modal>
      </div>
    </PageFlush>
  );
}

/** 该段是否默认只能从本机回环访问（local 段）。 */
function isLoopbackHost(zone: string): boolean {
  return zone === "local";
}