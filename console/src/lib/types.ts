export type PrepareMode = "generate" | "status" | string;

export type HostStat = {
  id: string;
  name: string;
  kind?: string;
  version?: string;
  meta?: Record<string, string | number | boolean>;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  avgPromptTokens: number;
  maxPromptTokens: number;
  degradedCalls: number;
  cacheHits: number;
  lastMode: PrepareMode;
  lastDurationMs: number;
  spark: number[];
  provides: string[];
  requires: string[];
};

export type TurnRecord = {
  seq: number;
  at: number;
  hostId: string;
  hostName?: string;
  hostKind?: string;
  hostVersion?: string;
  mode: PrepareMode;
  /** Host-supplied operation label. */
  label?: string;
  /** Per-turn context (chatId, route, action…). */
  meta?: Record<string, string | number | boolean>;
  cacheScope?: string;
  promptTokens: number;
  promptChars?: number;
  softTrimCap?: number;
  hardFit?: number;
  fill?: number;
  contextLimit?: number;
  completionReserve?: number;
  messages: number;
  systemSections: number;
  loreCount?: number;
  vectorHits?: number;
  loreInjected?: { id: string; name: string }[];
  toSummarizePairCount?: number;
  warnings: string[];
  degraded: boolean;
  cacheHit: boolean;
  emergencyDropped: number;
  softTrimmed: boolean;
  /**
   * 软顶是否启用（= `softTrimCap > 0`）。
   *
   * 网关侧是**算出来**的（`tools/viz-server.cjs` 的映射器），而不是透传宿主字段；
   * 类型这边此前漏了它，于是"有没有软顶"只能靠 `softTrimCap` 反推。
   */
  softTrimEnabled?: boolean;
  steps?: string[];
  durationMs: number;
  timings: Record<string, number>;
  counter?: {
    hits?: number;
    misses?: number;
    distinct?: number;
    evictions?: number;
  };
  /** Identity of the TokenCounter that produced the budget numbers. */
  counterId?: string;
  /**
   * Prefix reuse vs. the previous turn in the same scope. Distinct from
   * `cacheHit` (which only reports assembly-cache reuse) — this is what a local
   * runtime's KV cache can actually reuse.
   */
  prefix?: {
    prefixTokens: number;
    previousTokens: number;
    freshTokens: number;
    reuseRatio: number;
    firstDivergenceIndex: number;
    midPromptDrift: boolean;
  };
  /** Per-priority-tier system token attribution: who filled the budget. */
  budgetTiers?: { priority: number; before: number; after: number }[];
  /** True for records imported from a durable log (not live traffic). */
  replayed?: true;
  memory?: {
    summarizedCount?: number;
    pendingPairs?: number;
    compressReason?: string | null;
    contextUsed?: number;
    contextTriggerAt?: number;
    watermarkEnd?: number;
    shouldSummarize?: boolean;
  };
  ports: string[];
};

/**
 * Port competition state for one port, as reported by a host process.
 * `shadowed` is the part `portTable()` cannot express: a provider that connected
 * but is not in effect.
 */
export type PortDiagnostic = {
  port: string;
  bound: boolean;
  /**
   * 真正生效的来源。构造注入 / wire() 优先于 connect()，而注册表只知道 connect——
   * 不看这个字段，面板会把"构造注入的 lore 生效中"显示成"未接入"。
   */
  source?: "connection" | "constructor" | "builtin" | "none" | string;
  winner: {
    providerId: string | null;
    providerName: string | null;
    priority: number | null;
    builtin: boolean;
  };
  shadowed: { providerId: string; providerName: string; priority: number }[];
};

export type PortReport = {
  hostId: string;
  hostName: string;
  at: number;
  ports: PortDiagnostic[];
};

export type PipelineProgress = {
  runId: string;
  hostId: string;
  hostName?: string;
  mode: string;
  stage: string;
  phase: "start" | "end";
  ms?: number;
  at: number;
};

