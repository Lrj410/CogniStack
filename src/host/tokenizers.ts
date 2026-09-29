/**
 * Ship-able TokenCounter implementations (host utilities).
 *
 * Why this module exists
 * ---------------------
 * The engine's contract for a real tokenizer is already fully specified *and
 * tested*: `prepareAsync` pre-hydrates a corpus, and a `count()` that meets an
 * unknown string must throw `{ code: "CACHE_MISS", missText }` so the engine can
 * call `hydrateOne` and retry (see `test/fusion-engine.test.ts` →
 * "计数器抛 CACHE_MISS 时走 hydrateOne 重试并成功").
 *
 * What was missing is a *producer*: nothing in the repo ever threw CACHE_MISS,
 * so every host had to reverse-engineer the contract from a test. Meanwhile the
 * only shipped counters (`exactCharTokenCounter` / `approximateTokenCounter`)
 * are explicitly test doubles — the easiest thing to reach for, and the most
 * damaging to ship.
 *
 * These helpers are host-side: the engine never imports them and never starts
 * network I/O on its own. Nothing here is enabled implicitly.
 */
import type { TokenCounter } from "../types";

/** Thrown when a sync `count()` meets a string the cache has not seen. */
export type CacheMissError = Error & { code: "CACHE_MISS"; missText: string };

function cacheMiss(text: string): CacheMissError {
  const err = new Error(
    `token cache miss (${text.length} chars) — call hydrate() first (prepareAsync does)`,
  ) as CacheMissError;
  err.code = "CACHE_MISS";
  err.missText = text;
  return err;
}

/* ------------------------------------------------------------------ */
/* Sync: wrap any local tokenizer                                      */
/* ------------------------------------------------------------------ */

export type CounterStatsDetail = {
  /** Strings currently memoized. */
  entries: number;
  /** Cache hits since creation. */
  hits: number;
  /** Cache misses since creation (each one is a real tokenization). */
  misses: number;
  /** HTTP requests issued (0 for local counters). */
  requests: number;
};

export type IdentifiedTokenCounter = TokenCounter & {
  stats(): CounterStatsDetail;
};

/**
 * Wrap a synchronous local tokenizer (WASM tiktoken, a native binding, a
 * `llama-server` client with an in-process model…). `id` is required-ish: pass
 * it so the dashboard can tell which tokenizer produced the budget numbers.
 */
