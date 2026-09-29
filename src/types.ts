/**
 * Shared turn / prompt types (package-local; no DB coupling).
 *
 * Naming: preferred names are domain-neutral (MessageRole, LoreEntryLike, …).
 * Legacy RP/ST aliases (`Rp*`, `WorldBook*`, `CharacterCard*`) remain for
 * wire/API compatibility — see docs/decisions/ADR-001-de-rp-naming.md.
 */

/** Chat / completion roles. */
export type MessageRole = "system" | "user" | "assistant";
/** @deprecated Use {@link MessageRole} */
export type RpRole = MessageRole;

/**
 * Opaque prompt-preset payload. CogniStack passes it to the `PresetResolver`
 * port untouched; the shape belongs to the host.
 */
export type PromptPresetLike = Record<string, unknown>;

/** Opaque side-note / authors-note payload (see PromptPresetLike). */
export type AuthorsNoteLike = Record<string, unknown>;

/**
 * Normalized find/replace script (shape-only). Host owns validation.
 * Field layout is compatible with common ST-style regex script packs.
 */
export type RegexScriptLike = {
  id?: string;
  name?: string;
  find: string;
  replace: string;
  placement?: string | string[];
  enabled?: boolean;
  flags?: string;
  [key: string]: unknown;
};

/** One message in an assembled prompt (ready for a chat API). */
export type PromptMessage = {
  role: MessageRole;
  content: string;
};
/** @deprecated Use {@link PromptMessage} */
export type RpMessage = PromptMessage;

/** Injectable token budget seam — must be a real tokenizer counter. */
export type TokenCounter = {
  count(text: string): number;
  /**
   * Optional stable identity of the underlying tokenizer, e.g.
   * `"http:/tokenize"`, `"tiktoken:cl100k_base"`, `"char-exact(test-only)"`.
   *
   * Why this is part of the contract: every budget / soft-trim / emergency-drop
   * decision is derived from `count()`. When a host runs a test double by
   * accident, nothing in the returned result says so — the numbers just look
   * plausible. Carrying an identity lets `diagnostics.counterId` and telemetry
   * expose it, turning a silent distortion into a visible one.
   */
  id?: string;
};

export type DepthPromptSpec = {
  prompt: string;
  /** Depth from end of chat history (0 = after last message) */
  depth: number;
  role: MessageRole;
};

/**
 * Agent / system profile injected into the prompt.
 * Wire field names (`mes_example`, …) are stable for storage compat;
 * treat them as: brief, style, operating context, few-shot, post-history note.
 */
export type AgentProfileLike = {
  first_mes?: string;
  /** Agent brief / capability description */
  description?: string;
  /** Tone / style hints */
  personality?: string;
  /** Operating context for this session */
  scenario?: string;
  system_prompt?: string;
  /** Few-shot examples (legacy field name) */
  mes_example?: string;
  post_history_instructions?: string;
  name?: string;
  /** Injected at chat depth, not folded into post_history */
  depth_prompt?: DepthPromptSpec | null;
};
/** @deprecated Use {@link AgentProfileLike} */
export type CharacterCardLike = AgentProfileLike;

/**
 * Lore insert slot (numeric index or string alias).
 * Wire values kept for storage compat:
 * 0 before_char · 1 after_char · 2 before_example · 3 after_example ·
 * 4 AN top · 5 AN bottom · 6 at_depth
 */
export type LoreSlot =
  | number
  | "before_char"
  | "after_char"
  | "before_example"
  | "after_example"
  | "an_top"
  | "an_bottom"
  | "at_depth";
/** @deprecated Use {@link LoreSlot} */
export type WorldBookPosition = LoreSlot;

/** One retrievable knowledge / policy / FAQ snippet. */
export type LoreEntryLike = {
  id: string;
  name: string;
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  insertionOrder: number;
  caseSensitive?: boolean | undefined;
  /** Secondary keys — AND filter when present */
  secondaryKeys?: string[] | undefined;
  /** Activation probability 0–100 (absent = always) */
  probability?: number | undefined;
  position?: LoreSlot | undefined;
  /** Used when position is at_depth / 6 */
  depth?: number | undefined;
  /** Role when inserted as a history message */
  role?: MessageRole | undefined;
  /** Scan only the last N dialogue messages (0 / absent = full scanText) */
  scanDepth?: number | undefined;
  /** Allow this entry's content to unlock further keyed entries */
  recursive?: boolean | undefined;
  /** Never use this entry's content to expand the recursive scan */
  preventRecursion?: boolean | undefined;
  /** Keep injecting for N turns after activation */
  sticky?: number | undefined;
  /** After activation, ignore for N turns */
  cooldown?: number | undefined;
  /** Require N consecutive matching turns before first activation */
  delay?: number | undefined;
};
/** @deprecated Use {@link LoreEntryLike} */
export type WorldBookEntryLike = LoreEntryLike;

