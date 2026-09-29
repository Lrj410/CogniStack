/**
 * CogniStackEngine — 上下文引擎 × 记忆引擎 的融合体。
 *
 * -------------------------------------------------------------------------
 * What this replaces
 * -------------------------------------------------------------------------
 * In `@xoox/rp-engine` the two engines were siblings coordinated by a third
 * class, `RPHeadDispatcherD1`, which owned ~450 lines of ordering rules:
 *
 *   Memory(水位/raw) → WorldBook → Context(拼装+触发切片+软顶) → 紧急裁剪
 *
 * The dispatcher also duplicated orchestration for generate / status modes
 * (`generate` / `status`), each with its own copy of the watermark
 * resolution, the token accounting and the block slicing. The copies drifted
 * (e.g. `status` re-derived `summaryTokens + rawTokens` that `generate` had
 * already computed).
 *
 * CogniStack makes the two engines one object with one pipeline:
 *
 *   resolve watermark → slice raw window → resolve blocks → (assemble |
 *   status-only) → token accounting → trigger decision → soft-trim /
 *   emergency fit
 *
 * -------------------------------------------------------------------------
 * Design rules
 * -------------------------------------------------------------------------
 * 1. EACH STRING IS TOKENIZED AT MOST ONCE per prepare() — every count goes
 *    through one memoized counter (see fusion/counter.ts).
 * 2. The budget is a pure function (fusion/budget.ts) — no magic numbers buried
 *    in orchestration.
 * 3. The prompt is never dropped below the last complete UA pair silently; the
 *    emergency fit records exactly what it removed.
 * 4. Hosts supply domain data through ports (ports.ts). Nothing in this file
 *    knows what a character card or a world book *is*.
 */
import { ContextEngine, type SoftTrimProfile, TRIM_NOTE } from "../context/ContextEngine";
import {
  type AssembleSectionOptions,
  type ContextAssembleResult,
  type ContextAssembleEngine,
} from "../context/ContextAssembleEngine";
import { MemoryEngine, defaultCompressPolicy, joinSummaryBlocks, resolveSummaryBlocks } from "../memory/MemoryEngine";
import { compactMemoryBlocks } from "../memory/MemoryBlocksEngine";
import { auditMemory, memoryAuditWarnings, type MemoryAuditReport } from "../memory/memoryAudit";
import type { SummaryEngine } from "../memory/SummaryEngine";
import { VectorMemoryEngine } from "../memory/VectorMemoryEngine";
import type {
  AssembleCollaborators,
  AssembleFragments,
  RegexScriptLike,
} from "../ports";
import type {
  AgentProfileLike,
  CharacterCardLike,
  DialogueMessage,
  LoreEntryLike,
  LoreRuntimeState,
  MacroNames,
  MemoryCompressPolicy,
  MemoryStatus,
  PromptMessage,
  PromptSection,
  RpMessage,
  RpWorldState,
  SummaryBlock,
  TokenCounter,
  WorldBookEntryLike,
  WorldState,
} from "../types";
import {
  type CogniStackTelemetry,
  type HostIdentity,
  UNKNOWN_HOST,
} from "../telemetry";
import {
  type ConnectManifest,
  type PortBinding,
  type PortDiagnostic,
  PortRegistry,
  PORT_NAMES,
} from "../protocol";
import { resolveBudget, type BudgetOptions, type PrepareMode, type ResolvedBudget } from "./budget";
import {
  counterIdentity,
  countMessages,
  memoizeCounter,
  type CounterStats,
  type MemoizedCounter,
} from "./counter";
import {
  defaultCardResolver,
  defaultLoreProvider,
  defaultMacroBinder,
  defaultPresetResolver,
  defaultWorldStateProvider,
  noopRegexApplier,
} from "../defaults";
import { fitMessagesUnderTokenCap } from "./fitMessages";
import { attributeBudget, type BudgetAttribution } from "./budgetAttribution";
import { cacheKey, contentFpCached, stableValueFp } from "./fingerprint";
import { formatGuardWarning, partitionPrepareWarnings, type WarningSeverity } from "./prepareWarnings";
import {
  PrefixTracker,
  type PrefixInput,
  type PrefixStability,
} from "./prefixStability";

export const COGNISTACK_ENGINE_ID = "CogniStackEngine" as const;
import { COGNISTACK_VERSION } from "../version";
export { COGNISTACK_VERSION };

/**
 * Built-in fallback provider labels per port, in one place.
 *
 * `portTable()` and `portDiagnostics()` must agree on who the default is;
 * duplicating this map is how they start disagreeing.
 */
const DEFAULT_PORT_PROVIDER_NAMES = {
  card: "引擎缺省",
  macros: "引擎缺省",
  lore: "未接入",
  state: "引擎缺省",
  preset: "未接入",
  regex: "未接入",
  vector: "引擎内置",
} as const;

/** Hard ceiling on lore entries injected in one turn (budget safety). */
const DEFAULT_MAX_LORE_ENTRIES = 24;
const DEFAULT_MAX_VECTOR_HITS = 6;
const DEFAULT_MAX_VECTOR_HIT_CHARS = 800;
const DEFAULT_ASSEMBLE_CACHE_SIZE = 32;
const DEFAULT_SCAN_MAX_CHARS = 4_000;

export type CogniStackStatus = MemoryStatus & { watermarkEnd: number };

export type CogniStackOptions = {
  /** Domain ports (card / macros / lore / state / regex / vector / preset). */
  collaborators?: AssembleCollaborators;
  /** Inject for tests; defaults to a fresh VectorMemoryEngine. */
  vector?: VectorMemoryEngine;
  /** Summary authoring engine (defaults to a fresh MemoryEngine). */
  memory?: MemoryEngine;
  /** Assemble-result LRU size, per cache scope. Default 32. */
  assembleCacheSize?: number;
  /** Max lore entries injected per turn. Default 24. */
  maxLoreEntries?: number;
  /** Max vector hits injected. Default 6. */
  maxVectorHits?: number;
  /** Max chars per vector hit. Default 800. */
  maxVectorHitChars?: number;
  /** Baseline rules block; forwarded to the assembler. */
  systemRules?: string;
  /**
   * Where every turn is reported. Omit for zero overhead; pass
   * `getGlobalTelemetry()` to feed the live visualization.
   */
  /**
   * Audit the memory document before/after this turn's rewrite and emit
   * `memory-*` notices when protected columns (【硬事实】/【未决】) lose content.
   *
   * Off by default: it is an extra normalization pass per turn, and hosts that
   * never commit memory have nothing to audit. Turn it on where memory actually
   * evolves, and watch the dashboard for `memory-lost-protected`.
   */
  auditMemory?: boolean;
  telemetry?: CogniStackTelemetry;
  /** Identity of the system owning this engine instance. */
  host?: HostIdentity;
};

/**
 * Everything except the identity field.
 *
 * `profile` / `card` are pulled out below so the type can state what the runtime
 * guard has always enforced: **at least one of them must be present**. They used
 * to be two independent optionals, so TypeScript accepted an input that
 * `prepare()` then rejected with "profile (or legacy card) required" — the exact
 * "compiles, then throws" drift the A-7 note recorded.
 */
type PrepareInputFields = {
  /** `generate` (default) = full assemble + soft trim; `status` = trigger only. */
  mode?: PrepareMode | undefined;

  /** Full dialogue (user+assistant), oldest → newest. */
  dialogue: DialogueMessage[];

  /** Denormalized joined summary (compat / preview). */
  summary?: string | null | undefined;
  /** Preferred: committed blocks (oldest → newest). */
  summaryBlocks?: SummaryBlock[] | null | undefined;
  /** Messages covered by committed blocks (compat integer watermark). */
  summarizedCount?: number | undefined;
  /** Message id watermark; wins over summarizedCount when resolvable. */
  summarizedThroughMessageId?: string | null | undefined;

  /** ② 对话回合数压缩：完整 UA 回合数 N. */
  pairBatchSize?: number | undefined;
  /** 压缩策略覆写。 */
  memory?: Partial<MemoryCompressPolicy> | undefined;

  /** Preferred: knowledge / policy / FAQ snippets */
  loreEntries?: Array<LoreEntryLike | WorldBookEntryLike> | undefined;
  /** @deprecated Use `loreEntries` */
  worldEntries?: Array<LoreEntryLike | WorldBookEntryLike> | undefined;
  /** Preferred: when false, skip lore injection (default true) */
  loreEnabled?: boolean | undefined;
  /** @deprecated Use `loreEnabled` */
  worldBookEnabled?: boolean | undefined;
  scanText?: string | undefined;
  scanMaxChars?: number | undefined;
  /** When false, the scan head omits joined memory blocks. */
  includeMemoryInScan?: boolean | undefined;
  loreRuntime?: LoreRuntimeState | null | undefined;
  /** When false, lore timers do not advance. */
  loreTick?: boolean | undefined;

  personaBio?: string | null | undefined;
  worldState?: WorldState | RpWorldState | null | undefined;
  macros?: MacroNames | undefined;

  assembleOptions?: AssembleSectionOptions | undefined;
  assembleLimits?: {
    loreEntryChars?: number | undefined;
    stateChars?: number | undefined;
    personaChars?: number | undefined;
    cardFieldChars?: number | undefined;
  } | undefined;
  fragments?: AssembleFragments | null | undefined;
  regexScripts?: RegexScriptLike[] | null | undefined;
  vectorHits?: { name?: string | undefined; content: string }[] | null | undefined;
  /** Opaque preset payload forwarded to the `PresetResolver` port. */
  preset?: unknown;
  /** Opaque author's-note payload forwarded to the `PresetResolver` port. */
  authorsNote?: unknown;

  /** n_ctx in tokens; wins over `memory.contextCharLimit`. */
  contextTokenLimit?: number | undefined;
  /** Tokens reserved for the completion. */
  completionReserveTokens?: number | undefined;
  /** @deprecated prefer `softTrimTokenCap`; kept for call-site compat. */
  maxContextChars?: number | undefined;
  /** Explicit soft-trim cap (tokens). 0/omitted = auto from n_ctx. */
  softTrimTokenCap?: number | undefined;
  /** Budget tuning. */
  budget?: Omit<BudgetOptions, "mode"> | undefined;

  softTrimProfile?: SoftTrimProfile | undefined;

  /** Assemble-cache partition (e.g. chatId). */
  cacheScope?: string | undefined;
  /**
   * Who is asking. Overrides the engine-level `host` for this turn — use it when
   * one engine instance serves several callers.
   */
  host?: HostIdentity | undefined;
  /**
   * Human-readable operation label for the dashboard
   * (e.g. "发送消息", "开场白", "状态探针"). Shown per turn.
   */
  label?: string | undefined;
  /**
   * Per-turn context from the host system (chatId, route, userId, action…).
   * Merged with `host.meta` for the telemetry record (turn wins on key clash).
   */
  meta?: Record<string, string | number | boolean> | undefined;
  /** For `mode: "status"`: last real assembled size, to keep `contextUsed` honest. */
  priorAssembledPromptTokens?: number | undefined;

  /** Required. Heuristics are refused — see fusion/counter.ts. */
  tokenCounter: TokenCounter;
};

