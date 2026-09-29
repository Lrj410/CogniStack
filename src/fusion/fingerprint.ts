/**
 * Cheap stable fingerprints for cache keys.
 *
 * Extracted from the RP dispatcher. `djb2` is order-sensitive over parts;
 * `contentFp` hashes the *full* string (plus length) so assemble-cache keys
 * cannot false-hit when only the middle of a long field changes.
 *
 * Earlier head+tail sampling missed middle edits of length-stable strings and
 * served stale prompts from the assemble cache — a correctness bug, not a
 * perf trade-off worth keeping.
 */

export function djb2(parts: readonly string[]): string {
  let h = 5381;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h = ((h << 5) + h + p.charCodeAt(i)) | 0;
    }
    h = ((h << 5) + h + 31) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Second mix with a different seed — paired with djb2 for ~64-bit assemble keys. */
export function djb2b(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h = Math.imul(h ^ p.charCodeAt(i), 0x01000193);
    }
    h = Math.imul(h ^ 0x1f, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Assemble-cache key: dual 32-bit mixes + total length (collision-resistant enough for LRU scopes). */
export function cacheKey(parts: readonly string[]): string {
  let len = 0;
  for (const p of parts) len += p.length;
  return `${djb2(parts)}:${djb2b(parts)}:${len.toString(36)}`;
}

export function contentFp(text: string | null | undefined): string {
  const s = text ?? "";
  if (!s) return "0";
  return `${s.length}:${djb2([s])}:${djb2b([s])}`;
}

/**
 * 有界记忆化的 `contentFp`。
 *
 * 装配缓存键每轮都要对卡片字段、每条 raw 消息、每条 lore 各求一次指纹，而
 * `contentFp` 是**两遍全串扫描**（djb2 + djb2b）。大卡片 + 长对话下这是每轮
 * 固定浪费；而绝大多数输入（历史消息、未变的卡片字段）在相邻轮次里完全相同。
 *
 * 按**内容**做键而不是对象身份，所以不存在"就地改了对象却命中旧指纹"的陈旧
 * 风险 —— 内容变了键就变了。V8 会缓存字符串 hash，重复查找同内容字符串是 O(1)。
 *
 * 两条内存护栏：
 *   1. 条目数有界（FIFO 淘汰）。
 *   2. 超长字符串**不进缓存**（只算不存），避免一条 200KB 的 `summary` 之类
 *      把长字符串长期钉在缓存里。
 */
const FP_CACHE_MAX_ENTRIES = 512;
const FP_CACHE_MAX_ENTRY_CHARS = 4_096;
const fpCache = new Map<string, string>();

export function contentFpCached(text: string | null | undefined): string {
  const s = text ?? "";
  if (!s) return "0";
  if (s.length > FP_CACHE_MAX_ENTRY_CHARS) return contentFp(s);
  const hit = fpCache.get(s);
  if (hit !== undefined) return hit;
  const fp = contentFp(s);
  if (fpCache.size >= FP_CACHE_MAX_ENTRIES) {
    // Map 保持插入序 → 删最早插入的即 FIFO。
    const oldest = fpCache.keys().next();
    if (!oldest.done) fpCache.delete(oldest.value);
  }
  fpCache.set(s, fp);
  return fp;
}

/**
 * Fingerprint of an arbitrary object, **insensitive to key order**.
 *
 * Why this exists: the assemble cache key enumerated a fixed list of card fields
 * (name / description / personality / scenario / system_prompt /
 * post_history_instructions / mes_example / depth_prompt). That is exactly the
 * set `defaultCardResolver` reads — but `card` is a *port*, and a host-supplied
 * resolver may render anything else it likes (`creator`, `first_mes`, `tags`,
 * `extensions`, …). Measured with a custom resolver: changing only `creator`
 * produced `cacheHit: true` and a prompt still containing the OLD value. That is
 * a silently wrong prompt, i.e. the worst possible failure for a cache.
 *
 * So the whole profile goes into the key. Order-insensitivity matters because a
 * host may rebuild the profile object per turn with a different key order, which
 * would otherwise invalidate the cache on every call.
 *
 * Bounded depth: profiles are shallow; a pathological/cyclic object falls back to
 * `JSON.stringify` (which throws on cycles → the caller's guard handles it) rather
 * than recursing forever.
 */
export function stableValueFp(value: unknown, depth = 0): string {
  if (value == null) return "null";
  const t = typeof value;
  if (t === "string") return `s${contentFpCached(value as string)}`;
  if (t === "number" || t === "boolean" || t === "bigint") return `p${String(value)}`;
  if (t === "function" || t === "symbol") return "f";
  if (depth >= 6) return `d${contentFpCached(JSON.stringify(value) ?? "")}`;
  if (Array.isArray(value)) {
    return `a[${value.map((v) => stableValueFp(v, depth + 1)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `o{${keys.map((k) => `${k}:${stableValueFp(obj[k], depth + 1)}`).join(",")}}`;
}
