/**
 * CogniStack Engine — 统一入口。
 *
 * 上下文引擎（拼装 / 预算 / 软顶）与记忆引擎（水位 / 结构化摘要 / 记忆块 /
 * 向量召回）在此融合为一条管线，对外只有一个 `CogniStackEngine`。
 *
 * 零运行时依赖：token 计数通过 `TokenCounter` 注入，领域数据通过 ports 注入。
 */

/* ------------------------------------------------------------------ */
/* 融合引擎                                                             */
/* ------------------------------------------------------------------ */
export {
  CogniStackEngine,
  CogniStackConnection,
  CogniStackHostHandle,
  createCogniStackEngine,
  buildLoreScanText,
  collectTextsForTokenHydrate,
  COGNISTACK_ENGINE_ID,
  type CogniStackDiagnostics,
  type CogniStackOptions,
  type CogniStackPlan,
  type CogniStackPrepareInput,
  type CogniStackPrepareResult,
  /** @deprecated Alias of `CogniStackPrepareResult` (ADR-004). */
  type PrepareTurnResult,
  type CogniStackStatus,
  type CompressSlicePlan,
} from "./fusion/CogniStackEngine";

/* ------------------------------------------------------------------ */
/* 融合层构件                                                           */
/* ------------------------------------------------------------------ */
export {
  resolveBudget,
  adaptiveSafetyPad,
  adaptiveTemplateOverhead,
  BUDGET_DEFAULTS,
  type BudgetOptions,
  type PrepareMode,
  type ResolvedBudget,
} from "./fusion/budget";
export {
  approximateTokenCounter,
  counterIdentity,
  countMessages,
  exactCharTokenCounter,
  memoizeCounter,
  type CounterStats,
  type MemoizedCounter,
} from "./fusion/counter";
export { clipToTokens, fitMessagesUnderTokenCap, type FitResult } from "./fusion/fitMessages";
export { contentFp, contentFpCached, djb2, djb2b, cacheKey } from "./fusion/fingerprint";
export {
  computePrefixStability,
  fingerprintMessages,
  PrefixTracker,
  type PrefixInput,
  type PrefixSnapshot,
  type PrefixStability,
} from "./fusion/prefixStability";
export {
  attributeBudget,
  type BudgetAttribution,
  type SectionTierAttribution,
} from "./fusion/budgetAttribution";
export {
  buildPrepareChecksum,
  buildTurnObservability,
  classifyPrepareWarning,
  formatGuardWarning,
  partitionPrepareWarnings,
  type TurnObservability,
  type WarningSeverity,
} from "./fusion/prepareWarnings";

/* ------------------------------------------------------------------ */
/* 上下文引擎                                                           */
/* ------------------------------------------------------------------ */
export {
  ContextAssembleEngine,
  DEFAULT_SYSTEM_RULES,
  insertAtDepth,
  type AssembleSectionOptions,
  type ContextAssembleInput,
  type ContextAssembleResult,
} from "./context/ContextAssembleEngine";
export {
  ContextEngine,
  headTailClip,
  stripTrimNote,
  TRIM_NOTE,
  type CompressOptions,
  type SoftTrimProfile,
} from "./context/ContextEngine";
export {
  clipTextToTokenCap,
  planSectionTokenAllocations,
  sectionBudgetWeight,
  type BudgetSection,
} from "./context/sectionBudget";
export {
  normalizeLoreSlot,
  normalizeWorldBookPosition,
  LORE_SLOT_ORDER,
  WORLD_BOOK_POSITION_ORDER,
  type LorePosition,
} from "./context/lorePosition";

/* ------------------------------------------------------------------ */
/* 记忆引擎                                                             */
/* ------------------------------------------------------------------ */
export {
  defaultCompressPolicy,
  joinSummaryBlocks,
  MemoryEngine,
  normalizeCompressPolicyPatch,
  resolveSummaryBlocks,
  type CompletePair,
} from "./memory/MemoryEngine";
export { MemoryBlocksEngine } from "./memory/MemoryBlocksEngine";
export { SummaryEngine, type StructuredCompressResult } from "./memory/SummaryEngine";
export {
  clipOneStructuredDocument,
  clipStructuredSummary,
  canonicalColumnTitle,
  dedupeTextUnits,
  detectUnknownColumns,
  extractSalientSlices,
  isThinColumnBody,
  looksStructured,
  MEMORY_COLUMN_ALIASES,
  mergeStructuredMemoryTexts,
  migrateStructuredMemoryDocument,
  minStructuredDocumentLength,
  normalizeStructuredMemory,
  splitMemoryColumns,
  splitMemoryDocuments,
  splitTextUnits,
  assessSummaryQuality,
  type MemoryColumnSlice,
  type MemoryDocument,
  type MemoryMigrationReport,
  type SummaryQuality,
} from "./memory/structuredMemory";
export {
  deserializeMemoryState,
  MEMORY_ENVELOPE_KIND,
  MEMORY_ENVELOPE_VERSION,
  serializeMemoryState,
  type DeserializeResult,
  type MemoryEnvelope,
  type MemoryStateInput,
} from "./memory/memoryEnvelope";
export {
  auditMemory,
  memoryAuditWarnings,
  protectedColumns,
  type MemoryAuditLoss,
  type MemoryAuditReport,
} from "./memory/memoryAudit";
export {
  LOCAL_EMBED_DIM,
  VectorMemoryEngine,
  type CosineTopKOptions,
  type EmbedFn,
  type RetrieveLocalOptions,
  type VectorHit,
  type VectorRow,
} from "./memory/VectorMemoryEngine";

