/**
 * Memory audit — did this pipeline stage quietly lose memory?
 *
 * Why this exists
 * ---------------
 * The structured-memory rules are full of "never drop this" promises: hard facts
 * are the last column to be sacrificed (`MEMORY_COLUMN_SACRIFICE_ORDER`), and a
 * one-character hard fact must not be mistaken for a stub (AUDIT F-2 — a real
 * incident where `"火"` was deleted on every merge).
 *
 * Those promises were only enforced by tests. Once a host is running, every
 * `merge` / `normalize` / clip can drop content and nothing says so: the memory
 * just gets worse, and the first symptom is the model forgetting something ten
 * turns later. This module turns the promises into a runtime check.
 *
 * It reports facts, not guesses: which units disappeared, from which column,
 * and whether the document also got shorter (i.e. was plausibly clipped, which
 * is allowed). It deliberately does NOT decide whether a loss was legitimate.
 */
import { MEMORY_COLUMN_SACRIFICE_ORDER, type MemoryColumnTitle } from "../types";
import {
  detectUnknownColumns,
  looksStructured,
  normalizeStructuredMemory,
  splitMemoryColumns,
  splitTextUnits,
} from "./structuredMemory";

export type MemoryAuditLoss = {
  column: string;
  units: string[];
};

export type MemoryAuditReport = {
  /** `not-structured` = the "before" text has no known columns, so auditing is meaningless. */
  verdict: "clean" | "degraded" | "data-loss" | "not-structured";
  /** Units present before and absent after, per column. */
  lost: MemoryAuditLoss[];
  /**
   * Losses from the two protected columns (【硬事实】/【未决】). These are the ones
   * the rules promise to keep; anything here deserves attention.
   */
  lostProtected: MemoryAuditLoss[];
  /**
   * Units that sat *outside* every column (the preamble) and did not survive.
   *
   * Why this exists: column-wise comparison is blind to exactly the loss the
   * normalizer itself performs. Measured before the fix,
   * `auditMemory(before, normalize(before))` returned `verdict: "clean"` with an
   * empty `lostProtected` for a document whose opening line ("重要硬事实：火…")
   * had in fact been deleted — the content was never associated with a column,
   * so nothing compared it. A "hard facts are never lost" runtime guard that
   * reports `clean` while losing them is worse than no guard.
   */
  preambleLost: string[];
  /** Unrecognised bracket titles — the entry point of silent format drift. */
  unknownColumns: { before: string[]; after: string[] };
  /**
   * A protected column lost content while a column *later* in the sacrifice
   * order kept all of its own. Order says the later one should have gone first.
   */
  sacrificeOrderViolated: boolean;
  beforeChars: number;
  afterChars: number;
  /** The document also shrank — consistent with (allowed) clipping. */
  shrank: boolean;
};

const PROTECTED_COLUMNS = new Set<string>(["【硬事实】", "【未决】"]);

/** Mirrors `compactKey` in structuredMemory (not exported there). */
function squash(s: string): string {
  return s.replace(/\s+/g, "").replace(/[；;，,。！？!?、·…]/g, "");
}

/**
 * Units that live *outside* any recognised column, taken from the **raw** text.
 *
 * Deliberately does not normalize first: normalizing is one of the operations
 * being audited.
 */
