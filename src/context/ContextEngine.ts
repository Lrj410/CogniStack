import type { AssembleCollaborators } from "../ports";
import { MemoryBlocksEngine } from "../memory/MemoryBlocksEngine";
import type { CompletePair, MemoryEngine } from "../memory/MemoryEngine";
import { clipStructuredSummary } from "../memory/structuredMemory";
import {
  ContextAssembleEngine,
  type ContextAssembleInput,
  type ContextAssembleResult,
} from "./ContextAssembleEngine";
import { clipTextToTokenCap, planSectionTokenAllocations } from "./sectionBudget";
import { contentFp } from "../fusion/fingerprint";
import type {
  DialogueMessage,
  MemoryCompressPolicy,
  MemoryStatus,
  PromptSection,
  RpMessage,
  TokenCounter,
} from "../types";
import { SECTION_PRIORITY } from "../types";

function contentTokens(messages: RpMessage[], counter: TokenCounter): number {
  return messages.reduce((n, m) => n + counter.count(m.content), 0);
}

/** O-04: memoize TokenCounter.count during one soft-trim pass (fingerprint keys — no full-string pin). */
const CACHED_COUNTERS = new WeakSet<TokenCounter>();

function cachedCounter(counter: TokenCounter): TokenCounter {
  // Re-wrapping an already-cached counter would nest a second, non-shared Map
  // (compressImpl passes its cached counter down into trim). Reuse the existing
  // memo instead so the whole pass keys one fingerprint cache.
  if (CACHED_COUNTERS.has(counter)) return counter;
  const cache = new Map<string, number>();
  const wrapped: TokenCounter = {
    count(text: string) {
      const key = contentFp(text);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const n = counter.count(text);
      cache.set(key, n);
      return n;
    },
  };
  CACHED_COUNTERS.add(wrapped);
  return wrapped;
}

export const TRIM_NOTE = "\n\n【系统提示已按总预算截断；未压缩对白未丢弃】\n";

/** Strip leading soft-trim note so section equality / re-trim stay aligned. */
export function stripTrimNote(system: string): string {
  if (system.startsWith(TRIM_NOTE)) return system.slice(TRIM_NOTE.length);
  // Tolerate callers that normalized leading newlines away.
  const trimmed = TRIM_NOTE.replace(/^\n+/, "");
  if (trimmed && system.startsWith(trimmed)) return system.slice(trimmed.length);
  return system;
}

export type SoftTrimProfile = "balanced" | "protectLore" | "protectMemory";

/**
 * Options for {@link ContextEngine.compress}.
 *
 * CogniStack addition. The source took six positional parameters, four of them
 * optional — passing them out of order produced either an untrimmed prompt (bad)
 * or `undefined.filter is not a function` (worse). Named options make the order
 * irrelevant.
 */
export type CompressOptions = {
  /** Required on any path that actually wants to trim. */
  tokenCounter?: TokenCounter | undefined;
  /** Total prompt budget in tokens. 0 / omitted = no soft trim. */
  maxTokens?: number | undefined;
  /** @deprecated ignored — soft trim now uses whatever room dialogue leaves. */
  minSystemTokens?: number | undefined;
  sections?: PromptSection[] | null | undefined;
  softTrimProfile?: SoftTrimProfile | null | undefined;
  memoryDocumentImportances?: number[] | null | undefined;
};

type Section = { text: string; index: number; priority: number };

function isMemorySection(section: { text: string; priority: number }): boolean {
  if (section.priority === SECTION_PRIORITY.memory) return true;
  return section.text.includes("长期记忆摘要");
}

