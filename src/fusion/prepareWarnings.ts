/**
 * PrepareTurn warning / observability helpers.
 *
 * Guard failures used to be anonymous `label-failed:…` strings that the UI
 * could miss (or overwrite with lore chips). Prefixes make severity explicit.
 */
import type { MemoryStatus } from "../types";

/** Critical: assemble/compress fell back — prompt may be rules-only or untrimmed. */
const DEGRADED_RE = /^(degraded:)?(assemble|compress)-failed:/i;
/**
 * Data loss / budget violation — the turn is *not what the caller thinks it is*.
 *
 * Why these belong in `degraded` and not `info` (measured before the fix): with
 * `softTrimOff` + a long rules block, a 512-token context produced
 * `hard-fit-violated:300>288` and `emergency-dialogue-window:dropped-8` while
 * every consumer that filters on `degraded`/`notice` saw *nothing* — the only
 * entry in `notices` was `prompt-budget-trimmed` (the benign one). The most
 * severe outcomes were the least visible.
 *
 * Deliberately NOT included: `hard-fit-enforced` (the engine succeeded in
 * fitting), `emergency-fit-forced` (also a success), `memory-lost-*` (the prompt
 * is still usable — those stay `notice` by design, see MEMORY_AUDIT_RE).
 */
const DATA_LOSS_RE =
  /^(hard-fit-violated|emergency-dialogue-window|dialogue-(system-)?role-dropped)/i;
/** Soft: world-book / preset / etc. failed but dialogue still usable. */
const SOFT_FAIL_RE = /^(degraded:)?[\w-]+-failed:/i;
const BUDGET_RE =
  /prompt-budget-trimmed|prompt-budget-unreachable|watermark-off-active-path|ciphertext|branch-memory-empty|vector-dim-mismatch|vector-retrieve-failed|prepare-checksum/i;
/**
 * Sizing / configuration signals the caller can act on. These say "the budget
 * you gave me did something surprising", not "content was lost".
 *
 * `budget-missing-context-limit` sits here rather than in {@link DATA_LOSS_RE}
 * on purpose: measured across the existing fixtures, *not* passing
 * `contextTokenLimit` is a normal state (many hosts and every bare test fixture
 * do it), so escalating it would mark a large share of ordinary turns degraded
 * and drown the signals that mean real damage. The warning is still visible in
 * `severity.notices`, and `hard-fit-violated` — the engine had a ceiling and
 * missed it — remains `degraded`.
 */
const SIZING_RE =
  /^(hard-fit-enforced|hard-fit-degenerate|emergency-fit-forced|soft-trim-|lore-capped|lore-trimmed|world-book-capped|budget-missing-context-limit)/i;
/**
 * Memory-quality signals. The prompt is still usable — the *memory* got poorer.
 * Filed as `notice` rather than `degraded` so a lost hard fact is visible without
 * declaring every subsequent turn broken.
 */
const MEMORY_AUDIT_RE = /^memory-(lost|unknown-column|sacrifice-order|blocks-compacted)/i;

export type WarningSeverity = "degraded" | "notice" | "info";

export function classifyPrepareWarning(warning: string): WarningSeverity {
  const w = warning.trim();
  if (DEGRADED_RE.test(w) || DATA_LOSS_RE.test(w)) return "degraded";
  if (
    SOFT_FAIL_RE.test(w) ||
    BUDGET_RE.test(w) ||
    SIZING_RE.test(w) ||
    MEMORY_AUDIT_RE.test(w)
  ) {
    return "notice";
  }
  return "info";
}

export function partitionPrepareWarnings(warnings: string[] | null | undefined): {
  degraded: string[];
  notices: string[];
  info: string[];
  /** True when assemble/compress guard fired. */
  isDegraded: boolean;
} {
  const degraded: string[] = [];
  const notices: string[] = [];
  const info: string[] = [];
  for (const w of warnings ?? []) {
    const sev = classifyPrepareWarning(w);
    if (sev === "degraded") degraded.push(w);
    else if (sev === "notice") notices.push(w);
    else info.push(w);
  }
  return {
    degraded,
    notices,
    info,
    isDegraded: degraded.length > 0,
  };
}

/** Tag guard failures so UI can always surface them. */
export function formatGuardWarning(label: string, detail: string): string {
  const critical = label === "assemble" || label === "compress";
  const body = `${label}-failed:${detail.slice(0, 60)}`;
  return critical ? `degraded:${body}` : body;
}

