/**
 * Portable envelope for long-term memory state.
 *
 * Why this exists
 * ---------------
 * The engine is stateless by design: every turn the host hands it the current
 * memory state and gets the next one back. But "the current memory state" is not
 * one value — it is `summaryBlocks` + `summarizedThroughMessageId` +
 * `summarizedCount` + `loreRuntime`, and every host was free to persist that
 * combination however it liked. Two consequences showed up immediately:
 *
 *   - migrating a session between hosts / environments had no defined format;
 *   - a half-written or hand-edited record could deserialize into a state where
 *     `summarizedCount` and the block list disagree, and the watermark silently
 *     skips or re-summarizes dialogue.
 *
 * This module defines the wire format and validates on the way in. It does NOT
 * store anything — persistence stays a host concern.
 *
 * Versioning: the version lives here, in the envelope, never inside the memory
 * document body. The body is fed to the model, so a marker there would burn
 * prompt tokens on every single turn.
 */
import type { LoreRuntimeState, SummaryBlock } from "../types";

export const MEMORY_ENVELOPE_KIND = "cognistack-memory" as const;
export const MEMORY_ENVELOPE_VERSION = 1;

export type MemoryStateInput = {
  summaryBlocks?: SummaryBlock[] | null;
  /** Flat summary text (legacy single-document form). */
  summary?: string | null;
  summarizedThroughMessageId?: string | null;
  summarizedCount?: number;
  loreRuntime?: LoreRuntimeState | null;
};

export type MemoryEnvelope = {
  kind: typeof MEMORY_ENVELOPE_KIND;
  version: number;
  blocks: SummaryBlock[];
  /** Present only when the host used the flat-summary form. */
  summary?: string;
  summarizedThroughMessageId: string | null;
  summarizedCount: number;
  loreRuntime?: LoreRuntimeState;
  /** Epoch ms when serialized (informational, host-supplied). */
  updatedAt?: number;
};

export type DeserializeResult = {
  state: MemoryStateInput;
  /** Human-readable repairs applied. Non-empty means the stored record was invalid or stale. */
  repaired: string[];
  /** True when the payload was not a CogniStack envelope at all. */
  foreign: boolean;
};

function asString(v: unknown, max = 512): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function asCount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Sanitize one stored block. Returns null when it is unusable. */
function sanitizeBlock(raw: unknown): { block: SummaryBlock | null; note?: string } {
  if (!raw || typeof raw !== "object") return { block: null, note: "block-not-object" };
  const o = raw as Record<string, unknown>;
  const text = asString(o.text, 200_000);
  if (!text) return { block: null, note: "block-empty-text" };
  const id = asString(o.id, 128) ?? `blk_${Math.abs(hashText(text)).toString(36)}`;
  // `throughMessageId` is what the watermark walks. A block without it cannot be
  // placed on the path, so it must not enter the list — keeping it would make
  // `resolveEffectiveWatermark` unable to find its anchor.
  const throughMessageId = asString(o.throughMessageId, 256);
  if (!throughMessageId) return { block: null, note: "block-missing-through-id" };
  const kind = o.kind === "episode" ? "episode" : o.kind === "full" ? "full" : undefined;
  const pairCount = asCount(o.pairCount);
  const importance = typeof o.importance === "number" && Number.isFinite(o.importance)
    ? Math.max(0, Math.min(100, o.importance))
    : undefined;
  return {
    block: {
      id,
      text,
      throughMessageId,
      ...(pairCount ? { pairCount } : {}),
      ...(kind ? { kind } : {}),
      ...(importance !== undefined ? { importance } : {}),
    },
  };
}

function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h;
}

function sanitizeLoreRuntime(raw: unknown): LoreRuntimeState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const pick = (key: string): Record<string, number> | undefined => {
    const v = o[key];
    if (!v || typeof v !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) out[String(k).slice(0, 128)] = n;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const state: LoreRuntimeState = {};
  const sticky = pick("stickyRemaining");
  const cooldown = pick("cooldownRemaining");
  const delay = pick("delayProgress");
  if (sticky) state.stickyRemaining = sticky;
  if (cooldown) state.cooldownRemaining = cooldown;
  if (delay) state.delayProgress = delay;
  return Object.keys(state).length ? state : undefined;
}