/** U-13: remap section priorities for soft-trim sacrifice order. */
function applySoftTrimProfile(sections: Section[], profile?: SoftTrimProfile | null): Section[] {
  if (!profile || profile === "balanced") return sections;
  return sections.map((s) => {
    let priority = s.priority;
    if (profile === "protectLore") {
      if (priority === SECTION_PRIORITY.lore) priority += 25;
      else if (priority === SECTION_PRIORITY.memory) priority -= 10;
      else if (priority === SECTION_PRIORITY.vectorMemory) priority -= 5;
    } else if (profile === "protectMemory") {
      if (priority === SECTION_PRIORITY.memory) priority += 25;
      else if (priority === SECTION_PRIORITY.lore) priority -= 10;
      else if (priority === SECTION_PRIORITY.mesExample) priority -= 5;
    }
    return priority === s.priority ? s : { ...s, priority };
  });
}

function sectionPriority(text: string): number {
  const head = text.slice(0, 48);
  if (head.includes("历史后指令")) return 90;
  if (head.includes("长期记忆摘要")) return 80;
  if (head.includes("相关检索记忆")) return 75;
  if (head.includes("当前世界状态")) return 70;
  if (head.includes("知识资料") || head.includes("世界书") || head.includes("设定资料")) return 60;
  if (head.includes("档案设定") || head.includes("角色设定") || head.includes("性格：") || head.includes("场景：")) {
    return 50;
  }
  if (head.includes("用户侧写") || head.includes("用户人设")) return 45;
  if (head.includes("对话示例")) return 30;
  if (head.includes("遵守适用法律与安全政策")) return 10;
  if (head.includes("所有出场角色均为成年人")) return 10;
  if (head.includes("你是角色扮演 AI")) return 10;
  return 40;
}

const MEMORY_COLUMN_HEADS = [
  "【硬事实】",
  "【近期情节】",
  "【未决】",
  "【时间线】",
  "【关系与称呼】",
  "【记忆块",
] as const;

/**
 * When sniffing system text by blank-line splits, structured memory columns
 * become separate sections and lose the `长期记忆摘要` header — later columns
 * look like generic priority-40 text and can survive while the real memory
 * unit is sacrificed. Re-merge consecutive memory fragments before trim.
 */
function coalesceMemorySniffSections(sections: Section[]): Section[] {
  if (sections.length <= 1) return sections;
  const out: Section[] = [];
  let i = 0;
  while (i < sections.length) {
    const cur = sections[i]!;
    const isMemory =
      isMemorySection(cur) ||
      MEMORY_COLUMN_HEADS.some((h) => cur.text.trimStart().startsWith(h));
    if (!isMemory) {
      out.push({ ...cur, index: out.length });
      i += 1;
      continue;
    }
    let text = cur.text;
    let j = i + 1;
    while (j < sections.length) {
      const next = sections[j]!;
      const nextIsCol =
        isMemorySection(next) ||
        MEMORY_COLUMN_HEADS.some((h) => next.text.trimStart().startsWith(h));
      if (!nextIsCol) break;
      text += `\n\n${next.text}`;
      j += 1;
    }
    out.push({ text, index: out.length, priority: SECTION_PRIORITY.memory });
    i = j;
  }
  return out;
}

function resolveSections(system: string, explicit?: PromptSection[] | null): Section[] {
  if (explicit?.length) {
    const usable = explicit.filter((s) => Boolean(s.text));
    const joined = usable.map((s) => s.text).join("\n\n");
    const body = stripTrimNote(system);
    // Emergency re-soft-trim passes TRIM_NOTE+body with sections that omit the note.
    if (joined === system || joined === body) {
      return usable.map((s, index) => ({
        text: s.text,
        index,
        priority: s.priority,
      }));
    }
  }
  const body = stripTrimNote(system);
  const sniffed = body
    .split(/\n{2,}/)
    .filter((text) => Boolean(text.trim()))
    .map((text, index) => ({ text, index, priority: sectionPriority(text) }));
  return coalesceMemorySniffSections(sniffed);
}

/**
 * 上下文引擎 — 拼装 + 压缩编排 + 软顶 + 记忆块提交。
 *
 * 对外只暴露这一层；内部仍用 ContextAssembleEngine 做段落拼接。
 * 水位线 / 对白对枚举委托 MemoryEngine，避免双份实现。
 */
