import type { DialogueMessage, SummaryBlock } from "../types";
import { SummaryEngine } from "./SummaryEngine";

export type CompletePair = {
  user: DialogueMessage;
  assistant: DialogueMessage;
  /** Inclusive end index in dialogue array (assistant) */
  endIndex: number;
};

export function defaultCompressPolicy(
  pairBatchSize: number,
  patch?: Partial<import("../types").MemoryCompressPolicy>,
): import("../types").MemoryCompressPolicy {
  const n = Math.max(1, Math.floor(pairBatchSize || 10));
  const base: import("../types").MemoryCompressPolicy = {
    pairBatchSize: n,
    maxBlocks: 3,
    overlapPairs: 1,
    totalPromptCharCap: 0,
    contextCharLimit: 0,
    contextTriggerRatio: 0.7,
    maxBlockChars: 6_000,
    maxTotalBlockChars: 18_000,
    maxBatchChars: 24_000,
  };
  if (!patch) return base;

  const normalized = normalizeCompressPolicyPatch(patch);

  const effectiveBatchSize =
    typeof normalized.pairBatchSize === "number" && normalized.pairBatchSize > 0
      ? Math.floor(normalized.pairBatchSize)
      : base.pairBatchSize;

  return {
    pairBatchSize: effectiveBatchSize,
    maxBlocks:
      typeof normalized.maxBlocks === "number" && normalized.maxBlocks > 0
        ? Math.floor(normalized.maxBlocks)
        : base.maxBlocks,
    overlapPairs:
      typeof normalized.overlapPairs === "number" && normalized.overlapPairs >= 0
        ? Math.floor(normalized.overlapPairs)
        : base.overlapPairs,
    totalPromptCharCap:
      typeof normalized.totalPromptCharCap === "number" && normalized.totalPromptCharCap >= 0
        ? Math.floor(normalized.totalPromptCharCap)
        : base.totalPromptCharCap,
    contextCharLimit:
      typeof normalized.contextCharLimit === "number" && normalized.contextCharLimit >= 0
        ? Math.floor(normalized.contextCharLimit)
        : base.contextCharLimit,
    contextTriggerRatio:
      typeof normalized.contextTriggerRatio === "number" &&
      normalized.contextTriggerRatio > 0 &&
      normalized.contextTriggerRatio <= 1
        ? normalized.contextTriggerRatio
        : base.contextTriggerRatio,
    maxBlockChars:
      typeof normalized.maxBlockChars === "number" && normalized.maxBlockChars > 0
        ? Math.floor(normalized.maxBlockChars)
        : base.maxBlockChars,
    maxTotalBlockChars:
      typeof normalized.maxTotalBlockChars === "number" && normalized.maxTotalBlockChars >= 0
        ? Math.floor(normalized.maxTotalBlockChars)
        : base.maxTotalBlockChars,
    maxBatchChars:
      typeof normalized.maxBatchChars === "number" && normalized.maxBatchChars > 0
        ? Math.floor(normalized.maxBatchChars)
        : base.maxBatchChars,
    softTrimOff: normalized.softTrimOff === true ? true : undefined,
  };
}

/**
 * Map preferred `*Token*` aliases onto canonical `*Char*` fields (token units).
 * Alias wins when both are set.
 */
export function normalizeCompressPolicyPatch(
  patch: Partial<import("../types").MemoryCompressPolicy>,
): Partial<import("../types").MemoryCompressPolicy> {
  const out: Partial<import("../types").MemoryCompressPolicy> = { ...patch };
  if (typeof patch.totalPromptTokenCap === "number") {
    out.totalPromptCharCap = patch.totalPromptTokenCap;
  }
  if (typeof patch.contextTokenLimit === "number") {
    out.contextCharLimit = patch.contextTokenLimit;
  }
  if (typeof patch.maxBatchTokenCap === "number") {
    out.maxBatchChars = patch.maxBatchTokenCap;
  }
  delete out.totalPromptTokenCap;
  delete out.contextTokenLimit;
  delete out.maxBatchTokenCap;
  return out;
}

/** Normalize legacy summary string into blocks. */
export function resolveSummaryBlocks(params: {
  summaryBlocks?: SummaryBlock[] | null | undefined;
  summary?: string | null | undefined;
  summarizedThroughMessageId?: string | null | undefined;
  dialogue?: DialogueMessage[] | undefined;
}): SummaryBlock[] {
  if (params.summaryBlocks?.length) {
    return params.summaryBlocks.filter((b) => b.text?.trim());
  }
  const text = params.summary?.trim();
  if (!text) return [];
  const through = params.summarizedThroughMessageId?.trim() || "legacy-unknown";
  return [
    {
      id: "legacy-summary",
      text,
      throughMessageId: through,
    },
  ];
}

export function joinSummaryBlocks(blocks: SummaryBlock[]): string {
  const texts = blocks.map((b) => b.text.trim()).filter(Boolean);
  if (texts.length <= 1) return texts[0] ?? "";
  // Match ContextAssembleEngine multi-block labels so normalize/merge keep
  // episode boundaries instead of mashing every 【硬事实】 into one document.
  return texts
    .map((t, i) => `【记忆块 ${i + 1}/${texts.length}】\n${t}`)
    .join("\n\n");
}

