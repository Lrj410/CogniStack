/**
 * VectorMemoryEngine — embed + cosine / hybrid top-K retrieval (PGlite-safe jsonb).
 */

export const LOCAL_EMBED_DIM = 256;

export type VectorRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  text: string;
  embedding: number[];
};

export type VectorHit = {
  id: string;
  sourceType: string;
  sourceId: string;
  text: string;
  score: number;
  name?: string;
};

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export type CosineTopKOptions = {
  /** When set, blend cosine with lexical overlap (helps weak local embeds). */
  queryText?: string;
  /** Absolute floor; also scaled vs top score when adaptive. Default 0.05 */
  minScore?: number;
  /** Prefer diverse hits (MMR-lite). Default true when k > 2 */
  diversity?: boolean;
  /** Cosine weight in hybrid mode (0–1). Default 0.7 */
  cosineWeight?: number;
  /**
   * Opt-in: boost newer rows. Pass ISO/epoch via `rowMeta.get(sourceId)` or
   * parse trailing `#ts=<epochMs>` from sourceId. Default off (bit-stable).
   */
  recencyBoost?: number;
  /** Half-life in days for recency boost decay (Ebbinghaus recency curve). Default 30. */
  recencyHalfLifeDays?: number | undefined;
  /** Opt-in: multiply score by weight for `sourceType` (missing = 1). */
  sourceTypeWeight?: Record<string, number>;
  /** Optional lookup for recency timestamps (epoch ms). */
  rowMeta?: Map<string, { updatedAt?: number }>;
};

export type RetrieveLocalOptions = CosineTopKOptions & {
  /** Max hits. Default 4 */
  k?: number;
  /** Injected embedder; falls back to local pseudo-embed. */
  embed?: EmbedFn;
};

export class VectorMemoryEngine {
  readonly id = "VectorMemoryEngine" as const;