export class ContextEngine extends MemoryBlocksEngine {
  override readonly id = "ContextEngine" as const;

  private readonly assembler: ContextAssembleEngine;

  constructor(
    private readonly memory: MemoryEngine,
    collaborators: AssembleCollaborators = {},
  ) {
    super();
    this.assembler = new ContextAssembleEngine(collaborators);
  }

  /** 拼装 system + 对白（不做预算裁剪）。 */
  assemble(input: ContextAssembleInput): ContextAssembleResult {
    return this.assembler.assemble(input);
  }

  /** ①上下文长度阈值 / ②对话回合数 — 谁先到谁压。 */
  status(params: {
    dialogue: DialogueMessage[];
    summarizedCount: number;
    summarizedThroughMessageId?: string | null | undefined;
    policy: MemoryCompressPolicy;
    /** @deprecated use overheadTokens — value is already in token units */
    overheadChars?: number | undefined;
    /** System (or other) token overhead when assembledPromptTokens is omitted */
    overheadTokens?: number | undefined;
    /**
     * Prefer the real assembled prompt size (system + overlap history + pending
     * + depth inserts). When omitted, falls back to system + post-watermark only
     * (legacy underestimate).
     */
    assembledPromptTokens?: number | undefined;
    tokenCounter: TokenCounter;
  }): MemoryStatus & { watermarkEnd: number } {
    const counter = params.tokenCounter;
    if (!counter || typeof counter.count !== "function") {
      throw new Error("ContextEngine.status 需要真实 TokenCounter");
    }
    const watermarkEnd = this.memory.watermarkEndIndex(
      params.dialogue,
      params.summarizedThroughMessageId,
      params.summarizedCount,
    );
    const pendingMsgs = this.memory.unsummarizedMessages(params.dialogue, watermarkEnd);
    const pendingPairsList = this.memory.pendingPairsAfterWatermark(params.dialogue, watermarkEnd);
    const pendingPairs = pendingPairsList.length;
    // Align with prompt path: ciphertext never contributes to pending token estimates.
    const pendingPlain = pendingMsgs.filter((m) => !m.encrypted);
    const pendingChars = pendingPlain.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const pendingTokens = pendingPlain.reduce((n, m) => n + counter.count(m.content ?? ""), 0);
    const n = params.policy.pairBatchSize;

    const overhead = Math.max(0, Math.floor(params.overheadTokens ?? params.overheadChars ?? 0));
    const assembled = Math.max(0, Math.floor(params.assembledPromptTokens ?? 0));
    const contextUsed = assembled > 0 ? assembled : overhead + pendingTokens;
    const ratio = params.policy.contextTriggerRatio;
    const contextTriggerAt =
      params.policy.contextCharLimit > 0 && ratio > 0
        ? Math.max(1, Math.floor(params.policy.contextCharLimit * ratio))
        : 0;

    // U-06: shrink batch N as context fill rises so compress fires sooner.
    let effectiveBatchSize = Math.max(1, Math.floor(n));
    if (contextTriggerAt > 0 && contextUsed > 0) {
      const fill = contextUsed / contextTriggerAt;
      if (fill >= 0.9) effectiveBatchSize = Math.max(1, Math.floor(n * 0.5));
      else if (fill >= 0.75) effectiveBatchSize = Math.max(1, Math.floor(n * 0.75));
      else if (fill >= 0.6) effectiveBatchSize = Math.max(1, Math.floor(n * 0.9));
    }

    let compressReason: MemoryStatus["compressReason"] = null;
    let shouldSummarize = false;
    if (contextTriggerAt > 0 && contextUsed >= contextTriggerAt && pendingPairs >= 1) {
      shouldSummarize = true;
      compressReason = "context";
    } else if (pendingPairs >= effectiveBatchSize) {
      shouldSummarize = true;
      compressReason = "batch";
    }

    return {
      dialogueCount: params.dialogue.length,
      summarizedCount: Math.max(0, watermarkEnd + 1),
      pending: pendingMsgs.length,
      pendingPairs,
      pendingChars,
      pendingTokens,
      contextUsed,
      contextTriggerAt,
      shouldSummarize,
      compressReason,
      adaptivePairBatchSize: effectiveBatchSize,
      watermarkEnd,
    };
  }