export function createFunctionTokenCounter(
  fn: (text: string) => number,
  opts?: { id?: string; maxEntries?: number },
): IdentifiedTokenCounter {
  if (typeof fn !== "function") throw new Error("createFunctionTokenCounter(fn) requires a function");
  const max = Math.max(64, Math.floor(opts?.maxEntries ?? 8192));
  const cache = new Map<string, number>();
  let hits = 0;
  let misses = 0;

  return {
    id: opts?.id?.trim() || "function:unnamed",
    count(text: string) {
      if (!text) return 0;
      const hit = cache.get(text);
      if (hit !== undefined) {
        hits += 1;
        cache.delete(text);
        cache.set(text, hit);
        return hit;
      }
      misses += 1;
      const n = fn(text);
      if (Number.isFinite(n)) {
        if (cache.size >= max) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(text, n);
      }
      return n;
    },
    stats() {
      return { entries: cache.size, hits, misses, requests: 0 };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Async: HTTP /tokenize (llama.cpp and friends)                       */
/* ------------------------------------------------------------------ */

export type HttpTokenCounterOptions = {
  /** Endpoint that tokenizes one string, e.g. `http://127.0.0.1:8080/tokenize`. */
  url: string;
  /** Request body key for the text. llama.cpp uses `content`. */
  field?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Identity shown in diagnostics/telemetry. Defaults to `http:<url>`. */
  id?: string;
  maxEntries?: number;
  /** Parallel requests per hydrate() call. Localhost tolerates more than remote. */
  concurrency?: number;
  /**
   * Extract a token count from the response JSON. Built-in handling covers
   * `{tokens: number[]}`, `{count|n_tokens|tokens_count: number}` and a bare
   * number. Pass this when your server uses another shape — do NOT fall back to
   * an estimate: a wrong token count silently corrupts every budget decision.
   */
  parseCount?: (json: unknown) => number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type HttpTokenCounter = IdentifiedTokenCounter & {
  /** Pre-fill the cache. Safe to call repeatedly; already-known strings are skipped. */
  hydrate(texts: string[]): Promise<void>;
  /** Fill one string; resolves to its token count. */
  hydrateOne(text: string): Promise<number>;
};

function defaultParseCount(json: unknown): number {
  if (typeof json === "number" && Number.isFinite(json)) return json;
  if (Array.isArray(json)) {
    // `[{"tokens":[…]}]` — single-element batch response.
    if (json.length === 1) return defaultParseCount(json[0]);
    return json.length;
  }
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const key of ["count", "n_tokens", "tokens_count", "token_count"]) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    const tokens = o.tokens;
    if (Array.isArray(tokens)) return tokens.length;
  }
  throw new Error(
    "cannot read a token count from /tokenize response — pass opts.parseCount " +
      `(got ${JSON.stringify(json)?.slice(0, 120)})`,
  );
}

/**
 * Token counter backed by an HTTP `/tokenize` endpoint.
 *
 * `count()` is synchronous and cache-only: on an unknown string it throws
 * CACHE_MISS, which is exactly what `engine.prepareAsync({ hydrate, hydrateOne })`
 * expects. Wire it up as:
 *
 * ```ts
 * const counter = createHttpTokenCounter({ url: "http://127.0.0.1:8080/tokenize" });
 * await engine.prepareAsync({
 *   ...input,
 *   tokenCounter: counter,
 *   hydrate: (t) => counter.hydrate(t),
 *   hydrateOne: (t) => counter.hydrateOne(t),
 * });
 * ```
 */
export function createHttpTokenCounter(opts: HttpTokenCounterOptions): HttpTokenCounter {
  if (!opts?.url) throw new Error("createHttpTokenCounter requires { url }");
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof doFetch !== "function") {
    throw new Error("global fetch unavailable — pass opts.fetchImpl (Node >= 22 has it built in)");
  }
  const httpFetch: typeof fetch = doFetch;
  const field = opts.field ?? "content";
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 15_000));
  const concurrency = Math.max(1, Math.min(64, Math.floor(opts.concurrency ?? 8)));
  const max = Math.max(64, Math.floor(opts?.maxEntries ?? 8192));
  const parseCount = opts.parseCount ?? defaultParseCount;

  const cache = new Map<string, number>();
  let hits = 0;
  let misses = 0;
  let requests = 0;

  function remember(text: string, n: number): void {
    if (cache.size >= max) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(text, n);
  }

  async function tokenizeOne(text: string): Promise<number> {
    const body = JSON.stringify({ [field]: text });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    requests += 1;
    try {
      const res = await httpFetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body,
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`POST ${opts.url} → HTTP ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as unknown;
      const n = parseCount(json);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`tokenizer returned a non-finite count: ${String(n)}`);
      }
      remember(text, n);
      return n;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: opts.id?.trim() || `http:${opts.url}`,
    count(text: string) {
      if (!text) return 0;
      const hit = cache.get(text);
      if (hit !== undefined) {
        hits += 1;
        cache.delete(text);
        cache.set(text, hit);
        return hit;
      }
      misses += 1;
      throw cacheMiss(text);
    },
    async hydrate(texts: string[]) {
      const todo = new Set<string>();
      for (const t of texts ?? []) {
        if (typeof t !== "string" || !t) continue;
        if (!cache.has(t)) todo.add(t);
      }
      const queue = [...todo];
      if (!queue.length) return;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (;;) {
          const i = cursor;
          cursor += 1;
          if (i >= queue.length) return;
          const text = queue[i]!;
          // Duplicate work is impossible (Set), so a throw here is a real failure.
          await tokenizeOne(text);
        }
      });
      await Promise.all(workers);
    },
    async hydrateOne(text: string) {
      if (!text) return 0;
      const hit = cache.get(text);
      if (hit !== undefined) return hit;
      return tokenizeOne(text);
    },
    stats() {
      return { entries: cache.size, hits, misses, requests };
    },
  };
}