/* ------------------------------------------------------------------ */
/* 端口 / 默认实现                                                      */
/* ------------------------------------------------------------------ */
export {
  EMPTY_FRAGMENTS,
  type AssembleCollaborators,
  type AssembleFragments,
  type CardResolver,
  type DepthInsertFragment,
  type LoreProvider,
  type MacroBinder,
  type MacroVars,
  type PresetResolver,
  type RegexApplier,
  type VectorFormatter,
  type WorldStateProvider,
} from "./ports";
export {
  buildLoreScanText as buildLoreScanTextFallback,
  DEFAULT_MAX_CARD_FIELD_CHARS,
  DEFAULT_VECTOR_HITS_CHARS,
  DEFAULT_WORLD_STATE_CHARS,
  defaultCardResolver,
  defaultLoreProvider,
  defaultMacroBinder,
  defaultPresetResolver,
  defaultVectorFormatter,
  defaultWorldStateProvider,
  defaultToolRegistryProvider,
  defaultMcpResourceProvider,
  createKeywordLoreProvider,
  noopRegexApplier,
} from "./defaults";
export type { KeywordLoreOptions } from "./defaults";

/* ------------------------------------------------------------------ */
/* 接入协议 —— 外部系统按此把能力接到引擎上                              */
/* ------------------------------------------------------------------ */
export {
  PortRegistry,
  PORT_NAMES,
  MODERN_PORT_NAMES,
  CONTEXT_PORT_NAMES,
  type ConnectManifest,
  type PortBinding,
  type PortDiagnostic,
  type PortName,
} from "./protocol";
export type { ToolRegistryProvider, McpResourceProvider } from "./ports";

/* ------------------------------------------------------------------ */
/* 遥测 — 谁接入了、每一轮做了什么                                       */
/* ------------------------------------------------------------------ */
export {
  CogniStackTelemetry,
  DURATION_BUCKETS_MS,
  FILL_BUCKETS,
  getGlobalTelemetry,
  Histogram,
  resetGlobalTelemetry,
  TOKEN_BUCKETS,
  UNKNOWN_HOST,
  warningClass,
  type HostIdentity,
  type HostStat,
  type PipelineProgress,
  type ProgressListener,
  type TelemetryMetrics,
  type TelemetrySnapshot,
  type TurnListener,
  type TurnListenerLite,
  type TurnMemoryDigest,
  type TurnPrefixDigest,
  type TurnRecord,
} from "./telemetry";

/* ------------------------------------------------------------------ */
/* 宿主工具（引擎不自动启用）                                            */
/* ------------------------------------------------------------------ */
export {
  createFunctionTokenCounter,
  createHttpTokenCounter,
  type CounterStatsDetail,
  type HttpTokenCounter,
  type HttpTokenCounterOptions,
  type IdentifiedTokenCounter,
} from "./host/tokenizers";

/* ------------------------------------------------------------------ */
/* MCP 协议适配                                                        */
/* ------------------------------------------------------------------ */
export {
  createMcpLoreProvider,
  createMcpToolProvider,
  mcpPromptToCard,
  mcpResourceToLoreEntry,
  mcpToolToToolDefinition,
  type McpGetPromptResult,
  type McpPromptMessage,
  type McpResource,
  type McpResourceContent,
  type McpTool,
} from "./host/mcpAdapter";

/* ------------------------------------------------------------------ */
/* 版本                                                                 */
/* ------------------------------------------------------------------ */
export { COGNISTACK_VERSION } from "./version";

/* ------------------------------------------------------------------ */
/* 类型契约                                                             */
/* ------------------------------------------------------------------ */
export type {
  AgentProfileLike,
  AuthorsNoteLike,
  CharacterCardLike,
  DepthPromptSpec,
  DialogueMessage,
  LlmEngine,
  LlmSampling,
  LlmStreamDelta,
  LoreEntryLike,
  LoreRuntimeState,
  LoreSlot,
  MacroNames,
  MemoryCompressPolicy,
  MemoryStatus,
  MessageRole,
  PrepareTurnInput,
  PromptMessage,
  PromptPresetLike,
  PromptSection,
  RegexScriptLike,
  RpMessage,
  RpRole,
  RpWorldState,
  RpWorldStateEntry,
  SummaryBlock,
  TokenCounter,
  ToolDefinitionLike,
  WorldBookEntryLike,
  WorldBookPosition,
  WorldState,
  WorldStateEntry,
} from "./types";
export {
  MEMORY_COLUMN_SACRIFICE_ORDER,
  MEMORY_COLUMN_TITLES,
  SECTION_PRIORITY,
  type MemoryColumnTitle,
} from "./types";
