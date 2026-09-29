import {
  type AssembleCollaborators,
  type AssembleFragments,
  EMPTY_FRAGMENTS,
  type RegexScriptLike,
} from "../ports";
import {
  type AgentProfileLike,
  type CharacterCardLike,
  type DialogueMessage,
  type LoreEntryLike,
  type MacroNames,
  type PromptSection,
  type RpMessage,
  type RpRole,
  type RpWorldState,
  type WorldBookEntryLike,
  type WorldState,
  SECTION_PRIORITY,
} from "../types";
import { normalizeLoreSlot, type LorePosition } from "./lorePosition";
import { DEFAULT_SYSTEM_RULES } from "./systemRules";

export { DEFAULT_SYSTEM_RULES };

export type AssembleSectionOptions = {
  includeSystemRules?: boolean;
  includeSystemPrompt?: boolean;
  includeDescription?: boolean;
  includePersonality?: boolean;
  includeScenario?: boolean;
  includeMesExample?: boolean;
  includePersona?: boolean;
  /** Preferred: inject selected lore / knowledge snippets */
  includeLore?: boolean;
  /** @deprecated Use `includeLore` */
  includeWorldBook?: boolean;
  includeState?: boolean;
  includeSummary?: boolean;
  includePostHistory?: boolean;
  bindPrompt?: boolean;
  scrubHistory?: boolean;
  formatMesExample?: boolean;
  /**
   * CogniStack addition: replace the baseline rules block per call instead of
   * forking the engine. Omit to use the bundled default rules.
   */
  systemRulesText?: string;
  /**
   * Hard cap on lore entries entering the system prompt.
   * - omitted / undefined = uncapped at assemble layer
   * - `0` = hard off (inject none)
   * - `n > 0` = at most n entries
   */
  maxLoreEntries?: number;
};

export type ContextAssembleInput = {
  /** Preferred */
  profile?: AgentProfileLike | undefined;
  /** @deprecated Use `profile` */
  card: CharacterCardLike;
  selectedLore?: Array<LoreEntryLike | WorldBookEntryLike> | undefined;
  /** Preferred */
  loreEntries?: Array<LoreEntryLike | WorldBookEntryLike> | undefined;
  /** @deprecated Use `loreEntries` */
  worldEntries?: WorldBookEntryLike[] | undefined;
  /** Preferred */
  loreEnabled?: boolean | undefined;
  /** @deprecated Use `loreEnabled` */
  worldBookEnabled?: boolean | undefined;
  scanText?: string | undefined;
  summary?: string | null | undefined;
  summaryBlocks?: { text: string }[] | null | undefined;
  worldState?: WorldState | RpWorldState | null | undefined;
  personaBio?: string | null | undefined;
  recentMessages: DialogueMessage[];
  macros?: MacroNames | undefined;
  options?: AssembleSectionOptions | undefined;
  limits?: {
    loreEntryChars?: number | undefined;
    stateChars?: number | undefined;
    personaChars?: number | undefined;
    cardFieldChars?: number | undefined;
  } | undefined;
  /** From the preset resolver. */
  fragments?: AssembleFragments | null | undefined;
  regexScripts?: RegexScriptLike[] | null | undefined;
  /** Semantic retrieval snippets. */
  vectorHits?: { name?: string | undefined; content: string }[] | null | undefined;
  /** Baseline system rules; defaults to the bundled block. */
  systemRules?: string | undefined;
};

export type ContextAssembleResult = {
  messages: RpMessage[];
  loreInjected: { id: string; name: string }[];
  notes: string[];
  /**
   * The system sections that produced messages[0], each tagged with the
   * priority the soft-trim should sacrifice it at. Order here is the order in
   * the built prompt.
   */
  systemSections: PromptSection[];
};

const DEFAULT_LORE_ENTRY_CHARS = 6_000;
const DEFAULT_STATE_CHARS = 3_000;
const DEFAULT_PERSONA_CHARS = 4_000;

function clip(text: string, max: number, note: string, notes: string[]): string {
  if (text.length <= max) return text;
  notes.push(note);
  const marker = "\n…（已按预算截断）";
  if (max <= 0) return "";
  if (max <= marker.length) return text.slice(0, max);
  return `${text.slice(0, max - marker.length)}${marker}`;
}

function formatLoreBlock(
  entries: Array<LoreEntryLike | WorldBookEntryLike>,
  sub: (t: string) => string,
  loreEntryCap: number,
  notes: string[],
): string {
  return entries
    .map((e) => {
      const body = clip(sub(e.content.trim()), loreEntryCap, `lore-trimmed:${e.name}`, notes);
      return [`【${sub(e.name)}】`, body].join("\n");
    })
    .join("\n\n");
}

