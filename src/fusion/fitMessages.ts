/**
 * Last-resort prompt fitting.
 *
 * Extracted verbatim from the RP dispatcher so it can be tested in isolation.
 * It is the *emergency* gate that runs when soft-trim alone cannot get the
 * prompt under `cap` (soft-trim may shrink the system block but must never drop
 * unsummarized dialogue; when the dialogue alone exceeds the cap something has
 * to go).
 *
 * CogniStack fixes vs. the original:
 *  - `dropped` now counts *real* removals/truncations. The source incremented it
 *    unconditionally in the last-resort branch, which produced bogus
 *    `dropped-1` warnings (and a bogus emergency-dialogue-window step) on turns
 *    where nothing actually changed.
 *  - The final "hard guarantee" pass no longer double-counts a clip it already
 *    applied.
 */
import type { RpMessage, TokenCounter } from "../types";

export type FitResult = {
  messages: RpMessage[];
  /** Messages removed or truncated. 0 means the input already fitted. */
  dropped: number;
};

/**
 * Note: the old `totalOf(system, dialogue, counter)` helper is gone on purpose —
 * re-summing the list at every step was the O(n²). Token counts now travel with
 * the messages (`items`) and the system count is kept in `systemTokens`.
 */

/** Clip so the returned string (including optional ellipsis) is ≤ tokenCap. */
export function clipToTokens(text: string, tokenCap: number, counter: TokenCounter): string {
  const cap = Math.max(0, Math.floor(tokenCap));
  if (cap <= 0) return "";
  if (counter.count(text) <= cap) return text;

  const ellipsis = "…";
  const ellipsisCost = counter.count(ellipsis);
  const longestPrefixWithin = (limit: number): string => {
    let lo = 0;
    let hi = text.length;
    let best = "";
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const piece = text.slice(0, mid);
      if (counter.count(piece) <= limit) {
        best = piece;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  if (cap <= ellipsisCost) return longestPrefixWithin(cap);

  const bodyCap = cap - ellipsisCost;
  const best = longestPrefixWithin(bodyCap);
  if (!best) return "";
  const withEllipsis = `${best}${ellipsis}`;
  return counter.count(withEllipsis) <= cap ? withEllipsis : best;
}

/**
 * Drop oldest non-system turns until the message list fits `cap` tokens.
 * Keeps the leading system (if any) and at least the last user+assistant pair
 * when possible; otherwise clips content to force a fit.
 */
/**
 * Drop oldest non-system turns until the message list fits `cap` tokens.
 *
 * **Order matters, and it is system-first.** The dialogue is what the caller
 * asked to keep — soft-trim's contract is that unsummarized dialogue is never
 * dropped — while the leading system block is where the *sacrificable* content
 * lives (rules, lore tail, sacrifice-ordered memory). So the system is shrunk
 * before any dialogue is removed.
 *
 * The previous order was the reverse and produced a real data loss: with a
 * 1500-char rules block and 8 short dialogue messages on a 512-token context, it
 * dropped 7 dialogue messages (leaving a single orphan `assistant` turn, breaking
 * the user/assistant pairing the same doc promises to preserve) while the rules
 * block still measured 279 chars, and then attributed the failure to the dialogue
 * (`prompt-budget-unreachable:dialogue-exceeds-cap`). The correct outcome was to
 * clip the rules block to `budget - dialogueTokens` and keep all 8 turns.
 *
 * Counts are maintained incrementally. The previous shape re-summed the whole
 * list after every step, which is O(n²) — measured 15.2s in a single call at
 * n=8000 messages, blocking the event loop in exactly the "host never summarized,
 * very long conversation" case this gate exists for.
 */
export function fitMessagesUnderTokenCap(
  messages: RpMessage[],
  cap: number,
  counter: TokenCounter,
): FitResult {
  const budget = Math.floor(cap);
  if (!(budget > 0)) {
    // Explicit non-positive cap: return empty prompt rather than inventing room.
    const dropped = messages.reduce((n, m) => n + (m.content ? 1 : 0), 0);
    return { messages: [], dropped };
  }

  const hasSystem = messages[0]?.role === "system";
  let system = hasSystem ? messages[0]! : null;
  /*
   * The working window lives in `items` as the `[lo, hi]` range instead of being
   * re-sliced on every drop.
   *
   * `items` is built fresh right here, so it is ours to mutate: removing from
   * either end becomes an index move, not an array copy. The old `items = items
   * .slice(1)` copied the whole tail once per dropped message — O(n²) element
   * copies on top of the re-summing that was already fixed. Behaviour is
   * unchanged; only the container is. (`hi` never moves: this algorithm only ever
   * drops from the front, and rewrites the tail in place.)
   */
  const items = (hasSystem ? messages.slice(1) : messages.slice()).map((msg) => ({
    msg,
    tokens: counter.count(msg.content),
  }));
  let lo = 0;
  const hi = items.length - 1;
  const count = () => hi - lo + 1;
  let dropped = 0;
  let systemTokens = system ? counter.count(system.content) : 0;
  let dialogueTokens = items.reduce((n, it) => n + it.tokens, 0);
  const total = () => systemTokens + dialogueTokens;

  if (total() <= budget) return { messages, dropped: 0 };

  // 1. Shrink the system block first — it is the section that may be sacrificed.
  if (system && systemTokens > Math.max(0, budget - dialogueTokens)) {
    const clipped = clipToTokens(system.content, Math.max(0, budget - dialogueTokens), counter);
    if (clipped !== system.content) {
      system = { ...system, content: clipped };
      systemTokens = counter.count(clipped);
      dropped += 1;
    }
  }

  // 2. System is as small as it can get and it still does not fit → the dialogue
  //    really is over budget. Drop oldest turns, keeping at least the last pair.
  while (count() > 2 && total() > budget) {
    dialogueTokens -= items[lo]!.tokens;
    lo += 1;
    dropped += 1;
  }

  // 3. Clip from the front of the remaining dialogue (keep ≥ 1 line).
  while (count() > 1 && total() > budget) {
    const head = items[lo]!;
    const restTokens = dialogueTokens - head.tokens;
    const room = Math.max(0, budget - systemTokens - restTokens);
    const clipped = clipToTokens(head.msg.content, room, counter);
    if (clipped.length > 0 && clipped.length < head.msg.content.length) {
      const clippedTokens = counter.count(clipped);
      items[lo] = { msg: { ...head.msg, content: clipped }, tokens: clippedTokens };
      dialogueTokens = restTokens + clippedTokens;
      dropped += 1;
      if (total() <= budget) break;
    }
    dropped += 1;
    dialogueTokens = restTokens;
    lo += 1;
  }

  // 4. Shrink the last remaining line.
  if (total() > budget && count() >= 1) {
    const last = items[hi]!;
    const room = Math.max(0, budget - systemTokens);
    const clipped = clipToTokens(last.msg.content, room, counter);
    if (clipped.length < last.msg.content.length) {
      const clippedTokens = counter.count(clipped);
      items[hi] = { msg: { ...last.msg, content: clipped }, tokens: clippedTokens };
      dialogueTokens += clippedTokens - last.tokens;
      dropped += 1;
    }
  }

  // 5. The dialogue alone busts the cap → the system cannot survive at all.
  if (system && total() > budget && dialogueTokens > budget) {
    system = null;
    systemTokens = 0;
    dropped += 1;
  }

  // 6. Hard guarantee: never return over budget.
  let guard = 0;
  const maxGuards = Math.max(messages.length + 16, 32);
  while (total() > budget && guard < maxGuards) {
    guard += 1;
    const before = total();

    if (count() > 1) {
      dialogueTokens -= items[lo]!.tokens;
      lo += 1;
      dropped += 1;
      continue;
    }
    if (system) {
      const room = Math.max(0, budget - dialogueTokens);
      const clippedSys = clipToTokens(system.content, room, counter);
      if (clippedSys.length < system.content.length) {
        system = { ...system, content: clippedSys };
        systemTokens = counter.count(clippedSys);
        dropped += 1;
      } else {
        // System still over even at empty — drop it so dialogue can fit.
        system = null;
        systemTokens = 0;
        dropped += 1;
      }
      if (total() <= budget) break;
    }
    if (count() === 1) {
      const cur = items[lo]!;
      const clippedLast = clipToTokens(
        cur.msg.content,
        Math.max(0, budget - systemTokens),
        counter,
      );
      if (clippedLast.length < cur.msg.content.length) {
        const clippedTokens = counter.count(clippedLast);
        items[lo] = { msg: { ...cur.msg, content: clippedLast }, tokens: clippedTokens };
        dialogueTokens = clippedTokens;
        dropped += 1;
      } else if (clippedLast.length === 0 && cur.msg.content.length > 0) {
        items[lo] = { msg: { ...cur.msg, content: "" }, tokens: 0 };
        dialogueTokens = 0;
        dropped += 1;
      }
    }

    // No progress → stop rather than spin (non-monotonic counters).
    if (total() >= before) break;
  }

  // 7. Absolute: if still over (broken / non-monotonic counter), nuke to a
  // single clipped line or empty. Small-ctx hosts must never leave prepare()
  // with promptTokens > hardFit.
  if (total() > budget) {
    system = null;
    systemTokens = 0;
    if (count() === 0) {
      return { messages: [], dropped: dropped + 1 };
    }
    const last = items[hi]!;
    const clipped = clipToTokens(last.msg.content, budget, counter);
    // Count once: extras removed + whether the surviving line was shortened.
    dropped += Math.max(0, count() - 1);
    if (clipped !== last.msg.content) dropped += 1;
    const clippedTokens = counter.count(clipped);
    items[hi] = { msg: { ...last.msg, content: clipped }, tokens: clippedTokens };
    lo = hi;
    dialogueTokens = clippedTokens;
    if (total() > budget) {
      items[hi] = { msg: { ...last.msg, content: "" }, tokens: 0 };
      dialogueTokens = 0;
      if (clipped.length > 0) dropped += 1;
    }
  }

  const out = items.slice(lo, hi + 1).map((it) => it.msg);
  return { messages: system ? [system, ...out] : out, dropped };
}