  toSummarizeSlice(params: {
    dialogue: DialogueMessage[];
    watermarkEnd: number;
    policy: MemoryCompressPolicy;
    shouldSummarize: boolean;
    contextTriggered?: boolean | undefined;
    tokenCounter?: TokenCounter | undefined;
    /** U-06: use adaptive N from status() when batch-triggered */
    pairBatchCap?: number | undefined;
  }): {
    items: DialogueMessage[];
    nextSummarizedCount: number;
    nextSummarizedThroughMessageId: string | null;
    pairCount: number;
  } {
    const idle = {
      items: [] as DialogueMessage[],
      nextSummarizedCount: Math.max(0, params.watermarkEnd + 1),
      nextSummarizedThroughMessageId: null as string | null,
      pairCount: 0,
    };
    if (!params.shouldSummarize) return idle;

    const pendingPairs = this.memory.pendingPairsAfterWatermark(
      params.dialogue,
      params.watermarkEnd,
    );
    const take = this.planBatchSize(
      pendingPairs,
      params.policy,
      params.contextTriggered === true,
      params.tokenCounter,
      params.pairBatchCap,
    );
    if (take <= 0) return idle;

    const batchPairs = pendingPairs.slice(0, take);
    const lastEnd = batchPairs[batchPairs.length - 1]!.endIndex;
    const start = params.watermarkEnd + 1;
    if (lastEnd < start) return idle;

    const items = params.dialogue
      .slice(start, lastEnd + 1)
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.encrypted);

