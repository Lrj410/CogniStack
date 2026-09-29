/**
 * MemoryBlocksEngine — committed summary-block budget, merge, and clip.
 *
 * Internal base of ContextEngine. Prefer `dispatcher.context`.
 */
import type { SummaryBlock } from "../types";
import { clipStructuredSummary, mergeStructuredMemoryTexts } from "./structuredMemory";

/**
 * Local merge of oldest blocks until count AND optional total-size fit.
 * Uses column-wise merge when both sides are structured.
 *
 * Module-level (not only a method) so the fusion engine can apply the policy at
 * the single point where blocks are resolved, without reaching into the
 * ContextEngine's collaborator graph.
 */
export function mergeOldestBlocks(
  blocks: SummaryBlock[],
  maxBlocks: number,
  maxBlockChars = 0,
  maxTotalBlockChars = 0,
): SummaryBlock[] {
  const m = Math.max(1, maxBlocks);
  let next = blocks.slice();
  const overSize = () => {
    const cap = Math.floor(maxTotalBlockChars ?? 0);
    return cap > 0 && totalBlockChars(next) > cap;
  };
  while (next.length > m || (next.length > 1 && overSize())) {
    const a = next[0]!;
    const b = next[1]!;
    const mergedText = mergeStructuredMemoryTexts(a.text, b.text);
    const clipped =
      maxBlockChars > 0 ? clipStructuredSummary(mergedText, maxBlockChars) : mergedText;
    const merged: SummaryBlock = {
      id: `merge-${a.id}-${b.id}`,
      text: clipped,
      throughMessageId: b.throughMessageId,
      pairCount: (a.pairCount ?? 0) + (b.pairCount ?? 0),
      kind: "full",
      importance: Math.max(a.importance ?? 80, b.importance ?? 80),
    };
    next = [merged, ...next.slice(2)];
  }
  const cap = Math.floor(maxTotalBlockChars ?? 0);
  if (cap > 0 && next.length === 1 && totalBlockChars(next) > cap) {
    const only = next[0]!;
    next = [{ ...only, text: clipStructuredSummary(only.text, cap) }];
  }
  return next;
}

function totalBlockChars(blocks: SummaryBlock[]): number {
  return blocks.reduce((n, b) => n + (b.text?.length ?? 0), 0);
}

export type BlockCompactionPolicy = {
  maxBlocks: number;
  maxBlockChars: number;
  maxTotalBlockChars: number;
};

/**
 * Apply the memory policy to a block list: bound the count, and — when the policy
 * sets them — the per-block and total character caps.
 *
 * Why this exists: `MemoryCompressPolicy.maxBlocks` / `maxBlockChars` /
 * `maxTotalBlockChars` were declared and handed to hosts, but **the engine never
 * applied them**. `prepare()` returned the caller's blocks untouched (measured:
 * 20 blocks in → 20 blocks out), while `joinSummaryBlocks` re-merged the whole
 * list for the prompt on every turn. A host that stores the returned
 * `summaryBlocks` as its authoritative state therefore grew the list forever —
 * the symptom `scripts/sim.cjs` shows as "49 blocks by turn 60, fill pinned at
 * 0.99, soft-trim every turn".
 *
 * Compacting here makes the returned (stored) view and the prompt view the same
 * thing, and makes `maxBlocks` mean what it says.
 *
 * Returns the **same array reference** when nothing needed to change, so callers
 * can cheaply tell whether the policy actually did anything.
 */
export function compactMemoryBlocks(
  blocks: SummaryBlock[],
  policy: BlockCompactionPolicy,
): SummaryBlock[] {
  const m = Math.max(1, Math.floor(policy.maxBlocks || 1));
  const per = Math.max(0, Math.floor(policy.maxBlockChars ?? 0));
  const total = Math.max(0, Math.floor(policy.maxTotalBlockChars ?? 0));
  const withinCount = blocks.length <= m;
  const withinSize = !(total > 0) || totalBlockChars(blocks) <= total;
  if (withinCount && withinSize) return blocks;
  return mergeOldestBlocks(blocks, m, per, total);
}

