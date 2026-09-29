import type { DialogueMessage, SummaryBlock } from "../types";
import { MEMORY_COLUMN_TITLES } from "../types";
import {
  assessSummaryQuality as assessSummaryQualityShared,
  extractSalientSlices as extractSalientSlicesShared,
  looksStructured as looksStructuredShared,
  type MemoryColumnSlice,
  type SummaryQuality,
  normalizeStructuredMemory,
  splitMemoryColumns,
} from "./structuredMemory";

export type StructuredCompressResult = {
  /** Summary body with STATE_PATCH stripped. */
  summaryText: string;
  /**
   * Raw JSON value inside STATE_PATCH (usually `{ entries: [...] }`).
   * Call site MUST run it through StateEngine.entriesFromUnknown / overlayEntries —
   * Summary does not own keyed-snapshot quality rules.
   *
   * When the model emitted **several** blocks, their `entries` arrays are merged
   * into one `{ entries }` (so no patch is silently dropped). If the shapes are
   * not mergeable, this is the array of parsed blocks verbatim.
   */
  statePatchRaw: unknown | null;
  /** True when a STATE_PATCH block was present but JSON.parse failed. */
  statePatchParseFailed?: boolean;
  /** Every parsed block, in order. Only present when more than one was found. */
  statePatchesRaw?: unknown[];
  /** How many complete STATE_PATCH blocks were found. */
  statePatchCount: number;
  /**
   * Structural quality of the returned body. Deterministic and free — see
   * `assessSummaryQuality`. A host can retry the summary when a protected column
   * came back missing, instead of discovering it ten turns later.
   */
  quality: SummaryQuality;
};

/**
 * Machine-block pattern, source form so callers can build both a single-match and
 * a global regex from it. The global one is mandatory: models regularly emit more
 * than one block, and matching only the first used to leave every later
 * `<<<STATE_PATCH>>>…<<<END>>>` in the summary **body** — which then went into the
 * prompt, burning tokens and demonstrating the private marker syntax back to the
 * model. Measured before the fix: block #1 parsed, block #2's payload ("黑衣人")
 * and both markers still present in `summaryText`.
 */
const STATE_PATCH_SRC = "<<<STATE_PATCH>>>\\s*([\\s\\S]*?)\\s*<<<END>>>";

export type { MemoryColumnSlice };

/**
 * 摘要写作能力 — 现由 MemoryEngine 继承对外暴露。
 * 本文件保留类体，便于测试与类型引用；调度器请用 `dispatcher.memory`。
 *
 * Seam: produces REPLACE/fuse/episode text (+ optional STATE_PATCH machine block).
 * Compress planning / soft trim → ContextEngine.
 * World-state entry quality → StateEngine.
 */
export class SummaryEngine {
  readonly id: string = "SummaryEngine";

  readonly systemPrompt =
    "将对话压缩为简洁中文长期记忆文档。必须使用以下固定栏目标题（缺栏目可写「无」，不可改标题文案）：\n" +
    "【硬事实】专有名词、约定、禁忌、不可推翻设定\n" +
    "【时间线】有序节点\n" +
    "【关系与称呼】\n" +
    "【未决】冲突、目标、悬念\n" +
    "【近期情节】可牺牲的叙事缓冲\n" +
    "世界状态条目是硬事实锚点，不得与其矛盾，已列出的关键事实必须体现在【硬事实】或对应栏目。\n" +
    "用陈述句概述，禁止逐句抄写对白，禁止发明未发生的情节。\n" +
    "摘要正文之后，若能抽出结构化状态，追加机器块（可省略）：\n" +
    "<<<STATE_PATCH>>>\n" +
    '{"entries":[{"key":"地点","value":"..."}]}\n' +
    "<<<END>>>";

  /**
   * Pull **all** STATE_PATCH blocks out of a raw model response.
   *
   * Returns the body with every complete block removed, plus a flag when a block
   * was malformed — either its JSON did not parse, or the model truncated output
   * mid-block (opening marker with no `<<<END>>>`), which is common enough to
   * handle explicitly: without it the machine block leaks into the summary.
   */
  private extractStatePatches(text: string): {
    body: string;
    raws: unknown[];
    parseFailed: boolean;
  } {
    const re = new RegExp(STATE_PATCH_SRC, "gi");
    const raws: unknown[] = [];
    let parseFailed = false;
    for (const m of text.matchAll(re)) {
      const jsonRaw = (m[1] ?? "").trim();
      if (!jsonRaw) continue;
      try {
        raws.push(JSON.parse(jsonRaw) as unknown);
      } catch {
        parseFailed = true;
      }
    }
    let body = text.replace(new RegExp(STATE_PATCH_SRC, "gi"), "").trim();
    const openIdx = body.search(/<<<STATE_PATCH>>>/i);
    if (openIdx >= 0) {
      body = body.slice(0, openIdx).trim();
      parseFailed = true;
    }
    return { body, raws, parseFailed };
  }