type DepthInsert = {
  role: RpRole;
  content: string;
  depth: number;
  label: string;
};

/**
 * 段落拼装 — ContextEngine 的实现体；对外请用 ContextEngine.assemble。
 *
 * Builds at most ONE leading system message for card/rules; depth lore may
 * insert additional role messages into history (ST World Info @D).
 * Every pushed section carries its trim priority (SECTION_PRIORITY).
 *
 * CogniStack change: collaborators arrive as ports (`AssembleCollaborators`)
 * instead of seven concrete RP engines. Wire domain providers through the
 * connection protocol (`engine.connect(...)`) or pass your own.
 */
export class ContextAssembleEngine {
  readonly id = "ContextAssembleEngine" as const;

  constructor(private readonly deps: AssembleCollaborators = {}) {}

  /** Late binding so hosts can wire ports after construction. */
  with(next: AssembleCollaborators): ContextAssembleEngine {
    const merged = new ContextAssembleEngine({ ...this.deps, ...next });
    return merged;
  }

  assemble(input: ContextAssembleInput): ContextAssembleResult {
    const opt = input.options ?? {};
    const on = (key: keyof AssembleSectionOptions) => opt[key] !== false;
    const notes: string[] = [];

    const cardPort = this.deps.card;
    const textBind = this.deps.macros;
    const profile = input.profile ?? input.card;

    const resolved = cardPort
      ? cardPort.resolve(profile, { maxFieldChars: input.limits?.cardFieldChars })
      : profile;
    // Assemble reads depth_prompt from the resolved profile (preserved by the resolver).
    const cardForDepth = resolved;
    const macros = textBind
      ? textBind.resolveVars({ card: resolved, macros: input.macros })
      : { char: resolved.name?.trim() || "助手", user: input.macros?.user?.trim() || "你" };
    const bindOn = on("bindPrompt");
    const sub = (text: string) => (bindOn && textBind ? textBind.bind(text, macros) : text);

    const loreOptOn = opt.includeLore !== false && opt.includeWorldBook !== false;
    const loreEnabled = input.loreEnabled !== false && input.worldBookEnabled !== false;
    const loreOn = loreOptOn && loreEnabled;
    const entryPool = input.loreEntries ?? input.worldEntries ?? [];
    const selectedLore =
      input.selectedLore ??
      (loreOn && this.deps.lore
        ? this.deps.lore.selectEntries(entryPool, input.scanText ?? "")
        : []);
    const maxLore = Math.max(0, Math.floor(opt.maxLoreEntries ?? Number.POSITIVE_INFINITY));
    // `maxLoreEntries: 0` is a hard off-switch (inject none). Omitted / undefined
    // keeps the previous uncapped behaviour for callers that pass selected lore
    // without an engine-level cap. Finite N slices to the first N entries.
    const loreForPrompt = loreOn
      ? Number.isFinite(maxLore)
        ? selectedLore.slice(0, maxLore)
        : selectedLore
      : [];

    const limits = input.limits ?? {};
    const loreEntryCap = Math.max(
      1,
      Math.floor(limits.loreEntryChars ?? DEFAULT_LORE_ENTRY_CHARS),
    );
    const stateCap = Math.max(1, Math.floor(limits.stateChars ?? DEFAULT_STATE_CHARS));
    const personaCap = Math.max(1, Math.floor(limits.personaChars ?? DEFAULT_PERSONA_CHARS));

    const byPos: Record<LorePosition, Array<LoreEntryLike | WorldBookEntryLike>> = {
      before_char: [],
      after_char: [],
      before_example: [],
      after_example: [],
      an_top: [],
      an_bottom: [],
      at_depth: [],
    };
    for (const e of loreForPrompt) {
      byPos[normalizeLoreSlot(e.position)].push(e);
    }

    const fragments: AssembleFragments = input.fragments ?? EMPTY_FRAGMENTS;

    const loreSection = (bucket: Array<LoreEntryLike | WorldBookEntryLike>, title: string) => {
      if (!bucket.length) return null;
      return [title, formatLoreBlock(bucket, sub, loreEntryCap, notes)].join("\n");
    };

    const sections: PromptSection[] = [];
    /** Push a non-empty system section together with its trim priority. */
    const add = (text: string | null | undefined, priority: number) => {
      if (text?.trim()) sections.push({ text, priority });
    };

    if (on("includeSystemRules")) {
      add(opt.systemRulesText ?? input.systemRules ?? DEFAULT_SYSTEM_RULES, SECTION_PRIORITY.systemRules);
    }

    for (const p of fragments.systemPrefix) {
      if (p.trim()) add(sub(p.trim()), SECTION_PRIORITY.promptFragment);
    }

    add(
      loreSection(byPos.before_char, "知识资料（档案前）："),
      SECTION_PRIORITY.lore,
    );

    if (on("includeSystemPrompt") && resolved.system_prompt?.trim()) {
      add(sub(resolved.system_prompt.trim()), SECTION_PRIORITY.card);
    }
    if (on("includeDescription") && resolved.description?.trim()) {
      add(["档案设定：", sub(resolved.description.trim())].join("\n"), SECTION_PRIORITY.card);
    }
    if (on("includePersonality") && resolved.personality?.trim()) {
      add(["性格：", sub(resolved.personality.trim())].join("\n"), SECTION_PRIORITY.card);
    }
    if (on("includeScenario") && resolved.scenario?.trim()) {
      add(["场景：", sub(resolved.scenario.trim())].join("\n"), SECTION_PRIORITY.card);
    }

    add(loreSection(byPos.after_char, "知识资料（档案后）："), SECTION_PRIORITY.lore);

    if (on("includePersona") && input.personaBio?.trim()) {
      const personaText = clip(sub(input.personaBio.trim()), personaCap, "persona-trimmed", notes);
      add(
        ["用户侧写（对话中的 {{user}} 即此人）：", personaText].join("\n"),
        SECTION_PRIORITY.persona,
      );
    }

    add(loreSection(byPos.before_example, "知识资料（示例前）："), SECTION_PRIORITY.lore);

    if (on("includeMesExample") && resolved.mes_example?.trim()) {
      const mes = resolved.mes_example.trim();
      add(
        on("formatMesExample") && textBind ? textBind.formatMesExample(mes, macros) : sub(mes),
        SECTION_PRIORITY.mesExample,
      );
    }

    add(loreSection(byPos.after_example, "知识资料（示例后）："), SECTION_PRIORITY.lore);

    if (on("includeState") && this.deps.state) {
      const stateText = this.deps.state.formatForPrompt(input.worldState, { maxChars: stateCap });
      if (stateText) add(sub(stateText), SECTION_PRIORITY.worldState);
    }

    if (on("includeSummary")) {
      const blockTexts = (input.summaryBlocks ?? [])
        .map((b) => b.text?.trim())
        .filter(Boolean) as string[];
      if (blockTexts.length === 1) {
        add(
          ["长期记忆摘要（请遵守其中已发生的事实）：", sub(blockTexts[0]!)].join("\n"),
          SECTION_PRIORITY.memory,
        );
      } else if (blockTexts.length > 1) {
        // Legacy multi-block rows until the next REPLACE compress folds them.
        const body = blockTexts
          .map((t, i) => `【记忆块 ${i + 1}/${blockTexts.length}】\n${sub(t)}`)
          .join("\n\n");
        add(["长期记忆摘要（请遵守其中已发生的事实）：", body].join("\n"), SECTION_PRIORITY.memory);
      } else if (input.summary?.trim()) {
        add(
          ["长期记忆摘要（请遵守其中已发生的事实）：", sub(input.summary.trim())].join("\n"),
          SECTION_PRIORITY.memory,
        );
      }
    }

    if (input.vectorHits?.length) {
      const hits = input.vectorHits.map((h) => ({
        name: h.name ? sub(h.name) : h.name,
        content: sub((h.content || "").trim()),
      }));
      const formatter = this.deps.vector;
      if (formatter) {
        const formatted = formatter.formatAssembleHits(hits);
        if (formatted) add(formatted, SECTION_PRIORITY.vectorMemory);
      } else {
        const body = hits
          .map((h, i) => {
            const title = h.name?.trim() || `检索 ${i + 1}`;
            return `【${title}】\n${h.content}`;
          })
          .filter((b) => b.trim())
          .join("\n\n");
        if (body.trim()) {
          add(
            ["相关检索记忆（语义召回，请酌情遵守）：", body].join("\n"),
            SECTION_PRIORITY.vectorMemory,
          );
        }
      }
    }

    add(loreSection(byPos.an_top, "知识资料（附注前）："), SECTION_PRIORITY.lore);

    if (on("includePostHistory")) {
      const post = resolved.post_history_instructions?.trim();
      if (post) {
        add(
          ["【历史后指令】请在回复时优先遵守：", sub(post)].join("\n"),
          SECTION_PRIORITY.postHistory,
        );
      }
    }

    add(loreSection(byPos.an_bottom, "知识资料（附注后）："), SECTION_PRIORITY.lore);

    for (const p of fragments.systemSuffix) {
      if (p.trim()) add(sub(p.trim()), SECTION_PRIORITY.promptFragment);
    }

    const systemContentPreRegex = sections.map((s) => s.text).join("\n\n");

    // F-09: apply prompt_input regex per section so priorities stay aligned
    // after a rewrite (avoids wiping systemSections and falling back to sniffing).
    const regex = this.deps.regex;
    if (regex && input.regexScripts?.length && sections.length) {
      for (let i = 0; i < sections.length; i++) {
        const tmp = [{ role: "system" as const, content: sections[i]!.text }];
        const applied = regex.applyMessages(tmp, input.regexScripts);
        const next = applied[0]?.content;
        if (typeof next === "string" && next !== sections[i]!.text) {
          sections[i] = { text: next, priority: sections[i]!.priority };
        }
      }
    }

    const systemContent = sections.map((s) => s.text).join("\n\n");
    const messages: RpMessage[] = [];
    if (systemContent.trim()) {
      messages.push({ role: "system", content: systemContent });
    } else {
      notes.push("system-empty-skipped");
    }

    const scrubHistory = on("scrubHistory");
    let skippedCiphertext = 0;
    const history: RpMessage[] = [];
    for (const m of input.recentMessages) {
      if (m.role === "system") continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.encrypted) {
        skippedCiphertext += 1;
        continue;
      }
      let content: string;
      if (m.role === "assistant") {
        content =
          scrubHistory && textBind
            ? textBind.scrub(m.content, macros)
            : bindOn && textBind
              ? textBind.bind(m.content, macros)
              : m.content;
      } else {
        content = sub(m.content);
      }
      history.push({ role: m.role, content });
    }
    if (skippedCiphertext > 0) notes.push(`ciphertext-skipped:${skippedCiphertext}`);

