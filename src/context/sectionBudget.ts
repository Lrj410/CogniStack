/**
 * Layered token budget for system sections (U-01).
 *
 * Instead of only sacrificing low-priority sections after the fact, allocate a
 * fair share up-front (weighted by SECTION_PRIORITY) so high-value layers keep
 * coherent chunks rather than being nibbled last by a global binary search.
 */
import type { TokenCounter } from "../types";
import { SECTION_PRIORITY } from "../types";

export type BudgetSection = {
  text: string;
  index: number;
  priority: number;
};

/** Higher priority → larger weight. Floors prevent tiny high-pri slices. */
export function sectionBudgetWeight(priority: number): number {
  const p = Math.max(1, Math.floor(priority));
  // Square-ish curve: postHistory(90) ≫ systemRules(10)
  return p * p;
}

/**
 * Water-fill allocations (tokens) for each section index.
 * Unused slack from short sections is redistributed to longer ones by weight.
 */
export function planSectionTokenAllocations(
  sections: BudgetSection[],
  tokenBudget: number,
  counter: TokenCounter,
): Map<number, number> {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const alloc = new Map<number, number>();
  if (!sections.length || budget <= 0) return alloc;

  const natural = sections.map((s) => ({
    ...s,
    tokens: Math.max(0, counter.count(s.text)),
  }));
  const totalNatural = natural.reduce((n, s) => n + s.tokens, 0);
  if (totalNatural <= budget) {
    for (const s of natural) alloc.set(s.index, s.tokens);
    return alloc;
  }

  // Min floor for non-empty sections (keep a stub of high-priority layers).
  const minFloor = Math.min(48, Math.max(16, Math.floor(budget / Math.max(4, natural.length * 2))));

  type Row = { index: number; priority: number; natural: number; weight: number };
  let active: Row[] = natural
    .filter((s) => s.tokens > 0)
    .map((s) => ({
      index: s.index,
      priority: s.priority,
      natural: s.tokens,
      weight: sectionBudgetWeight(s.priority),
    }));

  let remaining = budget;
  // First pass: guarantee floors for highest priority while budget lasts.
  active.sort((a, z) => z.priority - a.priority || a.index - z.index);
  for (const row of active) {
    const floor = Math.min(row.natural, minFloor);
    if (remaining < floor) break;
    alloc.set(row.index, floor);
    remaining -= floor;
  }

  // Water-fill the rest by weight, never exceeding natural.
  //
  // Each round can top up every active row, so the rounds needed are bounded by
  // the section count. A fixed cap silently stopped distributing once there were
  // more sections than that, leaving budget unspent.
  const maxRounds = Math.max(4, natural.length * 2 + 4);
  let guard = 0;
  while (remaining > 0 && active.length && guard < maxRounds) {
    guard += 1;
    active = active.filter((row) => (alloc.get(row.index) ?? 0) < row.natural);
    if (!active.length) break;

    const weightSum = active.reduce((n, r) => n + r.weight, 0) || 1;
    let progressed = false;
    // Snapshot remaining so simultaneous fair shares don't starve later rows.
    const slice = remaining;
    for (const row of active) {
      const have = alloc.get(row.index) ?? 0;
      const room = row.natural - have;
      if (room <= 0) continue;
      const share = Math.max(1, Math.floor((slice * row.weight) / weightSum));
      const add = Math.min(room, share, remaining);
      if (add <= 0) continue;
      alloc.set(row.index, have + add);
      remaining -= add;
      progressed = true;
      if (remaining <= 0) break;
    }
    if (!progressed) {
      // Give leftover 1-token crumbs to highest priority with room.
      active.sort((a, z) => z.priority - a.priority);
      for (const row of active) {
        const have = alloc.get(row.index) ?? 0;
        if (have >= row.natural || remaining <= 0) continue;
        alloc.set(row.index, have + 1);
        remaining -= 1;
        progressed = true;
        break;
      }
      if (!progressed) break;
    }
  }

  for (const s of natural) {
    if (!alloc.has(s.index)) alloc.set(s.index, 0);
  }
  return alloc;
}

/**
 * Clip section text to approximately `tokenCap` tokens.
 * Uses char binary search + TokenCounter (same pattern as soft trim).
 */
export function clipTextToTokenCap(
  text: string,
  tokenCap: number,
  counter: TokenCounter,
  clipChars: (source: string, maxChars: number) => string,
): string {
  const cap = Math.floor(tokenCap);
  if (cap <= 0) return "";
  if (counter.count(text) <= cap) return text;

  let lo = 0;
  let hi = text.length;
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const piece = mid <= 0 ? "" : clipChars(text, mid);
    if (counter.count(piece) <= cap) {
      best = piece;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export { SECTION_PRIORITY };
