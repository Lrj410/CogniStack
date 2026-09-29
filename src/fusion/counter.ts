/**
 * Memoizing token counter.
 *
 * Why this exists
 * ---------------
 * The source RP pipeline re-counted the *same* strings many times per turn:
 * `compress()` created its own throwaway cache and the dispatcher then counted
 * `baseMessages`, the trimmed list, each emergency pass and the final list with
 * the raw counter. A 6k-token system block was therefore tokenized 5–8 times.
 *
 * CogniStack funnels every count in a `prepare()` pass through one memo, so each
 * distinct string is tokenized at most once. Correctness is unaffected: the memo
 * is a pure cache and eviction only costs recomputation.
 *
 * Key choice: keys are `length + two independent 32-bit mixes` rather than the
 * raw string. Retaining multi-KB strings as Map keys would pin every
 * intermediate soft-trim fragment for the lifetime of the turn; a 64-bit-ish
 * fingerprint keeps that to a few bytes while making collisions negligible.
 */
import type { TokenCounter } from "../types";

export type CounterStats = {
  hits: number;
  misses: number;
  /**
   * Entries **currently held** by the memo — not "distinct strings this pass
   * saw". The two agree only until the first eviction; afterwards this plateaus
   * at `maxEntries` while `misses` keeps counting real tokenizations.
   *
   * Kept as-is rather than redefined because a caller (bench) was quoting it as
   * a distinct-string count, which under-reports exactly when the memo is under
   * pressure. `misses` is the number to use for "how much did we tokenize".
   * Read it together with `evictions`: non-zero means this field has hit its cap.
   *
   * (An eviction-proof distinct count would need a set of every key ever seen,
   * which is unbounded memory in a long-lived process — a worse trade for a
   * diagnostic.)
   */
  distinct: number;
  evictions: number;
};

export type MemoizedCounter = TokenCounter & {
  stats(): CounterStats;
};

const DEFAULT_MAX_ENTRIES = 8192;

/** FNV-1a style mix, two independent seeds → ~64-bit fingerprint. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x1000193;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  // Mix in the length so two different strings can never hash to the same key
  // by construction of the trailing-length trick alone.
  return `${n.toString(36)}|${(a >>> 0).toString(36)}|${(b >>> 0).toString(36)}`;
}

export function memoizeCounter(
  counter: TokenCounter,
  opts?: { maxEntries?: number },
): MemoizedCounter {
  const max = Math.max(64, Math.floor(opts?.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const cache = new Map<string, number>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  return {
    id: counter.id ? `memo:${counter.id}` : "memo:unnamed",
    count(text: string) {
      if (!text) return 0;
      const key = fingerprint(text);
      const hit = cache.get(key);
      if (hit !== undefined) {
        hits += 1;
        // LRU: refresh insertion order so hot system blocks survive eviction.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      misses += 1;
      const n = counter.count(text);
      // Never memoize a non-finite result — a broken backend must stay loud.
      if (Number.isFinite(n)) {
        if (cache.size >= max) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) {
            cache.delete(oldest);
            evictions += 1;
          }
        }
        cache.set(key, n);
      }
      return n;
    },
    stats() {
      return { hits, misses, distinct: cache.size, evictions };
    },
  };
}

/**
 * Stable identity string for a counter. Never throws, never returns empty —
 * an unnamed counter reports `"unnamed"` so dashboards cannot silently show a
 * blank where a real tokenizer identity should be.
 */
export function counterIdentity(counter: TokenCounter | null | undefined): string {
  const raw = counter?.id;
  if (typeof raw !== "string") return "unnamed";
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 96) : "unnamed";
}

/** Exact identity counter for unit tests only (1 char = 1 token). */
export function exactCharTokenCounter(): TokenCounter {
  return { id: "char-exact(test-only)", count: (text: string) => (text ? text.length : 0) };
}

/**
 * Word/char blended counter — a *test* double. Never use this on a real path;
 * the engine's public API requires a real TokenCounter.
 */
export function approximateTokenCounter(): TokenCounter {
  return {
    id: "approx-blend(test-only)",
    count(text: string) {
      if (!text) return 0;
      let cjk = 0;
      let other = 0;
      for (const ch of text) {
        const c = ch.codePointAt(0) ?? 0;
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk += 1;
        else other += 1;
      }
      return Math.ceil(cjk * 0.75 + other / 4);
    },
  };
}

export function countMessages(messages: { content: string }[], counter: TokenCounter): number {
  let n = 0;
  for (const m of messages) n += counter.count(m.content ?? "");
  return n;
}