  /**
   * Deterministic local pseudo-embedding.
   * Char n-grams + CJK unigrams + light TF weighting; L2-normalized.
   */
  buildLocalEmbedding(text: string, dim = LOCAL_EMBED_DIM): number[] {
    const vec = new Array<number>(dim).fill(0);
    const raw = normalizeForEmbed(text);
    if (!raw) return vec;

    // Head+tail sample for very long strings (keeps salience, bounds CPU).
    const sample = raw.length > 2400 ? `${raw.slice(0, 1400)}${raw.slice(-1000)}` : raw;

    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (isSkippableCode(c)) continue;

      const isCjk = c >= 0x4e00 && c <= 0x9fff;
      const w1 = isCjk ? 1.35 : 1;
      const h1 = mix32(c, i);
      vec[h1 % dim]! += w1;

      // Position-decayed unigram so early topic words matter more.
      const posBoost = 1 + Math.max(0, 1 - i / Math.max(sample.length, 1)) * 0.25;
      vec[mix32(c * 17, i + 3) % dim]! += 0.35 * posBoost;

      if (i + 1 < sample.length) {
        const c2 = sample.charCodeAt(i + 1);
        if (!isSkippableCode(c2)) {
          const h2 = mix32(c * 131 + c2, i + 17);
          vec[h2 % dim]! += isCjk ? 1.8 : 1.5;
        }
      }
      if (i + 2 < sample.length) {
        const c2 = sample.charCodeAt(i + 1);
        const c3 = sample.charCodeAt(i + 2);
        if (!isSkippableCode(c2) && !isSkippableCode(c3)) {
          const h3 = mix32(c * 131 + c2 * 31 + c3, i + 41);
          vec[h3 % dim]! += 0.9;
        }
      }
    }
    return l2normalize(vec);
  }

  async embedTexts(texts: string[], embed?: EmbedFn): Promise<number[][]> {
    if (embed) {
      try {
        const out = await embed(texts);
        if (Array.isArray(out) && out.length === texts.length) {
          return out.map((v) => l2normalize(v.map(Number)));
        }
      } catch {
        // fall through to local
      }
    }
    return texts.map((t) => this.buildLocalEmbedding(t));
  }

  cosine(a: number[], b: number[]): number {
    if (!a.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na <= 0 || nb <= 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /** Jaccard overlap on character / short-token bags (CJK-friendly). */
  lexicalOverlap(a: string, b: string): number {
    return jaccardBags(bagOfUnitsCached(a), bagOfUnitsCached(b));
  }

  cosineTopK(query: number[], rows: VectorRow[], k = 4, opts?: CosineTopKOptions): VectorHit[] {
    const topK = Math.max(1, Math.floor(k));
    const qText = (opts?.queryText ?? "").trim();
    const cw = Math.min(1, Math.max(0, opts?.cosineWeight ?? (qText ? 0.7 : 1)));
    const lw = 1 - cw;
    const minScore = opts?.minScore ?? 0.05;
    const useDiversity = opts?.diversity ?? topK > 2;
    const recencyBoost = Math.max(0, opts?.recencyBoost ?? 0);
    const typeW = opts?.sourceTypeWeight;
    const now = Date.now();

    const scored = rows
      .filter(
        (r) =>
          r.text?.trim() &&
          Array.isArray(r.embedding) &&
          (r.embedding.length === query.length || Boolean(qText)),
      )
      .map((r) => {
        const dimOk = r.embedding.length === query.length;
        // Remote vs local dim mix: keep lexical path so recall is not empty.
        const cos = dimOk ? this.cosine(query, r.embedding) : 0;
        const lex = qText ? this.lexicalOverlap(qText, r.text) : 0;
        let score = !dimOk ? lex : qText ? cw * cos + lw * lex : cos;
        if (typeW && typeof typeW[r.sourceType] === "number") {
          score *= Math.max(0, typeW[r.sourceType]!);
        }
        if (recencyBoost > 0) {
          const ts = resolveRowUpdatedAt(r, opts?.rowMeta);
          if (ts != null && Number.isFinite(ts)) {
            const ageDays = Math.max(0, (now - ts) / 86_400_000);
            const halfLife = Math.max(0.01, opts?.recencyHalfLifeDays ?? 30);
            score *= 1 + recencyBoost * Math.exp(-ageDays / halfLife);
          }
        }
        return {
          id: r.id,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          text: r.text,
          score,
        };
      })
      .filter((h) => h.score > minScore);

    if (!scored.length) return [];

    // Adaptive floor: drop weak tails relative to the best hit.
    let best = -Infinity;
    for (const h of scored) if (h.score > best) best = h.score;
    const adaptive = Math.max(minScore, best * 0.35);
    const filtered = scored.filter((h) => h.score >= adaptive);

    if (!useDiversity || filtered.length <= topK) {
      // Pure top-K slice — a fixed-size heap avoids a full O(n log n) sort when
      // the candidate pool is large (identical result, see selectTopByScore).
      return selectTopByScore(filtered, topK);
    }
    // MMR needs every candidate in score order for stable tie-breaking.
    filtered.sort((a, b) => b.score - a.score);
    return this.mmrSelect(filtered, topK);
  }

  /**
   * Host-side retrieve helper: embed query (local or injected) → cosineTopK.
   * Does NOT run inside sync `prepare()` — hosts call this, then pass hits as
   * `vectorHits`. Keeps the core zero-deps and prepare deterministic.
   */
  async retrieveLocal(
    queryText: string,
    rows: VectorRow[],
    opts?: RetrieveLocalOptions,
  ): Promise<VectorHit[]> {
    const q = (queryText || "").trim();
    if (!q || !rows.length) return [];
    const k = opts?.k ?? 4;
    const [queryVec] = await this.embedTexts([q], opts?.embed);
    return this.cosineTopK(queryVec ?? this.buildLocalEmbedding(q), rows, k, {
      ...opts,
      queryText: q,
    });
  }

  /** Sync variant using only the local pseudo-embedder (tests / offline). */
  retrieveLocalSync(
    queryText: string,
    rows: VectorRow[],
    opts?: Omit<RetrieveLocalOptions, "embed">,
  ): VectorHit[] {
    const q = (queryText || "").trim();
    if (!q || !rows.length) return [];
    const k = opts?.k ?? 4;
    const queryVec = this.buildLocalEmbedding(q);
    return this.cosineTopK(queryVec, rows, k, { ...opts, queryText: q });
  }

  /** Format sanitized assemble hits (name/content) for the system section. */
  formatAssembleHits(hits: { name?: string | undefined; content: string }[], maxChars = 4000): string {
    if (!hits.length) return "";
    const header = "相关检索记忆（语义召回，请酌情遵守）：";
    const room = Math.max(0, maxChars - header.length - 1);
    if (room <= 0) return "";
    const parts: string[] = [];
    let used = 0;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      const title = h.name?.trim() || `检索 ${i + 1}`;
      let body = (h.content || "").trim();
      if (!body) continue;
      const titleCost = `【${title}】\n`.length;
      const remaining = room - used - (parts.length ? 2 : 0) - titleCost;
      if (remaining <= 0) break;
      if (body.length > remaining) {
        body = body.slice(0, remaining);
      }
      const block = `【${title}】\n${body}`;
      if (!block.trim()) continue;
      parts.push(block);
      used += block.length + (parts.length > 1 ? 2 : 0);
    }
    if (!parts.length) return "";
    const out = [header, parts.join("\n\n")].join("\n");
    return out.length <= maxChars ? out : out.slice(0, maxChars);
  }

  /** Format VectorHit rows for prompt injection. */
  formatHitsForPrompt(hits: VectorHit[], maxChars = 4000): string {
    return this.formatAssembleHits(
      hits.map((h) => ({ name: h.name, content: h.text })),
      maxChars,
    );
  }

  /**
   * Deduplicate / clip hits before assemble:
   * - drop empties
   * - soft-downweight near-duplicates of committed summary (U-10)
   * - drop near-duplicates among hits
   * - clip each hit body
   */
  sanitizeHits(
    hits: { name?: string | undefined; content: string }[] | null | undefined,
    opts?: { summaryText?: string | null; maxHits?: number; maxCharsEach?: number },
  ): { name?: string | undefined; content: string }[] {
    if (!hits?.length) return [];
    const maxHits = Math.max(1, opts?.maxHits ?? 6);
    const maxCharsEach = Math.max(120, opts?.maxCharsEach ?? 800);
    const summary = (opts?.summaryText ?? "").trim();
    // Build the (potentially 200k-char) summary bag once and reuse it for every
    // hit instead of rebuilding it per hit.
    const summaryBag = summary ? bagOfUnitsCached(summary) : null;
    const out: { name?: string | undefined; content: string }[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      let content = (h.content || "").trim();
      if (!content) continue;
      if (content.length > maxCharsEach) {
        content = `${content.slice(0, Math.floor(maxCharsEach * 0.7))}…${content.slice(-Math.floor(maxCharsEach * 0.25))}`;
      }
      const key = content.slice(0, 120);
      if (seen.has(key)) continue;
      if (summaryBag) {
        const overlap = jaccardBags(summaryBag, bagOfUnitsCached(content));
        // Drop near-duplicates of committed summary. Full-content inclusion is
        // safe; prefix-only inclusion is NOT (unique suffixes must survive).
        if (overlap >= 0.85 || summary.includes(content)) {
          continue;
        }
        if (overlap >= 0.45) {
          const keep = Math.max(64, Math.floor(maxCharsEach * 0.28));
          content =
            content.length > keep
              ? `${content.slice(0, Math.floor(keep * 0.7))}…${content.slice(-Math.floor(keep * 0.25))}`
              : content;
        }
      }
      if (out.some((o) => jaccardBags(bagOfUnitsCached(o.content), bagOfUnitsCached(content)) > 0.72)) {
        continue;
      }
      seen.add(key);
      out.push({ name: h.name, content });
      if (out.length >= maxHits) break;
    }
    return out;
  }

  /** MMR-lite: greedily pick high score with low overlap to already chosen. */
  private mmrSelect(ranked: VectorHit[], k: number): VectorHit[] {
    const n = ranked.length;
    const selected: VectorHit[] = [];
    if (!n) return selected;
    const bags = ranked.map((h) => bagOfUnitsCached(h.text));
    const used = new Array<boolean>(n).fill(false);
    // maxRed[i] = max overlap between candidate i and anything already selected.
    // Maintained incrementally: a new selection can only raise it, so we update
    // each remaining candidate once per selection instead of re-mapping the
    // whole selected set (avoids the Math.max spread + repeated overlap work).
    const maxRed = new Array<number>(n).fill(0);
    while (selected.length < k) {
      let bestIdx = -1;
      let bestVal = -Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const val = 0.85 * ranked[i]!.score - 0.15 * maxRed[i]!;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      used[bestIdx] = true;
      selected.push(ranked[bestIdx]!);
      if (selected.length >= k) break;
      const chosen = bags[bestIdx]!;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const ov = jaccardBags(chosen, bags[i]!);
        if (ov > maxRed[i]!) maxRed[i] = ov;
      }
    }
    return selected;
  }
}