/** Build a portable envelope from the values a host already holds. */
export function serializeMemoryState(
  input: MemoryStateInput,
  opts?: { updatedAt?: number },
): MemoryEnvelope {
  const blocks: SummaryBlock[] = [];
  for (const raw of input.summaryBlocks ?? []) {
    const { block } = sanitizeBlock(raw);
    if (block) blocks.push(block);
  }
  const env: MemoryEnvelope = {
    kind: MEMORY_ENVELOPE_KIND,
    version: MEMORY_ENVELOPE_VERSION,
    blocks,
    summarizedThroughMessageId: asString(input.summarizedThroughMessageId, 256),
    summarizedCount: asCount(input.summarizedCount),
  };
  const flat = asString(input.summary, 200_000);
  if (flat) env.summary = flat;
  const lore = sanitizeLoreRuntime(input.loreRuntime);
  if (lore) env.loreRuntime = lore;
  if (opts?.updatedAt !== undefined && Number.isFinite(opts.updatedAt)) {
    env.updatedAt = Math.floor(opts.updatedAt);
  }
  return env;
}

/**
 * Validate / repair a stored record.
 *
 * Never throws: a corrupt envelope must degrade to "no memory" (and say so),
 * not crash a chat turn. Every change is reported in `repaired` so the caller
 * can log it — silent repair is how data problems become invisible.
 */
export function deserializeMemoryState(payload: unknown): DeserializeResult {
  const repaired: string[] = [];
  const empty: MemoryStateInput = {
    summaryBlocks: [],
    summarizedThroughMessageId: null,
    summarizedCount: 0,
  };

  let obj: unknown = payload;
  if (typeof payload === "string") {
    try {
      obj = JSON.parse(payload) as unknown;
    } catch {
      return { state: empty, repaired: ["not-json"], foreign: true };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { state: empty, repaired: ["not-an-object"], foreign: true };
  }

  const o = obj as Record<string, unknown>;
  if (o.kind !== MEMORY_ENVELOPE_KIND) {
    return { state: empty, repaired: ["not-a-cognistack-envelope"], foreign: true };
  }

  const version = asCount(o.version) || 0;
  if (version > MEMORY_ENVELOPE_VERSION) {
    // Do not guess at a future format: refuse the blocks instead of importing
    // fields we do not understand into a live session.
    return {
      state: empty,
      repaired: [`version-ahead:${version}>${MEMORY_ENVELOPE_VERSION}`],
      foreign: false,
    };
  }
  if (version < MEMORY_ENVELOPE_VERSION) repaired.push(`version-upgraded:${version}`);

  const blocks: SummaryBlock[] = [];
  const rawBlocks = Array.isArray(o.blocks) ? o.blocks : [];
  for (const raw of rawBlocks) {
    const { block, note } = sanitizeBlock(raw);
    if (block) blocks.push(block);
    else if (note) repaired.push(note);
  }

  const summarizedCount = asCount(o.summarizedCount);
  let throughId = asString(o.summarizedThroughMessageId, 256);
  if (!throughId && blocks.length) {
    // Recover the anchor from the blocks rather than declaring "no memory":
    // the LAST block's through-id is the watermark by construction (blocks are
    // appended in dialogue order), so this is a real recovery, not a guess.
    throughId = blocks[blocks.length - 1]!.throughMessageId;
    repaired.push("through-id-recovered-from-blocks");
  }
  if (blocks.length > 0 && summarizedCount === 0) {
    // Flag only. `summarizedCount` is in MESSAGES while a block's `pairCount` is in
    // UA PAIRS — cross-validating them without the dialogue is not possible, and an
    // earlier version of this function did exactly that and rewrote the watermark
    // on every load (pairs ≠ messages). Rewriting a watermark to a wrong value is
    // worse than leaving it: the engine re-anchors from `summarizedThroughMessageId`
    // anyway, so leaving 0 here is the safe direction.
    repaired.push("summarized-count-missing");
  }

  const state: MemoryStateInput = {
    summaryBlocks: blocks,
    summarizedThroughMessageId: throughId,
    summarizedCount,
  };
  const flat = asString(o.summary, 200_000);
  if (flat) state.summary = flat;
  const lore = sanitizeLoreRuntime(o.loreRuntime);
  if (lore) state.loreRuntime = lore;

  return { state, repaired, foreign: false };
}
