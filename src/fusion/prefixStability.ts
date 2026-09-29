/**
 * Prefix-stability diagnostics.
 *
 * Why this is not the same as `stages.assembleCacheHit`
 * ----------------------------------------------------
 * `assembleCacheHit` answers "did we skip re-assembling the system block for this
 * exact input". It says nothing about whether the *token stream* sent to the
 * model starts with the same tokens as last turn — which is the only thing that
 * decides whether a local runtime (llama.cpp prefix reuse, or any provider's
 * prompt cache) can skip prefill.
 *
 * Those two numbers get read as if they were the same thing, and that misreading
 * is expensive: a turn can report `cacheHit: true` (same input, assembly skipped)
 * while the prompt itself was rewritten from message 0, so prefill is paid in
 * full. The failure mode in practice is drift at the *front* of the prompt —
 * a volatile memory summary or a re-ordered section pushing everything
 * downstream into fresh tokens.
 *
 * So this module reports divergence position, not just a ratio.
 *
 * Memory: previous turns are remembered as fingerprints + token counts (a few
 * bytes per message), never as text. Keeping the previous prompt around would
 * pin a full copy of every recent prompt in the process.
 */
import type { TokenCounter } from "../types";
import { contentFp } from "./fingerprint";

export type PrefixInput = { role: string; content: string };

/** What we retain per scope between turns. */
export type PrefixSnapshot = {
  /** One fingerprint per message, in order (capped, see `truncated`). */
  fingerprints: readonly string[];
  /** Total prompt tokens of that turn — the reuse denominator. */
  tokens: number;
  /**
   * The prompt had more messages than {@link PrefixTracker} retains, so the tail
   * of `fingerprints` is missing. Compared against a longer list, the ratio would
   * be a guess — see {@link computePrefixStability}, which reports
   * `comparable: false` instead of inventing one.
   */
  truncated?: true;
};

export type PrefixStability = {
  /** False on the first turn for this scope — nothing to compare against. */
  comparable: boolean;
  /** Tokens at the front that are byte-identical to the previous turn. */
  prefixTokens: number;
  /** Tokens of the *previous* prompt — the upper bound for reuse. */
  previousTokens: number;
  /** Tokens of the current prompt. */
  totalTokens: number;
  /** Tokens that must be prefilled fresh = totalTokens − prefixTokens. */
  freshTokens: number;
  /**
   * Index of the first message that differs from the previous turn.
   * `-1` means the previous list was a strict prefix (pure append — ideal),
   * in which case the whole previous prompt is reusable.
   */
  firstDivergenceIndex: number;
  /** `prefixTokens / previousTokens`. 1.0 means the previous prompt was fully reusable. */
  reuseRatio: number;
  /**
   * True when the divergence happens before the end of the previous prompt —
   * i.e. something in the *middle* changed and everything after it must be
   * re-prefilled. Divergence at the very end is normal conversation growth.
   */
  midPromptDrift: boolean;
};

const EMPTY = {
  comparable: false,
  prefixTokens: 0,
  previousTokens: 0,
  totalTokens: 0,
  freshTokens: 0,
  firstDivergenceIndex: -1,
  reuseRatio: 0,
  midPromptDrift: false,
} satisfies PrefixStability;

/** Fingerprint one message. Role is folded in: a role swap is a real change. */
function fpOf(msg: PrefixInput): string {
  return `${msg.role}\u0000${contentFp(msg.content)}`;
}

export function fingerprintMessages(messages: readonly PrefixInput[]): string[] {
  const out: string[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i += 1) out[i] = fpOf(messages[i]!);
  return out;
}

/**
 * Compare a message list against the previous turn's snapshot.
 *
 * Pure — `previous` is whatever {@link PrefixTracker} retained last turn.
 */
