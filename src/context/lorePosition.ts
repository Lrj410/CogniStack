/**
 * Lore entry placement normalization (pure mapping for the assemble stage).
 *
 * Slot wire values (`before_char`, …) are stable storage aliases — they mean
 * "before / after the agent profile block", not roleplay-only semantics.
 */
import type { LoreSlot, WorldBookPosition } from "../types";

export type LorePosition =
  | "before_char"
  | "after_char"
  | "before_example"
  | "after_example"
  | "an_top"
  | "an_bottom"
  | "at_depth";

/**
 * Index map (wire-stable):
 * 0 before_char · 1 after_char · 2 before_example ·
 * 3 after_example · 4 note top · 5 note bottom · 6 at_depth
 */
const BY_INDEX: LorePosition[] = [
  "before_char",
  "after_char",
  "before_example",
  "after_example",
  "an_top",
  "an_bottom",
  "at_depth",
];

const STRING_POSITIONS = new Set<string>(BY_INDEX);

export function normalizeLoreSlot(position?: LoreSlot | WorldBookPosition): LorePosition {
  if (typeof position === "string") {
    return STRING_POSITIONS.has(position) ? (position as LorePosition) : "before_char";
  }
  if (typeof position === "number" && Number.isFinite(position)) {
    const idx = Math.floor(position);
    return BY_INDEX[idx] ?? "before_char";
  }
  return "before_char";
}

/** @deprecated Use {@link normalizeLoreSlot} */
export const normalizeWorldBookPosition = normalizeLoreSlot;

export { BY_INDEX as LORE_SLOT_ORDER, BY_INDEX as WORLD_BOOK_POSITION_ORDER };
