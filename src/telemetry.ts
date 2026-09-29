/**
 * CogniStack telemetry — who is plugged in, and what every turn actually did.
 *
 * Why this lives in the core
 * --------------------------
 * `prepare()` already computes everything a dashboard needs (budget, stage
 * timings, counter stats, warnings, cache hits). None of it escaped the return
 * value, so answering "which systems are driving this engine, and is the prompt
 * fitting?" meant instrumenting every call site by hand. Telemetry is the
 * missing seam: one optional object, zero cost when nobody is listening.
 *
 * Design constraints
 * ------------------
 * - Zero runtime dependencies and no timers/handles of its own: if no
 *   telemetry is configured, `prepare()` does exactly one extra cheap check.
 * - Bounded memory: turns live in a ring buffer, host stats are aggregates.
 * - Structural, not stringly-typed: the visualization renders straight from
 *   `snapshot()`, no log parsing.
 */
import type { MemoryStatus } from "./types";
import type { CounterStats } from "./fusion/counter";
import type { PrepareMode, ResolvedBudget } from "./fusion/budget";
import { COGNISTACK_VERSION } from "./version";

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** A system that drives the engine. */
export type HostIdentity = {
  /** Stable id — same process restart should reuse it ("xoox-api"). */
  id: string;
  /** Human label for the dashboard. */
  name: string;
  /** Free-form bucket; preset kinds get an icon in the UI. */
  kind?: "service" | "client" | "worker" | "cli" | "test" | string | undefined;
  version?: string | undefined;
  /** Extra context (pid, route, tenant…). Shown as-is. */
  meta?: Record<string, string | number | boolean> | undefined;
  /** Ports this system provides to the engine through the connection protocol. */
  provides?: string[] | undefined;
  /** Ports this system declared it needs (informational). */
  requires?: string[] | undefined;
};

export const UNKNOWN_HOST: HostIdentity = {
  id: "_anonymous",
  name: "未登记调用方",
  kind: "unknown",
};

function finiteNonNeg(n: unknown, fallback = 0): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return v;
}

function sanitizeTurnMeta(
  raw: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 32) break;
    const key = String(k).slice(0, 64);
    if (typeof v === "string") {
      out[key] = v.slice(0, 512);
      n += 1;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
      n += 1;
    } else if (typeof v === "boolean") {
      out[key] = v;
      n += 1;
    }
  }
  return out;
}

function sanitizeCounterId(raw: unknown): string {
  if (typeof raw !== "string") return "unnamed";
  const t = raw.trim();
  return t ? t.slice(0, 96) : "unnamed";
}