/**
 * Prepare input.
 *
 * `profile` is preferred, the legacy `card` is still accepted on its own, and
 * passing **both** keeps working (`profile` wins) — so this is a strict
 * tightening of the previous shape: only "neither" becomes a compile error, which
 * is exactly the case the runtime refuses.
 */
export type CogniStackPrepareInput = PrepareInputFields &
  (
    | { profile: AgentProfileLike; card?: CharacterCardLike }
    | { card: CharacterCardLike; profile?: AgentProfileLike }
  );

export type CogniStackDiagnostics = {
  severity: ReturnType<typeof partitionPrepareWarnings>;
  counter: CounterStats;
  /**
   * Identity of the injected TokenCounter (`"unnamed"` when the host passed a
   * bare `{count}`). Budget numbers are only meaningful next to the tokenizer
   * that produced them — a test double must be visible, not inferred.
   */
  counterId: string;
  /** Milliseconds per stage. */
  timings: Record<string, number>;
  cacheHit: boolean;
  /**
   * How much of the previous turn's prompt is still byte-identical at the front.
   * Distinct from `cacheHit` (assembly) — this is what a local runtime's prefix
   * cache can actually reuse. See `fusion/prefixStability.ts`.
   */
  prefixStability: PrefixStability;
  /** Present when `auditMemory` is enabled: what the resolve step did to memory. */
  memoryAudit?: MemoryAuditReport;
  /** Which priority tier held the tokens, and which one paid for the trim. */
  budgetAttribution?: BudgetAttribution;
  /** Structured per-stage outcomes, for UI/debug panels. */
  stages: {
    watermarkOnPath: boolean;
    loreSelected: number;
    loreCapped: boolean;
    vectorInject: number;
    assembleCacheHit: boolean;
    softTrimmed: boolean;
    emergencyDropped: number;
    /** True when generate mode left promptTokens ≤ budget.hardFit (or no hardFit). */
    fitsHardFit: boolean;
  };
};

export type CogniStackPrepareResult = {
  engine: typeof COGNISTACK_ENGINE_ID;
  version: typeof COGNISTACK_VERSION;
  mode: PrepareMode;

  /** The prompt to send. Empty in `status` mode. */
  messages: Array<PromptMessage | RpMessage>;
  /** Sections aligned with the (possibly soft-trimmed) leading system message. */
  systemSections: PromptSection[];

  promptChars: number;
  promptTokens: number;

  summary: string;
  summaryBlocks: SummaryBlock[];
  memory: CogniStackStatus;
  budget: ResolvedBudget;

  loreInjected: { id: string; name: string }[];
  loreRuntime: LoreRuntimeState;

  /** Raw messages for the next compress batch (complete pairs; ciphertext stripped). */
  toSummarize: { id?: string | undefined; role: string; content: string }[];
  toSummarizePairCount: number;
  nextSummarizedCount: number;
  nextSummarizedThroughMessageId: string | null;

  /** Engine trail for debugging (kept as strings for host-log compatibility). */
  steps: string[];
  /** Non-fatal degradations, prefixed by severity class. */
  warnings: string[];
  /** Prefix reuse potential vs. the previous turn in the same scope. */
  prefixStability: PrefixStability;
  diagnostics: CogniStackDiagnostics;
};

/**
 * 兼容别名 —— 与 {@link CogniStackPrepareResult} 是**同一个**类型。
 *
 * 为什么改别名：`src/types.ts` 曾独立声明一个同名的 `PrepareTurnResult`，字段与
 * `prepare()` 的真实返回类型**互不可赋** —— 外部消费方在 `skipLibCheck: false`
 * 下报 `TS2741: Property 'dispatchedBy' is missing`。而 `api:surface` 只比较导出
 * 签名文本，抓不到「两个导出类型之间不可赋值」这类漂移。现在只有一处定义，
 * 别名结构上不可能再漂移。见 `docs/decisions/ADR-004-prepare-result-type-unification.md`。
 *
 * @deprecated 用 `CogniStackPrepareResult`。
 */
export type PrepareTurnResult = CogniStackPrepareResult;

/**
 * 端口最终归属的来源。
 *
 * 为什么需要它：生效优先级是 **构造注入 / `wire()` > `connect()` > 引擎缺省**
 * （`rebuildContext` 里 `{ ...registry.resolve(), ...collaborators }`，后者覆盖前者）。
 * 而 `PortRegistry` 只知道 `connect()` 那一层——只看注册表，面板会把
 * "构造注入的 lore 正在生效" 显示成 "lore 未接入"，或者把被构造注入压制的
 * connect 提供方显示成赢家。**显示错的赢家比不显示更糟。**
 */
export type CogniStackPortSource = "connection" | "constructor" | "builtin" | "none";

/** `PortDiagnostic` + 实际生效来源。 */
export type CogniStackPortDiagnostic = PortDiagnostic & { source: CogniStackPortSource };

/** Result of {@link CogniStackEngine.plan} — a pre-flight, not a prediction. */
export type CogniStackPlan = {
  mode: PrepareMode;
  /** Same budget object `prepare()` would resolve for this input. */
  budget: ResolvedBudget;
  /** Real token count of the dialogue (user/assistant rows only). */
  dialogueTokens: number;
  dialogueMessages: number;
  /** Input weights, measured separately — deliberately not summed into a fake total. */
  cardTokens: number;
  summaryTokens: number;
  loreTokens: number;
  /** `budget.hardFit`, or 0 when not configured. */
  hardFit: number;
  /** The dialogue alone cannot fit — section budgeting cannot rescue this turn. */
  dialogueExceedsHardFit: boolean;
  /** How far the dialogue is over `hardFit` (0 when it fits). */
  overByTokens: number;
  warnings: string[];
};

export type CompressSlicePlan = {
  items: DialogueMessage[];
  nextSummarizedCount: number;
  nextSummarizedThroughMessageId: string | null;
  pairCount: number;
};

/**
 * 上下文 × 记忆 融合引擎。
 *
 * Public surface:
 *   prepare(input)              — one call, one token accounting pass
 *   status(input)               — trigger decision only
 *   planCompression(input)      — the batch to hand to your summarizer
 *   assemble(input)             — raw assemble (no budget)
 *   compress(messages, cap, …)  — soft-trim only
 *   author*()                   — summary authoring (via MemoryEngine/SummaryEngine)
 */
/**
 * Name used when the host supplies no `cacheScope`.
 *
 * Single constant on purpose: the assemble cache and the prefix tracker used to
 * invent *different* names for "no scope given" — `"_"` and `"_default"` — so
 * `clearCache("_")` cleared the assemble cache while silently leaving the prefix
 * memory behind (tracker keys are `${scope}::${mode}` and are matched by prefix).
 * Two names for one concept was the bug; one name is the fix.
 */
const DEFAULT_CACHE_SCOPE = "_default";

export class CogniStackEngine {
  readonly id = COGNISTACK_ENGINE_ID;
  readonly version = COGNISTACK_VERSION;

  readonly memory: MemoryEngine;
  readonly vector: VectorMemoryEngine;
  /**
   * 上下文装配器。端口重接线时由 `rebuildContext()` 整体替换，因此只对外暴露
   * getter —— 原来是 `readonly context!` 配合 `(this as {context}).context = …`
   * 强写，属于类型漏洞（`!` 掩盖了"只在重建路径里赋值"这一事实）。
   */
  private _context!: ContextEngine;
  get context(): ContextEngine {
    return this._context;
  }
  /** Summary authoring seam (REPLACE / episode / STATE_PATCH parsing). */
  readonly author: SummaryEngine;

  private readonly collaborators: AssembleCollaborators;
  /**
   * 协议接线后的最终合并结果（注册表 + 显式注入 + 机械缺省）。
   *
   * CogniStack fix: 引擎自己的 lore 选择步骤原来读的是构造时的
   * `this.collaborators` —— 那里面没有协议接入的实现，于是 `connect()` 之后
   * 端口表显示已接线、实际却一个条目都没选出来。装配器用的是合并结果，
   * 这一步也必须用。
   */
  private resolved: AssembleCollaborators = {};
  private readonly systemRules?: string | undefined;
  private readonly maxLoreEntries: number;
  private readonly maxVectorHits: number;
  private readonly maxVectorHitChars: number;
  private readonly assembleCacheSize: number;
  private readonly telemetry?: CogniStackTelemetry | undefined;
  private readonly defaultHost?: HostIdentity | undefined;
  /** Opt-in: audit the memory document before/after the resolve step each turn. */
  private readonly auditMemoryEnabled: boolean;
  /** Per-scope prompt shape from the previous turn (fingerprints only). */
  private readonly prefixTracker = new PrefixTracker();

  /** 接入协议的端口注册表：谁提供了哪个端口。 */
  private readonly registry = new PortRegistry<AssembleCollaborators>();
  private readonly connections = new Map<string, CogniStackConnection>();
  /** Per-id generation so a stale handle.close() cannot drop a newer reconnect. */
  private readonly connectionGeneration = new Map<string, number>();
  /** Bumped on every rebuildContext so prepareAsync can detect mid-flight rewires. */
  private wireGeneration = 0;

  /** scope → { key, result } (LRU by insertion). */
  private assembleCache = new Map<string, { key: string; result: ContextAssembleResult }>();

  constructor(opts: CogniStackOptions = {}) {
    this.memory = opts.memory ?? new MemoryEngine();
    this.vector = opts.vector ?? new VectorMemoryEngine();
    this.author = this.memory;
    // 浅拷贝：`wire()` 会往这个对象里 `Object.assign`，绝不能污染调用方传入的
    // 配置对象（多引擎共享同一对象时会互相串台）。
    this.collaborators = { ...(opts.collaborators ?? {}) };
    this.systemRules = opts.systemRules;
    this.telemetry = opts.telemetry;
    this.auditMemoryEnabled = opts.auditMemory === true;
    this.defaultHost = opts.host;
    if (this.telemetry && this.defaultHost) this.telemetry.registerHost(this.defaultHost);
    this.maxLoreEntries = Math.max(
      0,
      Math.floor(opts.maxLoreEntries ?? DEFAULT_MAX_LORE_ENTRIES),
    );
    this.maxVectorHits = Math.max(1, Math.floor(opts.maxVectorHits ?? DEFAULT_MAX_VECTOR_HITS));
    this.maxVectorHitChars = Math.max(
      120,
      Math.floor(opts.maxVectorHitChars ?? DEFAULT_MAX_VECTOR_HIT_CHARS),
    );
    this.assembleCacheSize = Math.max(1, Math.floor(opts.assembleCacheSize ?? DEFAULT_ASSEMBLE_CACHE_SIZE));

    this.rebuildContext();
  }

  /**
   * 重建装配器：构造函数注入的 collaborators 优先级最高（显式覆写），
   * 其次是按接入协议注册的提供方，最后落到引擎缺省（机械、无领域语义）。
   */
  private rebuildContext(): void {
    this.wireGeneration += 1;
    const merged: AssembleCollaborators = {
      ...this.registry.resolve(),
      ...this.collaborators,
    };
    // 机械缺省：不带任何领域语义。领域逻辑必须由宿主通过协议接入。
    if (!merged.card) merged.card = defaultCardResolver;
    if (!merged.macros) merged.macros = defaultMacroBinder;
    if (!merged.vector) merged.vector = this.vector;
    if (!merged.lore) merged.lore = defaultLoreProvider;
    if (!merged.state) merged.state = defaultWorldStateProvider;
    if (!merged.preset) merged.preset = defaultPresetResolver;
    if (!merged.regex) merged.regex = noopRegexApplier;
    this.resolved = merged;
    this._context = new ContextEngine(this.memory, merged);
    this.assembleCache.clear();
  }