/** Per-chat lore timers for sticky / cooldown / delay. */
export type LoreRuntimeState = {
  stickyRemaining?: Record<string, number>;
  cooldownRemaining?: Record<string, number>;
  delayProgress?: Record<string, number>;
};

export type DialogueMessage = {
  /** Stable id when available (watermark / CAS). */
  id?: string;
  role: string;
  content: string;
  encrypted?: boolean;
  /** Group chat speaker (assistant rows). */
  characterId?: string | null;
};

/** One committed long-term memory block (replaces a batch of raw pairs). */
export type SummaryBlock = {
  id: string;
  text: string;
  /** Last dialogue message id covered by this block (usually an assistant). */
  throughMessageId: string;
  /** Complete UA pairs folded into this block (informational). */
  pairCount?: number | undefined;
  /**
   * `full` = structured REPLACE document; `episode` = rolling batch slice
   * when maxBlocks > 1. Omitted on legacy rows → treat as full.
   */
  kind?: "full" | "episode" | undefined;
  /** 0–100 retention hint for soft trim (higher survives longer). */
  importance?: number | undefined;
};

/** Fixed column headers for structured long-term memory documents. */
export const MEMORY_COLUMN_TITLES = [
  "【硬事实】",
  "【时间线】",
  "【关系与称呼】",
  "【未决】",
  "【近期情节】",
] as const;

export type MemoryColumnTitle = (typeof MEMORY_COLUMN_TITLES)[number];

/**
 * Sacrifice order when clipping a structured memory doc (first = drop first).
 * Hard facts are last resort.
 */
export const MEMORY_COLUMN_SACRIFICE_ORDER: MemoryColumnTitle[] = [
  "【近期情节】",
  "【时间线】",
  "【关系与称呼】",
  "【未决】",
  "【硬事实】",
];

/** One dynamic facet of the session snapshot (keys evolve per turn). */
export type WorldStateEntry = {
  key: string;
  value: string;
};
/** @deprecated Use {@link WorldStateEntry} */
export type RpWorldStateEntry = WorldStateEntry;

/**
 * Structured session / environment snapshot.
 * Not a fixed schema — entries are created/renamed/dropped by the host.
 */
export type WorldState = {
  entries: WorldStateEntry[];
};
/** @deprecated Use {@link WorldState} */
export type RpWorldState = WorldState;

export type MemoryStatus = {
  dialogueCount: number;
  summarizedCount: number;
  pending: number;
  /** Complete UA pairs not yet under watermark */
  pendingPairs: number;
  /** Total chars of not-yet-committed dialogue (early-char trigger input) */
  pendingChars: number;
  /** Token estimate of pending dialogue (TokenCounter) */
  pendingTokens?: number;
  /** Estimated live context (committed memory + uncommitted dialogue) in budget units */
  contextUsed: number;
  /** Context size that triggers compression (0 = context trigger disabled) */
  contextTriggerAt: number;
  shouldSummarize: boolean;
  /**
   * Why compress was triggered:
   * - `context` = ①上下文长度阈值压缩
   * - `batch` = ②对话回合数压缩
   */
  compressReason?: "batch" | "context" | null;
  /** U-06: effective N after context-fill adaptation (may be < policy.pairBatchSize). */
  adaptivePairBatchSize?: number;
};

/**
 * Names for `{{char}}` / `{{user}}` substitution in assembled prompts.
 * For non-RP hosts: `char` ≈ agent display name, `user` ≈ end-user label.
 */
export type MacroNames = {
  char?: string;
  user?: string;
  /** Full profile title when distinct from short agent name (output scrubbing). */
  charTitle?: string;
};

/**
 * memory.v2 policy for batch-replace compression (no silent raw drops).
 * Budget fields are in **token units** via a real TokenCounter
 * (tiktoken or /tokenize); historically named *Char* for API compat.
 *
 * Prefer the `*Token*` aliases when writing new code; `normalizeCompressPolicy`
 * maps them onto the canonical *Char* fields.
 */