/** Two decimals — enough for a quantile, short enough to read in a scrape. */
function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Escape a Prometheus label value (backslash, quote, newline). */
function labelEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** `_bucket` / `_sum` / `_count` triple in Prometheus convention. */
function histogramLines(name: string, help: string, h: Histogram): string[] {
  const out = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
  for (const { bound, cumulative } of h.series()) {
    out.push(`${name}_bucket{le="${bound === null ? "+Inf" : String(bound)}"} ${cumulative}`);
  }
  out.push(`${name}_sum ${h.total}`, `${name}_count ${h.count}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */
export type TurnMemoryDigest = {
  shouldSummarize: boolean;
  compressReason: MemoryStatus["compressReason"] | null;
  pendingPairs: number;
  contextUsed: number;
  contextTriggerAt: number;
  watermarkEnd: number;
  summarizedCount: number;
};

/**
 * Prefix reuse digest. Duck-typed on purpose: `fusion/prefixStability` produces a
 * superset (`comparable`), so hosts and engine can pass theirs straight through
 * without telemetry depending on that module.
 */
export type TurnPrefixDigest = {
  /** Tokens at the front identical to the previous prompt. */
  prefixTokens: number;
  /** Tokens of the previous prompt (reuse denominator). */
  previousTokens: number;
  /** Tokens that had to be prefilled fresh. */
  freshTokens: number;
  /** prefixTokens / previousTokens. */
  reuseRatio: number;
  /** Index of the first changed message; -1 = pure append. */
  firstDivergenceIndex: number;
  /** A change before the end of the previous prompt (invalidates a reusable tail). */
  midPromptDrift: boolean;
};

export type TurnRecord = {
  /** Monotonic per-telemetry sequence. */
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  hostId: string;
  /** Snapshot of host display name at record time. */
  hostName?: string | undefined;
  hostKind?: string | undefined;
  hostVersion?: string | undefined;

  mode: PrepareMode;
  /** Host-supplied operation label (e.g. "发送消息"). */
  label?: string | undefined;
  /** Per-turn + host meta (chatId, route, action…). */
  meta?: Record<string, string | number | boolean> | undefined;
  /** Assemble-cache partition (usually chatId). */
  cacheScope?: string | undefined;

  /* prompt shape */
  messages: number;
  systemSections: number;
  promptTokens: number;
  promptChars: number;
  loreCount: number;
  vectorHits: number;
  /** Lore entry ids/names injected this turn (capped). */
  loreInjected?: { id: string; name: string }[] | undefined;

  /* budget */
  softTrimCap: number;
  hardFit?: number | undefined;
  contextLimit: number;
  completionReserve: number;
  softTrimEnabled: boolean;
  /** promptTokens / softTrimCap, 0 when soft trim is off. */
  fill: number;

  /* memory */
  memory: TurnMemoryDigest;
  toSummarizePairCount: number;

  /* health */
  warnings: string[];
  degraded: boolean;
  cacheHit: boolean;
  emergencyDropped: number;
  softTrimmed: boolean;
  /** Pipeline step markers from prepare (e.g. assemble, pressure.dropLore). */
  steps?: string[] | undefined;

  /* cost */
  durationMs: number;
  timings: Record<string, number>;
  counter: CounterStats;
  /** Identity of the TokenCounter that produced these numbers (see types.ts). */
  counterId?: string | undefined;
  /**
   * Prefix reuse vs. the previous turn in the same scope. Distinct from
   * `cacheHit`, which only reports assembly-cache reuse.
   */
  prefix?: TurnPrefixDigest | undefined;
  /**
   * Per-priority-tier token attribution for the system block. Lets the console
   * show *which* tier filled the budget and which one paid for the trim, instead
   * of a single fill percentage.
   */
  budgetTiers?: { priority: number; before: number; after: number }[] | undefined;

  /** Ports actually wired on the engine that served this turn. */
  ports: string[];
  /**
   * True for records imported from a durable log rather than observed live.
   * Replayed history must stay distinguishable — blending it into live data is
   * how a dashboard starts lying about "now".
   */
  replayed?: true;

  /**
   * 原始输入快照（G-14 前置能力）。**仅当 telemetry 构造时传了
   * `captureInputs: true` 才有值；默认关闭。**
   *
   * 价值：TurnRecord 平时只有计数与摘要，没有原始输入，所以「把一次生产回合变成
   * eval 用例」实际上做不到——重放需要知道当时喂了什么。打开开关后，宿主在
   * `record({ … inputSnapshot })` 里带上输入，这一轮才可被重放。
   *
   * 隐私：它包含用户正文（对话、人设等），属于个人数据。因此默认 false；只有
   * 明确需要做回放的部署才应打开，并自行评估留存合规与访问控制。
   *
   * 注意：回放导入（`importTurns`）**不**受 captureInputs 影响——它只是把已经
   * 存在的记录放回环形缓冲，是否携带快照由记录本身决定。
   */
  inputSnapshot?: unknown;
  /**
   * 快照因超过 64KB 上限或不可序列化而被丢弃。见 {@link TurnRecord.inputSnapshot}。
   */
  inputSnapshotDropped?: boolean | undefined;
};

export type HostStat = HostIdentity & {
  firstSeen: number;
  lastSeen: number;
  calls: number;
  /** Rolling average of promptTokens. */
  avgPromptTokens: number;
  maxPromptTokens: number;
  degradedCalls: number;
  cacheHits: number;
  lastMode: PrepareMode;
  lastDurationMs: number;
  /** Recent promptTokens, oldest → newest (capped, for sparklines). */
  spark: number[];
  /** Ports this system provides through the connection protocol. */
  provides: string[];
  /** Ports this system declared it needs (informational). */
  requires: string[];
};

/** Mid-prepare stage signal — emitted before the turn is finalized. */
export type PipelineProgress = {
  runId: string;
  hostId: string;
  hostName?: string | undefined;
  mode: PrepareMode | string;
  /** Stage key, or `_run` for whole prepare begin/end. */
  stage: string;
  phase: "start" | "end";
  ms?: number | undefined;
  at: number;
};

export type TelemetrySnapshot = {
  engine: "CogniStackEngine";
  version: string;
  /** Epoch ms when this snapshot was taken. */
  now: number;
  startedAt: number;
  uptimeMs: number;
  totalTurns: number;
  /** Turns per second over the last 10s window. */
  tps: number;
  hosts: HostStat[];
  /** Newest first. */
  turns: TurnRecord[];
  /** Ports wired on the engines that ever reported here. */
  ports: string[];
  /**
   * Latest mid-prepare progress (or null). Hitchhiked so SSE reconnects /
   * snapshot polls can resume a live run without waiting for the next stage.
   */
  progress?: PipelineProgress | null;
};

/** Aggregated counters for Prometheus / scrape endpoints. */
export type TelemetryMetrics = {
  turns_total: number;
  turns_degraded_total: number;
  turns_cache_hit_total: number;
  turns_should_summarize_total: number;
  prompt_tokens_sum: number;
  prompt_tokens_max: number;
  duration_ms_sum: number;
  duration_ms_max: number;
  emergency_dropped_sum: number;
  soft_trimmed_total: number;
  hosts: number;
  tps_10s: number;
  uptime_ms: number;
  /* Tail latencies — the numbers a mean hides. */
  duration_ms_p50: number;
  duration_ms_p95: number;
  duration_ms_p99: number;
  prompt_tokens_p50: number;
  prompt_tokens_p95: number;
  fill_p95: number;
  /** Warning counts keyed by {@link warningClass}. */
  warnings_by_class: Record<string, number>;
  /** Turns per TokenCounter identity — surfaces a test double in production. */
  counter_ids: Record<string, number>;
  /* Prefix reuse (local runtimes' KV cache is driven by this, not by cacheHit). */
  prefix_comparable_turns: number;
  prefix_reuse_ratio_mean: number;
  prefix_fresh_tokens_sum: number;
  prefix_mid_drift_total: number;
};

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

export type TurnListener = (turn: TurnRecord, snap: TelemetrySnapshot) => void;

/**
 * 只收 turn 的轻量订阅者（见 `subscribeTurn`）。不接收 snapshot，
 * 因此每轮 turn 都不需要为了它去构建一份全量快照。
 */
export type TurnListenerLite = (turn: TurnRecord) => void;

export type ProgressListener = (ev: PipelineProgress) => void;

const DEFAULT_RING = 200;
const DEFAULT_MAX_HOSTS = 256;
/**
 * Upper bound for the string-keyed aggregate maps (`warningsByClass`, `counterIds`).
 *
 * Both are keyed by host-supplied strings, and `/api/turn` is unauthenticated by
 * default — one client sending a fresh warning class or counter id per turn would
 * otherwise grow them without limit, and inflate `/api/metrics` linearly.
 */
const MAX_AGGREGATE_KEYS = 512;

/** Increment `key` in an insertion-ordered count map, evicting the oldest past `limit`. */
function bump(map: Map<string, number>, key: string, limit = MAX_AGGREGATE_KEYS): void {
  map.set(key, (map.get(key) ?? 0) + 1);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
/**
 * 输入快照的硬上限（序列化后的 UTF-8 字节）。超过就丢弃并标记
 * `inputSnapshotDropped`，绝不把一条超大快照塞进环形缓冲——否则「内存有界」这条
 * 设计约束会被一个不经意的 `inputSnapshot` 打破。
 */
const MAX_INPUT_SNAPSHOT_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ */
/* Histograms (zero-dep)                                               */
/* ------------------------------------------------------------------ */

/** Duration buckets in ms: 1ms … 5s. Local prepare is ~10ms; HTTP hosts see more. */
export const DURATION_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
/** Prompt token buckets: 512 … 64k, covering 2k–32k n_ctx hosts. */
export const TOKEN_BUCKETS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
/** Soft-trim fill buckets. 1.0 = exactly at the cap. */
export const FILL_BUCKETS = [0.5, 0.7, 0.85, 0.95, 1, 1.25];

/**
 * Fixed-bucket histogram with Prometheus-style quantile estimation.
 *
 * Why not just min/max/mean: a pipeline with p95 = 120ms can have a mean of 8ms,
 * and "avg" is the column people read. Anything decided about the hot path has to
 * come from the tail, otherwise the one slow turn in twenty is invisible.
 */
export class Histogram {
  readonly bounds: readonly number[];
  private readonly counts: number[];
  private sum = 0;
  private n = 0;
  /**
   * Exact extremes. Bucket interpolation alone can produce values that are
   * *outside* the observed range — with every sample at 5ms, coarse buckets
   * report a median of 3.5ms. Prometheus accepts that (it has no choice, the
   * buckets are all it keeps); an in-process histogram can trivially track the
   * extremes, and clamping into them is never less accurate.
   */
  private lo = Infinity;
  private hi = 0;

  constructor(bounds: readonly number[]) {
    this.bounds = [...bounds].sort((a, z) => a - z);
    this.counts = new Array<number>(this.bounds.length + 1).fill(0);
  }

  observe(value: number): void {
    const v = Number.isFinite(value) && value > 0 ? value : 0;
    let i = 0;
    while (i < this.bounds.length && v > this.bounds[i]!) i += 1;
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.sum += v;
    this.n += 1;
    if (v < this.lo) this.lo = v;
    if (v > this.hi) this.hi = v;
  }

  get count(): number {
    return this.n;
  }

  get total(): number {
    return this.sum;
  }

  /** Smallest observed value (0 when empty). */
  min(): number {
    return this.n > 0 ? this.lo : 0;
  }

  /** Largest observed value (0 when empty). */
  max(): number {
    return this.n > 0 ? this.hi : 0;
  }

  mean(): number {
    return this.n > 0 ? this.sum / this.n : 0;
  }

  /**
   * Prometheus-style quantile: linear interpolation inside the bucket holding
   * the rank, then clamped into the exact observed `[min, max]`.
   *
   * The clamp matters for trust: a p50 that reports 3.5ms when every single
   * sample was 5ms is the kind of number that makes people stop believing the
   * dashboard. Values in the +Inf bucket report the last finite bound.
   */
  quantile(q: number): number {
    if (this.n === 0) return 0;
    const raw = this.rawQuantile(q);
    return Math.min(this.hi, Math.max(this.lo, raw));
  }

  private rawQuantile(q: number): number {
    const rank = Math.min(1, Math.max(0, q)) * this.n;
    let prevCum = 0;
    let prevBound = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      const cum = prevCum + (this.counts[i] ?? 0);
      const isInf = i >= this.bounds.length;
      const bound = isInf ? (this.bounds[this.bounds.length - 1] ?? 0) : this.bounds[i]!;
      if (cum >= rank) {
        if (cum === prevCum) return bound;
        const frac = (rank - prevCum) / (cum - prevCum);
        return prevBound + (bound - prevBound) * frac;
      }
      prevCum = cum;
      prevBound = bound;
    }
    return this.bounds[this.bounds.length - 1] ?? 0;
  }

  reset(): void {
    this.counts.fill(0);
    this.sum = 0;
    this.n = 0;
    this.lo = Infinity;
    this.hi = 0;
  }

  /** `[bound | null for +Inf, cumulative]` — for Prometheus text and charts. */
  series(): { bound: number | null; cumulative: number }[] {
    const out: { bound: number | null; cumulative: number }[] = [];
    let cum = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      cum += this.counts[i] ?? 0;
      out.push({ bound: i < this.bounds.length ? this.bounds[i]! : null, cumulative: cum });
    }
    return out;
  }
}

/**
 * Stable class for a warning string, for counters and grouping.
 *
 * `degraded:assemble-failed:boom` → `assemble-failed`. Without this, every
 * distinct detail message becomes its own bucket and the counter is useless.
 */
export function warningClass(warning: string): string {
  const w = String(warning ?? "").trim().replace(/^degraded:/i, "");
  const at = w.indexOf(":");
  const cls = (at >= 0 ? w.slice(0, at) : w).trim();
  return cls.slice(0, 64) || "unknown";
}

/**
 * `record()` 的输入契约。
 *
 * 抽成具名类型（此前是内联对象）是为了让**运行时键清单**能锚在它上面：
 * 跨进程宿主把回合上报给网关（`POST /api/turn`），网关按字段逐项映射
 * （`tools/lib/turn-map.cjs`）。两边一旦不对齐，字段会被**静默丢弃** ——
 * 实测损失过 `counterId` / `prefixStability` / `budgetTiers`。
 */
export type TelemetryRecordInput = {
  host: HostIdentity;
  mode: PrepareMode;
  label?: string | undefined;
  meta?: Record<string, string | number | boolean> | undefined;
  cacheScope?: string | undefined;
  messages: number;
  systemSections: number;
  promptTokens: number;
  promptChars: number;
  loreCount: number;
  vectorHits: number;
  loreInjected?: { id: string; name: string }[] | undefined;
  budget: ResolvedBudget;
  memory: TurnMemoryDigest;
  toSummarizePairCount: number;
  warnings: string[];
  degraded: boolean;
  cacheHit: boolean;
  emergencyDropped: number;
  softTrimmed: boolean;
  steps?: string[] | undefined;
  durationMs: number;
  timings: Record<string, number>;
  counter: CounterStats;
  /** Identity of the injected TokenCounter (see types.ts). */
  counterId?: string | undefined;
  /** Prefix reuse vs. the previous turn in the same scope. */
  prefixStability?: TurnPrefixDigest | undefined;
  /** Per-priority-tier system token attribution. */
  budgetTiers?: { priority: number; before: number; after: number }[] | undefined;
  ports: string[];
  /**
   * 本轮原始输入。仅当构造 telemetry 时 `captureInputs: true` 才会被存下
   * （超过 64KB 或不可序列化会被丢弃）。未开启时该字段被完全忽略，
   * record() 的行为与引入前一致。
   */
  inputSnapshot?: unknown;
};

/**
 * {@link TelemetryRecordInput} 的运行时键清单 —— 跨进程映射器的对齐基准。
 *
 * `satisfies` 保证清单里的每一项都是合法键（拼错/拼错的旧名会当场编译失败）；
 * 「有没有漏」由 `test/turn-map.test.cjs` 与映射器读者表求差集来守
 * （差集非空即失败）。
 */
export const TELEMETRY_RECORD_INPUT_KEYS = [
  "host",
  "mode",
  "label",
  "meta",
  "cacheScope",
  "messages",
  "systemSections",
  "promptTokens",
  "promptChars",
  "loreCount",
  "vectorHits",
  "loreInjected",
  "budget",
  "memory",
  "toSummarizePairCount",
  "warnings",
  "degraded",
  "cacheHit",
  "emergencyDropped",
  "softTrimmed",
  "steps",
  "durationMs",
  "timings",
  "counter",
  "counterId",
  "prefixStability",
  "budgetTiers",
  "ports",
  "inputSnapshot",
] as const satisfies readonly (keyof TelemetryRecordInput)[];

export class CogniStackTelemetry {
  readonly startedAt = Date.now();

  private readonly ring: TurnRecord[] = [];
  private readonly ringSize: number;
  private readonly maxHosts: number;
  /**
   * 是否把每轮的原始输入存进 TurnRecord（见 {@link TurnRecord.inputSnapshot}）。
   * 默认 false：默认路径上不序列化、不存储，行为与引入该开关前完全一致。
   */
  private readonly captureInputs: boolean;
  private readonly hosts = new Map<string, HostStat>();
  private readonly listeners = new Set<TurnListener>();
  private readonly turnOnlyListeners = new Set<TurnListenerLite>();
  private readonly progressListeners = new Set<ProgressListener>();
  private readonly ports = new Set<string>();
  private seq = 0;
  /** Latest in-flight prepare progress (for snapshot hitchhikers). */
  private lastProgress: PipelineProgress | null = null;
  /**
   * Turn timestamps kept separately from the ring.
   *
   * The ring EVICTS old entries, so counting "turns newer than now-10s" off the
   * ring silently under-reports once traffic outpaces `ringSize` — a busy board
   * would show a *falling* tps the busier it got. This array is pruned to the
   * window on every snapshot instead.
   */
  private turnTimes: number[] = [];
  /** Lifetime counters for /metrics (survive ring eviction). */
  private degradedTotal = 0;
  private cacheHitTotal = 0;
  private shouldSummarizeTotal = 0;
  private promptTokensSum = 0;
  private promptTokensMax = 0;
  private durationMsSum = 0;
  private durationMsMax = 0;
  private emergencyDroppedSum = 0;
  private softTrimmedTotal = 0;
  /** Tail / size histograms — see {@link Histogram}. */
  private readonly durationHist = new Histogram(DURATION_BUCKETS_MS);
  private readonly promptTokensHist = new Histogram(TOKEN_BUCKETS);
  private readonly fillHist = new Histogram(FILL_BUCKETS);
  /** warning class → count, so a noisy detail message cannot spam the metric. */
  private readonly warningsByClass = new Map<string, number>();
  /** TokenCounter identity → turns. A test double in production shows up here. */
  private readonly counterIds = new Map<string, number>();
  private prefixComparableTurns = 0;
  private prefixReuseRatioSum = 0;
  private prefixFreshTokensSum = 0;
  private prefixMidDriftTotal = 0;

  constructor(opts?: { ringSize?: number; maxHosts?: number; captureInputs?: boolean }) {
    this.ringSize = Math.max(1, Math.floor(opts?.ringSize ?? DEFAULT_RING));
    this.maxHosts = Math.max(8, Math.floor(opts?.maxHosts ?? DEFAULT_MAX_HOSTS));
    this.captureInputs = opts?.captureInputs === true;
  }

  /**
   * Whether the engine should attach an input snapshot to each turn.
   *
   * Exposed so `CogniStackEngine` can skip building the snapshot entirely when it
   * is off — the point of the default is that it costs nothing.
   */
  get captureInputsEnabled(): boolean {
    return this.captureInputs;
  }

  /** Register (or refresh) an identity. Idempotent. Evicts least-recently-seen when over cap. */
  registerHost(host: HostIdentity): HostStat {    const now = Date.now();
    const existing = this.hosts.get(host.id);
    if (existing) {
      // Refresh the display fields; keep the counters.
      existing.name = host.name;
      existing.kind = host.kind ?? existing.kind;
      existing.version = host.version ?? existing.version;
      existing.meta = host.meta ?? existing.meta;
      existing.provides = host.provides ?? existing.provides ?? [];
      existing.requires = host.requires ?? existing.requires ?? [];
      return existing;
    }
    while (this.hosts.size >= this.maxHosts) {
      let oldestId: string | null = null;
      let oldestSeen = Infinity;
      for (const [id, st] of this.hosts) {
        if (st.lastSeen < oldestSeen) {
          oldestSeen = st.lastSeen;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.hosts.delete(oldestId);
    }
    const stat: HostStat = {
      ...host,
      kind: host.kind ?? "unknown",
      // Normalized so the field is always a real boolean over the wire.
      firstSeen: now,
      lastSeen: now,
      calls: 0,
      avgPromptTokens: 0,
      maxPromptTokens: 0,
      degradedCalls: 0,
      cacheHits: 0,
      lastMode: "generate",
      lastDurationMs: 0,
      spark: [],
      provides: host.provides ?? [],
      requires: host.requires ?? [],
    };
    this.hosts.set(host.id, stat);
    return stat;
  }

  markHostSeen(host: HostIdentity): HostStat {
    const stat = this.registerHost(host);
    stat.lastSeen = Date.now();
    return stat;
  }

  /** Called by `CogniStackEngine.prepare()` right before it returns. */
  record(input: TelemetryRecordInput): TurnRecord {
    this.seq += 1;
    const at = Date.now();
    const cap = input.budget.softTrimTokenCap;
    const promptTokens = finiteNonNeg(input.promptTokens);
    const promptChars = finiteNonNeg(input.promptChars);
    const durationMs = finiteNonNeg(input.durationMs);
    const emergencyDropped = finiteNonNeg(input.emergencyDropped);
    const messages = finiteNonNeg(input.messages);
    const systemSections = finiteNonNeg(input.systemSections);
    const loreCount = finiteNonNeg(input.loreCount);
    const vectorHits = finiteNonNeg(input.vectorHits);
    const toSummarizePairCount = finiteNonNeg(input.toSummarizePairCount);

    const meta = sanitizeTurnMeta({
      ...(input.host.meta ?? {}),
      ...(input.meta ?? {}),
    });    const label =
      (typeof input.label === "string" && input.label.trim()
        ? input.label.trim().slice(0, 128)
        : "") ||
      (typeof meta.action === "string" ? String(meta.action).slice(0, 128) : "") ||
      (typeof meta.operation === "string" ? String(meta.operation).slice(0, 128) : "") ||
      undefined;

    // 输入快照：只在显式开启时评估，默认路径上零成本。序列化失败或超限都只标记
    // 丢弃，绝不让一条脏数据弄坏这一轮调用。
    let inputSnapshot: unknown;
    let inputSnapshotDropped: true | undefined;
    if (this.captureInputs && input.inputSnapshot !== undefined) {
      try {
        const serialized = JSON.stringify(input.inputSnapshot);
        const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
        if (bytes <= MAX_INPUT_SNAPSHOT_BYTES) inputSnapshot = input.inputSnapshot;
        else inputSnapshotDropped = true;
      } catch {
        // 循环引用 / BigInt 等不可序列化 → 丢弃。
        inputSnapshotDropped = true;
      }
    }

    const turn: TurnRecord = {
      seq: this.seq,
      at,
      hostId: input.host.id,
      hostName: input.host.name,
      hostKind: input.host.kind,
      hostVersion: input.host.version,
      mode: input.mode,
      label,
      meta: Object.keys(meta).length ? meta : undefined,
      cacheScope: input.cacheScope ? String(input.cacheScope).slice(0, 256) : undefined,
      messages,
      systemSections,
      promptTokens,
      promptChars,
      loreCount,
      vectorHits,
      loreInjected: (input.loreInjected ?? []).slice(0, 32).map((e) => ({
        id: String(e.id ?? "").slice(0, 128),
        name: String(e.name ?? "").slice(0, 128),
      })),
      softTrimCap: cap,
      hardFit: input.budget.hardFit,
      contextLimit: input.budget.contextLimit,
      completionReserve: input.budget.completionReserve,
      softTrimEnabled: input.budget.softTrimEnabled,
      fill: cap > 0 ? promptTokens / cap : 0,
      memory: input.memory,
      toSummarizePairCount,
      warnings: input.warnings.slice(),
      degraded: input.degraded,
      cacheHit: input.cacheHit,
      emergencyDropped,
      softTrimmed: input.softTrimmed,
      steps: (input.steps ?? []).slice(0, 64).map((s) => String(s).slice(0, 128)),
      durationMs,
      timings: { ...input.timings },
      counter: { ...input.counter },
      counterId: sanitizeCounterId(input.counterId),
      prefix: input.prefixStability
        ? {
            prefixTokens: finiteNonNeg(input.prefixStability.prefixTokens),
            previousTokens: finiteNonNeg(input.prefixStability.previousTokens),
            freshTokens: finiteNonNeg(input.prefixStability.freshTokens),
            reuseRatio: Number.isFinite(input.prefixStability.reuseRatio)
              ? Math.min(1, Math.max(0, input.prefixStability.reuseRatio))
              : 0,
            firstDivergenceIndex: Number.isFinite(input.prefixStability.firstDivergenceIndex)
              ? input.prefixStability.firstDivergenceIndex
              : -1,
            midPromptDrift: input.prefixStability.midPromptDrift === true,
          }
        : undefined,
      budgetTiers: Array.isArray(input.budgetTiers)
        ? input.budgetTiers.slice(0, 32).map((t) => ({
            priority: finiteNonNeg(t?.priority),
            before: finiteNonNeg(t?.before),
            after: finiteNonNeg(t?.after),
          }))
        : undefined,
      ports: input.ports.slice(),
      // 仅在实际有值时才写入这两个字段：默认关闭时必须让记录对象与引入前逐字节
      // 一致（测试与「导入导出」会比较对象形状）。
      ...(inputSnapshot !== undefined ? { inputSnapshot } : {}),
      ...(inputSnapshotDropped ? { inputSnapshotDropped: true } : {}),
    };

    this.ring.push(turn);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.turnTimes.push(at);
    // Bound turnTimes even when nobody calls snapshot().
    const keepFrom = at - 60_000;
    if (this.turnTimes.length > 2 && this.turnTimes[0]! < keepFrom) {
      this.turnTimes = this.turnTimes.filter((t) => t >= keepFrom);
    }
    for (const p of input.ports) {
      if (typeof p === "string" && p) this.ports.add(p);
    }

    if (input.degraded) this.degradedTotal += 1;
    if (input.cacheHit) this.cacheHitTotal += 1;
    if (input.memory?.shouldSummarize) this.shouldSummarizeTotal += 1;
    this.promptTokensSum += promptTokens;
    this.promptTokensMax = Math.max(this.promptTokensMax, promptTokens);
    this.durationMsSum += durationMs;
    this.durationMsMax = Math.max(this.durationMsMax, durationMs);
    this.emergencyDroppedSum += emergencyDropped;
    if (input.softTrimmed) this.softTrimmedTotal += 1;

    // Observe every turn, including degraded ones — a degraded turn that took
    // 2s is precisely the sample a mean would hide.
    this.durationHist.observe(durationMs);
    this.promptTokensHist.observe(promptTokens);
    if (cap > 0) this.fillHist.observe(promptTokens / cap);
    for (const w of input.warnings) {
      bump(this.warningsByClass, warningClass(w));
    }
    bump(this.counterIds, turn.counterId ?? "unnamed");
    const prefix = turn.prefix;
    if (prefix && prefix.previousTokens > 0) {
      this.prefixComparableTurns += 1;
      this.prefixReuseRatioSum += prefix.reuseRatio;
      this.prefixFreshTokensSum += prefix.freshTokens;
      if (prefix.midPromptDrift) this.prefixMidDriftTotal += 1;
    }

    const stat = this.registerHost(input.host);
    stat.lastSeen = at;
    stat.calls += 1;
    stat.lastMode = input.mode;
    stat.lastDurationMs = durationMs;
    stat.maxPromptTokens = Math.max(stat.maxPromptTokens, promptTokens);
    // Incremental mean — no need to keep every value.
    stat.avgPromptTokens += (promptTokens - stat.avgPromptTokens) / stat.calls;
    if (input.degraded) stat.degradedCalls += 1;
    if (input.cacheHit) stat.cacheHits += 1;
    stat.spark.push(promptTokens);
    if (stat.spark.length > 32) stat.spark.shift();

    if (this.listeners.size || this.turnOnlyListeners.size) {
      // 轻量订阅者先跑：它们不要 snapshot，因此这一轮完全不必构建快照。
      for (const fn of this.turnOnlyListeners) {
        try {
          fn(turn);
        } catch {
          // A broken listener must never break a turn.
        }
      }
      if (this.listeners.size) {
        // snapshot() 内含 hosts 排序 + recent() + turnTimes 剪枝，成本不低；
        // 只有在确实存在需要它的订阅者时才构建（原来只要有订阅者就无条件构建，
        // 而 viz-server 之类只关心自己的节流后快照，这份几乎是白算）。
        const snap = this.snapshot();
        for (const fn of this.listeners) {
          try {
            fn(turn, snap);
          } catch {
            // A broken listener must never break a turn.
          }
        }
      }
    }
    return turn;
  }

  /**
   * Push externally supplied turns into the display ring.
   *
   * Deliberately does NOT touch any counter or histogram: imported history is
   * not this process's traffic. Counting it would inflate turns_total, skew every
   * quantile and make "turns per second" meaningless right after a restart.
   *
   * Every imported record is stamped `replayed: true`, so a viewer can always
   * tell restored history from live data. Blending the two is a trust bug, not a
   * cosmetic one.
   *
   * @returns how many records were accepted.
   */
  importTurns(turns: TurnRecord[] | null | undefined): number {
    if (!Array.isArray(turns) || !turns.length) return 0;
    let accepted = 0;
    for (const t of turns) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.hostId !== "string" || !t.hostId) continue;
      this.ring.push({ ...t, replayed: true });
      if (this.ring.length > this.ringSize) this.ring.shift();
      accepted += 1;
    }
    return accepted;
  }

  /** Subscribe to live turns. Returns an unsubscribe function. */
  subscribe(fn: TurnListener): () => void {    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 只关心 turn、不需要 snapshot 的订阅者用这个（例如把 turn 转发到面板服务）。
   * 与 `subscribe` 的区别：不传 snapshot，因此每轮 turn 不会白构建一份快照。
   * 需要聚合视图的订阅者请继续用 `subscribe`。
   */
  subscribeTurn(fn: TurnListenerLite): () => void {
    this.turnOnlyListeners.add(fn);
    return () => {
      this.turnOnlyListeners.delete(fn);
    };
  }

  /**
   * Mid-pipeline progress (stage start/end). Used by the console flowchart so
   * stages light up before the finished turn arrives — and so slow prepareAsync
   * paths are visible live.
   */
  emitProgress(ev: PipelineProgress): void {
    this.lastProgress = ev;
    if (!this.progressListeners.size) return;
    for (const fn of this.progressListeners) {
      try {
        fn(ev);
      } catch {
        /* never break prepare */
      }
    }
  }

  subscribeProgress(fn: ProgressListener): () => void {
    this.progressListeners.add(fn);
    return () => {
      this.progressListeners.delete(fn);
    };
  }

  latestProgress(): PipelineProgress | null {
    return this.lastProgress;
  }

  /** Newest first. */
  recent(limit = 50): TurnRecord[] {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    return this.ring.slice(-n).reverse();
  }

  listHosts(): HostStat[] {
    return [...this.hosts.values()].sort((a, z) => z.lastSeen - a.lastSeen);
  }

  snapshot(turnLimit = 50): TelemetrySnapshot {
    const now = Date.now();
    const turns = this.recent(turnLimit);

    // Prune to a 60s lookback so the array cannot grow with uptime.
    const keepFrom = now - 60_000;
    if (this.turnTimes.length && this.turnTimes[0]! < keepFrom) {
      this.turnTimes = this.turnTimes.filter((t) => t >= keepFrom);
    }
    const windowStart = now - 10_000;
    let inWindow = 0;
    for (let i = this.turnTimes.length - 1; i >= 0; i -= 1) {
      if (this.turnTimes[i]! < windowStart) break;
      inWindow += 1;
    }
    // Fixed 10s lookback denominator — density in the window, not instantaneous
    // rate. A burst of 60 turns in 50ms still reports 6.0 (locked by regression).

    return {
      engine: "CogniStackEngine",
      version: COGNISTACK_VERSION,
      now,
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      totalTurns: this.seq,
      tps: inWindow / 10,
      hosts: this.listHosts(),
      turns,
      ports: [...this.ports].sort(),
      progress: this.lastProgress,
    };
  }

  /** Lifetime aggregates for scrape / dashboards (independent of ring eviction). */
  metrics(): TelemetryMetrics {
    const snap = this.snapshot(0);
    return {
      turns_total: this.seq,
      turns_degraded_total: this.degradedTotal,
      turns_cache_hit_total: this.cacheHitTotal,
      turns_should_summarize_total: this.shouldSummarizeTotal,
      prompt_tokens_sum: this.promptTokensSum,
      prompt_tokens_max: this.promptTokensMax,
      duration_ms_sum: this.durationMsSum,
      duration_ms_max: this.durationMsMax,
      emergency_dropped_sum: this.emergencyDroppedSum,
      soft_trimmed_total: this.softTrimmedTotal,
      hosts: this.hosts.size,
      tps_10s: snap.tps,
      uptime_ms: snap.uptimeMs,
      duration_ms_p50: round2(this.durationHist.quantile(0.5)),
      duration_ms_p95: round2(this.durationHist.quantile(0.95)),
      duration_ms_p99: round2(this.durationHist.quantile(0.99)),
      prompt_tokens_p50: round2(this.promptTokensHist.quantile(0.5)),
      prompt_tokens_p95: round2(this.promptTokensHist.quantile(0.95)),
      fill_p95: round2(this.fillHist.quantile(0.95)),
      warnings_by_class: Object.fromEntries(this.warningsByClass),
      counter_ids: Object.fromEntries(this.counterIds),
      prefix_comparable_turns: this.prefixComparableTurns,
      prefix_reuse_ratio_mean:
        this.prefixComparableTurns > 0
          ? round2(this.prefixReuseRatioSum / this.prefixComparableTurns)
          : 0,
      prefix_fresh_tokens_sum: this.prefixFreshTokensSum,
      prefix_mid_drift_total: this.prefixMidDriftTotal,
    };
  }

  /** Prometheus exposition format (text/plain; version=0.0.4). */
  toPrometheusText(): string {
    const m = this.metrics();
    const lines = [
      "# HELP cognistack_turns_total Total prepare turns recorded.",
      "# TYPE cognistack_turns_total counter",
      `cognistack_turns_total ${m.turns_total}`,
      "# HELP cognistack_turns_degraded_total Turns marked degraded.",
      "# TYPE cognistack_turns_degraded_total counter",
      `cognistack_turns_degraded_total ${m.turns_degraded_total}`,
      "# HELP cognistack_turns_cache_hit_total Assemble cache hits.",
      "# TYPE cognistack_turns_cache_hit_total counter",
      `cognistack_turns_cache_hit_total ${m.turns_cache_hit_total}`,
      "# HELP cognistack_turns_should_summarize_total Turns that requested summarization.",
      "# TYPE cognistack_turns_should_summarize_total counter",
      `cognistack_turns_should_summarize_total ${m.turns_should_summarize_total}`,
      "# HELP cognistack_prompt_tokens_sum Sum of prompt tokens across turns.",
      "# TYPE cognistack_prompt_tokens_sum counter",
      `cognistack_prompt_tokens_sum ${m.prompt_tokens_sum}`,
      "# HELP cognistack_prompt_tokens_max Peak prompt tokens in a single turn.",
      "# TYPE cognistack_prompt_tokens_max gauge",
      `cognistack_prompt_tokens_max ${m.prompt_tokens_max}`,
      "# HELP cognistack_duration_ms_sum Sum of prepare duration milliseconds.",
      "# TYPE cognistack_duration_ms_sum counter",
      `cognistack_duration_ms_sum ${m.duration_ms_sum}`,
      "# HELP cognistack_duration_ms_max Peak prepare duration milliseconds.",
      "# TYPE cognistack_duration_ms_max gauge",
      `cognistack_duration_ms_max ${m.duration_ms_max}`,
      "# HELP cognistack_emergency_dropped_sum Messages dropped by hard-fit.",
      "# TYPE cognistack_emergency_dropped_sum counter",
      `cognistack_emergency_dropped_sum ${m.emergency_dropped_sum}`,
      "# HELP cognistack_soft_trimmed_total Turns that soft-trimmed the system prompt.",
      "# TYPE cognistack_soft_trimmed_total counter",
      `cognistack_soft_trimmed_total ${m.soft_trimmed_total}`,
      "# HELP cognistack_hosts Registered host identities.",
      "# TYPE cognistack_hosts gauge",
      `cognistack_hosts ${m.hosts}`,
      "# HELP cognistack_tps_10s Turns per second over the last 10s window.",
      "# TYPE cognistack_tps_10s gauge",
      `cognistack_tps_10s ${m.tps_10s}`,
      "# HELP cognistack_uptime_ms Process telemetry uptime.",
      "# TYPE cognistack_uptime_ms gauge",
      `cognistack_uptime_ms ${m.uptime_ms}`,
    ];

    // Quantiles as explicit gauges: easier to graph than _bucket math, and the
    // whole point of adding them is that the mean is not enough.
    lines.push(
      "# HELP cognistack_duration_ms_quantile Prepare duration quantile (ms).",
      "# TYPE cognistack_duration_ms_quantile gauge",
      `cognistack_duration_ms_quantile{quantile="0.5"} ${m.duration_ms_p50}`,
      `cognistack_duration_ms_quantile{quantile="0.95"} ${m.duration_ms_p95}`,
      `cognistack_duration_ms_quantile{quantile="0.99"} ${m.duration_ms_p99}`,
      "# HELP cognistack_prompt_tokens_quantile Prompt tokens quantile.",
      "# TYPE cognistack_prompt_tokens_quantile gauge",
      `cognistack_prompt_tokens_quantile{quantile="0.5"} ${m.prompt_tokens_p50}`,
      `cognistack_prompt_tokens_quantile{quantile="0.95"} ${m.prompt_tokens_p95}`,
      "# HELP cognistack_soft_trim_fill_quantile promptTokens/softTrimCap quantile.",
      "# TYPE cognistack_soft_trim_fill_quantile gauge",
      `cognistack_soft_trim_fill_quantile{quantile="0.95"} ${m.fill_p95}`,
    );

    // Histograms, in Prometheus convention (cumulative _bucket + _sum + _count).
    lines.push(...histogramLines("cognistack_duration_ms", "Prepare duration.", this.durationHist));
    lines.push(
      ...histogramLines("cognistack_prompt_tokens", "Prompt tokens per turn.", this.promptTokensHist),
    );
    lines.push(...histogramLines("cognistack_soft_trim_fill", "Soft-trim fill ratio.", this.fillHist));

    // Warning classes: without the class split, "degraded went up" is unactionable.
    if (Object.keys(m.warnings_by_class).length) {
      lines.push(
        "# HELP cognistack_warnings_total Prepare warnings by class.",
        "# TYPE cognistack_warnings_total counter",
      );
      for (const [cls, n] of Object.entries(m.warnings_by_class)) {
        lines.push(`cognistack_warnings_total{class="${labelEscape(cls)}"} ${n}`);
      }
    }

    // TokenCounter identity per turn — the fastest way to spot a test double.
    lines.push(
      "# HELP cognistack_turns_by_counter_id Turns per TokenCounter identity.",
      "# TYPE cognistack_turns_by_counter_id counter",
    );
    for (const [id, n] of Object.entries(m.counter_ids)) {
      lines.push(`cognistack_turns_by_counter_id{id="${labelEscape(id)}"} ${n}`);
    }

    lines.push(
      "# HELP cognistack_prefix_reuse_ratio_mean Mean prefix reuse vs. previous turn.",
      "# TYPE cognistack_prefix_reuse_ratio_mean gauge",
      `cognistack_prefix_reuse_ratio_mean ${m.prefix_reuse_ratio_mean}`,
      "# HELP cognistack_prefix_mid_drift_total Turns where the prompt changed mid-way.",
      "# TYPE cognistack_prefix_mid_drift_total counter",
      `cognistack_prefix_mid_drift_total ${m.prefix_mid_drift_total}`,
      "# HELP cognistack_prefix_fresh_tokens_sum Tokens that had to be prefilled fresh.",
      "# TYPE cognistack_prefix_fresh_tokens_sum counter",
      `cognistack_prefix_fresh_tokens_sum ${m.prefix_fresh_tokens_sum}`,
      "",
    );
    return lines.join("\n");
  }

  reset(): void {
    this.ring.length = 0;
    this.hosts.clear();
    // Keep subscribers — viz server registers once at boot; wiping listeners
    // made live SSE turn-push silently die after "清空".
    this.ports.clear();
    this.turnTimes = [];
    this.seq = 0;
    this.lastProgress = null;
    this.degradedTotal = 0;
    this.cacheHitTotal = 0;
    this.shouldSummarizeTotal = 0;
    this.promptTokensSum = 0;
    this.promptTokensMax = 0;
    this.durationMsSum = 0;
    this.durationMsMax = 0;
    this.emergencyDroppedSum = 0;
    this.softTrimmedTotal = 0;
    this.durationHist.reset();
    this.promptTokensHist.reset();
    this.fillHist.reset();
    this.warningsByClass.clear();
    this.counterIds.clear();
    this.prefixComparableTurns = 0;
    this.prefixReuseRatioSum = 0;
    this.prefixFreshTokensSum = 0;
    this.prefixMidDriftTotal = 0;
  }
}

let globalTelemetry: CogniStackTelemetry | null = null;

/**
 * Process-wide telemetry.
 *
 * Multiple engine instances (one per chat scope, per tenant…) share it, so the
 * dashboard answers "what is plugged into CogniStack in this process" instead of
 * "what did this one object do".
 */
export function getGlobalTelemetry(): CogniStackTelemetry {
  if (!globalTelemetry) globalTelemetry = new CogniStackTelemetry();
  return globalTelemetry;
}

export function resetGlobalTelemetry(): void {
  globalTelemetry = null;
}
