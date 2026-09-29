/**
 * Shared structured long-term memory document parsing.
 *
 * Single secret for column/document layout — used by MemoryEngine (authoring),
 * ContextEngine block commit/clip, and ContextEngine soft trim.
 * Do not re-implement title scanning elsewhere.
 */
import {
  MEMORY_COLUMN_SACRIFICE_ORDER,
  MEMORY_COLUMN_TITLES,
  type MemoryColumnTitle,
} from "../types";

export type MemoryColumnSlice = {
  title: string;
  body: string;
};

export type MemoryDocument = {
  /** e.g. 【记忆块 1/3】 — empty for a single unlabeled doc */
  label: string;
  body: string;
};

/**
 * Legacy / synonymous column titles → canonical title.
 *
 * Why: the whole normalize/merge/clip machinery keys off exact column titles.
 * A stored summary written by an older prompt (or by a different host) that
 * says 「【长期事实】」 instead of 「【硬事实】」 is *not* recognised at all —
 * `splitMemoryColumns` finds no canonical title, so the document is treated as
 * unstructured and its entire body is dumped into 【硬事实】. That is silent
 * data degradation: no error, no warning, just a worse memory from then on.
 *
 * Titles are bracket-delimited, which makes them self-delimiting: `【事实】`
 * can never match inside `【硬事实】`, so alias matching cannot double-count.
 */
export const MEMORY_COLUMN_ALIASES: Record<MemoryColumnTitle, string[]> = {
  "【硬事实】": ["【长期事实】", "【核心事实】", "【确定事实】", "【事实】", "【设定】"],
  "【时间线】": ["【事件时间线】", "【时间线记录】", "【大事记】", "【发生的事】"],
  "【关系与称呼】": ["【人物关系】", "【关系】", "【称呼】"],
  "【未决】": ["【未决事项】", "【待决】", "【悬而未决】", "【开放问题】"],
  "【近期情节】": ["【最近情节】", "【近期剧情】", "【最近剧情】", "【当前情节】"],
};

/** Accepts canonical titles (identity) and known aliases. Returns null when unknown. */
export function canonicalColumnTitle(title: string): MemoryColumnTitle | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  if ((MEMORY_COLUMN_TITLES as readonly string[]).includes(t)) return t as MemoryColumnTitle;
  for (const canonical of MEMORY_COLUMN_TITLES) {
    if (MEMORY_COLUMN_ALIASES[canonical].includes(t)) return canonical;
  }
  return null;
}

/** Every accepted title string → canonical. Longest-first so扫描优先长匹配。 */
function columnCandidates(): { probe: string; canonical: MemoryColumnTitle }[] {
  const out: { probe: string; canonical: MemoryColumnTitle }[] = [];
  for (const canonical of MEMORY_COLUMN_TITLES) {
    out.push({ probe: canonical, canonical });
    for (const alias of MEMORY_COLUMN_ALIASES[canonical]) {
      out.push({ probe: alias, canonical });
    }
  }
  return out.sort((a, z) => z.probe.length - a.probe.length);
}

/**
 * Rewrite non-canonical *bracket forms* of a column header line into `【…】`.
 *
 * Why: the whole parser keys off `【】`, but models drop that habit easily —
 * they emit `［硬事实］` (full-width brackets), `[硬事实]` (half-width) or a
 * markdown `# 硬事实`. Measured before this fix:
 *
 *   normalize("［硬事实］\n火\n\n［未决］\n仇")
 *     → 【硬事实】 kept the literal `［硬事实］` line as *content*,
 *       【未决】 became 「无」 — 「仇」 never reached any column,
 *     and `detectUnknownColumns` (which only scans `【】`) reported nothing.
 *
 * That is the exact silent-degradation path `MEMORY_COLUMN_ALIASES` exists to
 * prevent; it just wore a different bracket.
 *
 * Conservative by construction: only a **whole line** that is nothing but a
 * bracketed (or `#`-prefixed) title gets rewritten, and only when the inner text
 * contains CJK. Prose containing brackets (`[1]`, `见 [附录]`) is untouched.
 */
