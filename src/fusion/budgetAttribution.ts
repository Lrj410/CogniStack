/**
 * Per-section budget attribution.
 *
 * Why: `promptTokens / softTrimCap` tells you the prompt is full, but not *what
 * filled it*. Without attribution, tuning is guesswork — you change a knob, see
 * the fill move, and still do not know which section paid for it. The classic
 * case: the rules block and the card together crowd out the memory summary, and
 * nothing in the result says so.
 *
 * Attribution is bucketed by `SECTION_PRIORITY` rather than matched section by
 * section. Matching would require stable identity per section, which
 * `PromptSection` deliberately does not carry (it is just `{text, priority}`), and
 * soft trim may merge, split or drop entries. Bucketing is exact about what it
 * claims (tokens per priority tier) and cannot silently mis-pair two sections.
 */
import type { PromptSection, TokenCounter } from "../types";

export type SectionTierAttribution = {
  priority: number;
  /** Tokens across all sections of this tier before trimming. */
  beforeTokens: number;
  /** Tokens after trimming. */
  afterTokens: number;
  /** `beforeTokens - afterTokens`. */
  clippedTokens: number;
  sectionsBefore: number;
  sectionsAfter: number;
};

export type BudgetAttribution = {
  tiers: SectionTierAttribution[];
  systemBeforeTokens: number;
  systemAfterTokens: number;
  /** Total tokens removed from the system block. */
  clippedTokens: number;
  /** True when nothing was clipped (before and after are identical in size). */
  untouched: boolean;
};

/**
 * Compare a pre-trim and a post-trim section list.
 *
 * Pure. Token counts come from the injected counter, so a memoizing counter makes
 * this nearly free (the same strings were already counted during accounting).
 */
export function attributeBudget(
  before: readonly PromptSection[],
  after: readonly PromptSection[],
  counter: TokenCounter,
): BudgetAttribution {
  const tiers = new Map<number, SectionTierAttribution>();

  const touch = (priority: number): SectionTierAttribution => {
    const existing = tiers.get(priority);
    if (existing) return existing;
    const fresh: SectionTierAttribution = {
      priority,
      beforeTokens: 0,
      afterTokens: 0,
      clippedTokens: 0,
      sectionsBefore: 0,
      sectionsAfter: 0,
    };
    tiers.set(priority, fresh);
    return fresh;
  };

  let systemBeforeTokens = 0;
  for (const s of before) {
    const n = counter.count(s.text ?? "");
    const tier = touch(s.priority);
    tier.beforeTokens += n;
    tier.sectionsBefore += 1;
    systemBeforeTokens += n;
  }

  let systemAfterTokens = 0;
  for (const s of after) {
    const n = counter.count(s.text ?? "");
    const tier = touch(s.priority);
    tier.afterTokens += n;
    tier.sectionsAfter += 1;
    systemAfterTokens += n;
  }

  const list = [...tiers.values()]
    .map((t) => ({
      ...t,
      clippedTokens: Math.max(0, t.beforeTokens - t.afterTokens),
    }))
    // Heaviest tier first — that is the one worth acting on.
    .sort((a, z) => z.beforeTokens - a.beforeTokens || a.priority - z.priority);

  return {
    tiers: list,
    systemBeforeTokens,
    systemAfterTokens,
    clippedTokens: Math.max(0, systemBeforeTokens - systemAfterTokens),
    untouched: systemBeforeTokens === systemAfterTokens,
  };
}
