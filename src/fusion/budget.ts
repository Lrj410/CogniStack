/**
 * Budget resolution — extracted from the RP dispatcher's inline logic.
 *
 * In the source system this arithmetic lived inside `prepareTurn()` next to
 * ~40 lines of unrelated orchestration, so it could only be exercised through a
 * full turn. It is a pure function of (policy, mode, completion reserve, n_ctx),
 * so CogniStack pulls it out: it is now directly unit-testable and the magic
 * numbers are named options with the historical defaults.
 *
 * Small-context hardening (≤8k):
 *   - Missing `contextCharLimit` is inferred from `totalPromptCharCap` when set
 *     (hosts that only pass a soft cap used to skip all fitting).
 *   - Safety pad scales up on tiny n_ctx so chat-template / role overhead does
 *     not push a "fitting" prompt over the real model window (e.g. 4109 > 4096).
 */
import type { MemoryCompressPolicy } from "../types";

export type PrepareMode = "generate" | "status";

export type BudgetOptions = {
  mode: PrepareMode;
  /** Tokens reserved for the completion (max_tokens / server default). */
  completionReserveTokens?: number | undefined;
  /** Pad kept between prompt and n_ctx. Default: adaptive by n_ctx size. */
  safetyPadTokens?: number | undefined;
  /**
   * Extra tokens reserved for chat-template / special tokens the host counter
   * does not see. Added on top of safetyPad. Default: adaptive (0 when n_ctx
   * unknown).
   */
  templateOverheadTokens?: number | undefined;
  /** Fraction of n_ctx the prompt may occupy when no explicit cap is set. */
  softTrimRatio?: number | undefined;
  /** Minimum share of n_ctx the prompt must keep when clamping the reserve. */
  minPromptShareOfContext?: number | undefined;
};

export type ResolvedBudget = {
  /** Effective policy (totalPromptCharCap resolved). */
  policy: MemoryCompressPolicy;
  /** Policy as supplied, before soft-trim cap resolution. */
  basePolicy: MemoryCompressPolicy;
  /** n_ctx in tokens (policy.contextCharLimit). 0 = not configured. */
  contextLimit: number;
  completionReserve: number;
  safetyPad: number;
  /** Chat-template / special-token overhead reserved out of n_ctx. */
  templateOverhead: number;
  /** Largest prompt that still leaves room for the completion. */
  hardFit: number;
  /** Cap handed to the soft-trim. 0 = soft trim disabled. */
  softTrimTokenCap: number;
  softTrimEnabled: boolean;
  warnings: string[];
};

export const BUDGET_DEFAULTS = {
  safetyPadTokens: 64,
  softTrimRatio: 0.95,
  minPromptShareOfContext: 0.25,
} as const;

/**
 * Adaptive safety pad for small windows. Chat templates often cost 30–150
 * tokens that content-only counters never see — on 4k that is the difference
 * between "fits" and llama.cpp rejecting the request.
 */
export function adaptiveSafetyPad(contextLimit: number): number {
  if (!(contextLimit > 0)) return BUDGET_DEFAULTS.safetyPadTokens;
  // Tiny windows: pad aggressively — template overhead is a large fraction of n_ctx.
  if (contextLimit <= 4096) return Math.max(128, Math.ceil(contextLimit * 0.04));
  if (contextLimit <= 8192) return Math.max(96, Math.ceil(contextLimit * 0.02));
  // Large windows: flat legacy pad is enough; do not grow without bound.
  return BUDGET_DEFAULTS.safetyPadTokens;
}

/** Adaptive template overhead (role markers, BOS/EOS, etc.). */
export function adaptiveTemplateOverhead(contextLimit: number): number {
  if (!(contextLimit > 0)) return 0;
  if (contextLimit <= 4096) return Math.max(32, Math.ceil(contextLimit * 0.012));
  if (contextLimit <= 8192) return Math.max(24, Math.ceil(contextLimit * 0.006));
  return 16;
}