export function normalizeMemoryHeaderLines(text: string): string {
  const src = text ?? "";
  // Cheap bail-out — the overwhelming majority of calls have nothing to rewrite.
  if (!src.includes("［") && !src.includes("[") && !src.includes("#")) return src;
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      const stripped = t.replace(/^#{1,6}\s*/, "");
      if (!/[\u3400-\u9fff]/.test(stripped)) return line;
      const m = /^[【［\[]\s*([^】］\]]{1,20}?)\s*[】］\]]$/.exec(stripped);
      if (m) {
        const inner = (m[1] ?? "").trim();
        return inner ? `【${inner}】` : line;
      }
      // Bare markdown heading (`# 硬事实`). Only rewritten when it is a title we
      // already know — `# 第一章` must stay prose, not become a column.
      if (stripped !== t && !/[。，；：、！？]/.test(stripped)) {
        const asTitle = `【${stripped}】`;
        if (canonicalColumnTitle(asTitle)) return asTitle;
      }
      return line;
    })
    .join("\n");
}

/**
 * Bracket-delimited titles that are neither canonical nor known aliases.
 *
 * These are the dangerous ones: an unseen title is not a column to the parser,
 * so its content silently joins whatever column precedes it (or the preamble).
 * Surfaced as `memory-unknown-column` so a format drift becomes visible instead
 * of quietly degrading memory quality.
 */
export function detectUnknownColumns(text: string): string[] {
  const src = normalizeMemoryHeaderLines(text ?? "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of src.matchAll(/【[^】\n]{1,16}】/g)) {
    const title = m[0]!;
    if (/^【记忆块\s*\d+\s*\/\s*\d+】$/.test(title)) continue;
    if (canonicalColumnTitle(title)) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push(title);
    if (out.length >= 12) break;
  }
  return out;
}

export type SummaryQuality = {
  /** False when the model did not return a structured document at all. */
  looksStructured: boolean;
  /** Canonical columns absent from the document. */
  missingColumns: string[];
  /** 【硬事实】carries a real body (not "无"). The single most important column. */
  hasHardFact: boolean;
  /** Bracket titles the parser does not recognise (format drift). */
  unknownColumns: string[];
  /** True when the body is empty or only column headers. */
  isEmpty: boolean;
  charCount: number;
  /** charCount / previous charCount. undefined when no previous was supplied. */
  lengthRatioVsPrev?: number | undefined;
};

/**
 * Structural quality of a structured summary — **no LLM involved**.
 *
 * Why structural only: ADR-003 rejected LLM-as-judge (flaky, costly, and it makes
 * CI depend on a model vendor). But the absence of a judge left the obvious gap —
 * the host could see `shouldSummarize: true` and nothing about whether the summary
 * that came back was any good. Length was the only signal available, so "the model
 * returned a plausible-looking paragraph that answers nothing" went unnoticed for
 * several turns.
 *
 * Missing columns and a missing 硬事实 are deterministic, free, and catch exactly
 * that failure. Determinism also means these can be asserted in eval.
 */
export function assessSummaryQuality(
  text: string,
  opts?: { previous?: string | null | undefined; columnTitles?: readonly string[] | undefined },
): SummaryQuality {
  const src = (text ?? "").trim();
  const titles = opts?.columnTitles ?? (MEMORY_COLUMN_TITLES as readonly string[]);
  const cols = splitMemoryColumns(src);
  const present = new Set(cols.filter((c) => c.title).map((c) => c.title));
  const hardFactBody = (cols.find((c) => c.title === "【硬事实】")?.body ?? "").trim();
  const quality: SummaryQuality = {
    looksStructured: looksStructured(src),
    missingColumns: titles.filter((t) => !present.has(t)),
    hasHardFact: hardFactBody !== "" && hardFactBody !== "无",
    unknownColumns: detectUnknownColumns(src),
    isEmpty: src.length === 0,
    charCount: src.length,
  };
  const prev = opts?.previous?.trim();
  if (prev) {
    quality.lengthRatioVsPrev = prev.length > 0 ? src.length / prev.length : undefined;
  }
  return quality;
}

export type MemoryMigrationReport = {
  /** Normalized text — always canonical titles, canonical column order. */
  text: string;
  /** Alias titles rewritten to canonical. Empty when the doc was already canonical. */
  rewritten: { from: string; to: string }[];
  /** Titles the parser does not recognise (see {@link detectUnknownColumns}). */
  unknown: string[];
  /** True when `text` differs from the input. */
  changed: boolean;
};