export type MemoryCompressPolicy = {
  /** ② 对话回合数压缩：完整 UA 回合数 N */
  pairBatchSize: number;
  /** M: max committed summary blocks */
  maxBlocks: number;
  /** K: already-covered pairs still kept as raw overlap */
  overlapPairs: number;
  /**
   * Soft total prompt budget in **tokens** (historical *Char* name).
   * Shrinks system (lore/blocks), never drops unsummarized dialogue. 0 = off.
   */
  totalPromptCharCap: number;
  /** Preferred alias for `totalPromptCharCap` (token units). */
  totalPromptTokenCap?: number;
  /**
   * ① 上下文长度阈值压缩：模型上下文长度（token；历史字段名 *Char*）。
   * > 0 时占用达到 `contextCharLimit × contextTriggerRatio` 即压。
   */
  contextCharLimit: number;
  /** Preferred alias for `contextCharLimit` (token units). */
  contextTokenLimit?: number;
  /** ① 上下文长度阈值压缩：阈值（0~1），默认 0.7 */
  contextTriggerRatio: number;
  /** Cap for a single summary block (chars); overflow is clipped head+tail */
  maxBlockChars: number;
  /** Cap for ALL committed blocks combined (chars). 0 = unlimited */
  maxTotalBlockChars: number;
  /**
   * Cap for one compress-batch transcript in **tokens** (historical *Char* name).
   * Protects the summary LLM call. Prefer `maxBatchTokenCap` when writing new code.
   */
  maxBatchChars: number;
  /** Preferred alias for `maxBatchChars` (token units). */
  maxBatchTokenCap?: number;
  /**
   * When true, skip O-06 auto soft-trim default (context×0.95) even if
   * totalPromptCharCap is 0. Does NOT disable an explicit totalPromptCharCap.
   */
  softTrimOff?: boolean | undefined;
};

export type PrepareTurnInput = {
  /** Preferred: agent / system profile */
  profile?: AgentProfileLike;
  /** @deprecated Use `profile` */
  card: CharacterCardLike;
  /** Preferred: knowledge / policy snippets */
  loreEntries?: LoreEntryLike[];
  /** @deprecated Use `loreEntries` */
  worldEntries?: WorldBookEntryLike[];
  /** Denormalized joined summary (compat / preview) */
  summary?: string | null;
  /** Preferred: committed blocks (oldest → newest) */
  summaryBlocks?: SummaryBlock[] | null;
  /** Full dialogue (user+assistant), oldest → newest */
  dialogue: DialogueMessage[];
  /**
   * @deprecated memory.v2: not used for prompt window. Kept for API compat.
   * Callers may omit; defaults ignored for slicing.
   */
  memoryWindow?: number;
  /** Messages covered by committed blocks (compat integer watermark) */
  summarizedCount: number;
  /** Message id watermark; wins over summarizedCount when resolvable */
  summarizedThroughMessageId?: string | null;
  /**
   * N = complete pairs per batch.
   * Legacy rows may still store message thresholds; callers should migrate.
   */
  summarizeEvery: number;
  /** Override policy knobs (engine settings); merged with summarizeEvery as N */
  compressPolicy?: Partial<MemoryCompressPolicy>;
  /** Text used for lore key scan; if omitted, built tail-biased */
  scanText?: string;
  /** When false, assemble skips lore selection (default true) */
  loreEnabled?: boolean;
  /** @deprecated Use `loreEnabled` */
  worldBookEnabled?: boolean;
  /**
   * @deprecated Silent dialogue drop removed. Mapped to totalPromptCharCap
   * when compressPolicy.totalPromptCharCap unset.
   */
  maxContextChars?: number;
  /** Display names for macros; defaults from profile.name */
  macros?: MacroNames;
  /** Optional end-user persona bio injected near the profile */
  personaBio?: string | null;
  /** Structured session snapshot */
  worldState?: WorldState | null;
  /** Max chars for lore scan when scanText omitted */
  scanMaxChars?: number;
  /** When false, scan head omits joined memory blocks */
  includeMemoryInScan?: boolean;
  /**
   * Soft-trim priority profile — remaps SECTION_PRIORITY during sacrifice.
   * - balanced: default priorities
   * - protectLore: keep knowledge snippets longer
   * - protectMemory: keep long-term memory longer
   */
  softTrimProfile?: "balanced" | "protectLore" | "protectMemory";
  /**
   * Soft compress: minimum leading-system budget kept when trimming.
   * Unit is **tokens** (historical name kept for API compat).
   * Prefer `minSystemTokens` when both are set.
   */
  minSystemChars?: number;
  /** Preferred alias for `minSystemChars` (token units). */
  minSystemTokens?: number;
  /** Fine-grained assemble section toggles + textBind behavior */
  assembleOptions?: {
    includeSystemRules?: boolean;
    includeSystemPrompt?: boolean;
    includeDescription?: boolean;
    includePersonality?: boolean;
    includeScenario?: boolean;
    includeMesExample?: boolean;
    includePersona?: boolean;
    /** Preferred */
    includeLore?: boolean;
    /** @deprecated Use `includeLore` */
    includeWorldBook?: boolean;
    includeState?: boolean;
    includeSummary?: boolean;
    includePostHistory?: boolean;
    bindPrompt?: boolean;
    scrubHistory?: boolean;
    formatMesExample?: boolean;
  };
  /** Per-section char budgets forwarded to ContextEngine.assemble */
  assembleLimits?: {
    loreEntryChars?: number;
    stateChars?: number;
    personaChars?: number;
    cardFieldChars?: number;
  };
  /** Sticky / cooldown / delay timers (per chat) */
  loreRuntime?: LoreRuntimeState | null;
  /**
   * When false, lore still injects matches but does not advance
   * sticky/cooldown/delay (compress / post-turn replan). Default true.
   */
  loreTick?: boolean;
  /**
   * Prepare depth:
   * - `generate` (default): full assemble + soft trim — for LLM calls
   * - `status`: watermark + status/slice only — compress replan rounds
   */
  prepareMode?: "generate" | "status";
  /**
   * Tokens reserved for the completion (max_tokens / server default). Soft trim
   * targets `contextLimit - completionReserve - pad` so prompt+output fit n_ctx.
   * Clamped so prompt keeps ≥25% of context, with a hard floor of 64 tokens
   * (see `resolveBudget` 的 `minPromptFloor`)。floor 曾写成 512，与实现不符。
   */
  completionReserveTokens?: number;
  /**
   * When `prepareMode: "status"`, prefer this last real assembled size over the
   * sysFloor heuristic so replan `contextUsed` tracks generate.
   */
  priorAssembledPromptTokens?: number;
  /**
   * Assemble-cache partition (e.g. chatId). Different scopes never share a
   * cached assemble result. Defaults to a single global bucket.
   */
  cacheScope?: string;
  /**
   * Required for prepareTurn (sync). Use prepareTurnAsync / TokenEngine.resolveCounter
   * to obtain a real tiktoken or /tokenize counter — heuristics are forbidden.
   */
  tokenCounter?: TokenCounter;
  /**
   * Prompt preset (host-owned shape). Passed straight to the `PresetResolver`
   * port; CogniStack never inspects it.
   */
  promptPreset?: PromptPresetLike | null;
  /** Session Author's Note (host-owned shape). */
  authorsNote?: AuthorsNoteLike | null;
  /** Regex scripts applied during assemble / output. */
  regexScripts?: RegexScriptLike[] | null;
  /** Semantic retrieval hits (VectorMemoryEngine) */
  vectorHits?: { name?: string; content: string }[] | null;
};