export class MemoryBlocksEngine {
  readonly id: string = "MemoryBlocksEngine";

  totalBlockChars(blocks: SummaryBlock[]): number {
    return totalBlockChars(blocks);
  }

  overBudget(
    blocks: SummaryBlock[],
    incomingText: string,
    policy: { maxBlocks: number; maxTotalBlockChars: number },
  ): boolean {
    if (blocks.length + 1 > Math.max(1, policy.maxBlocks)) return true;
    const cap = Math.floor(policy.maxTotalBlockChars ?? 0);
    if (!(cap > 0)) return false;
    return this.totalBlockChars(blocks) + incomingText.length > cap;
  }

  /**
   * Which write path a compress result should take.
   * fuse when count or total size would overflow; else incremental append.
   */
  planAction(params: {
    blocks: SummaryBlock[];
    incomingEstimateChars: number;
    policy: { maxBlocks: number; maxTotalBlockChars: number };
  }): { action: "fuse" | "incremental"; reason: "count" | "size" | "append" } {
    const { blocks, incomingEstimateChars, policy } = params;
    if (blocks.length + 1 > Math.max(1, policy.maxBlocks)) {
      return { action: "fuse", reason: "count" };
    }
    const cap = Math.floor(policy.maxTotalBlockChars ?? 0);
    if (cap > 0 && this.totalBlockChars(blocks) + incomingEstimateChars > cap) {
      return { action: "fuse", reason: "size" };
    }
    return { action: "incremental", reason: "append" };
  }

  clipStructuredSummary(
    text: string,
    maxChars: number,
    opts?: { documentImportances?: number[] | null },
  ): string {
    return clipStructuredSummary(text, maxChars, opts);
  }

  /** @deprecated alias — prefer clipStructuredSummary */
  clipSummaryTail(text: string, maxChars: number): string {
    return this.clipStructuredSummary(text, maxChars);
  }

  mergeStructuredMemoryTexts(older: string, newer: string): string {
    return mergeStructuredMemoryTexts(older, newer);
  }

  /** Head+tail clip for one opaque block (legacy / non-structured). */
  clipBlockText(text: string, maxChars: number): string {
    const max = Math.floor(maxChars ?? 0);
    if (!(max > 0) || text.length <= max) return text;
    const marker = "\n…（中段已省略）…\n";
    // CogniStack fix: never emit the marker alone when the budget is smaller
    // than the marker — that returned a string longer than `max`.
    if (max <= marker.length) return text.slice(0, max);
    const room = max - marker.length;
    const head = Math.floor(room * 0.6);
    const tail = room - head;
    const headText = text.slice(0, head).trimEnd();
    const tailText = text.slice(text.length - tail).trimStart();
    return `${headText}${marker}${tailText}`;
  }

  /**
   * Local merge of oldest blocks until count AND optional total-size fit.
   * Uses column-wise merge when both sides are structured.
   */
  mergeOldestBlocksLocal(
    blocks: SummaryBlock[],
    maxBlocks: number,
    maxBlockChars = 0,
    maxTotalBlockChars = 0,
  ): SummaryBlock[] {
    return mergeOldestBlocks(blocks, maxBlocks, maxBlockChars, maxTotalBlockChars);
  }

  /** Apply the full block policy (count + size caps). See {@link compactMemoryBlocks}. */
  compact(blocks: SummaryBlock[], policy: BlockCompactionPolicy): SummaryBlock[] {
    return compactMemoryBlocks(blocks, policy);
  }

  commitBlock(
    blocks: SummaryBlock[],
    block: SummaryBlock,
    maxBlocks: number,
    maxBlockChars = 0,
    maxTotalBlockChars = 0,
  ): SummaryBlock[] {
    return this.mergeOldestBlocksLocal(
      [...blocks, block],
      maxBlocks,
      maxBlockChars,
      maxTotalBlockChars,
    );
  }
}