/**
 * Normalize one stored memory document, reporting what had to be rewritten.
 *
 * Deliberately does NOT stamp a version marker into the text: the document body
 * is fed to the model, so any marker would burn prompt tokens every turn. The
 * version lives in the out-of-band envelope (`memoryEnvelope.ts`).
 */
export function migrateStructuredMemoryDocument(text: string): MemoryMigrationReport {
  const src = text ?? "";
  const rewritten: { from: string; to: string }[] = [];
  const seenFrom = new Set<string>();
  for (const { probe, canonical } of columnCandidates()) {
    if (probe === canonical) continue;
    if (seenFrom.has(probe)) continue;
    if (src.includes(probe)) {
      seenFrom.add(probe);
      rewritten.push({ from: probe, to: canonical });
    }
  }
  const migrated = normalizeStructuredMemory(src);
  return {
    text: migrated,
    rewritten,
    unknown: detectUnknownColumns(src),
    changed: migrated !== src,
  };
}

export function looksStructured(text: string): boolean {
  const src = normalizeMemoryHeaderLines(text ?? "");
  for (const { probe } of columnCandidates()) {
    if (src.includes(probe)) return true;
  }
  return false;
}

/** Split assembled multi-block memory into documents. */
export function splitMemoryDocuments(text: string): MemoryDocument[] {
  const src = (text ?? "").trim();
  if (!src) return [];
  const re = /【记忆块\s*\d+\s*\/\s*\d+】/g;
  const hits: { label: string; index: number; end: number }[] = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    hits.push({ label: m[0]!, index: m.index, end: m.index + m[0]!.length });
  }
  if (!hits.length) return [{ label: "", body: src }];

  const docs: MemoryDocument[] = [];
  const preamble = src.slice(0, hits[0]!.index).trim();
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const nextStart = i + 1 < hits.length ? hits[i + 1]!.index : src.length;
    const body = src.slice(cur.end, nextStart).trim();
    if (i === 0 && preamble) {
      docs.push({ label: cur.label, body: `${preamble}\n${body}`.trim() });
    } else {
      docs.push({ label: cur.label, body });
    }
  }
  return docs.filter((d) => d.body.trim());
}

/**
 * Split structured memory into titled columns.
 * Multi-block joins are flattened so every episode's columns are visible.
 */
export function splitMemoryColumns(text: string): MemoryColumnSlice[] {
  const src = normalizeMemoryHeaderLines(text ?? "").trim();
  if (!src) return [];

  if (/【记忆块\s*\d+\s*\/\s*\d+】/.test(src)) {
    const parts = src
      .split(/【记忆块\s*\d+\s*\/\s*\d+】/)
      .map((p) => p.trim())
      .filter(Boolean);
    const out: MemoryColumnSlice[] = [];
    for (const part of parts) out.push(...splitMemoryColumns(part));
    return out;
  }

  const indices: { title: MemoryColumnTitle; start: number; headerEnd: number }[] = [];
  for (const { probe, canonical } of columnCandidates()) {
    let from = 0;
    while (from < src.length) {
      const at = src.indexOf(probe, from);
      if (at < 0) break;
      indices.push({ title: canonical, start: at, headerEnd: at + probe.length });
      from = at + probe.length;
    }
  }
  if (!indices.length) return [{ title: "", body: src }];
  // Longer probes are scanned first, but sorting by position is what defines the
  // slice boundaries; ties keep the longest header (already first in the array).
  indices.sort((a, z) => a.start - z.start || z.headerEnd - a.headerEnd);
  const deduped: typeof indices = [];
  for (const cur of indices) {
    const last = deduped[deduped.length - 1];
    // Same offset = overlapping probes; the longest one already won the sort.
    if (last && last.start === cur.start) continue;
    deduped.push(cur);
  }
  const slices: MemoryColumnSlice[] = [];
  if (deduped[0]!.start > 0) {
    const preamble = src.slice(0, deduped[0]!.start).trim();
    if (preamble) slices.push({ title: "", body: preamble });
  }
  for (let i = 0; i < deduped.length; i++) {
    const cur = deduped[i]!;
    const end = i + 1 < deduped.length ? deduped[i + 1]!.start : src.length;
    const body = src
      .slice(cur.headerEnd, end)
      .replace(/^\s*\n?/, "")
      .trim();
    slices.push({ title: cur.title, body });
  }
  return slices;
}