  /**
   * Yield the event loop, then abort if connect()/wire rebuilt ports mid-flight.
   * prepareLive catches `WIRE_CHANGED` and restarts the pipeline.
   */
  private *checkpointWire(genAtStart: number): Generator<void, void, void> {
    yield;
    if (this.wireGeneration !== genAtStart) {
      const err = new Error(
        "CogniStack: ports rewired during prepare; retry",
      ) as Error & { code: string };
      err.code = "WIRE_CHANGED";
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 接入协议                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 一个外部系统按协议接入。
   *
   * 系统在 manifest 里声明自己能提供哪些端口，引擎立即接线；断开时自动回退到
   * 下一个提供方或引擎缺省。接入方身份（含 provides）同时进入遥测，
   * 面板的接入拓扑因此能画出「哪个系统提供了哪个端口」。
   */
  connect(manifest: ConnectManifest): CogniStackConnection {
    if (!manifest?.id) throw new Error("connect 需要 manifest.id");

    // 先过注册表：它在自身校验失败时**无副作用**地抛错（见 PortRegistry.register）。
    // 顺序反了就会留下一条"幽灵连接"—— 面板上看得见、结构上拿不到任何调用，
    // 因为 register 抛错后剩下的状态没人回滚。
    this.registry.register(
      manifest.id,
      manifest.name,
      (manifest.provides ?? {}) as Partial<AssembleCollaborators>,
      manifest.priority,
    );

    // Drop the stale handle mapping only — the registry entry was just refreshed
    // in place, so same-id refresh keeps arrival FIFO (注：注册表的 FIFO 由它自己的
    // 序列号维持，与这张句柄映射无关)。
    this.connections.delete(manifest.id);

    const gen = (this.connectionGeneration.get(manifest.id) ?? 0) + 1;
    this.connectionGeneration.set(manifest.id, gen);

    const conn = new CogniStackConnection(this, { ...manifest }, gen);
    this.connections.set(manifest.id, conn);
    this.rebuildContext();

    if (this.telemetry) {
      this.telemetry.registerHost({
        id: manifest.id,
        name: manifest.name,
        kind: manifest.kind,
        version: manifest.version,
        meta: manifest.meta,
        provides: Object.keys(manifest.provides ?? {}),
        requires: manifest.requires ?? [],
      });
    }
    return conn;
  }

  /** 断开一个接入方（端口自动回退）。 */
  disconnect(id: string): boolean {
    const conn = this.connections.get(id);
    if (!conn) return false;
    conn.close();
    return true;
  }

  /** 当前所有接入方（最早接入在前）。 */
  connectionsList(): CogniStackConnection[] {
    return [...this.connections.values()];
  }

  /** 端口归属表：哪个端口由谁提供。 */
  portTable(): PortBinding[] {
    return this.registry.table(DEFAULT_PORT_PROVIDER_NAMES);
  }

  /**
   * 端口竞争诊断：谁生效、谁被压制、哪些端口没人接。
   *
   * 面板拓扑与排错都消费它。`shadowed` 非空说明"有人接上了但没生效"——
   * 这种问题在 `portTable()` 上完全看不出来。
   *
   * 每个端口额外给出 `source`：注册表之外的构造注入 / `wire()` 也是真实生效的提供方，
   * 只看注册表会报出错的赢家（见 `CogniStackPortSource` 的说明）。
   */
  portDiagnostics(): CogniStackPortDiagnostic[] {
    const injected = this.collaborators as Record<string, unknown>;
    return this.registry.diagnostics(DEFAULT_PORT_PROVIDER_NAMES).map((d) => {
      const impl = injected[d.port];
      // 构造注入 / wire() 优先于 connect：它生效时，注册表里的赢家其实是被压制的那个，
      // 必须放进 shadowed —— "接上了却被构造注入盖住"正是最难自查的一类接线问题。
      if (impl !== undefined && impl !== null) {
        const shadowed = [...d.shadowed];
        if (d.bound && d.winner.providerId) {
          shadowed.unshift({
            providerId: d.winner.providerId,
            providerName: d.winner.providerName ?? d.winner.providerId,
            priority: d.winner.priority ?? 0,
          });
        }
        return {
          ...d,
          bound: true,
          source: "constructor" as const,
          winner: {
            providerId: null,
            providerName: "构造注入 / wire()",
            priority: null,
            builtin: false,
          },
          shadowed,
        };
      }
      if (d.bound) return { ...d, source: "connection" as const };
      if (d.winner.builtin) return { ...d, source: "builtin" as const };
      return { ...d, source: "none" as const };
    });
  }

  /** @internal 由 CogniStackConnection.close() 调用。 */
  _dropConnection(id: string, generation?: number): void {
    if (generation !== undefined && this.connectionGeneration.get(id) !== generation) {
      return;
    }
    this.connections.delete(id);
    this.registry.unregister(id);
    this.connectionGeneration.delete(id);
    this.rebuildContext();
  }

  /** @internal 刷新已有连接的清单（不换代、不换句柄）。 */
  _refreshConnection(conn: CogniStackConnection): void {
    if (this.connections.get(conn.id) !== conn) {
      throw new Error("connection handle is stale; reconnect with connect()");
    }
    this.registry.register(
      conn.manifest.id,
      conn.manifest.name,
      (conn.manifest.provides ?? {}) as Partial<AssembleCollaborators>,
      conn.manifest.priority,
    );
    this.rebuildContext();
    if (this.telemetry) {
      this.telemetry.registerHost({
        id: conn.manifest.id,
        name: conn.manifest.name,
        kind: conn.manifest.kind,
        version: conn.manifest.version,
        meta: conn.manifest.meta,
        provides: Object.keys(conn.manifest.provides ?? {}),
        requires: conn.manifest.requires ?? [],
      });
    }
  }

  /**
   * Bind a caller identity to this engine.
   *
   * The returned handle stamps `host` on every call, so a single engine that
   * serves several callers still reports per-system in telemetry — which is
   * exactly the "what is plugged in" question the dashboard answers.
   */
  forHost(host: HostIdentity): CogniStackHostHandle {
    if (this.telemetry) this.telemetry.registerHost(host);
    return new CogniStackHostHandle(this, host);
  }

  /** 端口名列表（含缺省），遥测上报用。 */
  get ports(): string[] {
    return this.portTable().map((b) => b.port);
  }

  /**
   * Swap/add domain ports after construction.
   *
   * @deprecated 用 `connect({ id, name, provides })` —— 走协议的接入会进遥测、
   * 能在面板上看到归属，断开时还会自动回退。
   */
  wire(collaborators: AssembleCollaborators): this {
    Object.assign(this.collaborators, collaborators);
    this.rebuildContext();
    return this;
  }

  /** Drop cached assemble results (e.g. after a card edit). */
  clearCache(scope?: string): void {
    if (scope === undefined) this.assembleCache.clear();
    else this.assembleCache.delete(scope);
    // Prefix memory is derived from the same prompt shape, so a scope-scoped
    // clear must drop it too — otherwise the next turn reports reuse against a
    // prompt that no longer exists. Tracker keys are `${scope}::${mode}`, hence
    // the prefix match rather than an exact delete.
    if (scope === undefined) this.prefixTracker.clear();
    else this.prefixTracker.clearPrefix(scope);
  }

  /* ---------------------------------------------------------------- */
  /* Raw stage access (thin, port-friendly)                            */
  /* ---------------------------------------------------------------- */

  /** Assemble system + dialogue without any budget trimming. */
  assemble(input: Parameters<ContextAssembleEngine["assemble"]>[0]): ContextAssembleResult {
    return this.context.assemble(input);
  }

  /**
   * Trigger evaluation only — the fusion of `ContextEngine.status` and the
   * RP dispatcher's status-mode plumbing (which used to be duplicated inline).
   */
  status(params: {
    dialogue: DialogueMessage[];
    policy: MemoryCompressPolicy;
    tokenCounter: TokenCounter;
    summarizedCount?: number;
    summarizedThroughMessageId?: string | null | undefined;
    assembledPromptTokens?: number | undefined;
    overheadTokens?: number | undefined;
  }): CogniStackStatus {
    return this.context.status({
      dialogue: params.dialogue,
      summarizedCount: params.summarizedCount ?? 0,
      summarizedThroughMessageId: params.summarizedThroughMessageId,
      policy: params.policy,
      tokenCounter: params.tokenCounter,
      assembledPromptTokens: params.assembledPromptTokens,
      overheadTokens: params.overheadTokens,
    });
  }

  /** The complete-pair slice to hand to the summarizer, given a status. */
  planCompression(params: {
    dialogue: DialogueMessage[];
    status: CogniStackStatus;
    policy: MemoryCompressPolicy;
    tokenCounter?: TokenCounter;
  }): CompressSlicePlan {
    return this.context.toSummarizeSlice({
      dialogue: params.dialogue,
      watermarkEnd: params.status.watermarkEnd,
      policy: params.policy,
      shouldSummarize: params.status.shouldSummarize,
      contextTriggered: params.status.compressReason === "context",
      tokenCounter: params.tokenCounter,
      pairBatchCap: params.status.adaptivePairBatchSize ?? params.policy.pairBatchSize,
    });
  }

  /** Soft-trim a message list so it fits `maxTokens` (dialogue is never dropped). */
  compress(
    messages: RpMessage[],
    maxTokens: number | undefined,
    tokenCounter: TokenCounter,
    sections?: PromptSection[] | null,
    opts?: {
      minSystemTokens?: number;
      softTrimProfile?: SoftTrimProfile | null;
      memoryDocumentImportances?: number[] | null;
    },
  ): { messages: RpMessage[]; systemSections: PromptSection[] } {
    return this.context.compress(
      messages,
      maxTokens,
      opts?.minSystemTokens ?? 512,
      tokenCounter,
      sections,
      {
        softTrimProfile: opts?.softTrimProfile,
        memoryDocumentImportances: opts?.memoryDocumentImportances,
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Fused pipeline                                                    */
  /* ---------------------------------------------------------------- */

  prepare(input: CogniStackPrepareInput): CogniStackPrepareResult {
    const it = this.prepareGen(input);
    let step = it.next();
    while (!step.done) step = it.next();
    return step.value;
  }

  /**
   * Policy + budget resolution, in one place.
   *
   * Extracted so `plan()` and `prepare()` cannot drift apart. A pre-flight that
   * disagrees with the real run is worse than having no pre-flight — it is the
   * exact "two copies of the same arithmetic" failure this project was created to
   * get rid of.
   */
  private resolvePolicyAndBudget(
    input: CogniStackPrepareInput,
    mode: PrepareMode,
  ): { policy: MemoryCompressPolicy; budget: ResolvedBudget } {
    const policyBase = defaultCompressPolicy(input.pairBatchSize ?? 10, {
      ...input.memory,
      totalPromptCharCap:
        input.softTrimTokenCap ??
        input.memory?.totalPromptCharCap ??
        (input.maxContextChars && input.maxContextChars > 0 ? input.maxContextChars : 0),
      contextCharLimit: input.contextTokenLimit ?? input.memory?.contextCharLimit ?? 0,
    });
    const budget = resolveBudget(policyBase, {
      ...(input.budget ?? {}),
      mode,
      /*
       * Top-level wins, then falls back to the value inside `budget`.
       * Writing `input.completionReserveTokens` alone was a silent-override bug:
       * when the host set only `budget.completionReserveTokens`, the top-level
       * field was `undefined` and overwrote the spread value — the reserve then
       * resolved to 0, `hardFit` grew, and the turn could exceed n_ctx with the
       * panel reporting nothing wrong.
       */
      completionReserveTokens:
        input.completionReserveTokens ?? input.budget?.completionReserveTokens,
    });
    return { policy: budget.policy, budget };
  }

  /**
   * Budget pre-flight: no assembly, no prompt, no guessed final size.
   *
   * What it deliberately does NOT do is claim to know how big the assembled
   * prompt will be. That number depends on section ordering, clipping and the
   * card renderer — reproducing that arithmetic here would mean a second
   * implementation that silently drifts from the real one (and a host would then
   * make admission decisions on a number that is not the number).
   *
   * What it does give you, exactly and cheaply, is the *dialogue* weight. That is
   * the meaningful pre-flight signal because the engine guarantees uncompressed
   * dialogue is never softly trimmed — so if the dialogue alone exceeds `hardFit`,
   * no amount of section budgeting can save the turn.
   */
  /**
   * Validate + normalise a prepare input. **Every public entry point must use it.**
   *
   * Why this exists: `plan()` and `prepare()` each carried their own checks, and
   * they disagreed. Measured before the fix, on the same object:
   *
   *   prepare({ dialogue, contextTokenLimit, tokenCounter })  → throws
   *     "profile (or legacy card) required"
   *   plan   ({ dialogue, contextTokenLimit, tokenCounter })  → returns a budget
   *
   * A precheck that passes on an input the real call refuses is worse than no
   * precheck — it tells the host the turn is fine, right before it throws. That is
   * the exact failure mode recorded in G-2 ("一旦两者会漂移，这个 API 就是在骗人").
   *
   * It also ends the split personality of `profile`: the counting path accepted a
   * bare string (`typeof profile === "string"`) while the guard rejected anything
   * that was not an object, so a string profile passed `plan()` and threw in
   * `prepare()`. The object form is now the single contract.
   *
   * Returns a shallow copy with the legacy alias names rebound, so both
   * `profile`/`card` and `loreEntries`/`worldEntries` can be read downstream.
   */
  private validatePrepareInput(input: CogniStackPrepareInput): CogniStackPrepareInput {
    if (!input || typeof input !== "object") {
      throw new Error("prepare input must be an object");
    }
    if (!input.tokenCounter || typeof input.tokenCounter.count !== "function") {
      throw new Error("tokenCounter required (inject TokenCounter.count)");
    }
    const profile = input.profile ?? input.card;
    if (!profile || typeof profile !== "object") {
      throw new Error("profile (or legacy card) required");
    }
    /*
     * Shape checks below turn silent `TypeError: Cannot read properties of null
     * (reading 'some')` into something a host can act on. Measured before the fix:
     * `dialogue: null` → "reading 'some'", `dialogue: "x"` → "input.dialogue.some
     * is not a function", `summaryBlocks: "x"` → "params.summaryBlocks.filter is
     * not a function". `profile` already produced a clean message; the rest did
     * not.
     */
    if (!Array.isArray(input.dialogue)) {
      throw new Error("dialogue must be an array of messages");
    }
    if (input.summaryBlocks != null && !Array.isArray(input.summaryBlocks)) {
      throw new Error("summaryBlocks must be an array when provided");
    }
    const loreEntries = input.loreEntries ?? input.worldEntries;
    if (loreEntries != null && !Array.isArray(loreEntries)) {
      throw new Error("loreEntries / worldEntries must be an array when provided");
    }
    const loreEnabled = input.loreEnabled ?? input.worldBookEnabled;
    return {
      ...input,
      card: profile as CharacterCardLike,
      profile: profile as AgentProfileLike,
      worldEntries: loreEntries,
      loreEntries,
      worldBookEnabled: loreEnabled,
      loreEnabled,
    };
  }

  plan(input: CogniStackPrepareInput): CogniStackPlan {
    input = this.validatePrepareInput(input);
    const counter = memoizeCounter(input.tokenCounter);
    const mode: PrepareMode = input.mode === "status" ? "status" : "generate";
    const { budget } = this.resolvePolicyAndBudget(input, mode);

    const dialogue = input.dialogue.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    let dialogueTokens = 0;
    for (const m of dialogue) dialogueTokens += counter.count(m.content ?? "");

    const profile = (input.profile ?? input.card) as Record<string, unknown> | undefined;
    let cardTokens = 0;
    if (profile && typeof profile === "object") {
      for (const v of Object.values(profile)) {
        if (typeof v === "string") cardTokens += counter.count(v);
      }
    } else if (typeof profile === "string") {
      cardTokens = counter.count(profile);
    }

    let summaryTokens = counter.count(input.summary ?? "");
    for (const b of input.summaryBlocks ?? []) summaryTokens += counter.count(b?.text ?? "");

    let loreTokens = 0;
    for (const e of input.loreEntries ?? input.worldEntries ?? []) {
      loreTokens += counter.count((e as { content?: string })?.content ?? "");
    }

    const hardFit = budget.hardFit ?? 0;
    const over = hardFit > 0 ? dialogueTokens - hardFit : 0;
    return {
      mode,
      budget,
      dialogueTokens,
      dialogueMessages: dialogue.length,
      cardTokens,
      summaryTokens,
      loreTokens,
      hardFit,
      dialogueExceedsHardFit: hardFit > 0 && dialogueTokens > hardFit,
      overByTokens: over > 0 ? over : 0,
      warnings: budget.warnings.slice(),
    };
  }

  /**
   * Same pipeline as {@link prepare}, but yields the Node event loop between
   * stages so SSE `progress` can flush to the console before the HTTP response
   * completes. Sync `prepare()` still blocks the loop; HTTP / prepareAsync use this.
   */
  async prepareLive(input: CogniStackPrepareInput): Promise<CogniStackPrepareResult> {
    // Mid-flight connect()/wire bumps wireGeneration; restart a few times rather
    // than return a half-assembled prompt against mixed ports.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const it = this.prepareGen(input);
        let step = it.next();
        while (!step.done) {
          await new Promise<void>((r) => setImmediate(r));
          step = it.next();
        }
        return step.value;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "WIRE_CHANGED" && attempt < 3) continue;
        throw err;
      }
    }
    // Unreachable — loop either returns or throws.
    return this.prepare(input);
  }

  private *prepareGen(input: CogniStackPrepareInput): Generator<void, CogniStackPrepareResult, void> {
    const wireGen = this.wireGeneration;
    const t0 = now();
    input = this.validatePrepareInput(input);
    const counter = memoizeCounter(input.tokenCounter);
    const counterId = counterIdentity(input.tokenCounter);
    const steps: string[] = [];
    const warnings: string[] = [];
    const timings: Record<string, number> = {};
    const host = input.host ?? this.defaultHost ?? UNKNOWN_HOST;

    /* de-RP input aliases — already validated and rebound by validatePrepareInput. */
    const profile = input.profile ?? input.card;
    const loreEntries = input.loreEntries ?? input.worldEntries;

    // `plan` was removed — coerce legacy callers to generate so hosts don't crash.
    if ((input.mode as string | undefined) === "plan") {
      warnings.push("mode-plan-removed");
    }
    const mode: PrepareMode = input.mode === "status" ? "status" : "generate";
    /*
     * Non user/assistant roles are dropped from the dialogue.
     *
     * `system` already had a signal (and is graded `degraded` — a system turn
     * silently becoming ordinary dialogue was a real defect). Every *other* role
     * was dropped in complete silence: a library caller passing `tool` /
     * `developer` messages got neither the content nor any indication it was
     * ignored, so budget and memory numbers described a different conversation.
     */
    const droppedRoles = new Set<string>();
    for (const m of input.dialogue) {
      const role = String(m.role ?? "");
      if (role === "user" || role === "assistant") continue;
      if (role === "system") {
        if (!warnings.includes("dialogue-system-role-dropped")) {
          warnings.push("dialogue-system-role-dropped");
        }
        continue;
      }
      if (role) droppedRoles.add(role);
    }
    for (const role of droppedRoles) warnings.push(`dialogue-role-dropped:${role}`);
    const dialogue = input.dialogue.filter((m) => m.role === "user" || m.role === "assistant");
    const runId = `${host.id}:${t0}`;
    const track = (stage: string, phase: "start" | "end", ms?: number) => {
      this.telemetry?.emitProgress({
        runId,
        hostId: host.id,
        hostName: host.name,
        mode,
        stage,
        phase,
        ms,
        at: Date.now(),
      });
    };
    track("_run", "start");
    yield* this.checkpointWire(wireGen);

    /* -- 1. Policy + budget (pure) ---------------------------------- */
    track("budget", "start");
    yield* this.checkpointWire(wireGen);
    const { budget } = this.resolvePolicyAndBudget(input, mode);
    const policy = budget.policy;
    warnings.push(...budget.warnings);
    steps.push("budget.resolve");
    timings.budget = now() - t0;
    track("budget", "end", timings.budget);
    yield* this.checkpointWire(wireGen);

    /* -- 2. Watermark + memory window ------------------------------- */
    track("memoryWindow", "start");
    yield* this.checkpointWire(wireGen);
    const tMem = now();
    const effectiveWm = this.memory.resolveEffectiveWatermark(
      dialogue,
      input.summarizedThroughMessageId,
      input.summarizedCount ?? 0,
    );
    if (!effectiveWm.watermarkOnPath) warnings.push("watermark-off-active-path");

    const resolvedBlocks = resolveSummaryBlocks({
      summaryBlocks: input.summaryBlocks,
      summary: input.summary,
      summarizedThroughMessageId: effectiveWm.summarizedThroughMessageId,
      dialogue,
    });

    /*
     * Enforce the memory policy here — the single point where blocks are resolved.
     *
     * `policy.maxBlocks` / `maxBlockChars` / `maxTotalBlockChars` used to be
     * declared and handed to hosts but never applied by the engine: `prepare()`
     * returned the caller's list untouched, so a host storing it as authoritative
     * state grew it without bound, and the prompt re-merged the whole list every
     * turn. Compacting once at the source keeps the returned view and the prompt
     * view identical, and makes `maxBlocks` mean what it says.
     */
    const blocks = compactMemoryBlocks(resolvedBlocks, policy);
    if (blocks !== resolvedBlocks) {
      // Lossy by design (that is the policy), but it must never be silent.
      warnings.push(`memory-blocks-compacted:${resolvedBlocks.length}->${blocks.length}`);
    }

    const watermarkEnd = this.memory.watermarkEndIndex(
      dialogue,
      effectiveWm.summarizedThroughMessageId,
      effectiveWm.summarizedCount,
    );

    const rawForPrompt = this.buildRawWindow(dialogue, watermarkEnd, policy, steps);
    if (dialogue.some((m) => m.encrypted)) warnings.push("ciphertext-present-in-dialogue");

    const summaryJoined = joinSummaryBlocks(blocks) || input.summary || "";

    /*
     * Opt-in memory audit: compare what the host handed in against what the
     * resolve step produced. This is where merge / normalize / clip run, so this
     * is where a protected column can quietly lose content.
     */
    let auditReport: MemoryAuditReport | undefined;
    if (this.auditMemoryEnabled) {
      const beforeText = [joinSummaryBlocks(input.summaryBlocks ?? []), input.summary ?? ""]
        .filter((t) => t && t.trim())
        .join("\n\n");
      if (beforeText) {
        auditReport = auditMemory(beforeText, summaryJoined);
        warnings.push(...memoryAuditWarnings(auditReport, { maxUnits: 2 }));
        if (auditReport.verdict !== "clean") steps.push(`memory.audit:${auditReport.verdict}`);
      }
    }
    timings.memoryWindow = now() - tMem;
    steps.push("memory.window");
    track("memoryWindow", "end", timings.memoryWindow);
    yield* this.checkpointWire(wireGen);

    /* -- 3. status mode: no assemble -------------------------------- */
    if (mode === "status") {
      track("status", "start");
      yield* this.checkpointWire(wireGen);
      const tStatus = now();
      const summaryTokens = counter.count(summaryJoined);
      let rawTokens = 0;
      for (const m of rawForPrompt) rawTokens += counter.count(m.encrypted ? "" : m.content);

      const priorAssembled = Math.max(0, Math.floor(input.priorAssembledPromptTokens ?? 0));
      // Without a prior assemble measurement, do not invent a 1200-token system
      // floor — that biased compress triggers. Estimate system as 0 and let the
      // host pass `priorAssembledPromptTokens` when it has a real number.
      const sysFloor =
        priorAssembled > 0 ? Math.max(0, priorAssembled - summaryTokens - rawTokens) : 0;
      const assembledPromptTokens = summaryTokens + rawTokens + sysFloor;
      if (!(priorAssembled > 0)) {
        warnings.push("status-missing-prior-assembled-tokens");
      }

      const mem = this.context.status({
        dialogue,
        summarizedCount: effectiveWm.summarizedCount,
        summarizedThroughMessageId: effectiveWm.summarizedThroughMessageId,
        policy,
        assembledPromptTokens,
        tokenCounter: counter,
      });
      const slice = this.context.toSummarizeSlice({
        dialogue,
        watermarkEnd: mem.watermarkEnd,
        policy,
        shouldSummarize: mem.shouldSummarize,
        contextTriggered: mem.compressReason === "context",
        tokenCounter: counter,
        pairBatchCap: mem.adaptivePairBatchSize ?? policy.pairBatchSize,
      });
      timings.status = now() - tStatus;
      track("status", "end", timings.status);
      yield* this.checkpointWire(wireGen);
      steps.push("status+slice");

      track("_run", "end", now() - t0);
      yield* this.checkpointWire(wireGen);
      return this.finish({
        mode,
        host,
        startedAt: t0,
        messages: [],
        systemSections: [],
        promptChars: 0,
        promptTokens: assembledPromptTokens,
        summary: summaryJoined || input.summary || "",
        summaryBlocks: blocks,
        memory: mem,
        budget,
        loreInjected: [],
        loreRuntime: (input.loreRuntime ?? {}) as LoreRuntimeState,
        slice,
        steps,
        warnings,
        counter,
        counterId,
        timings,
        stages: {
          watermarkOnPath: effectiveWm.watermarkOnPath,
          loreSelected: 0,
          loreCapped: false,
          vectorInject: 0,
          assembleCacheHit: false,
          softTrimmed: false,
          emergencyDropped: 0,
          fitsHardFit: true,
        },
      });
    }

    /* -- 4. Lore scan + selection ----------------------------------- */
    track("lore", "start");
    yield* this.checkpointWire(wireGen);
    const tLore = now();
    const rawScan = rawForPrompt
      .map((m) => (m.encrypted ? "" : m.content))
      .filter(Boolean)
      .join("\n");
    const scanMax = input.scanMaxChars ?? DEFAULT_SCAN_MAX_CHARS;
    const includeMemoryInScan = input.includeMemoryInScan !== false;
    const scanText =
      input.scanText !== undefined
        ? input.scanText
        : (this.resolved.lore?.buildScanText ?? buildLoreScanText)({
            headText: includeMemoryInScan ? summaryJoined : "",
            rawTail: rawScan,
            maxChars: scanMax,
          });

    const worldBookEnabled = input.worldBookEnabled !== false;
    const lore = this.resolved.lore;
    const fallbackLoreRuntime = (input.loreRuntime ?? {}) as LoreRuntimeState;

    let loreResult: Array<LoreEntryLike | WorldBookEntryLike> = [];
    let loreRuntime = fallbackLoreRuntime;

    if (worldBookEnabled && lore?.selectWithRuntime) {
      // Full ST fidelity: the provider also advances sticky/cooldown/delay.
      const rich = this.guard(
        warnings,
        "lore",
        () =>
          lore.selectWithRuntime!(input.worldEntries ?? [], scanText, {
            maxEntries: this.maxLoreEntries,
            loreRuntime: fallbackLoreRuntime,
            dialogue: rawForPrompt,
            tick: input.loreTick !== false,
          }),
        () => ({ selected: [] as Array<LoreEntryLike | WorldBookEntryLike>, loreRuntime: fallbackLoreRuntime }),
      );
      loreResult = rich.selected;
      loreRuntime = rich.loreRuntime;
    } else if (worldBookEnabled && lore) {
      loreResult = this.guard(
        warnings,
        "lore",
        () =>
          lore.selectEntries(input.worldEntries ?? [], scanText, {
            maxEntries: this.maxLoreEntries,
            loreRuntime: fallbackLoreRuntime,
            dialogue: rawForPrompt,
          }),
        () => [] as Array<LoreEntryLike | WorldBookEntryLike>,
      );
    }

    // Empty default lore always returns [] — that is intentional, not a "miss".
    // Only warn when a real selector ran and still matched nothing.
    if (
      worldBookEnabled &&
      (input.worldEntries?.length ?? 0) > 0 &&
      !loreResult.length &&
      lore &&
      lore !== defaultLoreProvider
    ) {
      warnings.push("lore-no-hit");
      warnings.push("world-book-no-hit");
    }
    timings.lore = now() - tLore;
    steps.push("lore.select");
    track("lore", "end", timings.lore);
    yield* this.checkpointWire(wireGen);

    /* -- 5. Preset fragments + vector hits -------------------------- */
    track("fragments", "start");
    yield* this.checkpointWire(wireGen);
    const tFrag = now();
    const fragments = input.fragments ?? this.resolveFragments(input, dialogue, warnings);
    const vectorHits = this.vector.sanitizeHits(input.vectorHits, {
      summaryText: summaryJoined,
      maxHits: this.maxVectorHits,
      maxCharsEach: this.maxVectorHitChars,
    });
    if (vectorHits.length) steps.push("vector.inject");
    timings.fragments = now() - tFrag;
    track("fragments", "end", timings.fragments);
    yield* this.checkpointWire(wireGen);

    /* -- 6. Assemble (cached) --------------------------------------- */
    track("assemble", "start");
    yield* this.checkpointWire(wireGen);
    const tAssemble = now();
    // `maxLoreEntries` is a hard cap owned by the engine, not an optional hint.
    // Caller may request fewer; never more than the engine ceiling.
    // `0` means inject none (not "unlimited").
    const assembleOptions: AssembleSectionOptions = { ...(input.assembleOptions ?? {}) };
    const callerLoreCap = assembleOptions.maxLoreEntries;
    if (callerLoreCap === undefined) {
      assembleOptions.maxLoreEntries = this.maxLoreEntries;
    } else {
      // 非有限值（NaN / 非数字字符串）不能退化成"注入 0 条"——那会把
      // "未指定"悄悄变成"硬关闭"。回退到引擎上限。
      const raw = Number(callerLoreCap);
      const n = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : this.maxLoreEntries;
      assembleOptions.maxLoreEntries = Math.min(n, this.maxLoreEntries);
    }

    let loreWorking = loreResult;
    let vectorWorking = vectorHits;
    let { assembled, cacheHit } = this.assembleCached({
      input,
      assembleOptions,
      summaryJoined,
      blocks,
      rawForPrompt,
      lore: loreWorking,
      worldBookEnabled,
      scanText,
      fragments,
      vectorHits: vectorWorking,
      warnings,
    });
    for (const note of assembled.notes) warnings.push(note);
    timings.assemble = now() - tAssemble;
    steps.push(cacheHit ? "assemble:cache-hit" : "assemble");
    track("assemble", "end", timings.assemble);
    yield* this.checkpointWire(wireGen);

    let loreInjected = assembled.loreInjected;
    // Cap is real when selected lore exceeds the engine limit OR assemble sliced.
    let loreCapped =
      loreResult.length > this.maxLoreEntries || loreInjected.length < loreResult.length;
    if (loreCapped) {
      warnings.push(`lore-capped:${this.maxLoreEntries}`);
      warnings.push(`world-book-capped:${this.maxLoreEntries}`);
    }

    // Contextual typing does not flow through `.filter()`, so build this list
    // explicitly — otherwise `role: "system"` widens to `string`.
    const fallbackMessages: RpMessage[] = [];
    const rules = this.systemRules ?? "";
    if (rules.length > 0) fallbackMessages.push({ role: "system", content: rules });
    for (const m of rawForPrompt) {
      if (!m.content) continue;
      fallbackMessages.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      });
    }
    let baseMessages: RpMessage[] = assembled.messages.length
      ? assembled.messages
      : fallbackMessages;

    /* -- 7. Trigger decision (one accounting pass) ------------------ */
    track("account", "start");
    yield* this.checkpointWire(wireGen);
    const tAccount = now();
    let systemTokens = counter.count(baseMessages.find((m) => m.role === "system")?.content ?? "");
    let assembledPromptTokens = countMessages(baseMessages, counter);
    let mem = this.context.status({
      dialogue,
      summarizedCount: effectiveWm.summarizedCount,
      summarizedThroughMessageId: effectiveWm.summarizedThroughMessageId,
      policy,
      overheadTokens: systemTokens,
      assembledPromptTokens,
      tokenCounter: counter,
    });
    let slice = this.context.toSummarizeSlice({
      dialogue,
      watermarkEnd: mem.watermarkEnd,
      policy,
      shouldSummarize: mem.shouldSummarize,
      contextTriggered: mem.compressReason === "context",
      tokenCounter: counter,
      pairBatchCap: mem.adaptivePairBatchSize ?? policy.pairBatchSize,
    });
    timings.account = now() - tAccount;
    steps.push("status+slice");
    track("account", "end", timings.account);
    yield* this.checkpointWire(wireGen);

    /* -- 8. Soft trim + emergency fit ------------------------------- */
    track("trim", "start");
    yield* this.checkpointWire(wireGen);
    const tTrim = now();
    const softCap = budget.softTrimTokenCap;
    const hardCap = budget.hardFit;
    const skipSoftTrim = !budget.softTrimEnabled;
    // Soft-trim shrinks system sections; hard-fit is the last gate before the
    // provider rejects. `softTrimOff` must NOT skip hard-fit on generate.
    // Prefer softCap when set (stricter), but always keep hardCap as absolute ceiling.
    const fitCap =
      mode === "generate"
        ? skipSoftTrim
          ? hardCap
          : softCap > 0
            ? softCap
            : hardCap
        : 0;

    /* Pressure ladder: drop vector → half lore → drop last lore, reassemble each
       pass until under hardFit or nothing left to peel. Soft trim only shrinks
       system text; on 4k/8k card+lore+vector alone can exceed hardFit. */
    if (mode === "generate" && hardCap > 0) {
      const tPressure = now();
      let pressurePasses = 0;
      const MAX_PRESSURE_PASSES = 6;
      while (assembledPromptTokens > hardCap && pressurePasses < MAX_PRESSURE_PASSES) {
        let peeled = false;
        if (vectorWorking.length > 0) {
          vectorWorking = [];
          warnings.push("pressure-drop-vector");
          steps.push("pressure.dropVector");
          peeled = true;
        } else if (loreWorking.length > 1) {
          const next = Math.max(1, Math.floor(loreWorking.length / 2));
          warnings.push(`pressure-drop-lore:${loreWorking.length}->${next}`);
          loreWorking = loreWorking.slice(0, next);
          assembleOptions.maxLoreEntries = Math.min(
            assembleOptions.maxLoreEntries ?? next,
            next,
          );
          steps.push("pressure.dropLore");
          peeled = true;
        } else if (loreWorking.length === 1) {
          loreWorking = [];
          assembleOptions.maxLoreEntries = 0;
          warnings.push("pressure-drop-lore:all");
          steps.push("pressure.dropLore");
          peeled = true;
        }
        if (!peeled) break;
        pressurePasses += 1;
        const rebuilt = this.assembleCached({
          input,
          assembleOptions,
          summaryJoined,
          blocks,
          rawForPrompt,
          lore: loreWorking,
          worldBookEnabled,
          scanText,
          fragments,
          vectorHits: vectorWorking,
          warnings,
        });
        assembled = rebuilt.assembled;
        cacheHit = rebuilt.cacheHit;
        loreInjected = assembled.loreInjected;
        loreCapped =
          loreResult.length > this.maxLoreEntries || loreInjected.length < loreResult.length;
        baseMessages = assembled.messages.length ? assembled.messages : fallbackMessages;
        assembledPromptTokens = countMessages(baseMessages, counter);
        systemTokens = counter.count(baseMessages.find((m) => m.role === "system")?.content ?? "");
        // Re-account after peel so shouldSummarize / contextUsed reflect post-pressure size.
        mem = this.context.status({
          dialogue,
          summarizedCount: effectiveWm.summarizedCount,
          summarizedThroughMessageId: effectiveWm.summarizedThroughMessageId,
          policy,
          overheadTokens: systemTokens,
          assembledPromptTokens,
          tokenCounter: counter,
        });
        slice = this.context.toSummarizeSlice({
          dialogue,
          watermarkEnd: mem.watermarkEnd,
          policy,
          shouldSummarize: mem.shouldSummarize,
          contextTriggered: mem.compressReason === "context",
          tokenCounter: counter,
          pairBatchCap: mem.adaptivePairBatchSize ?? policy.pairBatchSize,
        });
        steps.push(cacheHit ? "pressure.assemble:cache-hit" : "pressure.assemble");
        steps.push("status+slice:reaccount");
      }
      if (pressurePasses > 0) timings.pressure = now() - tPressure;
    }

    if (softCap > 0 && assembledPromptTokens > softCap) {
      warnings.push(`prompt-budget-trimmed:${assembledPromptTokens}>${softCap}`);
    }

    let messages = baseMessages;
    let systemSections = assembled.systemSections;
    let softTrimmed = false;
    let emergencyDropped = 0;

    const importances = blocks.map((b) => (typeof b.importance === "number" ? b.importance : 50));

    if (!skipSoftTrim) {
      const trimmed = this.guard(
        warnings,
        "compress",
        () =>
          this.context.compress(
            baseMessages,
            softCap > 0 ? softCap : undefined,
            512,
            counter,
            assembled.systemSections,
            {
              softTrimProfile: input.softTrimProfile,
              memoryDocumentImportances: importances,
            },
          ),
        () => ({
          messages:
            softCap > 0
              ? fitMessagesUnderTokenCap(baseMessages, softCap, counter).messages
              : baseMessages,
          systemSections: assembled.systemSections,
        }),
      );
      messages = trimmed.messages;
      systemSections = trimmed.systemSections;
      const beforeSys = baseMessages[0]?.content ?? "";
      const afterSys = messages[0]?.content ?? "";
      softTrimmed =
        systemSections.length !== assembled.systemSections.length ||
        afterSys !== beforeSys ||
        afterSys.startsWith(TRIM_NOTE);
    }

    let promptTokens = countMessages(messages, counter);
    if (fitCap > 0 && promptTokens > fitCap) {
      warnings.push(`prompt-budget-unreachable:dialogue-exceeds-cap:${promptTokens}>${fitCap}`);
      // Soft trim cannot drop dialogue — emergency-drop oldest UA turns so the
      // request still fits n_ctx (compress should have run first; this is the
      // last-resort gate before the provider rejects the call).
      for (let pass = 0; pass < 3 && promptTokens > fitCap; pass += 1) {
        const fitted = fitMessagesUnderTokenCap(messages, fitCap, counter);
        if (fitted.dropped <= 0) break;
        warnings.push(`emergency-dialogue-window:dropped-${fitted.dropped}`);
        messages = fitted.messages;
        emergencyDropped += fitted.dropped;
        steps.push("emergency.dialogueWindow");

        if (!skipSoftTrim && messages[0]?.role === "system") {
          const re = this.guard(
            warnings,
            "compress",
            () =>
              this.context.compress(messages, fitCap, 512, counter, systemSections, {
                softTrimProfile: input.softTrimProfile,
                memoryDocumentImportances: importances,
              }),
            () => ({ messages, systemSections }),
          );
          messages = re.messages;
          systemSections = re.systemSections;
        }
        promptTokens = countMessages(messages, counter);
      }
      if (promptTokens > fitCap) {
        const before = promptTokens;
        const force = fitMessagesUnderTokenCap(messages, fitCap, counter);
        messages = force.messages;
        promptTokens = countMessages(messages, counter);
        emergencyDropped += force.dropped;
        warnings.push(`emergency-fit-forced:${before}->${promptTokens}(cap=${fitCap})`);
        steps.push("emergency.forcedFit");
      }
    }

    // Absolute hard-fit invariant: softCap ≤ hardFit, but softTrimOff / pressure
    // miss / non-monotonic counters can still leave us over. Never return over hardCap.
    if (mode === "generate" && hardCap > 0 && promptTokens > hardCap) {
      const before = promptTokens;
      const force = fitMessagesUnderTokenCap(messages, hardCap, counter);
      messages = force.messages;
      promptTokens = countMessages(messages, counter);
      emergencyDropped += force.dropped;
      warnings.push(`hard-fit-enforced:${before}->${promptTokens}(cap=${hardCap})`);
      steps.push("emergency.hardFit");
    }

    const fitsHardFit = !(mode === "generate" && hardCap > 0) || promptTokens <= hardCap;
    if (!fitsHardFit) {
      warnings.push(`hard-fit-violated:${promptTokens}>${hardCap}`);
    }

    /*
     * Which tier paid for the trim. Cheap when the counter is memoized (the same
     * section strings were counted during accounting).
     *
     * The "after" side must describe the prompt that actually ships. The
     * emergency gates above can rewrite `messages[0]` without refreshing
     * `systemSections`, and the previous code attributed against that stale list:
     * measured, the system was cut from 1507 → 286 chars while attribution still
     * reported `untouched: true, clippedTokens: 0` — the most aggressive trim in
     * the pipeline was reported as "nothing was trimmed" on the dashboard.
     *
     * When the section list no longer matches the shipped text we fall back to a
     * single-tier "after" (all of the shipped system under one priority). That is
     * coarser than per-tier attribution but it is *true*, which is the property
     * that matters here.
     */
    const shippedSystem = messages[0]?.role === "system" ? (messages[0].content ?? "") : "";
    const sectionsMatchShipped =
      systemSections.map((s) => s.text).join("\n\n") === shippedSystem ||
      systemSections.reduce((n, s) => n + counter.count(s.text ?? ""), 0) ===
        counter.count(shippedSystem);
    const afterSections: PromptSection[] = sectionsMatchShipped
      ? systemSections
      : shippedSystem
        ? [{ text: shippedSystem, priority: systemSections[0]?.priority ?? 0 }]
        : [];
    const budgetAttribution = attributeBudget(assembled.systemSections, afterSections, counter);

    /*
     * Replayable input snapshot — only built when the telemetry asks for it.
     *
     * Fields are listed explicitly rather than passing `input` through: the raw
     * input carries `tokenCounter`, which is a function and would vanish in
     * `JSON.stringify`, leaving a "replayable" record that cannot actually be
     * replayed. The counter's identity is recorded instead, which is what a replay
     * needs to know (and to warn about).
     */
    let inputSnapshot: unknown;
    if (this.telemetry?.captureInputsEnabled) {
      inputSnapshot = {
        mode,
        profile: profile as unknown,
        dialogue: input.dialogue,
        summary: input.summary ?? null,
        summaryBlocks: input.summaryBlocks ?? null,
        summarizedCount: input.summarizedCount ?? 0,
        summarizedThroughMessageId: input.summarizedThroughMessageId ?? null,
        pairBatchSize: input.pairBatchSize,
        memory: input.memory ?? null,
        contextTokenLimit: input.contextTokenLimit,
        completionReserveTokens: input.completionReserveTokens,
        softTrimTokenCap: input.softTrimTokenCap,
        maxContextChars: input.maxContextChars,
        loreEntries: loreEntries ?? null,
        vectorHits: input.vectorHits ?? null,
        cacheScope: input.cacheScope ?? null,
        label: input.label ?? null,
        meta: input.meta ?? null,
        counterId,
      };
    }

    timings.trim = now() - tTrim;
    track("trim", "end", timings.trim);
    yield* this.checkpointWire(wireGen);

    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    timings.total = now() - t0;
    track("_run", "end", timings.total);
    yield* this.checkpointWire(wireGen);

    return this.finish({
      mode,
      host,
      startedAt: t0,
      messages,
      systemSections,
      promptChars,
      promptTokens,
      summary: summaryJoined || input.summary || "",
      summaryBlocks: blocks,
      memory: mem,
      budget,
      loreInjected,
      loreRuntime,
      slice,
      steps,
      warnings,
      counter,
      counterId,
      timings,
      label: input.label,
      meta: input.meta,
      cacheScope: input.cacheScope,
      memoryAudit: auditReport,
      budgetAttribution,
      inputSnapshot,
      stages: {
        watermarkOnPath: effectiveWm.watermarkOnPath,
        loreSelected: loreResult.length,
        loreCapped,
        vectorInject: vectorWorking.length,
        assembleCacheHit: cacheHit,
        softTrimmed,
        emergencyDropped,
        fitsHardFit,
      },
    });
  }