/**
 * 记忆引擎 — 长期记忆的存储视图 + 摘要写作（原 SummaryEngine）。
 *
 * - 水位线、prompt 用 raw 窗口、summaryBlocks 规范化
 * - 结构化摘要写作（REPLACE / STATE_PATCH 剥离 / 应急抽取）
 *
 * 压缩触发与本批切片归 ContextEngine。
 */
export class MemoryEngine extends SummaryEngine {
  override readonly id = "MemoryEngine" as const;

  listCompletePairs(dialogue: DialogueMessage[]): CompletePair[] {
    const pairs: CompletePair[] = [];
    let i = 0;
    while (i < dialogue.length) {
      const a = dialogue[i]!;
      if (a.role !== "user") {
        i += 1;
        continue;
      }
      const b = dialogue[i + 1];
      if (b && b.role === "assistant") {
        // Skip ciphertext pairs — they cannot enter compress / pending meters.
        if (!a.encrypted && !b.encrypted) {
          pairs.push({ user: a, assistant: b, endIndex: i + 1 });
        }
        i += 2;
        continue;
      }
      i += 1;
    }
    return pairs;
  }

  watermarkEndIndex(
    dialogue: DialogueMessage[],
    summarizedThroughMessageId: string | null | undefined,
    summarizedCount: number,
  ): number {
    if (summarizedThroughMessageId) {
      // 正向扫描取**首次**出现：id 重复（宿主追加而非替换同一消息）时，反向
      // 扫描会取最后一次出现 → 切掉更多内容，可能把未摘要的回合一并划走。
      // 保守取首次出现，宁可多留上下文，也不丢内容。
      for (let i = 0; i < dialogue.length; i++) {
        if (dialogue[i]?.id === summarizedThroughMessageId) return i;
      }
      // Watermark points off the active path (branch switch) — do not fall back
      // to numeric summarizedCount (that would slice the wrong branch).
      return -1;
    }
    if (summarizedCount > 0) {
      return Math.min(dialogue.length, summarizedCount) - 1;
    }
    return -1;
  }

  /**
   * When the CAS watermark id is not on the active dialogue path, treat the
   * watermark as unset for prompt-window / compress planning only. Does not
   * mutate server state — the next compress on this path advances a new id.
   */
  resolveEffectiveWatermark(
    dialogue: DialogueMessage[],
    summarizedThroughMessageId: string | null | undefined,
    summarizedCount: number,
  ): {
    summarizedThroughMessageId: string | null;
    summarizedCount: number;
    watermarkOnPath: boolean;
  } {
    const through = summarizedThroughMessageId?.trim() || null;
    if (through) {
      const onPath = dialogue.some((m) => m.id === through);
      if (!onPath) {
        return {
          summarizedThroughMessageId: null,
          summarizedCount: 0,
          watermarkOnPath: false,
        };
      }
      return {
        summarizedThroughMessageId: through,
        summarizedCount: Math.max(0, Math.floor(summarizedCount || 0)),
        watermarkOnPath: true,
      };
    }
    return {
      summarizedThroughMessageId: null,
      summarizedCount: Math.max(0, Math.floor(summarizedCount || 0)),
      watermarkOnPath: true,
    };
  }

  leadingPreamble(dialogue: DialogueMessage[]): DialogueMessage[] {
    const out: DialogueMessage[] = [];
    for (const m of dialogue) {
      if (m.role === "assistant") out.push(m);
      else break;
    }
    return out;
  }

  pendingPairsAfterWatermark(dialogue: DialogueMessage[], watermarkEnd: number): CompletePair[] {
    return this.listCompletePairs(dialogue).filter((p) => p.endIndex > watermarkEnd);
  }

  unsummarizedMessages(dialogue: DialogueMessage[], watermarkEnd: number): DialogueMessage[] {
    if (watermarkEnd < 0) return dialogue.slice();
    return dialogue.slice(watermarkEnd + 1);
  }

  /**
   * Raw messages for the model: optional overlap of covered pairs + every
   * not-yet-committed message (includes the pending batch until commit).
   */
  promptRawMessages(
    dialogue: DialogueMessage[],
    watermarkEnd: number,
    overlapPairs: number,
    opts?: { includeEncrypted?: boolean },
  ): DialogueMessage[] {
    const includeEncrypted = opts?.includeEncrypted === true;
    const visible = (m: DialogueMessage) => includeEncrypted || !m.encrypted;

    const startIdx = watermarkEnd + 1;
    const unsummarized = (watermarkEnd < 0 ? dialogue.slice() : dialogue.slice(startIdx)).filter(
      visible,
    );

    if (overlapPairs <= 0 || watermarkEnd < 0) return unsummarized;

    const covered = this.listCompletePairs(dialogue)
      .filter((p) => p.endIndex <= watermarkEnd)
      .slice(-overlapPairs);

    const seen = new Set<number>();
    const head: DialogueMessage[] = [];
    const pushAt = (idx: number) => {
      if (idx < 0 || idx >= dialogue.length) return;
      if (idx >= startIdx) return;
      if (seen.has(idx)) return;
      seen.add(idx);
      const msg = dialogue[idx]!;
      if (visible(msg)) head.push(msg);
    };
    for (const p of covered) {
      pushAt(p.endIndex - 1);
      pushAt(p.endIndex);
    }
    return [...head, ...unsummarized];
  }
}
