/**
 * Degenerate-but-correct default ports.
 *
 * A host that only owns an agent profile can assemble, budget and compress a
 * prompt without supplying any collaborator. Every default here is deliberately
 * small and predictable; hosts that want rich lore selection connect a
 * provider through `engine.connect(...)`.
 *
 * These defaults are MECHANICAL and carry no domain semantics.
 */
import type {
  CardResolver,
  LoreProvider,
  MacroBinder,
  MacroVars,
  PresetResolver,
  RegexApplier,
  VectorFormatter,
  WorldStateProvider,
  ToolRegistryProvider,
  McpResourceProvider,
} from "./ports";
import { EMPTY_FRAGMENTS } from "./ports";
import type {
  AgentProfileLike,
  CharacterCardLike,
  DialogueMessage,
  LoreEntryLike,
  RpWorldState,
  WorldBookEntryLike,
  WorldState,
} from "./types";

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

/** Free-text profile fields injected verbatim into the system prompt. */
const LONG_CARD_FIELDS = [
  "description",
  "personality",
  "scenario",
  "system_prompt",
  "mes_example",
  "post_history_instructions",
] as const;

/** Soft per-field ceiling — stops one runaway import from flooding the prompt. */
export const DEFAULT_MAX_CARD_FIELD_CHARS = 24_000;

/**
 * Structural profile normalizer: clips runaway long fields and keeps the
 * `depth_prompt` extension (depth-injected note, not folded into post_history).
 *
 * Deliberately does NOT validate/import — validation belongs to the host.
 */
export const defaultCardResolver: CardResolver = {
  resolve(card, opts) {
    const max = Math.floor(opts?.maxFieldChars ?? DEFAULT_MAX_CARD_FIELD_CHARS);
    const resolved: AgentProfileLike = { ...card };

    if (max > 0) {
      for (const key of LONG_CARD_FIELDS) {
        const value = resolved[key];
        if (typeof value === "string" && value.length > max) {
          (resolved as Record<string, unknown>)[key] = `${value.slice(0, max)}\n…（字段过长已截断）`;
        }
      }
    }

    const depth = card.depth_prompt ?? resolved.depth_prompt;
    if (depth?.prompt?.trim()) {
      resolved.depth_prompt = {
        prompt: depth.prompt.trim(),
        depth: Math.max(0, Math.floor(Number(depth.depth) || 0)),
        role:
          depth.role === "user" || depth.role === "assistant" || depth.role === "system"
            ? depth.role
            : "system",
      };
    }
    return resolved;
  },
};

/* ------------------------------------------------------------------ */
/* Macros                                                              */
/* ------------------------------------------------------------------ */

const CARD_FIELD_MACRO_KEYS = [
  "description",
  "personality",
  "scenario",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
] as const;

const MACRO_RE = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;

/**
 * Compact macro binder: `{{char}}`, `{{user}}`, plus whit `{{field}}` card
 * macros. Unknown macros are left verbatim (matches ST behaviour) so a host
 * can detect leftovers instead of silently losing text.
 */
export const defaultMacroBinder: MacroBinder = {
  resolveVars({ card, macros }) {
    const cardName = card?.name?.trim() || "";
    const fields: Record<string, string> = {};
    for (const key of CARD_FIELD_MACRO_KEYS) {
      const value = card?.[key];
      if (typeof value === "string" && value.trim()) fields[key] = value;
    }
    return {
      char: macros?.char?.trim() || cardName || "助手",
      user: macros?.user?.trim() || "你",
      charTitle: macros?.charTitle?.trim() || cardName || undefined,
      fields: Object.keys(fields).length ? fields : undefined,
    };
  },

  bind(text, vars) {
    if (!text || !text.includes("{{")) return text;
    return text.replace(MACRO_RE, (whole, rawKey: string) => {
      const key = rawKey.toLowerCase();
      if (key === "char" || key === "bot") return vars.char;
      if (key === "user" || key === "persona") return vars.user;
      if (key === "chartitle" || key === "title") return vars.charTitle ?? vars.char;
      const field = vars.fields?.[key];
      return typeof field === "string" ? field : whole;
    });
  },

  scrub(text, vars) {
    const bound = defaultMacroBinder.bind(text, vars);
    return stripLeadingSpeakerLabel(bound, vars);
  },

  formatMesExample(raw, vars) {
    let t = raw.trim();
    t = t.replace(/^\s*\{\{\s*(char|bot|user|persona)\s*\}\}\s*[:：]\s*/gim, (_m, who: string) =>
      /user|persona/i.test(who) ? "[用户]：" : "[角色]：",
    );
    t = t.replace(/^\s*<\s*(CHAR|BOT|USER)\s*>\s*[:：]\s*/gim, (_m, who: string) =>
      who.toUpperCase() === "USER" ? "[用户]：" : "[角色]：",
    );
    t = defaultMacroBinder.bind(t, vars);

    const labels = [...new Set([vars.charTitle, vars.char].filter(Boolean) as string[])]
      .filter((l) => l.trim().length >= 2)
      .sort((a, b) => b.length - a.length);
    for (const label of labels) {
      t = t.replace(speakerLabelRe(label), "$1[角色]：");
    }
    const userLabel = vars.user?.trim();
    if (userLabel) {
      t = t.replace(speakerLabelRe(userLabel), "$1[用户]：");
    }
    return [
      "对话示例（仅作文风与节奏参考；禁止在回复中输出说话人标签、卡片标题或占位符）：",
      t,
    ].join("\n");
  },
};