/** Prefer hard-facts / open-loops for vector upsert; merges all episodes. */
export function extractSalientSlices(summaryText: string): { label: string; text: string }[] {
  const cols = splitMemoryColumns(summaryText);
  const out: { label: string; text: string }[] = [];
  for (const want of ["【硬事实】", "【未决】"] as const) {
    const bodies = cols
      .filter((c) => c.title === want && c.body && c.body !== "无")
      .map((c) => c.body.trim());
    if (!bodies.length) continue;
    const merged = dedupeTextUnits(bodies.join("；"));
    out.push({ label: want, text: `${want}\n${merged}`.trim() });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Normalize / dedupe                                                  */
/* ------------------------------------------------------------------ */

function compactKey(s: string): string {
  return s.replace(/\s+/g, "").replace(/[；;，,。！？!?、·…]/g, "");
}

/** Split a column body into clause-sized units for merge/dedupe. */
export function splitTextUnits(text: string): string[] {
  const src = (text ?? "").trim();
  if (!src) return [];
  if (src === "无") return [];
  return src
    .split(/(?<=[。！？；;\n])|(?<=[；;])/)
    .map((u) => u.replace(/^[；;\s]+|[；;\s]+$/g, "").trim())
    .filter((u) => u && u !== "无");
}

/**
 * Drop exact duplicates and near-substrings (keep the longer unit).
 * Joins survivors with `；`.
 */
export function dedupeTextUnits(textOrParts: string | string[]): string {
  const parts = Array.isArray(textOrParts)
    ? textOrParts.flatMap((p) => splitTextUnits(p))
    : splitTextUnits(textOrParts);
  if (!parts.length) return "无";

  const ranked = parts
    .map((raw, i) => ({ raw, key: compactKey(raw), i }))
    .filter((x) => x.key.length > 0)
    .sort((a, z) => z.key.length - a.key.length || a.i - z.i);

  // `ranked` is length-descending, so every already-kept key is at least as long
  // as the candidate's key: the shorter side of any near-dupe test is always the
  // candidate. That lets us (1) reject exact duplicates via a Set in O(1) and
  // (2) skip the expensive `includes` for every kept key whose length sits
  // outside the ≥0.85 ratio window. The result (which unit is kept / dropped) is
  // identical to the previous linear scan.
  const kept: { raw: string; key: string; i: number }[] = [];
  const exactKeys = new Set<string>();
  for (const cand of ranked) {
    const candLen = cand.key.length;
    let matched = exactKeys.has(cand.key);
    if (!matched) {
      // kept lengths are descending ⇒ `candLen / length >= 0.85` is monotone in
      // index; binary-search the first in-window key, then scan that band only.
      let lo = 0;
      let hi = kept.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candLen / kept[mid]!.key.length >= 0.85) hi = mid;
        else lo = mid + 1;
      }
      for (let j = lo; j < kept.length; j++) {
        const k = kept[j]!;
        if (k.key.length > candLen && candLen / k.key.length >= 0.85 && k.key.includes(cand.key)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      // The old replacement branch (`cand` strictly longer than the match) is
      // dead: `ranked` is length-descending, so a later candidate can never be
      // longer than the kept entry it matches.
      continue;
    }
    kept.push(cand);
    exactKeys.add(cand.key);
  }

  kept.sort((a, z) => a.i - z.i);
  const out = kept.map((k) => k.raw.replace(/[；;]+$/g, "").trim()).filter(Boolean);
  return out.length ? out.join("；") : "无";
}

/** True when a column body is too thin to keep (names-only / stub). */
export function isThinColumnBody(title: string, body: string): boolean {
  const t = (body ?? "").trim();
  if (!t || t === "无") return true;

  // Precious / identity columns: never kill on length alone. Empty / 「无」
  // already returned true above. Single-char nicknames ("哥") and timeline
  // nodes ("夜") are real memory — the old `t.length < 2` heuristic wiped them.
  if (
    title === "【硬事实】" ||
    title === "【未决】" ||
    title === "【关系与称呼】" ||
    title === "【时间线】"
  ) {
    return false;
  }

  if (title === "【近期情节】") {
    const hasBeat = /[。！？；;\n]/.test(t) || t.length >= 28;
    const hasAction = /[了着过到在把被让给开闭走进出说喊跪脱解开插抽含吞抵]/.test(t);
    // Absolute stubs or names-only without event signal.
    if (t.length < 4) return true;
    if (!hasBeat && !hasAction) return true;
  }
  if (t.length < 2) return true;
  return false;
}

/**
 * Bounded by-content memo for the pure normalizer. Soft-trim's binary search
 * calls clipStructuredSummary on the same memory text 20+ times (once per width
 * probe), re-normalizing it every time; this collapses that to one pass per
 * distinct input. Keys are content strings (never object identity) so an
 * in-place mutation can't produce a stale hit.
 */
const NORMALIZE_CACHE_LIMIT = 64;
/**
 * Total retained characters (key + value). Entry-count alone is not enough: in a
 * long-running server the 64 slots fill with 64 *different* memory texts (each
 * turn's text differs slightly), and a 200k-char document would pin ~25MB. The
 * budget is generous enough that the intended win (the same text normalized 20+
 * times inside one soft-trim pass) is fully preserved.
 */
const NORMALIZE_CACHE_CHARS = 1_000_000;
const normalizeCache = new Map<string, string>();
let normalizeCacheChars = 0;

/**
 * Canonicalize a memory document:
 * - bracket-form headers rewritten to `【…】` ({@link normalizeMemoryHeaderLines})
 * - text before the first column folded into 【硬事实】 (never discarded)
 * - fixed column order
 * - dedupe within columns + drop thin 近期情节
 * - scrub cross-column repeats (近期情节 vs 硬事实/时间线)
 */
export function normalizeStructuredMemory(text: string): string {
  const key = text ?? "";
  const hit = normalizeCache.get(key);
  if (hit !== undefined) return hit;
  const result = normalizeStructuredMemoryUncached(key);
  normalizeCache.set(key, result);
  normalizeCacheChars += key.length + result.length;
  // Never evict the entry we just inserted (it is the newest key).
  while (
    normalizeCache.size > 1 &&
    (normalizeCache.size > NORMALIZE_CACHE_LIMIT || normalizeCacheChars > NORMALIZE_CACHE_CHARS)
  ) {
    const oldest = normalizeCache.keys().next().value;
    if (oldest === undefined) break;
    const oldestVal = normalizeCache.get(oldest);
    normalizeCache.delete(oldest);
    normalizeCacheChars -= oldest.length + (oldestVal?.length ?? 0);
  }
  return result;
}

function normalizeStructuredMemoryUncached(text: string): string {
  const src = (text ?? "").trim();
  if (!src) return "";

  if (/【记忆块\s*\d+\s*\/\s*\d+】/.test(src)) {
    const docs = splitMemoryDocuments(src);
    // Preserve labels even for a single 【记忆块 1/1】 — otherwise the label
    // is stripped and later joins lose episode identity.
    if (docs.length >= 1 && docs.some((d) => d.label)) {
      return docs
        .map((d) => {
          const body = normalizeStructuredMemory(d.body);
          if (!body.trim()) return "";
          return d.label ? `${d.label}\n${body}` : body;
        })
        .filter(Boolean)
        .join("\n\n");
    }
  }

  const cols = splitMemoryColumns(src);
  const named = cols.filter((c) => (MEMORY_COLUMN_TITLES as readonly string[]).includes(c.title));
  if (!named.length) {
    const cleaned = dedupeTextUnits(src);
    if (!cleaned || cleaned === "无") return "";
    return (MEMORY_COLUMN_TITLES as readonly string[])
      .map((title) => `${title}\n${title === "【硬事实】" ? cleaned : "无"}`)
      .join("\n\n");
  }

  const buckets = new Map<string, string[]>();
  for (const title of MEMORY_COLUMN_TITLES) buckets.set(title, []);
  /*
   * Text before the first recognised column is KEPT, not discarded.
   *
   * The doc comment above used to read "drop unlabeled preamble garbage" and
   * that is exactly what the code did — silently, with no warning. Measured:
   *
   *   normalize("主角是林远，一名剑士。\n\n【时间线】\n第一天进城…")
   *     contains 「林远」 = false
   *
   * A summary that opens with one summary sentence is completely normal (the
   * summary prompt even forbids it, but models do it anyway), and that sentence
   * is typically "who this is" — the most expensive thing to lose. It went
   * missing on *every* write, and `auditMemory` could not see it either, because
   * it compares recognised columns only.
   *
   * Target column: 【硬事实】. Rationale — that is already what happens when a
   * document has no columns at all (everything lands in 【硬事实】), so this makes
   * the two paths agree instead of inventing new semantics, and 【硬事实】 is the
   * column that is never sacrificed first. Pure-noise preambles are still dropped
   * naturally: `compactKey` reduces punctuation-only text to "" and dedupe (which
   * runs over the bucket below) rejects empty keys.
   */
  const preambleText = cols
    .filter((c) => !c.title)
    .map((c) => (c.body ?? "").trim())
    .filter(Boolean)
    .join("\n");
  /*
   * A preamble carrying no letters or digits at all is pure structure noise
   * (`---`, `…`, `~~~`). The old code dropped *every* preamble, so keeping noise
   * would be a regression in the opposite direction — measured: `"---\n…"` landed
   * in 【硬事实】 verbatim.
   *
   * Only the all-noise case is filtered; a preamble that mixes noise with real
   * text is kept whole, because the text is the part that must not be lost.
   */
  const preamble = /[\p{L}\p{N}]/u.test(preambleText) ? preambleText : "";
  if (preamble) (buckets.get("【硬事实】") ?? []).push(preamble);
  for (const c of named) {
    const list = buckets.get(c.title);
    if (!list) continue;
    if (c.body?.trim()) list.push(c.body.trim());
  }

  const bodies = new Map<string, string>();
  for (const title of MEMORY_COLUMN_TITLES) {
    const merged = dedupeTextUnits(buckets.get(title) ?? []);
    bodies.set(title, isThinColumnBody(title, merged) ? "无" : merged);
  }

  const recent = bodies.get("【近期情节】") ?? "无";
  if (recent !== "无") {
    const canon = compactKey(
      `${bodies.get("【硬事实】") ?? ""}${bodies.get("【时间线】") ?? ""}`,
    );
    const kept = splitTextUnits(recent).filter((u) => {
      const k = compactKey(u);
      // Short beats ("他跑了。") are valid; only drop when long enough to be a
      // meaningful cross-column duplicate of 硬事实/时间线.
      if (k.length >= 4 && canon.includes(k)) return false;
      return true;
    });
    bodies.set("【近期情节】", kept.length ? dedupeTextUnits(kept) : "无");
    if (isThinColumnBody("【近期情节】", bodies.get("【近期情节】") ?? "无")) {
      bodies.set("【近期情节】", "无");
    }
  }

  return (MEMORY_COLUMN_TITLES as readonly string[])
    .map((title) => `${title}\n${bodies.get(title) ?? "无"}`)
    .join("\n\n");
}

/**
 * Column-wise merge of two memory texts.
 * 硬事实/未决/时间线/关系 union; 近期情节 prefer newer (if substantive).
 */
export function mergeStructuredMemoryTexts(older: string, newer: string): string {
  const aNorm = normalizeStructuredMemory(older);
  const bNorm = normalizeStructuredMemory(newer);
  const a = splitMemoryColumns(aNorm);
  const b = splitMemoryColumns(bNorm);
  const aNamed = a.some((c) => (MEMORY_COLUMN_TITLES as readonly string[]).includes(c.title));
  const bNamed = b.some((c) => (MEMORY_COLUMN_TITLES as readonly string[]).includes(c.title));
  if (!aNamed || !bNamed) {
    return normalizeStructuredMemory([older.trim(), newer.trim()].filter(Boolean).join("\n\n"));
  }

  const pick = (title: string): string => {
    const olderBodies = a.filter((c) => c.title === title).map((c) => c.body);
    const newerBodies = b.filter((c) => c.title === title).map((c) => c.body);
    if (title === "【近期情节】") {
      const n = newerBodies.filter((x) => !isThinColumnBody(title, x));
      if (n.length) return dedupeTextUnits(n[n.length - 1]!);
      return dedupeTextUnits(olderBodies);
    }
    return dedupeTextUnits([...olderBodies, ...newerBodies]);
  };

  const merged = (MEMORY_COLUMN_TITLES as readonly string[])
    .map((title) => `${title}\n${pick(title)}`)
    .join("\n\n");
  return normalizeStructuredMemory(merged);
}

/** Append a truncation marker while never exceeding `max`. */
function truncateWithMarker(text: string, max: number): string {
  const marker = "\n…（摘要已截断）";
  if (max <= marker.length) return text.slice(0, max);
  return `${text.slice(0, max - marker.length).trimEnd()}${marker}`;
}

/** Prefer cutting on sentence / clause boundaries. */
function clipBodyAtBoundary(body: string, max: number): string {
  const marker = "…（已省略）";
  if (body.length <= max) return body;
  if (max <= marker.length) return body.slice(0, max);
  const room = max - marker.length;
  let slice = body.slice(0, room);
  const breaks = ["。", "！", "？", "；", "\n", ";", ","].map((ch) => slice.lastIndexOf(ch));
  const best = Math.max(...breaks);
  if (best >= Math.floor(room * 0.35)) {
    slice = slice.slice(0, best + 1);
  }
  const out = `${slice.trimEnd()}${marker}`;
  return out.length <= max ? out : body.slice(0, max);
}

/** Column sacrifice for a single structured document (no 记忆块 wrappers). */
export function clipOneStructuredDocument(text: string, maxChars: number): string {
  const max = Math.floor(maxChars ?? 0);
  const normalized = normalizeStructuredMemory(text);
  // `max <= 0` means "do not clip" (callers use it as an explicit escape hatch).
  if (!(max > 0) || normalized.length <= max) return normalized;
  // Below even the empty template there is nothing well-formed to ship. The
  // caller drops the section instead of pasting in a half-written headline.
  if (max < minStructuredDocumentLength()) return "";

  const cols = splitMemoryColumns(normalized);
  const hasNamed = cols.some((c) => (MEMORY_COLUMN_TITLES as readonly string[]).includes(c.title));
  if (!hasNamed) {
    return truncateWithMarker(normalized, max);
  }

  const bodies = new Map<string, string>();
  for (const title of MEMORY_COLUMN_TITLES) {
    const hit = cols.find((c) => c.title === title);
    bodies.set(title, hit?.body?.trim() || "无");
  }

  const render = () =>
    (MEMORY_COLUMN_TITLES as readonly string[])
      .map((title) => {
        const body = bodies.get(title);
        if (body == null || body === "") return "";
        return `${title}\n${body}`;
      })
      .filter(Boolean)
      .join("\n\n");

  if (render().length <= max) return render();

  const precious = new Set<string>(["【硬事实】", "【未决】"]);
  for (const title of MEMORY_COLUMN_SACRIFICE_ORDER as MemoryColumnTitle[]) {
    if (render().length <= max) break;
    if (precious.has(title)) continue;
    if (bodies.has(title) && bodies.get(title) !== "无") bodies.set(title, "无");
  }

  for (const title of ["【未决】", "【硬事实】"] as const) {
    if (render().length <= max) break;
    const body = bodies.get(title);
    if (body == null || body === "无") continue;
    const headerCost = title.length + 1;
    const otherLen = Math.max(0, render().length - (headerCost + body.length));
    const roomForBody = Math.max(0, max - otherLen - headerCost - 8);
    if (roomForBody >= 16) {
      bodies.set(title, clipBodyAtBoundary(body, roomForBody));
    } else {
      bodies.set(title, "无");
    }
  }

  let out = render();
  if (out.length <= max) return normalizeStructuredMemory(out);
  out = truncateWithMarker(out, max);
  // CogniStack fix: DO NOT normalize here.
  //
  // `normalizeStructuredMemory` re-creates every column that the truncation
  // just cut off, so a document clipped to `max` grew back *over* `max`
  // (measured: ask for 40 chars, get 55). The budget must be authoritative
  // downstream — soft-trim money counts on it — so the truncated form ships
  // as-is even though a trailing column headline may be incomplete.
  return out;
}

/**
 * Smallest legal render of one structured document (all five columns set to
 * 「无」). Budgets below this cannot produce a well-formed document.
 */
export function minStructuredDocumentLength(): number {
  return (MEMORY_COLUMN_TITLES as readonly string[])
    .map((title) => `${title}\n无`)
    .join("\n\n").length;
}

/**
 * Clip structured memory (or multi-block join) by per-document column sacrifice,
 * then drop lowest-importance documents if still over budget (U-07).
 *
 * CogniStack contract: the result is always `maxChars` chars or shorter, except
 * when `maxChars <= 0`, which means "do not clip" (kept for API compatibility).
 * Budgets too small to hold even the empty template yield `""`.
 */
export function clipStructuredSummary(
  text: string,
  maxChars: number,
  opts?: { documentImportances?: number[] | null | undefined },
): string {
  const max = Math.floor(maxChars ?? 0);
  const normalized = normalizeStructuredMemory(text);
  if (!(max > 0) || normalized.length <= max) return normalized;

  const docs = splitMemoryDocuments(normalized);
  if (docs.length <= 1) {
    return clipOneStructuredDocument(docs[0]?.body ?? normalized, max);
  }

  // Drop lowest-importance docs first while over budget, then clip survivors.
  // Pre-clipping each to max/n emptied 【硬事实】 before importance could win.
  // Importance is resolved by the 【记忆块 n/m】 label index when present, so an
  // empty middle document filtered by splitMemoryDocuments cannot shift scores.
  let parts = docs.map((d, i) => ({
    label: d.label,
    body: d.body,
    importance: importanceForDocument(d, i, opts?.documentImportances),
    order: i,
  }));

  const render = () =>
    parts
      .map((p) => {
        const body = p.body.trim();
        if (!body) return "";
        return p.label ? `${p.label}\n${body}` : body;
      })
      .filter((t) => t.trim())
      .join("\n\n");

  while (parts.length > 1 && render().length > max) {
    let dropAt = 0;
    let best = Infinity;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const score = p.importance * 1000 + p.order;
      if (score < best) {
        best = score;
        dropAt = i;
      }
    }
    parts = parts.filter((_, i) => i !== dropAt);
  }

  if (parts.length === 1) {
    const only = parts[0]!;
    const body = clipOneStructuredDocument(only.body, max);
    // Empty body → drop entirely (do not ship orphan 【记忆块 n/m】 labels).
    if (!body) return "";
    // Prefer labeled form when it still fits; otherwise body-only clip.
    if (only.label) {
      const labeled = `${only.label}\n${body}`;
      if (labeled.length <= max) return labeled;
    }
    return body;
  }

  const roomEach = Math.max(64, Math.floor(max / parts.length));
  parts = parts
    .map((p) => ({
      ...p,
      body: clipOneStructuredDocument(p.body, roomEach),
    }))
    .filter((p) => p.body.trim());
  if (!parts.length) return "";
  if (parts.length === 1) {
    const only = parts[0]!;
    if (only.label) {
      const labeled = `${only.label}\n${only.body}`;
      if (labeled.length <= max) return labeled;
    }
    return only.body;
  }

  let out = render();
  if (out.length <= max) return out;

  while (parts.length > 1 && render().length > max) {
    let dropAt = 0;
    let best = Infinity;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const score = p.importance * 1000 + p.order;
      if (score < best) {
        best = score;
        dropAt = i;
      }
    }
    parts = parts.filter((_, i) => i !== dropAt);
  }

  out = render();
  if (out.length <= max) return out;
  if (parts.length === 1) {
    return clipOneStructuredDocument(parts[0]!.body, max);
  }
  const marker = "\n…（摘要已截断）";
  if (max <= marker.length) return "";
  const room = max - marker.length;
  const sliced = `${out.slice(0, room).trimEnd()}${marker}`;
  return sliced.length <= max ? sliced : out.slice(0, max);
}

/** Resolve importance for a memory document without shifting after empty drops. */
function importanceForDocument(
  doc: { label: string },
  fallbackIndex: number,
  importances?: number[] | null,
): number {
  const m = /【记忆块\s*(\d+)\s*\/\s*\d+】/.exec(doc.label);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (Number.isFinite(idx) && typeof importances?.[idx] === "number") {
      return importances[idx]!;
    }
  }
  if (typeof importances?.[fallbackIndex] === "number") return importances[fallbackIndex]!;
  return 50;
}