export function computePrefixStability(
  previous: PrefixSnapshot | null | undefined,
  messages: readonly PrefixInput[],
  counter: TokenCounter,
): PrefixStability {
  const totalTokens = countAll(messages, counter);
  if (!previous || previous.fingerprints.length === 0) {
    return { ...EMPTY, totalTokens, freshTokens: totalTokens };
  }
  // 上一轮的指纹表被截断，而这一轮更长：尾部没有可比对象，"纯追加"就无法证实。
  // 与其给一个看起来正常、实则是猜的 reuseRatio，不如如实说不可比较
  // （项目口径：显示错的比不显示更糟）。
  if (previous.truncated && messages.length > previous.fingerprints.length) {
    return { ...EMPTY, totalTokens, freshTokens: totalTokens };
  }

  const max = Math.min(previous.fingerprints.length, messages.length);
  let shared = 0;
  while (shared < max && previous.fingerprints[shared] === fpOf(messages[shared]!)) {
    shared += 1;
  }

  let prefixTokens = 0;
  for (let i = 0; i < shared; i += 1) {
    prefixTokens += counter.count(messages[i]!.content ?? "");
  }

  // Pure append: every previous message matched and the list only grew, so the
  // entire previous prompt is reusable and there is no divergence point.
  const appendedOnly = shared === previous.fingerprints.length;
  const previousTokens = previous.tokens;

  return {
    comparable: true,
    prefixTokens,
    previousTokens,
    totalTokens,
    freshTokens: Math.max(0, totalTokens - prefixTokens),
    firstDivergenceIndex: appendedOnly ? -1 : shared,
    reuseRatio: previousTokens > 0 ? Math.min(1, prefixTokens / previousTokens) : 0,
    // Mid-prompt drift: something before the end of the previous prompt changed,
    // so a tail that used to be reusable is now fresh.
    midPromptDrift: shared < previous.fingerprints.length,
  };
}

function countAll(messages: readonly PrefixInput[], counter: TokenCounter): number {
  let n = 0;
  for (const m of messages) n += counter.count(m.content ?? "");
  return n;
}

/**
 * Per-scope fingerprint cap.
 *
 * 逐条指纹是必要的（要报告分叉位置，就不能只留一个汇总哈希），但条数必须封顶：
 * prompt 的消息数由宿主的预算决定，缺预算时结构上无上限。缺预算的 32k-token prompt
 * 平均只有几百条消息，4096 留了充足余量，同时把最坏情况钉住
 * （4096 条/scope × 64 scope）。溢出部分不参与比较，由 `truncated` 如实标出。
 */
const DEFAULT_MAX_FINGERPRINTS_PER_SCOPE = 4096;

/** 取前 `limit` 条指纹；超限则标 `truncated`，不把尾巴带进内存。 */
function snapshotOf(
  messages: readonly PrefixInput[],
  tokens: number,
  limit: number,
): PrefixSnapshot {
  const kept = Math.min(messages.length, limit);
  const fingerprints = new Array<string>(kept);
  for (let i = 0; i < kept; i += 1) fingerprints[i] = fpOf(messages[i]!);
  return kept < messages.length
    ? { fingerprints, tokens, truncated: true }
    : { fingerprints, tokens };
}

/**
 * Bounded per-scope memory of the last prompt shape.
 *
 * Scope should encode everything that changes the prompt layout (host + chat +
 * mode). Mixing `generate` and `status` under one scope makes both look like they
 * drift every turn.
 */
export class PrefixTracker {
  private readonly byScope = new Map<string, PrefixSnapshot>();
  private readonly maxScopes: number;
  private readonly maxFingerprints: number;

  constructor(opts?: { maxScopes?: number; maxFingerprintsPerScope?: number }) {
    this.maxScopes = Math.max(1, Math.floor(opts?.maxScopes ?? 64));
    this.maxFingerprints = Math.max(
      1,
      Math.floor(opts?.maxFingerprintsPerScope ?? DEFAULT_MAX_FINGERPRINTS_PER_SCOPE),
    );
  }

  /** Compare against the previous turn and remember this one. */
  observe(
    scope: string,
    messages: readonly PrefixInput[],
    counter: TokenCounter,
  ): PrefixStability {
    const prev = this.byScope.get(scope) ?? null;
    const result = computePrefixStability(prev, messages, counter);
    if (this.byScope.has(scope)) this.byScope.delete(scope);
    while (this.byScope.size >= this.maxScopes) {
      const oldest = this.byScope.keys().next().value;
      if (oldest === undefined) break;
      this.byScope.delete(oldest);
    }
    this.byScope.set(scope, snapshotOf(messages, result.totalTokens, this.maxFingerprints));
    return result;
  }

  /** Drop one scope (e.g. a finished chat) or everything. */
  clear(scope?: string): void {
    if (scope === undefined) this.byScope.clear();
    else this.byScope.delete(scope);
  }

  /**
   * Drop every scope whose key starts with `${scopePrefix}::`.
   *
   * Scopes are stored as `${cacheScope}::${mode}`, so a caller holding only the
   * cache scope (which is what `clearCache(scope)` gets) cannot name a key
   * exactly. Matching by prefix keeps that call honest instead of silently
   * missing and leaving a stale baseline behind.
   */
  clearPrefix(scopePrefix: string): void {
    const head = `${scopePrefix}::`;
    for (const key of [...this.byScope.keys()]) {
      if (key.startsWith(head)) this.byScope.delete(key);
    }
  }

  scopeCount(): number {
    return this.byScope.size;
  }
}