  /**
   * Async prepare: resolves a real TokenCounter, pre-hydrates HTTP tokenize
   * caches, and retries on CACHE_MISS (new soft-trim strings are not in the
   * caller's corpus).
   */
  async prepareAsync(
    input: CogniStackPrepareInput & { hydrate?: (texts: string[]) => Promise<void>; hydrateOne?: (text: string) => Promise<number> },
  ): Promise<CogniStackPrepareResult> {
    const { hydrate, hydrateOne, ...rest } = input;
    // Always take the live path so progress SSE can flush between stages.
    if (typeof hydrate !== "function") return this.prepareLive(rest);

    const scope: "full" | "status" = (rest.mode ?? "generate") === "status" ? "status" : "full";
    let gen = this.wireGeneration;
    await hydrate(collectTextsForTokenHydrate(rest, scope));
    // connect/wire may rebuildContext while we awaited; re-hydrate once against new ports.
    if (this.wireGeneration !== gen) {
      gen = this.wireGeneration;
      await hydrate(collectTextsForTokenHydrate(rest, scope));
    }
    /*
     * Retry while hydration makes progress — not for a fixed number of rounds.
     *
     * Why: a `CACHE_MISS` carries a single string, so one round can register at
     * most one of them, and a rich prompt needs far more than the 8 the old bound
     * allowed. `collectTextsForTokenHydrate` pre-warms the host's *raw* input
     * strings; it cannot know the composite strings the assembler builds
     * ("档案设定：…", each `【name】\n body` lore block, the joined system block,
     * every soft-trim fragment). Measured on an ordinary card (7 profile fields +
     * 2 summary blocks + personaBio + worldState + vector hits + 4 lore entries):
     * 9 distinct misses, and `prepareAsync` threw `CACHE_MISS` at the caller —
     * the failure mode got *more* likely the bigger the prompt.
     *
     * So: keep going while each round actually registers a new string, and stop
     * the moment one repeats (that means `hydrateOne` is not helping for it — no
     * number of extra rounds will change that). Net effect: an unhydratable
     * string fails immediately with the offending text named, instead of after an
     * arbitrary count, and large prompts simply finish.
     */
    const seenMisses = new Set<string>();
    const maxRounds = 512;
    for (let attempt = 0; attempt < maxRounds; attempt += 1) {
      if (this.wireGeneration !== gen) {
        gen = this.wireGeneration;
        await hydrate(collectTextsForTokenHydrate(rest, scope));
      }
      try {
        return await this.prepareLive(rest);
      } catch (err) {
        const miss = err as { code?: string; missText?: string };
        if (miss?.code !== "CACHE_MISS" || typeof hydrateOne !== "function") throw err;
        const text = miss.missText ?? "";
        const key = text || "<empty-miss-text>";
        if (seenMisses.has(key)) {
          const stalled = new Error(
            `CACHE_MISS stalled: hydrateOne did not register ${JSON.stringify(text.slice(0, 80))}`,
          ) as Error & { code?: string };
          stalled.code = "CACHE_MISS_STALLED";
          throw stalled;
        }
        seenMisses.add(key);
        if (text) await hydrateOne(text);
        await hydrate(collectTextsForTokenHydrate(rest, scope));
        continue;
      }
    }
    throw new Error(`CACHE_MISS retry budget exhausted after ${maxRounds} rounds`);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                        */
  /* ---------------------------------------------------------------- */

  /** Raw prompt window: overlap of covered pairs + all uncommitted messages. */
  private buildRawWindow(
    dialogue: DialogueMessage[],
    watermarkEnd: number,
    policy: MemoryCompressPolicy,
    steps: string[],
  ): DialogueMessage[] {
    let raw = this.memory.promptRawMessages(dialogue, watermarkEnd, policy.overlapPairs);
    // U-05: keep a leading assistant preamble (e.g. first_mes) even when the
    // watermark window would otherwise omit it.
    const preamble = this.memory.leadingPreamble(dialogue);
    if (preamble.length) {
      // 身份去重：`watermarkEnd < 0` 时 `promptRawMessages` 已返回整段对白
      // （含 preamble，且是同一批对象引用）。只按 id 去重不够 —— 无 id 的
      // first_mes 会被再次前置，导致每轮 prompt 都重复注入开场白。
      const rawSet = new Set(raw);
      const seen = new Set(raw.map((m) => m.id).filter((id): id is string => Boolean(id)));
      const missing = preamble.filter(
        (m) => !rawSet.has(m) && !m.encrypted && (!m.id || !seen.has(m.id)),
      );
      if (missing.length) {
        raw = [...missing, ...raw];
        steps.push("memory.leadingPreamble");
      }
    }
    return raw;
  }

  private resolveFragments(
    input: CogniStackPrepareInput,
    dialogue: DialogueMessage[],
    warnings: string[],
  ): AssembleFragments {
    const preset = this.resolved.preset;
    if (!preset) return { systemPrefix: [], systemSuffix: [], depthInserts: [] };
    const turnIndex = dialogue.filter((m) => m.role === "user").length;
    return this.guard(
      warnings,
      "prompt-preset",
      () =>
        preset.resolve({
          preset: input.preset,
          authorsNote: input.authorsNote,
          turnIndex,
        }),
      () => ({ systemPrefix: [], systemSuffix: [], depthInserts: [] }) as AssembleFragments,
    );
  }

  /** Assemble with a per-scope fingerprint cache (LRU). */
  private assembleCached(params: {
    input: CogniStackPrepareInput;
    assembleOptions: AssembleSectionOptions;
    summaryJoined: string;
    blocks: SummaryBlock[];
    rawForPrompt: DialogueMessage[];
    lore: Array<LoreEntryLike | WorldBookEntryLike>;
    worldBookEnabled: boolean;
    scanText: string;
    fragments: AssembleFragments;
    vectorHits: { name?: string | undefined; content: string }[];
    warnings: string[];
  }): { assembled: ContextAssembleResult; cacheHit: boolean } {
    const { input } = params;
    const key = cacheKey([
      JSON.stringify(params.assembleOptions),
      JSON.stringify(input.assembleLimits ?? null),
      JSON.stringify(input.macros ?? null),
      params.summaryJoined,
      JSON.stringify(input.worldState ?? null),
      contentFpCached(input.personaBio),
      params.lore
        .map(
          (e) =>
            // position / depth / role 决定条目插到哪里、以什么角色插入。漏进键会让
            // "只改了插入位置"的编辑命中旧缓存（假命中 → 旧版式的 prompt）。
            `${e.id}|${e.name}|${String(e.position ?? "")}|${String(e.depth ?? "")}|${String(
              e.role ?? "",
            )}|${contentFpCached(e.content)}`,
        )
        .join(";"),
      params.rawForPrompt
        .map(
          (m) =>
            // encrypted 标志本身也要入键：空内容密文与空内容明文内容指纹相同，
            // 但装配时一个被跳过、一个产出空消息。
            `${m.id ?? ""}:${m.role}:${m.encrypted ? 1 : 0}:${contentFpCached(
              m.encrypted ? "" : m.content,
            )}`,
        )
        .join("|"),
      params.vectorHits.map((h) => `${h.name ?? ""}:${contentFpCached(h.content)}`).join("|"),
      JSON.stringify(params.fragments),
      JSON.stringify(
        (input.regexScripts ?? []).map((s) => ({
          id: String(s.id ?? ""),
          find: String(s.find ?? ""),
          replace: String(s.replace ?? ""),
          // 只键 find/replace 会漏掉"同一脚本被禁用 / 改 placement / 改 flags"
          // 的情况：切开关后仍命中旧缓存，返回被正则改写过的 prompt。
          enabled: s.enabled ?? null,
          flags: s.flags ?? null,
          placement: s.placement ?? null,
        })),
      ),
      this.systemRules ?? "",
      input.card?.name ?? "",
      contentFpCached(input.card?.description),
      contentFpCached(input.card?.personality),
      contentFpCached(input.card?.scenario),
      contentFpCached(input.card?.system_prompt),
      contentFpCached(input.card?.post_history_instructions),
      contentFpCached(input.card?.mes_example),
      // depth_prompt 除 prompt 外还有 depth / role，二者都会改变插入位置与角色。
      JSON.stringify(input.card?.depth_prompt ?? null),
      /*
       * Whole-profile fingerprint, last so the specific fields above stay readable
       * in the key. The explicit list covers `defaultCardResolver`; it does NOT
       * cover a host-supplied `card` port, which may render any other field.
       * Measured: with a custom resolver, editing only `creator` returned
       * `cacheHit: true` and a prompt still holding the old value.
       */
      stableValueFp(input.profile ?? input.card),
    ]);

    const scope = (input.cacheScope ?? "").trim() || DEFAULT_CACHE_SCOPE;
    const cached = this.assembleCache.get(scope);
    if (cached?.key === key) {
      this.assembleCache.delete(scope);
      this.assembleCache.set(scope, cached);
      // Never hand out the cached object graph — callers must not poison the cache.
      return { assembled: cloneAssembleResult(cached.result), cacheHit: true };
    }

    const warnBefore = params.warnings.length;
    const assembled = this.guard(
      params.warnings,
      "assemble",
      () =>
        this.context.assemble({
          profile: input.profile ?? input.card,
          card: (input.profile ?? input.card)!,
          selectedLore: params.lore,
          loreEntries: params.lore,
          loreEnabled: params.worldBookEnabled,
          worldBookEnabled: params.worldBookEnabled,
          scanText: params.scanText,
          summary: params.summaryJoined,
          summaryBlocks: params.blocks,
          worldState: input.worldState ?? null,
          personaBio: input.personaBio,
          recentMessages: params.rawForPrompt,
          macros: params.input.macros,
          options: params.assembleOptions,
          limits: input.assembleLimits,
          fragments: params.fragments,
          regexScripts: input.regexScripts,
          vectorHits: params.vectorHits,
          systemRules: this.systemRules,
        }),
      () => ({ messages: [], loreInjected: [], notes: [], systemSections: [] }),
    );

    const failed = params.warnings
      .slice(warnBefore)
      .some((w) => w.includes("assemble-failed"));
    if (!failed) {
      this.assembleCache.set(scope, { key, result: cloneAssembleResult(assembled) });
      while (this.assembleCache.size > this.assembleCacheSize) {
        const oldest = this.assembleCache.keys().next().value;
        if (oldest === undefined) break;
        this.assembleCache.delete(oldest);
      }
    }
    return { assembled, cacheHit: false };
  }

  private guard<T>(
    warnings: string[],
    label: string,
    fn: () => T,
    fallback: T | (() => T),
  ): T {
    try {
      return fn();
    } catch (err) {
      // Soft-trim mints new strings that are not in the HTTP tokenize cache.
      // Bubble CACHE_MISS so prepareAsync can hydrateOne and retry, instead of
      // swallowing it into a sticky「已降级」banner with an over-budget prompt.
      const tokenErr = err as { code?: string };
      if (tokenErr?.code === "CACHE_MISS") throw err;
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(formatGuardWarning(label, detail));
      return typeof fallback === "function" ? (fallback as () => T)() : fallback;
    }
  }

  private finish(params: {
    mode: PrepareMode;
    host: HostIdentity;
    startedAt: number;
    messages: RpMessage[];
    systemSections: PromptSection[];
    promptChars: number;
    promptTokens: number;
    summary: string;
    summaryBlocks: SummaryBlock[];
    memory: CogniStackStatus;
    budget: ResolvedBudget;
    loreInjected: { id: string; name: string }[];
    loreRuntime: LoreRuntimeState;
    slice: CompressSlicePlan;
    steps: string[];
    warnings: string[];
    counter: MemoizedCounter;
    counterId: string;
    timings: Record<string, number>;
    stages: CogniStackDiagnostics["stages"];
    label?: string | undefined;
    meta?: Record<string, string | number | boolean> | undefined;
    cacheScope?: string | undefined;
    /** Present only when `auditMemory` is enabled and there was a document to check. */
    memoryAudit?: MemoryAuditReport | undefined;
    /** Per-priority-tier token attribution (which section paid for the trim). */
    budgetAttribution?: BudgetAttribution | undefined;
    /** Attached only when telemetry has `captureInputs` enabled (see TurnRecord). */
    inputSnapshot?: unknown;
  }): CogniStackPrepareResult {
    const severity = partitionPrepareWarnings(params.warnings);
    const timings = params.timings;
    timings.total = now() - params.startedAt;

    // Prefix reuse is per (scope, mode): mixing them would make each mode look
    // like it drifts every turn. Status mode carries no messages, so it reports
    // `comparable: false` and costs nothing.
    const prefixStability = this.prefixTracker.observe(
      `${(params.cacheScope ?? "").trim() || DEFAULT_CACHE_SCOPE}::${params.mode}`,
      params.messages as unknown as PrefixInput[],
      params.counter,
    );

    if (this.telemetry) {
      this.telemetry.record({
        host: params.host,
        mode: params.mode,
        label: params.label,
        meta: params.meta,
        cacheScope: params.cacheScope,
        messages: params.messages.length,
        systemSections: params.systemSections.length,
        promptTokens: params.promptTokens,
        promptChars: params.promptChars,
        loreCount: params.loreInjected.length,
        vectorHits: params.stages.vectorInject,
        loreInjected: params.loreInjected,
        budget: params.budget,
        memory: {
          shouldSummarize: params.memory.shouldSummarize,
          compressReason: params.memory.compressReason ?? null,
          pendingPairs: params.memory.pendingPairs,
          contextUsed: params.memory.contextUsed,
          contextTriggerAt: params.memory.contextTriggerAt,
          watermarkEnd: params.memory.watermarkEnd,
          summarizedCount: params.memory.summarizedCount,
        },
        toSummarizePairCount: params.slice.pairCount,
        warnings: params.warnings,
        degraded: severity.isDegraded,
        cacheHit: params.stages.assembleCacheHit,
        emergencyDropped: params.stages.emergencyDropped,
        softTrimmed: params.stages.softTrimmed,
        steps: params.steps,
        durationMs: timings.total,
        timings,
        counter: params.counter.stats(),
        counterId: params.counterId,
        prefixStability,
        budgetTiers: params.budgetAttribution?.tiers.map((t) => ({
          priority: t.priority,
          before: t.beforeTokens,
          after: t.afterTokens,
        })),
        inputSnapshot: params.inputSnapshot,
        ports: this.ports,
      });
    }

    return {
      engine: COGNISTACK_ENGINE_ID,
      version: COGNISTACK_VERSION,
      mode: params.mode,
      messages: params.messages,
      systemSections: params.systemSections,
      promptChars: params.promptChars,
      promptTokens: params.promptTokens,
      summary: params.summary,
      summaryBlocks: params.summaryBlocks,
      memory: params.memory,
      budget: params.budget,
      loreInjected: params.loreInjected,
      loreRuntime: params.loreRuntime,
      toSummarize: params.slice.items.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      })),
      toSummarizePairCount: params.slice.pairCount,
      nextSummarizedCount: params.slice.nextSummarizedCount,
      nextSummarizedThroughMessageId: params.slice.nextSummarizedThroughMessageId,
      steps: params.steps,
      warnings: params.warnings,
      prefixStability,
      diagnostics: {
        severity,
        counter: params.counter.stats(),
        counterId: params.counterId,
        timings,
        cacheHit: params.stages.assembleCacheHit,
        prefixStability,
        ...(params.memoryAudit ? { memoryAudit: params.memoryAudit } : {}),
        ...(params.budgetAttribution ? { budgetAttribution: params.budgetAttribution } : {}),
        stages: params.stages,
      },
    };
  }
}