export function resolveBudget(
  basePolicy: MemoryCompressPolicy,
  opts: BudgetOptions,
): ResolvedBudget {
  const warnings: string[] = [];
  const policy = { ...basePolicy };

  const softHint = Math.max(0, Math.floor(policy.totalPromptCharCap || 0));
  /*
   * Non-finite / non-numeric limits must not reach the arithmetic below.
   *
   * Measured before this guard: `contextTokenLimit: Infinity` produced
   * `hardFit: NaN` — `minPromptFloor` also went to Infinity and the reserve clamp
   * computed `Infinity - Infinity`. NaN then makes *every* comparison false, so
   * `promptTokens <= hardFit` silently became "no ceiling at all", the fill ratio
   * read NaN, and `JSON.stringify` turned it into `null` on the wire.
   *
   * Clamping to 0 routes the input into the documented "no budget given" path,
   * which warns (`budget-missing-context-limit`) and disables soft trim — loud,
   * and with no poisoned numbers. Garbage strings (`"abc"`) used to reach the same
   * arithmetic as NaN; they land here too.
   */
  const rawLimit = Number(policy.contextCharLimit ?? 0);
  let contextLimit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 0;
  if (policy.contextCharLimit != null && !Number.isFinite(rawLimit)) {
    warnings.push(`context-limit-non-finite:${String(policy.contextCharLimit).slice(0, 32)}`);
  }
  if (contextLimit <= 0 && softHint > 0) {
    // Hosts often pass only softTrimTokenCap / maxContextChars. Without this
    // inference, softTrimEnabled stays false and hardFit=0 — prompts leave
    // prepare() uncapped and blow up on 4k/8k models.
    contextLimit = softHint;
    policy.contextCharLimit = softHint;
    warnings.push(`context-limit-inferred-from-prompt-cap:${softHint}`);
  }

  const softTrimRatio = clamp01(opts.softTrimRatio ?? BUDGET_DEFAULTS.softTrimRatio);
  const minShare = clamp01(
    opts.minPromptShareOfContext ?? BUDGET_DEFAULTS.minPromptShareOfContext,
  );

  const safetyPad = Math.max(
    0,
    Math.floor(opts.safetyPadTokens ?? adaptiveSafetyPad(contextLimit)),
  );
  const templateOverhead = Math.max(
    0,
    Math.floor(opts.templateOverheadTokens ?? adaptiveTemplateOverhead(contextLimit)),
  );

  const reserveRaw = Math.max(0, Math.floor(opts.completionReserveTokens ?? 0));

  const minPromptFloor = contextLimit > 0 ? Math.max(64, Math.floor(contextLimit * minShare)) : 64;
  const reservedFixed = safetyPad + templateOverhead;
  const completionReserve =
    contextLimit > 0
      ? Math.min(reserveRaw, Math.max(0, contextLimit - minPromptFloor - reservedFixed))
      : 0;

  if (reserveRaw > 0 && completionReserve < reserveRaw) {
    warnings.push(`completion-reserve-clamped:${reserveRaw}->${completionReserve}`);
  }

  const hardFit =
    contextLimit > 0
      ? Math.max(1, contextLimit - completionReserve - safetyPad - templateOverhead)
      : 0;
  if (contextLimit > 0 && hardFit < 64) {
    // n_ctx 小到几乎没有提示词空间（例如 contextTokenLimit: 1）。不会算出
    // 负数 / NaN，但语义上等于不可用 —— 显式告警，而不是静默退化。
    warnings.push(`hard-fit-degenerate:${hardFit}`);
  }
  const softTrimEnabled =
    opts.mode === "generate" && contextLimit > 0 && policy.softTrimOff !== true;

  if (opts.mode === "generate" && contextLimit <= 0) {
    warnings.push("budget-missing-context-limit");
  }

  let softTrimTokenCap = 0;
  if (softTrimEnabled) {
    const explicit = Math.max(0, Math.floor(policy.totalPromptCharCap || 0));
    // When we inferred n_ctx from the soft hint, do not treat that same number
    // as an "explicit soft cap" above hardFit — use auto ratio against hardFit.
    const inferred = warnings.some((w) => w.startsWith("context-limit-inferred-from-prompt-cap"));
    const auto =
      explicit > 0 && !inferred
        ? Math.min(explicit, hardFit)
        : Math.min(Math.max(1, Math.floor(contextLimit * softTrimRatio)), hardFit);
    if (auto !== explicit && !(inferred && explicit === contextLimit)) {
      policy.totalPromptCharCap = auto;
      if (explicit <= 0 || inferred) {
        warnings.push(
          completionReserve > 0
            ? `soft-trim-defaulted:context-reserve(${completionReserve})`
            : `soft-trim-defaulted:context*${softTrimRatio}`,
        );
      } else if (auto < explicit) {
        warnings.push(`soft-trim-clamped:completion-reserve(${completionReserve})`);
      }
    } else {
      policy.totalPromptCharCap = auto;
    }
    softTrimTokenCap = auto;
  } else if (opts.mode === "status" && policy.totalPromptCharCap > 0) {
    // status never soft-trim; surface the cap anyway so callers can log it.
    softTrimTokenCap = 0;
  }

  return {
    policy,
    basePolicy,
    contextLimit,
    completionReserve,
    safetyPad,
    templateOverhead,
    hardFit,
    softTrimTokenCap,
    softTrimEnabled,
    warnings,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