function stripLeadingSpeakerLabel(text: string, vars: MacroVars): string {
  const labels = [...new Set([vars.charTitle, vars.char].filter(Boolean) as string[])]
    .filter((l) => l.trim().length >= 2)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const label of labels) {
    out = out.replace(speakerLabelRe(label), "$1");
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 标签 → 已编译正则 的模块级缓存。
 *
 * 原来每个标签在每个热路径调用里都 `new RegExp(...)`（`formatMesExample` /
 * `stripLeadingSpeakerLabel` 都被每轮调用）。标签集合是很小且稳定的（角色名 /
 * 称呼 / 用户名），编译结果完全可复用。
 *
 * 用 `String#replace` 搭配带 `g` 的正则时，replace 会在开始时把 lastIndex 归零，
 * 因此复用同一个正则对象是安全的。
 */
const speakerLabelReCache = new Map<string, RegExp>();

function speakerLabelRe(label: string): RegExp {
  const hit = speakerLabelReCache.get(label);
  if (hit) return hit;
  const re = new RegExp(`(^|\\n)[ \\t]*${escapeRegExp(label)}[ \\t]*[:：][ \\t]*`, "g");
  // 上界保护：标签来自宿主输入，避免无界增长。
  if (speakerLabelReCache.size < 256) speakerLabelReCache.set(label, re);
  return re;
}

/* ------------------------------------------------------------------ */
/* Lore                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Lore                                                                */
/* ------------------------------------------------------------------ */

/**
 * No lore provider connected → no lore is injected.
 *
 * CogniStack change: the first cut shipped a mini keyword-matching lore
 * selector here, which meant the engine "had a world book in it" — exactly
 * what the base-services rule forbids. Lore selection is domain logic; a host
 * connects a `LoreProvider` through the connection protocol when it wants one.
 *
 * For HTTP / demos, use {@link createKeywordLoreProvider} explicitly
 * (`--lore keyword` on viz-server, or `createPrepareGateway({ lore })`).
 */
export const defaultLoreProvider: LoreProvider = {
  selectEntries() {
    return [];
  },
};

export type KeywordLoreOptions = {
  /** Case-insensitive key match. Default true. */
  ignoreCase?: boolean;
};

/**
 * Lightweight keyword lore selector (constant entries + key/secondaryKeys hit).
 * Opt-in only — not the engine default. Suitable for HTTP gateway demos and
 * hosts that do not yet own a full sticky/cooldown world-book engine.
 */
export function createKeywordLoreProvider(opts?: KeywordLoreOptions): LoreProvider {
  const ignoreCase = opts?.ignoreCase !== false;
  return {
    selectEntries(entries, scanText, selectOpts) {
      const scan = ignoreCase ? String(scanText || "").toLowerCase() : String(scanText || "");
      const max = Math.max(0, Math.floor(selectOpts?.maxEntries ?? 64));
      const hit: LoreEntryLike[] = [];
      const sorted = [...entries].sort(
        (a, b) => (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0),
      );
      for (const e of sorted) {
        if (e.enabled === false) continue;
        if (e.constant) {
          hit.push(normalizeLoreEntry(e, hit.length));
          if (hit.length >= max) break;
          continue;
        }
        const keys = [...(e.keys || []), ...(e.secondaryKeys || [])].filter(Boolean);
        if (!keys.length) continue;
        const matched = keys.some((k) => {
          const key = ignoreCase ? String(k).toLowerCase() : String(k);
          return key.length > 0 && scan.includes(key);
        });
        if (matched) {
          hit.push(normalizeLoreEntry(e, hit.length));
          if (hit.length >= max) break;
        }
      }
      return hit;
    },
  };
}

function normalizeLoreEntry(
  e: LoreEntryLike | WorldBookEntryLike,
  fallbackOrder: number,
): LoreEntryLike {
  return {
    id: String(e.id ?? `lore-${fallbackOrder}`),
    name: String(e.name ?? ""),
    keys: Array.isArray(e.keys) ? e.keys.map(String) : [],
    content: String(e.content ?? ""),
    enabled: e.enabled !== false,
    constant: Boolean(e.constant),
    insertionOrder:
      typeof e.insertionOrder === "number" && Number.isFinite(e.insertionOrder)
        ? e.insertionOrder
        : fallbackOrder,
    secondaryKeys: e.secondaryKeys,
    position: e.position,
    depth: e.depth,
    sticky: e.sticky,
    cooldown: e.cooldown,
    delay: e.delay,
    caseSensitive: e.caseSensitive,
    probability: e.probability,
    role: e.role,
    scanDepth: e.scanDepth,
    recursive: e.recursive,
    preventRecursion: e.preventRecursion,
  };
}

/**
 * Tail-biased scan corpus: newest dialogue wins the budget, memory head fills
 * whatever is left. Byte-identical to the RP `WorldBookEngine.buildScanText`.
 */
export function buildLoreScanText(params: {
  headText?: string;
  rawTail: string;
  maxChars: number;
}): string {
  const max = Math.max(200, Math.floor(params.maxChars || 4000));
  const raw = params.rawTail || "";
  if (raw.length >= max) return raw.slice(-max);
  const head = (params.headText || "").trim();
  if (!head) return raw;
  const remain = max - raw.length - 1;
  if (remain <= 0) return raw;
  const headPart = head.length > remain ? head.slice(-remain) : head;
  return [headPart, raw].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ */
/* World state                                                         */
/* ------------------------------------------------------------------ */

export const DEFAULT_WORLD_STATE_CHARS = 3_000;

export const defaultWorldStateProvider: WorldStateProvider = {
  formatForPrompt(state, opts) {
    const entries = state?.entries ?? [];
    const maxChars = Math.max(120, Math.floor(opts?.maxChars ?? DEFAULT_WORLD_STATE_CHARS));
    const maxEntries = Math.max(1, Math.floor(opts?.maxEntries ?? 24));
    const header = "当前世界状态（动态条目，请遵守，勿无故推翻）：";
    const kept: string[] = [];
    // 表头也要计入预算：原来从 0 起算且漏掉表头，输出可超 maxChars 约一个表头。
    let used = header.length;
    for (const e of entries.slice(0, maxEntries)) {
      const key = (e.key ?? "").trim();
      const value = (e.value ?? "").trim();
      if (!key || !value) continue;
      const line = `- ${key}：${value}`;
      // 判据与累加保持一致（行本身 + 行尾换行符），原来判据少算 1 个字符。
      if (used + line.length + 1 > maxChars) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (!kept.length) return "";
    return [header, ...kept].join("\n");
  },
};

/* ------------------------------------------------------------------ */
/* Regex / vector                                                      */
/* ------------------------------------------------------------------ */

export const noopRegexApplier: RegexApplier = {
  applyMessages(messages) {
    return messages;
  },
};

export const DEFAULT_VECTOR_HITS_CHARS = 4_000;

export const defaultVectorFormatter: VectorFormatter = {
  formatAssembleHits(hits, maxChars = DEFAULT_VECTOR_HITS_CHARS) {
    if (!hits?.length) return "";
    const header = "相关检索记忆（语义召回，请酌情遵守）：";
    const room = Math.max(0, maxChars - header.length - 1);
    if (room <= 0) return "";
    const parts: string[] = [];
    let used = 0;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      let body = (h.content ?? "").trim();
      if (!body) continue;
      const titleLine = `【${h.name?.trim() || `检索 ${i + 1}`}】\n`;
      const sep = parts.length ? 2 : 0;
      const remaining = room - used - sep - titleLine.length;
      if (remaining <= 0) break;
      if (body.length > remaining) body = body.slice(0, remaining);
      if (!body) break;
      const block = `${titleLine}${body}`;
      parts.push(block);
      used += sep + block.length;
      if (used >= room) break;
    }
    if (!parts.length) return "";
    const out = [header, parts.join("\n\n")].join("\n");
    return out.length <= maxChars ? out : out.slice(0, maxChars);
  },
};

/* ------------------------------------------------------------------ */
/* Preset                                                              */
/* ------------------------------------------------------------------ */

/** No preset configured → no fragments. */
export const defaultPresetResolver: PresetResolver = {
  resolve() {
    return EMPTY_FRAGMENTS;
  },
};

/* ------------------------------------------------------------------ */
/* Tools & MCP Defaults                                                */
/* ------------------------------------------------------------------ */

/** No tools configured → returns empty tool list and empty prompt text. */
export const defaultToolRegistryProvider: ToolRegistryProvider = {
  getToolDefinitions() {
    return [];
  },
  formatToolsForPrompt() {
    return "";
  },
};

/** No MCP provider configured → returns empty resources and null prompt. */
export const defaultMcpResourceProvider: McpResourceProvider = {
  getResources() {
    return [];
  },
  selectPrompt() {
    return null;
  },
};

export type { AgentProfileLike, CharacterCardLike, DialogueMessage, LoreEntryLike, RpWorldState, WorldBookEntryLike, WorldState };