/**
 * One assembled system-prompt section, with its trim priority carried as data.
 *
 * ContextEngine used to sniff the priority out of the first 48 chars of
 * each section's text ("【历史后指令】" → 90, …), so rewording a section
 * silently changed how it was sacrificed. Assemble now stamps the
 * priority onto the section itself; the sniffer stays only as a fallback for
 * callers that hand soft-trim a bare message list.
 */
export type PromptSection = {
  text: string;
  /** 10 = generic rules (sacrificed first) … 90 = post-history instructions */
  priority: number;
};

/** Trim priorities used by ContextEngine.assemble — single source of truth. */
export const SECTION_PRIORITY = {
  systemRules: 10,
  mesExample: 30,
  promptFragment: 40,
  persona: 45,
  /** Agent profile / card fields */
  card: 50,
  /** Knowledge / lore snippets (preferred key) */
  lore: 60,
  /** @deprecated Same value as `lore` — kept for older hosts */
  worldBook: 60,
  worldState: 70,
  vectorMemory: 75,
  memory: 80,
  postHistory: 90,
} as const;

/**
 * 已删除：这里曾有第二份 `PrepareTurnResult` 声明，字段与 `prepare()` 的真实返回类型
 * 互不可赋（外部消费方 `skipLibCheck: false` 时报 TS2741）。类型现在只有一处定义，
 * 公开名 `PrepareTurnResult` 是它的别名，见 `fusion/CogniStackEngine.ts`（ADR-004）。
 */

/** Sampling knobs forwarded to OpenAI-compatible providers (omit unsupported). */
export type LlmSampling = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
};

/** Injected LLM seam (web adapter implements; package does not call providers). */
export type LlmStreamDelta = (delta: string) => void;

export type LlmEngine = {
  stream(params: {
    messages: RpMessage[];
    onDelta: LlmStreamDelta;
    onReasoningDelta?: LlmStreamDelta;
    thinking?: { enabled: boolean; budget?: number };
    sampling?: LlmSampling;
    signal?: AbortSignal;
  }): Promise<string>;
  complete?(params: {
    messages: RpMessage[];
    thinking?: { enabled: boolean; budget?: number };
    sampling?: LlmSampling;
    signal?: AbortSignal;
  }): Promise<string>;
};

/** Standard tool / function call definition for modern LLM agents. */
export type ToolDefinitionLike = {
  type?: "function" | string | undefined;
  name: string;
  description?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
  strict?: boolean | undefined;
};