    const depthInserts: DepthInsert[] = [];

    for (const e of byPos.at_depth) {
      const role: RpRole =
        e.role === "user" || e.role === "assistant" || e.role === "system" ? e.role : "system";
      const body = clip(sub(e.content.trim()), loreEntryCap, `lore-trimmed:${e.name}`, notes);
      depthInserts.push({
        role,
        content: `【${sub(e.name)}】\n${body}`,
        depth: Math.max(0, Math.floor(e.depth ?? 0)),
        label: `lore:${e.id}`,
      });
    }

    const cardDepth = cardForDepth.depth_prompt ?? input.card.depth_prompt;
    if (cardDepth?.prompt?.trim()) {
      depthInserts.push({
        role: cardDepth.role === "user" || cardDepth.role === "assistant" ? cardDepth.role : "system",
        content: sub(cardDepth.prompt.trim()),
        depth: Math.max(0, Math.floor(cardDepth.depth ?? 0)),
        label: "depth-prompt",
      });
    }

    for (const d of fragments.depthInserts ?? []) {
      depthInserts.push({
        role: d.role,
        content: sub(d.content),
        depth: Math.max(0, Math.floor(d.depth)),
        label: d.label,
      });
    }

    messages.push(...insertAtDepth(history, depthInserts));

    // Regex on history (+ depth inserts). The system was handled per-section.
    if (regex && input.regexScripts?.length) {
      const headIsSystem = messages[0]?.role === "system";
      const histStart = headIsSystem ? 1 : 0;
      const hist = messages.slice(histStart);
      const applied = regex.applyMessages(hist, input.regexScripts);
      for (let i = 0; i < applied.length; i++) {
        const next = applied[i];
        const target = messages[histStart + i];
        if (next && target) {
          messages[histStart + i] = { role: target.role, content: next.content };
        }
      }
    }