  /** Fold several parsed blocks into one value without dropping any patch. */
  private mergeStatePatches(raws: unknown[]): unknown | null {
    if (!raws.length) return null;
    if (raws.length === 1) return raws[0];
    const entries: unknown[] = [];
    for (const r of raws) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return raws;
      const e = (r as { entries?: unknown }).entries;
      if (!Array.isArray(e)) return raws;
      entries.push(...e);
    }
    return { entries };
  }

  newBlockId(): string {
    // 结构化类型而不是 DOM 的 `Crypto`：本包是 Node 库，`lib` 里不该为这一个
    // 引用拖进整个 DOM（会放行 `window` / `localStorage` 这类 Node 不存在的全局）。
    const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
    const rnd =
      c && typeof c.randomUUID === "function"
        ? c.randomUUID().replace(/-/g, "").slice(0, 12)
        : Math.random().toString(36).slice(2, 10);
    return `b-${Date.now().toString(36)}-${rnd}`;
  }

  formatTranscript(items: { role: string; content: string }[]): string {
    return items.map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`).join("\n\n");
  }

  buildUserPrompt(params: {
    priorJoined: string;
    transcript: string;
    worldStateText?: string | null;
    maxCharsHint?: number;
    mode?: "replace" | "fuse" | "episode";
    /**
     * When true (StateEngine on), require a STATE_PATCH machine block so
     * compress can update world state in the same LLM call (U-02).
     */
    requireStatePatch?: boolean;
  }): string {
    const mode = params.mode ?? "replace";
    const prior = params.priorJoined.trim() || "（无）";
    const state = (params.worldStateText ?? "").trim() || "（无）";
    const hint =
      typeof params.maxCharsHint === "number" && params.maxCharsHint > 0
        ? Math.floor(params.maxCharsHint)
        : 0;
    const lengthLine = hint
      ? `篇幅：整份摘要控制在约 ${hint} 字以内；超长则合并去重，优先压缩【近期情节】，不得丢【硬事实】与【未决】。`
      : "篇幅：尽量精炼；超长则合并去重，优先压缩【近期情节】，不得丢【硬事实】与【未决】。";

    const columnsLine = `栏目顺序固定：${MEMORY_COLUMN_TITLES.join(" → ")}`;
    const qualityLine = [
      "栏目质量：每个栏目要么写实质内容，要么单独一行写「无」。",
      "禁止【近期情节】只写人名/称呼而无事件；禁止栏目之间复读同一句；禁止文首无标题碎句；禁止截断半句乱拼。",
      "【硬事实】= 稳定设定与已确认事实；【时间线】= 节点化事件；【近期情节】= 本批新推进的一两句（可写「无」）。",
    ].join("");

    const patchLine = params.requireStatePatch
      ? "硬性要求：正文后必须附 STATE_PATCH 机器块（entries 为完整快照或增量均可）；至少回写当前世界状态中仍有效的关键条目；不得省略该块。"
      : "正文后可附 STATE_PATCH（entries 为完整快照或增量均可；调用方会与旧状态叠加）；无法提取则省略。";
    const patchLineEpisode = params.requireStatePatch
      ? "硬性要求：正文后必须附 STATE_PATCH（仅本批导致的状态变更；无变更也需输出当前关键条目快照）；不得省略。"
      : "正文后可附 STATE_PATCH（仅本批导致的状态变更）；无法提取则省略该块。";
    const outro = params.requireStatePatch
      ? "只输出栏目正文 + STATE_PATCH，不要解释。"
      : "只输出栏目正文（+ 可选 STATE_PATCH），不要解释。";

    if (mode === "episode") {
      return [
        "已有长期记忆（只读参考，勿整份抄写）：",
        prior,
        "",
        "当前世界状态（硬事实锚点，必须保留且不得矛盾）：",
        state,
        "",
        "本批新对话：",
        params.transcript,
        "",
        "请输出一份短 episodic 记忆块（覆盖本批对白），使用固定栏目；以【近期情节】为主，仅写入本批新增的硬事实/未决。",
        "不要用 --- 分隔，不要 markdown 标题。",
        columnsLine,
        qualityLine,
        lengthLine,
        patchLineEpisode,
        outro,
      ].join("\n");
    }

    const fuseNote =
      mode === "fuse"
        ? "已有记忆可能含多段 episode，请融合去重为**一份**完整文档（整份替换）。合并时删除重复句与空壳栏目。"
        : "请输出一份完整的新摘要正文，用于**整份替换**旧摘要。在旧摘要基础上吸收本批对白，去重保留，不要另起碎段。";

    return [
      "已有长期记忆摘要（将被整份替换）：",
      prior,
      "",
      "当前世界状态（硬事实锚点，必须保留且不得矛盾）：",
      state,
      "",
      "本批新对话：",
      params.transcript,
      "",
      fuseNote,
      "硬性要求：保留旧摘要与本批对白中的关键事实、专有名词、称呼、时间线与未决事件；与世界状态对齐。",
      "不要增量补丁、不要分块、不要用 --- 分隔、不要 markdown 标题。",
      columnsLine,
      qualityLine,
      lengthLine,
      patchLine,
      outro,
    ].join("\n");
  }

  /**
   * Strip optional STATE_PATCH machine block.
   * Returns raw JSON for StateEngine — does not validate entry quality.
   */
  parseStructuredCompress(raw: string, opts?: { previous?: string | null }): StructuredCompressResult {
    const text = (raw ?? "").trim();
    if (!text) {
      const empty = "";
      return {
        summaryText: empty,
        statePatchRaw: null,
        statePatchCount: 0,
        quality: assessSummaryQualityShared(empty, { previous: opts?.previous }),
      };
    }

    const { body, raws, parseFailed } = this.extractStatePatches(text);
    const cleaned = looksStructuredShared(body) ? normalizeStructuredMemory(body) : body;
    const statePatchRaw = this.mergeStatePatches(raws);
    const result: StructuredCompressResult = {
      summaryText: cleaned,
      statePatchRaw,
      statePatchCount: raws.length,
      quality: assessSummaryQualityShared(cleaned, { previous: opts?.previous }),
    };
    if (parseFailed) result.statePatchParseFailed = true;
    if (raws.length > 1) result.statePatchesRaw = raws;
    return result;
  }

  splitMemoryColumns(text: string): MemoryColumnSlice[] {
    return splitMemoryColumns(text);
  }

  extractSalientSlices(summaryText: string): { label: string; text: string }[] {
    return extractSalientSlicesShared(summaryText);
  }

  looksStructured(text: string): boolean {
    return looksStructuredShared(text);
  }

  makeReplaceBlock(params: {
    text: string;
    throughMessageId: string;
    pairCount: number;
    kind?: "full" | "episode";
    importance?: number;
  }): SummaryBlock {
    const kind = params.kind ?? "full";
    const importance =
      typeof params.importance === "number"
        ? Math.max(0, Math.min(100, Math.floor(params.importance)))
        : kind === "episode"
          ? 40
          : 80;
    return {
      id: this.newBlockId(),
      text: looksStructuredShared(params.text.trim())
        ? normalizeStructuredMemory(params.text.trim()) || params.text.trim()
        : params.text.trim(),
      throughMessageId: params.throughMessageId,
      pairCount: params.pairCount,
      kind,
      importance,
    };
  }

  /** @deprecated use makeReplaceBlock */
  makeIncrementalBlock(params: {
    text: string;
    throughMessageId: string;
    pairCount: number;
  }): SummaryBlock {
    return this.makeReplaceBlock({ ...params, kind: "episode", importance: 40 });
  }

  /** @deprecated kept for old tests/callers */
  parseFusedBlocks(params: {
    text: string;
    throughMessageId: string;
    maxBlocks: number;
    pairCount: number;
  }): SummaryBlock[] {
    const parts = params.text
      .split(/\n\s*---\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    let chunks = parts.length ? parts : [params.text.trim()];
    chunks = chunks.filter(Boolean);
    if (!chunks.length) return [];

    const limit = Math.max(1, Math.floor(params.maxBlocks));
    if (chunks.length > limit) {
      const head = chunks.slice(0, limit - 1);
      const tail = chunks.slice(limit - 1).join("\n\n");
      chunks = [...head, tail];
    }

    const lastIndex = chunks.length - 1;
    return chunks.map((t, i) => ({
      id: this.newBlockId(),
      text: t,
      throughMessageId: params.throughMessageId,
      pairCount: i === lastIndex ? params.pairCount : undefined,
      kind: "full" as const,
      importance: 80,
    }));
  }

  extractiveBlock(items: DialogueMessage[], clipChars = 160, maxTotalChars = 4_000): string {
    const n = Math.max(40, Math.floor(clipChars || 160));
    const total = Math.max(400, Math.floor(maxTotalChars || 4_000));
    const lines: string[] = [
      "【硬事实】",
      "无",
      "",
      "【时间线】",
      "无",
      "",
      "【关系与称呼】",
      "无",
      "",
      "【未决】",
      "无",
      "",
      "【近期情节】",
      "【应急抽取摘要】",
    ];
    let used = lines.join("\n").length;
    let omitted = 0;
    for (const m of items) {
      const who = m.role === "user" ? "用户" : "角色";
      const clip = (m.content || "").replace(/\s+/g, " ").trim().slice(0, n);
      if (!clip) continue;
      const line = `${who}: ${clip}`;
      if (used + line.length + 1 > total) {
        omitted += 1;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (omitted > 0) lines.push(`（另有 ${omitted} 条对白因长度上限未收录）`);
    return lines.join("\n");
  }
}