export type TurnObservability = {
  promptTokens: number;
  promptChars: number;
  pendingPairs: number;
  compressReason: MemoryStatus["compressReason"] | null | undefined;
  contextUsed: number;
  contextTriggerAt: number;
  loreCount: number;
  warningCount: number;
  isDegraded: boolean;
  /** One-line chip text for the chat header. */
  memoryChip: string;
  /** Longer tooltip / statusHint. */
  detailHint: string;
};

/**
 * `buildTurnObservability` 的输入面 —— 结构性窄类型，取
 * `CogniStackPrepareResult` 的一个子集。
 *
 * 为什么不直接 `Pick<CogniStackPrepareResult, …>`：本模块被 `CogniStackEngine`
 * 导入，反向 import 它的类型会形成同层循环。字段对齐由
 * `test/fusion-utils.test.ts` 里的赋值断言守着 —— 结果类型一旦改名/改型，
 * 断言当场编译失败（这正是 `PrepareTurnResult` 曾漂移掉的那类问题）。
 */
export type ObservabilitySource = {
  promptTokens: number;
  promptChars: number;
  memory: MemoryStatus;
  loreInjected: { id: string; name: string }[];
  warnings: string[];
  steps: string[];
};

export function buildTurnObservability(
  result: ObservabilitySource,
  opts?: { showDebugSteps?: boolean },
): TurnObservability {
  const mem = result.memory;
  const parts = partitionPrepareWarnings(result.warnings);
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.max(0, Math.floor(n)));

  const promptTokens = Math.max(0, Math.floor(result.promptTokens ?? 0));
  const pendingPairs = Math.max(0, Math.floor(mem?.pendingPairs ?? 0));
  const contextUsed = Math.max(0, Math.floor(mem?.contextUsed ?? 0));
  const contextTriggerAt = Math.max(0, Math.floor(mem?.contextTriggerAt ?? 0));
  const loreCount = result.loreInjected?.length ?? 0;

  const chipParts: string[] = [];
  if (promptTokens > 0) chipParts.push(`${fmt(promptTokens)} tok`);
  else if (contextTriggerAt > 0) chipParts.push(`${fmt(contextUsed)}/${fmt(contextTriggerAt)}`);
  if (pendingPairs > 0) chipParts.push(`待压 ${pendingPairs}对`);
  if (mem?.compressReason === "context") chipParts.push("①阈值");
  else if (mem?.compressReason === "batch") chipParts.push("②回合");
  if (parts.isDegraded) chipParts.push("降级");

  const hints: string[] = [];
  if (parts.degraded.length) hints.push(`降级: ${parts.degraded.join("、")}`);
  if (parts.notices.length) hints.push(parts.notices.join("、"));
  // Lore count is structured on TurnObservability — keep names out of the
  // concatenated hint so UIs don't echo "世界书 ×N" beside a lore metric.
  if (loreCount > 0) {
    const names = (result.loreInjected ?? [])
      .map((x) => String(x.name ?? "").trim())
      .filter(Boolean)
      .slice(0, 4);
    hints.push(names.length ? `世界书: ${names.join("、")}` : `世界书 ×${loreCount}`);
  }
  if (opts?.showDebugSteps && result.steps?.length) {
    hints.push(`步骤: ${result.steps.join(" → ")}`);
  }
  // Omit "占用 / 阈值" echo — callers already expose contextUsed/contextTriggerAt.

  return {
    promptTokens,
    promptChars: Math.max(0, Math.floor(result.promptChars ?? 0)),
    pendingPairs,
    compressReason: mem?.compressReason ?? null,
    contextUsed,
    contextTriggerAt,
    loreCount,
    warningCount: (result.warnings ?? []).length,
    isDegraded: parts.isDegraded,
    memoryChip: chipParts.join(" · ") || "上下文就绪",
    detailHint: hints.join(" · ") || "",
  };
}

/** U-12: fingerprint plan inputs so client can detect stale /prompt payloads. */
export function buildPrepareChecksum(parts: {
  cardName?: string | null;
  summaryJoined?: string | null;
  summaryBlockIds?: string[] | null;
  worldEntryIds?: string[] | null;
  throughMessageId?: string | null;
  activeLeafId?: string | null;
  vectorHitCount?: number;
}): string {
  const payload = [
    parts.cardName ?? "",
    parts.summaryJoined?.slice(0, 400) ?? "",
    (parts.summaryBlockIds ?? []).join(","),
    (parts.worldEntryIds ?? []).join(","),
    parts.throughMessageId ?? "",
    parts.activeLeafId ?? "",
    String(parts.vectorHitCount ?? 0),
  ].join("\u001f");
  let h = 5381;
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) | 0;
  }
  return `pchk_${(h >>> 0).toString(36)}`;
}