/**
 * 网关自己的读数：被拒请求（见 `tools/viz-server.cjs` 的 `rejectsSnapshot()`）。
 *
 * 为什么单独一块：`turns` / `hosts` 只记录「进了引擎的」，而被拒发生在进引擎之前。
 * 缺了它，「客户端说连上了、面板却是空的」无法区分「它没调」与「它调了但被拒」。
 */
export type GatewayZone = {
  zone: string;
  status?: "running" | "stopped";
  host: string;
  port: number;
  base: string;
  publicBase?: string;
  addresses?: string[];
  baseSource?: string;
  reachable?: "loopback" | "lan" | "proxy";
  auth: "key" | "none";
  apiKey?: string;
  proxyKey?: string;
  rateLimit?: number;
  proxy?: { required: boolean; trustForwardedFor: boolean; header?: string };
  allow?: string[];
  console?: boolean;
};

export type HostZoneRecord = {
  zone: string;
  at: number;
};

export type GatewayRejectEvent = {
  id: string;
  at: number;
  zone: string;
  reason: string;
  detail?: string;
  method?: string;
  path?: string;
  clientIp?: string;
  status?: number;
};

export type GatewayRejects = {
  total: number;
  byReason: Record<string, number>;
  byZone?: Record<string, number>;
  last: {
    at: number;
    zone?: string;
    reason: string;
    detail?: string;
    method?: string;
    path?: string;
  } | null;
  events?: GatewayRejectEvent[];
};

export type GatewayClient = {
  ip: string;
  zone: string;
  firstAt: number;
  lastAt: number;
  calls: number;
  hostId?: string;
};

/**
 * 网关黑名单条目（`tools/viz-server.cjs`）。
 *
 * 两套独立作用域：
 * - `scope: "ip"`   —— 该 IP 发起的**全部**接入端一起失效（字段 `key` 是 IP）
 * - `scope: "host"` —— 只有该 `hostId` 失效，同一 IP 下的其它接入端不受影响
 *
 * 混成一条（旧版只按 IP 存）时，面板就再说不清「封的到底是一个地址还是一个系统」。
 */
export type GatewayBlockedIp = {
  scope?: "ip" | "host";
  /** scope 为 ip 时是地址，为 host 时是 hostId */
  key?: string;
  /** 旧版字段：等价于 scope="ip" 时的 key */
  ip?: string;
  reason: string;
  at: number;
};

export type GatewayBlockedHost = {
  scope?: "ip" | "host";
  key?: string;
  hostId?: string;
  reason: string;
  at: number;
};

export type TelemetrySnapshot = {
  engine: string;
  version: string;
  now: number;
  startedAt: number;
  uptimeMs: number;
  totalTurns: number;
  tps: number;
  hosts: HostStat[];
  turns: TurnRecord[];
  ports: string[];
  /** Hitchhiked mid-prepare progress (resume after reconnect). */
  progress?: PipelineProgress | null;
  /** Latest port report per host process (see POST /api/ports). */
  portDiagnostics?: PortReport[];
  /** 硬件架构与 Cluster 并发集群运行态 */
  system?: {
    cpus: number;
    cpuModel: string;
    isCluster: boolean;
    workerId: number;
    pid: number;
    primaryPid?: number;
    activeWorkers?: { id: number; pid?: number; state?: string }[];
    workersCount?: number;
    nodeVersion: string;
    platform: string;
  };
  /** 被拒请求与多段监听网关状态（网关侧）。 */
  gateway?: {
    rejects: GatewayRejects;
    zones?: GatewayZone[];
    hostZones?: Record<string, HostZoneRecord>;
    clients?: GatewayClient[];
    blockedIps?: Record<string, GatewayBlockedIp>;
    /** 接入端（hostId）级封禁，与 blockedIps 相互独立。 */
    blockedHosts?: Record<string, GatewayBlockedHost>;
  };
};