function normalizeForEmbed(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSkippableCode(c: number): boolean {
  // whitespace / common CJK + ASCII punctuation
  if (c <= 0x20) return true;
  if (c >= 0x30 && c <= 0x39) return false; // digits keep
  if (c >= 0x41 && c <= 0x5a) return false;
  if (c >= 0x61 && c <= 0x7a) return false;
  if (c >= 0x4e00 && c <= 0x9fff) return false;
  if (c >= 0x3400 && c <= 0x4dbf) return false;
  // punctuation ranges
  if (c >= 0x21 && c <= 0x2f) return true;
  if (c >= 0x3a && c <= 0x40) return true;
  if (c >= 0x5b && c <= 0x60) return true;
  if (c >= 0x7b && c <= 0x7e) return true;
  if (c >= 0x3000 && c <= 0x303f) return true;
  if (c >= 0xff00 && c <= 0xffef) return true;
  return false;
}

function bagOfUnits(text: string): Set<string> {
  const out = new Set<string>();
  const t = normalizeForEmbed(text);
  if (!t) return out;
  // CJK chars as units; latin as 3-grams / words
  let buf = "";
  const flush = () => {
    if (buf.length >= 2) {
      if (buf.length <= 12) out.add(buf);
      else {
        for (let i = 0; i + 3 <= buf.length; i++) out.add(buf.slice(i, i + 3));
      }
    }
    buf = "";
  };
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x4e00 && c <= 0x9fff) {
      flush();
      out.add(ch);
    } else if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) {
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Bounded by-content bag cache (strings are shared by reference, so a hit pins
 * no copy of the text). Callers only read the returned Set, never mutate it.
 */
const BAG_CACHE_LIMIT = 64;
/**
 * Total retained key characters. Without this, 64 slots × a ~200k-char summary
 * keeps both the string and a large unit Set pinned across turns in a
 * long-running server. Generous enough to preserve the in-call reuse
 * (`sanitizeHits` scoring several hits against one summary).
 */
const BAG_CACHE_CHARS = 1_000_000;
const bagCache = new Map<string, Set<string>>();
let bagCacheChars = 0;

function bagOfUnitsCached(text: string): Set<string> {
  const hit = bagCache.get(text);
  if (hit) return hit;
  const bag = bagOfUnits(text);
  bagCache.set(text, bag);
  bagCacheChars += text.length;
  // Never evict the entry we just inserted (it is the newest key).
  while (bagCache.size > 1 && (bagCache.size > BAG_CACHE_LIMIT || bagCacheChars > BAG_CACHE_CHARS)) {
    const oldest = bagCache.keys().next().value;
    if (oldest === undefined) break;
    bagCache.delete(oldest);
    bagCacheChars -= oldest.length;
  }
  return bag;
}

/** Jaccard over prebuilt bags (empty bag ⇒ 0). Symmetric. */
function jaccardBags(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  let inter = 0;
  for (const x of small) if (large.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Above this pool size a partial selection beats a full sort. */
const TOPK_HEAP_MIN = 512;

/**
 * Stable descending-by-score top-k: exactly
 * `[...items].sort((a, b) => b.score - a.score).slice(0, k)`, but O(n log k) via
 * a fixed-size min-heap once the pool is large. Ties are broken by original
 * index (earlier wins), matching the stable sort.
 */
function selectTopByScore<T extends { score: number }>(items: T[], k: number): T[] {
  const cap = Math.max(0, Math.floor(k));
  if (cap <= 0 || !items.length) return [];
  if (items.length <= cap || items.length < TOPK_HEAP_MIN) {
    return items.slice().sort((a, b) => b.score - a.score).slice(0, cap);
  }
  type Entry = { item: T; idx: number };
  const heap: Entry[] = [];
  const worse = (a: Entry, b: Entry): boolean =>
    a.item.score < b.item.score || (a.item.score === b.item.score && a.idx > b.idx);
  const siftUp = (i: number): void => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!worse(heap[i]!, heap[parent]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[parent]!;
      heap[parent] = tmp;
      i = parent;
    }
  };
  const siftDown = (i: number): void => {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l < heap.length && worse(heap[l]!, heap[smallest]!)) smallest = l;
      if (r < heap.length && worse(heap[r]!, heap[smallest]!)) smallest = r;
      if (smallest === i) break;
      const tmp = heap[i]!;
      heap[i] = heap[smallest]!;
      heap[smallest] = tmp;
      i = smallest;
    }
  };
  for (let i = 0; i < items.length; i++) {
    const entry: Entry = { item: items[i]!, idx: i };
    if (heap.length < cap) {
      heap.push(entry);
      siftUp(heap.length - 1);
    } else if (worse(heap[0]!, entry)) {
      heap[0] = entry;
      siftDown(0);
    }
  }
  return heap
    .sort((a, b) => b.item.score - a.item.score || a.idx - b.idx)
    .map((e) => e.item);
}

function mix32(a: number, b: number): number {
  let h = Math.imul(a ^ (b + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function l2normalize(vec: number[]): number[] {
  let n = 0;
  for (const v of vec) n += v * v;
  if (n <= 0) return vec;
  const s = Math.sqrt(n);
  return vec.map((v) => v / s);
}

function resolveRowUpdatedAt(
  r: VectorRow,
  meta?: Map<string, { updatedAt?: number }>,
): number | null {
  const fromMeta = meta?.get(r.sourceId)?.updatedAt ?? meta?.get(r.id)?.updatedAt;
  if (typeof fromMeta === "number" && Number.isFinite(fromMeta)) return fromMeta;
  const m = /#ts=(\d+)/.exec(r.sourceId);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