/**
 * `Omit` over the union inside {@link CogniStackPrepareInput} would collapse it to
 * "both identity fields optional" — exactly the shape that union exists to
 * forbid, so the host handle would silently lose the constraint. Distributing the
 * omit keeps "at least one of profile / card" intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A caller-scoped view of one engine.
 *
 * Every call through this handle is stamped with the host identity, so telemetry
 * can attribute turns to the system that issued them. Returned by
 * {@link CogniStackEngine.forHost}.
 */
export class CogniStackHostHandle {
  constructor(
    private readonly engine: CogniStackEngine,
    readonly host: HostIdentity,
  ) {}

  prepare(input: DistributiveOmit<CogniStackPrepareInput, "host">): CogniStackPrepareResult {
    return this.engine.prepare({ ...input, host: this.host });
  }

  prepareLive(input: DistributiveOmit<CogniStackPrepareInput, "host">): Promise<CogniStackPrepareResult> {
    return this.engine.prepareLive({ ...input, host: this.host });
  }

  prepareAsync(
    input: DistributiveOmit<CogniStackPrepareInput, "host"> &
      Partial<Pick<CogniStackPrepareInput, "host">>,
  ): Promise<CogniStackPrepareResult> {
    return this.engine.prepareAsync({ ...input, host: this.host });
  }