    if (systemContentPreRegex.trim() && systemContent !== systemContentPreRegex) {
      notes.push("system-regex-rewrote-sections");
    }

    return {
      messages,
      loreInjected: loreForPrompt.map((e) => ({ id: e.id, name: e.name })),
      notes,
      systemSections: sections,
    };
  }
}

/**
 * Insert depth messages into history.
 * depth 0 = after the last message; depth N = N messages up from the end.
 *
 * CogniStack change — clarification, NOT a behaviour fix: the source wrote this
 * as "sort deepest-first, then `out.length - depth` against the growing array".
 * That is algebraically identical to (originalLength − depth + already-inserted),
 * which is what this version states directly. Measured identical output; the
 * rewrite exists so the next person reading it does not have to prove it.
 */
export function insertAtDepth(history: RpMessage[], inserts: DepthInsert[]): RpMessage[] {
  if (!inserts.length) return history;
  const originalLength = history.length;
  const placed = inserts.map((ins, order) => ({
    ins,
    pos: Math.max(0, originalLength - Math.max(0, Math.floor(ins.depth))),
    order,
  }));
  // Ascending position, ties keep the caller's order.
  placed.sort((a, z) => a.pos - z.pos || a.order - z.order);

  const out = history.slice();
  let shift = 0;
  for (const p of placed) {
    const at = Math.min(out.length, Math.max(0, p.pos + shift));
    out.splice(at, 0, { role: p.ins.role, content: p.ins.content });
    shift += 1;
  }
  return out;
}