    const throughMsg = params.dialogue[lastEnd];
    return {
      items,
      nextSummarizedCount: lastEnd + 1,
      nextSummarizedThroughMessageId: throughMsg?.id ?? null,
      pairCount: take,
    };
  }

  planBatchSize(
    pairs: CompletePair[],
    policy: MemoryCompressPolicy,
    contextTriggered: boolean,
    tokenCounter?: TokenCounter,
    pairBatchCap?: number,
  ): number {
    if (!pairs.length) return 0;
    const n = Math.max(1, Math.floor(pairBatchCap ?? policy.pairBatchSize));
    const hardCap = contextTriggered ? pairs.length : Math.min(pairs.length, n);
    // O-05: prefer token budget when a real counter is available.
    if (tokenCounter && typeof tokenCounter.count === "function") {
      return this.pairsWithinTokenBudget(pairs, policy.maxBatchChars, hardCap, tokenCounter);
    }
    return this.pairsWithinCharBudget(pairs, policy.maxBatchChars, hardCap);
  }

  private pairsWithinTokenBudget(
    pairs: CompletePair[],
    budget: number,
    hardCap: number,
    counter: TokenCounter,
  ): number {
    const cap = Math.max(1, Math.min(hardCap, pairs.length));
    if (!(budget > 0)) return cap;
    let tokens = 0;
    let take = 0;
    for (const pair of pairs) {
      if (take >= cap) break;
      const cost =
        counter.count(pair.user.content ?? "") + counter.count(pair.assistant.content ?? "");
      // First pair over budget: still take 1 (compress must advance), but never more.
      if (take === 0 && cost > budget) return 1;
      if (take > 0 && tokens + cost > budget) break;
      tokens += cost;
      take += 1;
    }
    return take;
  }

  private pairsWithinCharBudget(pairs: CompletePair[], budget: number, hardCap: number): number {
    const cap = Math.max(1, Math.min(hardCap, pairs.length));
    if (!(budget > 0)) return cap;
    let chars = 0;
    let take = 0;
    for (const pair of pairs) {
      if (take >= cap) break;
      const cost = (pair.user.content?.length ?? 0) + (pair.assistant.content?.length ?? 0);
      if (take === 0 && cost > budget) return 1;
      if (take > 0 && chars + cost > budget) break;
      chars += cost;
      take += 1;
    }
    return take;
  }

  /**
   * Soft-trim leading system. Returns trimmed messages and the section list
   * that matches messages[0] after trim (F-15).
   *
   * Preferred form: `compress(messages, options)`.
   */
  compress(
    messages: RpMessage[],
    options: CompressOptions,
  ): { messages: RpMessage[]; systemSections: PromptSection[] };
  /**
   * @deprecated positional form — 6 positional parameters (4 optional) made it
   * trivially easy to pass `tokenCounter` where `minSystemTokens` belongs, which
   * silently produced either an untrimmed prompt or a crash. Use the options
   * object instead; this overload stays for source compatibility.
   */
  compress(
    messages: RpMessage[],
    maxContextChars?: number,
    minSystemTokens?: number,
    tokenCounter?: TokenCounter,
    sections?: PromptSection[] | null,
    opts?: {
      softTrimProfile?: SoftTrimProfile | null | undefined;
      memoryDocumentImportances?: number[] | null | undefined;
    },
  ): { messages: RpMessage[]; systemSections: PromptSection[] };
  compress(
    messages: RpMessage[],
    maxOrOptions?: number | CompressOptions,
    minSystemTokens = 512,
    tokenCounterLegacy?: TokenCounter,
    sectionsLegacy?: PromptSection[] | null,
    optsLegacy?: {
      softTrimProfile?: SoftTrimProfile | null | undefined;
      memoryDocumentImportances?: number[] | null | undefined;
    },
  ): { messages: RpMessage[]; systemSections: PromptSection[] } {
    const o: CompressOptions =
      typeof maxOrOptions === "object" && maxOrOptions !== null
        ? maxOrOptions
        : {
            maxTokens: typeof maxOrOptions === "number" ? maxOrOptions : undefined,
            minSystemTokens,
            tokenCounter: tokenCounterLegacy as TokenCounter,
            sections: sectionsLegacy,
            ...(optsLegacy ?? {}),
          };
    return this.compressImpl(messages, o);
  }

  private compressImpl(
    messages: RpMessage[],
    o: CompressOptions,
  ): { messages: RpMessage[]; systemSections: PromptSection[] } {
    const maxContextChars = o.maxTokens ?? 0;
    void o.minSystemTokens; // @deprecated — soft trim uses remaining room under total cap only
    const sections = o.sections ?? null;
    const tokenCounter = o.tokenCounter;
    const opts = {
      softTrimProfile: o.softTrimProfile,
      memoryDocumentImportances: o.memoryDocumentImportances,
    };
    const passthrough = {
      messages,
      systemSections: (sections ?? []).filter((s) => Boolean(s.text)),
    };
    if (!maxContextChars || maxContextChars <= 0) return passthrough;
    if (!tokenCounter || typeof tokenCounter.count !== "function") {
      throw new Error("ContextEngine.compress 需要真实 TokenCounter");
    }
    const counter = cachedCounter(tokenCounter);
    if (contentTokens(messages, counter) <= maxContextChars) return passthrough;

    const hasHeadSystem = messages[0]?.role === "system";
    if (!hasHeadSystem) return passthrough;

    const head = messages[0]!;
    const rest = messages.slice(1);
    const restTokens = contentTokens(rest, counter);
    // Dialogue is never dropped — system budget is whatever remains under the
    // total cap. (minSystemTokens used to inflate this above the cap when the
    // remaining room was smaller than the floor; that blew the soft trim.)
    const budgetForSystemTokens = Math.max(0, maxContextChars - restTokens);
    if (counter.count(head.content) <= budgetForSystemTokens) return passthrough;

    const { text: trimmed, sections: trimmedSections } = this.trimSystemToTokenBudgetDetailed(
      head.content,
      budgetForSystemTokens,
      counter,
      sections,
      opts,
    );
    if (!trimmed.trim()) {
      return { messages: rest, systemSections: [] };
    }
    return {
      messages: [{ role: "system", content: trimmed }, ...rest],
      systemSections: trimmedSections,
    };
  }

  trimSystemToTokenBudget(
    system: string,
    tokenBudget: number,
    counter: TokenCounter,
    explicitSections?: PromptSection[] | null,
    opts?: {
      softTrimProfile?: SoftTrimProfile | null | undefined;
      memoryDocumentImportances?: number[] | null | undefined;
    },
  ): string {
    return this.trimSystemToTokenBudgetDetailed(
      system,
      tokenBudget,
      counter,
      explicitSections,
      opts,
    ).text;
  }

  trimSystemToTokenBudgetDetailed(
    system: string,
    tokenBudget: number,
    counter: TokenCounter,
    explicitSections?: PromptSection[] | null,
    opts?: {
      softTrimProfile?: SoftTrimProfile | null | undefined;
      memoryDocumentImportances?: number[] | null | undefined;
    },
  ): { text: string; sections: PromptSection[] } {
    const budget = Math.floor(tokenBudget);
    if (budget <= 0) return { text: "", sections: [] };
    const counterCached = cachedCounter(counter);
    let resolved = resolveSections(system, explicitSections);
    resolved = applySoftTrimProfile(resolved, opts?.softTrimProfile);
    const memoryImportances = opts?.memoryDocumentImportances ?? undefined;
    /*
     * Structured clip, with a plain head/tail fallback.
     *
     * Why the fallback exists: `clipStructuredSummary` returns "" when the budget
     * is below the smallest well-formed document (measured: 45 chars,
     * `minStructuredDocumentLength()`), and the callers read "" as "this section
     * has nothing to say" — so at tight budgets the *entire* long-term memory
     * section disappeared, while lower-priority sections survived because they go
     * through `headTailClip` and always keep something. Measured at cap 30:
     * structured clip → "" (nothing), head/tail clip → 26 chars of real content.
     *
     * A truncated memory is strictly better than a prompt that asserts "no hard
     * facts, no open threads" — the model reads the latter as fact, not as
     * truncation.
     */
    const clipMemory = (source: string, maxChars: number) => {
      const clipped = clipStructuredSummary(source, maxChars, {
        documentImportances: memoryImportances,
      });
      if (clipped) return clipped;
      return headTailClip(source, maxChars);
    };
    const asPrompt = (): PromptSection[] =>
      resolved
        .filter((s) => Boolean(s.text.trim()))
        .map((s) => ({ text: s.text, priority: s.priority }));

    if (counterCached.count(system) <= budget) {
      return { text: system, sections: asPrompt() };
    }

    const noteTokens = counterCached.count(TRIM_NOTE);
    if (budget < noteTokens + 8) {
      const text = this.fitByBinarySlice(system, budget, counterCached, "suffix");
      return {
        text,
        sections: text ? [{ text, priority: SECTION_PRIORITY.promptFragment }] : [],
      };
    }

    const sections: Section[] = resolved;

    const joinBody = (parts: string[]) => parts.filter(Boolean).join("\n\n");
    // Additive estimate — never count(TRIM_NOTE+body), which is a novel string
    // that storms CACHE_MISS under HTTP tokenize (prefix estimate cannot hit).
    const countWithNote = (body: string) =>
      body ? noteTokens + counterCached.count(body) : noteTokens;

    let body = joinBody(sections.map((s) => s.text));
    if (countWithNote(body) <= budget) {
      // Additive estimate (noteTokens + count(body)) can undercount the real
      // (BPE) tokenizer once TRIM_NOTE and body are actually joined, so measure
      // the true output before returning; otherwise fall through to shrink.
      const out = TRIM_NOTE + body;
      if (counterCached.count(out) <= budget) {
        return { text: out, sections: asPrompt() };
      }
    }

    // U-01: layered pre-allocation
    const bodyBudget = Math.max(0, budget - noteTokens);
    const planned = planSectionTokenAllocations(sections, bodyBudget, counterCached);
    const preShrunk = new Map<number, string>();
    for (const section of sections) {
      const cap = planned.get(section.index) ?? 0;
      if (cap <= 0) {
        preShrunk.set(section.index, "");
        continue;
      }
      if (counterCached.count(section.text) <= cap) continue;
      const clipChars = (source: string, maxChars: number) => {
        if (maxChars <= 0) return "";
        if (isMemorySection(section)) return clipMemory(source, maxChars);
        return this.headTailClip(source, maxChars);
      };
      const clipped = clipTextToTokenCap(section.text, cap, counterCached, clipChars);
      if (clipped.length < section.text.length) preShrunk.set(section.index, clipped);
    }
    body = joinBody(
      sections.map((s) => {
        const piece = preShrunk.get(s.index);
        return piece === undefined ? s.text : piece;
      }),
    );
    if (countWithNote(body) <= budget) {
      const out = TRIM_NOTE + body;
      // Same real-tokenizer recheck as above — an early return must be measured.
      if (counterCached.count(out) <= budget) {
        const outSections = sections
          .map((s) => {
            const piece = preShrunk.get(s.index);
            const text = piece === undefined ? s.text : piece;
            return text.trim() ? { text, priority: s.priority } : null;
          })
          .filter((s): s is PromptSection => Boolean(s));
        return { text: out, sections: outSections };
      }
    }

    const order = [...sections].sort((a, z) => a.priority - z.priority || z.index - a.index);
    const dropped = new Set<number>();
    const shrunk = new Map<number, string>(preShrunk);

    const liveText = (s: Section): string => shrunk.get(s.index) ?? s.text;
    const currentBody = () =>
      joinBody(sections.filter((s) => !dropped.has(s.index)).map(liveText));

    for (const section of order) {
      if (countWithNote(currentBody()) <= budget) break;

      const source = liveText(section);
      const clipPiece = (width: number) => {
        if (width <= 0) return "";
        if (isMemorySection(section)) {
          return clipMemory(source, width);
        }
        return this.headTailClip(source, width);
      };
      // Everything except this section is frozen during its binary search, so
      // split the live body into the halves before/after it once, then rebuild
      // each probe by O(1) concatenation instead of re-filtering + re-mapping
      // every section (was O(S) work per probe → O(S²·log L) overall).
      const before: string[] = [];
      const after: string[] = [];
      let passed = false;
      for (const s of sections) {
        if (s.index === section.index) {
          passed = true;
          continue;
        }
        if (dropped.has(s.index)) continue;
        const t = liveText(s);
        if (!t) continue;
        (passed ? after : before).push(t);
      }
      const beforeJoin = joinBody(before);
      const afterJoin = joinBody(after);
      const trialWith = (piece: string): string =>
        joinBody(piece ? [beforeJoin, piece, afterJoin] : [beforeJoin, afterJoin]);

      let lo = 0;
      let hi = source.length;
      let bestPiece = "";
      let found = false;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const piece = clipPiece(mid);
        if (countWithNote(trialWith(piece)) <= budget) {
          found = true;
          bestPiece = piece;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (found && bestPiece.trim()) {
        if (bestPiece.length < source.length) shrunk.set(section.index, bestPiece);
      } else {
        dropped.add(section.index);
        shrunk.delete(section.index);
      }
    }

    body = currentBody();
    if (!body.trim()) {
      const text = this.fitByBinarySlice(system, budget, counterCached, "suffix");
      return {
        text,
        sections: text ? [{ text, priority: SECTION_PRIORITY.promptFragment }] : [],
      };
    }
    let out = TRIM_NOTE + body;
    if (counterCached.count(out) > budget) {
      out = this.fitByBinarySlice(out, budget, counterCached, "prefix");
      return {
        text: out,
        sections: out ? [{ text: out, priority: SECTION_PRIORITY.promptFragment }] : [],
      };
    }
    const outSections = sections
      .filter((s) => !dropped.has(s.index))
      .map((s) => {
        const text = shrunk.get(s.index) ?? s.text;
        return text.trim() ? { text, priority: s.priority } : null;
      })
      .filter((s): s is PromptSection => Boolean(s));
    return { text: out, sections: outSections };
  }

  /**
   * @deprecated Char-based soft trim — prefer trimSystemToTokenBudget.
   * Kept for legacy tests; do not use on the prepare hot path.
   */
  trimSystemPreservingTail(system: string, budget: number): string {
    const b = Math.floor(budget);
    if (b <= 0) return "";
    if (system.length <= b) return system;

    if (b < TRIM_NOTE.length + 40) return system.slice(-b);

    const sections = system
      .split(/\n{2,}/)
      .map((text, index) => ({ text, index, priority: sectionPriority(text) }));

    const avail = b - TRIM_NOTE.length;
    const total = sections.reduce((n, s) => n + s.text.length + 2, 0);
    if (total <= avail) {
      return TRIM_NOTE + sections.map((s) => s.text).join("\n\n");
    }

    const order = [...sections].sort((a, z) => a.priority - z.priority || z.index - a.index);
    const dropped = new Set<number>();
    const shrunk = new Map<number, string>();
    let used = total;

    for (const section of order) {
      if (used <= avail) break;
      const room = section.text.length - (used - avail);
      if (room >= 160) {
        const piece = isMemorySection(section)
          ? clipStructuredSummary(section.text, room)
          : this.headTailClip(section.text, room);
        shrunk.set(section.index, piece);
        used -= section.text.length - piece.length;
      } else {
        dropped.add(section.index);
        used -= section.text.length + 2;
      }
    }

    const body = sections
      .filter((s) => !dropped.has(s.index))
      .map((s) => shrunk.get(s.index) ?? s.text)
      .join("\n\n");
    if (!body.trim()) return system.slice(-b);
    return TRIM_NOTE + body;
  }

  private headTailClip(text: string, max: number): string {
    return headTailClip(text, max);
  }

  private fitByBinarySlice(
    text: string,
    tokenBudget: number,
    counter: TokenCounter,
    mode: "prefix" | "suffix",
  ): string {
    if (counter.count(text) <= tokenBudget) return text;
    let lo = 0;
    let hi = text.length;
    let best = "";
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const piece =
        mid <= 0 ? "" : mode === "prefix" ? text.slice(0, mid) : text.slice(text.length - mid);
      if (counter.count(piece) <= tokenBudget) {
        best = piece;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }
}

/**
 * Head+tail clip for one opaque section: keep the opening, drop the middle.
 *
 * CogniStack fix (promoted from a private method so it can be tested): the
 * original returned the bare `marker` when `max` was smaller than the marker
 * itself — i.e. a string LONGER than the budget it was asked to respect.
 * Callers binary-search over this function, so an over-budget return made them
 * shrink a section that could have kept real text.
 *
 * Guarantee: `result.length <= Math.max(0, max)` always.
 */
export function headTailClip(text: string, max: number): string {
  const cap = Math.floor(max);
  if (!(cap > 0)) return "";
  if (text.length <= cap) return text;
  const marker = "\n…（中段已按预算省略）…\n";
  if (cap <= marker.length) return text.slice(0, cap);
  const room = cap - marker.length;
  const head = Math.floor(room * 0.55);
  const tail = room - head;
  const headText = text.slice(0, head).trimEnd();
  const rawTail = text.slice(text.length - tail);
  const nl = rawTail.indexOf("\n");
  const tailText = (nl >= 0 ? rawTail.slice(nl + 1) : rawTail).trimStart();
  return `${headText}${marker}${tailText}`;
}