  /** Delegate to the underlying engine (no host stamping needed). */
  get raw(): CogniStackEngine {
    return this.engine;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function createCogniStackEngine(opts?: CogniStackOptions): CogniStackEngine {
  return new CogniStackEngine(opts);
}

/** Tail-biased scan corpus (same algorithm as the RP WorldBookEngine). */
export function buildLoreScanText(params: {
  headText?: string;
  rawTail: string;
  maxChars: number;
}): string {
  const max = Math.max(200, Math.floor(params.maxChars || 4_000));
  const raw = params.rawTail || "";
  if (raw.length >= max) return raw.slice(-max);
  const head = (params.headText || "").trim();
  if (!head) return raw;
  const remain = max - raw.length - 1;
  if (remain <= 0) return raw;
  const headPart = head.length > remain ? head.slice(-remain) : head;
  return [headPart, raw].filter(Boolean).join("\n");
}

/**
 * Pre-hydrate corpus for HTTP tokenize counters.
 * `status` scope skips card/lore/preset strings the status path never counts.
 */
export function collectTextsForTokenHydrate(
  input: CogniStackPrepareInput,
  scope: "full" | "status" = "full",
): string[] {
  const out: string[] = [];
  const push = (t?: string | null) => {
    if (t) out.push(t);
  };
  push(input.summary);
  for (const b of input.summaryBlocks ?? []) push(b.text);
  for (const m of input.dialogue ?? []) push(m.content);
  if (scope === "status") return out;

  push(input.personaBio);
  push(input.scanText);
  // 首选别名优先：HTTP 调用方按 README 字段百科传 profile / loreEntries，
  // 这里若只读 card / worldEntries，预热表为空 → HTTP tokenize 计数器整轮 CACHE_MISS。
  const card = input.profile ?? input.card;
  if (card) {
    push(card.name);
    push(card.description);
    push(card.personality);
    push(card.scenario);
    push(card.system_prompt);
    push(card.mes_example);
    push(card.post_history_instructions);
    push(card.first_mes);
    push(card.depth_prompt?.prompt);
  }
  for (const e of input.loreEntries ?? input.worldEntries ?? []) {
    push(e.name);
    push(e.content);
  }
  for (const e of input.worldState?.entries ?? []) {
    push(e.key);
    push(e.value);
  }
  for (const h of input.vectorHits ?? []) {
    push(h.name);
    push(h.content);
  }
  for (const m of Object.values(input.macros ?? {})) {
    if (typeof m === "string") push(m);
  }
  // Soft-trim budgets compute noteTokens + count(body); hydrate the note once.
  push(TRIM_NOTE);
  return out;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Deep-enough clone so callers cannot mutate the assemble cache entry. */
function cloneAssembleResult(r: ContextAssembleResult): ContextAssembleResult {
  return {
    messages: r.messages.map((m) => ({ ...m })),
    loreInjected: r.loreInjected.map((e) => ({ ...e })),
    notes: r.notes.slice(),
    systemSections: r.systemSections.map((s) => ({ ...s })),
  };
}

export type { WarningSeverity };

/**
 * 一次协议接入的句柄。
 *
 * 持有它才能调用引擎（`conn.handle.prepare(...)`），或者直接 `close()` 断开 ——
 * 断开后该系统提供的端口自动回退到下一个提供方或引擎缺省，无需手动清理。
 */
export class CogniStackConnection {
  readonly connectedAt = Date.now();
  private closed = false;
  /**
   * 真私有（`#`）字段，**不是** TS 的 `private`。
   *
   * `connectionsList()` 会把句柄交给调用方，而 TS `private` 只在类型层生效 ——
   * 运行时 `conn.engine` 照样读得到，等于把引擎实例（装配缓存、内部状态）交给
   * 任何拿到列表的人。`#` 是运行时真私有：名字不落在实例上，读不到也改不了。
   */
  readonly #engine: CogniStackEngine;

  constructor(
    engine: CogniStackEngine,
    readonly manifest: ConnectManifest,
    /** Generation token — stale handles after reconnect must not drop the new one. */
    private readonly generation: number,
  ) {
    this.#engine = engine;
  }

  get id(): string {
    return this.manifest.id;
  }

  /** 该连接当前实际接上的端口（可能随其它连接的接入/断开而变化）。 */
  get wired(): string[] {
    return PORT_NAMES.filter((p) => this.#engine.portTable().some(
      (b) => b.port === p && b.providerId === this.manifest.id,
    ));
  }

  /** 宿主句柄：所有调用自动盖上本系统的身份戳。 */
  get handle(): CogniStackHostHandle {
    const { id, name, kind, version, meta } = this.manifest;
    return this.#engine.forHost({ id, name, kind, version, meta });
  }

  /** 刷新清单（例如提供方升级后换了实现）。undefined 字段不覆盖。 */
  update(patch: Partial<ConnectManifest>): this {
    if (this.closed) throw new Error("connection already closed");
    for (const key of Object.keys(patch) as (keyof ConnectManifest)[]) {
      const value = patch[key];
      if (value !== undefined) {
        (this.manifest as Record<string, unknown>)[key] = value;
      }
    }
    this.#engine._refreshConnection(this);
    return this;
  }

  /** 断开接入。对重连后的旧句柄是空操作。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#engine._dropConnection(this.manifest.id, this.generation);
  }
}