function preambleUnits(text: string): string[] {
  const src = (text ?? "").trim();
  if (!src) return [];
  const out: string[] = [];
  for (const col of splitMemoryColumns(src)) {
    if (col.title) continue;
    for (const unit of splitTextUnits(col.body ?? "")) {
      const t = unit.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Index of a column in the sacrifice order; unknown columns sort last. */
function sacrificeRank(column: string): number {
  const idx = (MEMORY_COLUMN_SACRIFICE_ORDER as readonly string[]).indexOf(column);
  return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
}

function columnUnits(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const col of splitMemoryColumns(normalizeStructuredMemory(text))) {
    if (!col.title) continue;
    const body = (col.body ?? "").trim();
    if (!body || body === "无") continue;
    const set = out.get(col.title) ?? new Set<string>();
    for (const unit of splitTextUnits(body)) {
      const t = unit.trim();
      if (t) set.add(t);
    }
    if (set.size) out.set(col.title, set);
  }
  return out;
}

export function auditMemory(
  before: string | null | undefined,
  after: string | null | undefined,
): MemoryAuditReport {
  const b = before ?? "";
  const a = after ?? "";
  const beforeUnits = columnUnits(b);
  const afterUnits = columnUnits(a);
  /*
   * Preamble losses are computed against the *whole* after text (not per column):
   * the preamble fix folds that content into 【硬事实】, so "did this text survive
   * anywhere at all" is the right question. Squashed comparison so re-wrapping /
   * punctuation changes do not read as a loss.
   *
   * Units already reported as a column loss are removed below: after the fix a
   * preamble can legitimately be *tracked* as 【硬事实】, and reporting it twice
   * (once as a protected loss, once as a preamble loss) would just be noise. What
   * is left here is precisely "losses column comparison alone would have missed",
   * which is what this field is for.
   */
  const afterSquashed = squash(a);
  const preambleLost = preambleUnits(b).filter((u) => {
    const k = squash(u);
    return k.length > 0 && !afterSquashed.includes(k);
  });

  const base: MemoryAuditReport = {
    verdict: "clean",
    lost: [],
    lostProtected: [],
    preambleLost,
    unknownColumns: { before: detectUnknownColumns(b), after: detectUnknownColumns(a) },
    sacrificeOrderViolated: false,
    beforeChars: b.length,
    afterChars: a.length,
    shrank: a.length < b.length,
  };

  if (!looksStructured(b)) {
    /*
     * The audit compares *columns*. If the incoming text has no recognised
     * column at all, there is nothing to compare — and it must not be reported as
     * "clean", which would read as "verified lossless".
     *
     * This check has to run on the raw text, before normalization: `normalize`
     * deliberately wraps unstructured prose into a full column skeleton (body →
     * 【硬事实】), so after normalizing there is always at least one column and the
     * question becomes unanswerable.
     */
    return { ...base, verdict: "not-structured" };
  }
  if (beforeUnits.size === 0) {
    return { ...base, verdict: "not-structured" };
  }

  const lost: MemoryAuditLoss[] = [];
  for (const [column, units] of beforeUnits) {
    const survivors = afterUnits.get(column) ?? new Set<string>();
    const missing = [...units].filter((u) => !survivors.has(u));
    if (missing.length) lost.push({ column, units: missing });
  }

  const lostProtected = lost.filter((l) => PROTECTED_COLUMNS.has(l.column));

  // Order check: a protected column lost something while a column that should be
  // sacrificed FIRST kept everything it had.
  let sacrificeOrderViolated = false;
  if (lostProtected.length) {
    const worstLostRank = Math.max(...lostProtected.map((l) => sacrificeRank(l.column)));
    for (const [column, units] of beforeUnits) {
      if (sacrificeRank(column) >= worstLostRank) continue; // should-die-later columns are fine
      const survivors = afterUnits.get(column) ?? new Set<string>();
      if ([...units].every((u) => survivors.has(u))) {
        sacrificeOrderViolated = true;
        break;
      }
    }
  }

  const protectedLost = lostProtected.length > 0;
  // Keep `preambleLost` to what column comparison alone would have missed —
  // otherwise the same sentence is warned about twice.
  const reportedUnits = new Set<string>();
  for (const l of lost) for (const u of l.units) reportedUnits.add(squash(u));
  const preambleOnly = preambleLost.filter((u) => !reportedUnits.has(squash(u)));
  const anyLost = lost.length > 0 || preambleOnly.length > 0;
  return {
    ...base,
    verdict: protectedLost ? "data-loss" : anyLost ? "degraded" : "clean",
    lost,
    lostProtected,
    preambleLost: preambleOnly,
    sacrificeOrderViolated,
  };
}

/**
 * Warning strings for a report. Empty when nothing was lost.
 *
 * Codes are `memory-*` so {@link classifyPrepareWarning} files them as `notice`:
 * visible on the dashboard, without marking the whole turn as degraded (the
 * prompt is still usable — the memory is just poorer than it was).
 */
export function memoryAuditWarnings(report: MemoryAuditReport, opts?: { maxUnits?: number }): string[] {
  const max = Math.max(1, Math.min(5, opts?.maxUnits ?? 3));
  const out: string[] = [];
  for (const loss of report.lostProtected) {
    const sample = loss.units.slice(0, max).join(" / ");
    out.push(`memory-lost-protected:${loss.column}:${sample}`);
  }
  for (const loss of report.lost) {
    if (PROTECTED_COLUMNS.has(loss.column)) continue; // already reported above
    const sample = loss.units.slice(0, max).join(" / ");
    out.push(`memory-lost-column:${loss.column}:${sample}`);
  }
  if (report.preambleLost.length) {
    const sample = report.preambleLost.slice(0, max).join(" / ");
    out.push(`memory-lost-preamble:${sample}`);
  }
  if (report.sacrificeOrderViolated) {
    out.push("memory-sacrifice-order-violated");
  }
  for (const title of report.unknownColumns.after) {
    out.push(`memory-unknown-column:${title}`);
  }
  return out;
}

/** Columns whose loss should page someone, for callers that want the short list. */
export function protectedColumns(): MemoryColumnTitle[] {
  return ["【硬事实】", "【未决】"];
}
