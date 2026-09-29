/**
 * CogniStack Engine — core ports.
 *
 * The fused engine owns prompt assembly, token budgeting, soft-trim and
 * long-term memory. Everything that is *domain data* (agent profiles, lore /
 * knowledge snippets, session state, macro vocabulary, preset fragments,
 * regex scripts, embeddings) is reached only through the interfaces below.
 *
 * Why ports instead of concrete classes
 * -------------------------------------
 * Domain stacks used to hard-wire seven sibling engines into context assembly,
 * which made reuse impossible without dragging the whole stack. CogniStack
 * inverts that dependency: the core declares what it needs, the host supplies it.
 *
 * Compatibility: every port is declared *structurally*. Host engines that
 * already match these shapes can be passed as `collaborators` with no wrapper.
 * Domain implementations are NOT bundled — hosts supply them through
 * `engine.connect` / constructor `collaborators`.
 */
import type {
  AgentProfileLike,
  CharacterCardLike,
  DialogueMessage,
  LoreEntryLike,
  LoreRuntimeState,
  MacroNames,
  PromptMessage,
  RegexScriptLike,
  MessageRole,
  RpMessage,
  RpRole,
  RpWorldState,
  ToolDefinitionLike,
  WorldBookEntryLike,
  WorldState,
} from "./types";
import type { McpResource, McpGetPromptResult } from "./host/mcpAdapter";

/* ------------------------------------------------------------------ */
/* Value types referenced by the ports                                 */
/* ------------------------------------------------------------------ */

/** Macro vocabulary (`{{char}}` ≈ agent, `{{user}}` ≈ end-user, profile fields). */
export type MacroVars = {
  char: string;
  user: string;
  /** Full profile/library title — used only to scrub model output. */
  charTitle?: string | undefined;
  /** Whitelisted profile-field macros, e.g. `{ description: "…" }`. */
  fields?: Record<string, string> | undefined;
};

/** One pseudo-message injected into history at a given depth. */
export type DepthInsertFragment = {
  role: MessageRole;
  content: string;
  depth: number;
  label: string;
};

/** Ordered prompt fragments produced by a preset resolver. */
export type AssembleFragments = {
  /** Prefixed into system near the front (after rules). */
  systemPrefix: string[];
  /** Appended near post-history / end of system. */
  systemSuffix: string[];
  /** Pseudo-messages inserted into history by depth. */
  depthInserts: DepthInsertFragment[];
};

export const EMPTY_FRAGMENTS: AssembleFragments = {
  systemPrefix: [],
  systemSuffix: [],
  depthInserts: [],
};

/** Normalized find/replace script (shape lives in `types.ts`). */
export type { RegexScriptLike };

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

/** Resolves / normalizes an agent profile before it is rendered. */
export interface CardResolver {
  resolve(
    card: AgentProfileLike | CharacterCardLike,
    opts?: { maxFieldChars?: number | undefined },
  ): AgentProfileLike;
}

/** Binds `{{char}}` / `{{user}}` (and optional field macros) in prompt text. */
export interface MacroBinder {
  resolveVars(input: {
    card?: AgentProfileLike | CharacterCardLike | null | undefined;
    macros?: MacroNames | undefined;
  }): MacroVars;
  bind(text: string, vars: MacroVars): string;
  /** Scrubs agent name leakage from assistant history rows. */
  scrub(text: string, vars: MacroVars): string;
  /** Neutralizes speaker labels in few-shot (`mes_example`) blocks. */
  formatMesExample(text: string, vars: MacroVars): string;
}

/** Selects which lore / knowledge entries are active for a turn. */
export interface LoreProvider {
  selectEntries(
    entries: Array<LoreEntryLike | WorldBookEntryLike>,
    scanText: string,
    opts?: {
      maxEntries?: number;
      loreRuntime?: LoreRuntimeState | null;
      dialogue?: DialogueMessage[];
    },
  ): LoreEntryLike[];
  /**
   * Rich selection that also advances sticky / cooldown / delay timers.
   * Optional: when absent the engine keeps the caller's `loreRuntime` untouched.
   */
  selectWithRuntime?(
    entries: Array<LoreEntryLike | WorldBookEntryLike>,
    scanText: string,
    opts?: {
      maxEntries?: number;
      loreRuntime?: LoreRuntimeState | null;
      dialogue?: DialogueMessage[];
      tick?: boolean;
    },
  ): { selected: LoreEntryLike[]; loreRuntime: LoreRuntimeState };
  /**
   * Tail-biased concatenation of the memory head + raw dialogue tail, used as
   * the key-scan corpus. Optional: the core falls back to the bundled helper.
   */
  buildScanText?(params: { headText?: string; rawTail: string; maxChars: number }): string;
}

/** Resolves preset + side-note payloads into ordered assemble fragments. */
export interface PresetResolver {
  resolve(input: {
    preset?: unknown;
    authorsNote?: unknown;
    turnIndex?: number;
  }): AssembleFragments;
}

/** Renders the structured session snapshot into a system block. */
export interface WorldStateProvider {
  formatForPrompt(
    state?: WorldState | RpWorldState | null,
    opts?: { maxChars?: number; maxEntries?: number },
  ): string;
}

/** Applies find/replace scripts to a message list. */
export interface RegexApplier {
  applyMessages(
    messages: { role: string; content: string }[],
    scripts: RegexScriptLike[] | null | undefined,
  ): { role: string; content: string }[];
}

/** Formats semantically retrieved snippets into a system block. */
export interface VectorFormatter {
  formatAssembleHits(
    hits: { name?: string | undefined; content: string }[],
    maxChars?: number,
  ): string;
}

/** Manages function/tool definitions, schemas, and execution result budget for modern agents. */
export interface ToolRegistryProvider {
  /** Returns active tools and their schema definitions formatted for prompt injection or LLM API payload. */
  getToolDefinitions?(): ToolDefinitionLike[];
  /** Formats tool definitions into a system guidance section if needed. */
  formatToolsForPrompt?(tools: ToolDefinitionLike[], opts?: { maxTokens?: number }): string;
}

/** Model Context Protocol (MCP) resource & prompt provider. */
export interface McpResourceProvider {
  getResources?(): McpResource[];
  selectPrompt?(name: string, args?: Record<string, string>): McpGetPromptResult | null;
}

/* ------------------------------------------------------------------ */
/* Collaborator bundle + defaults                                      */
/* ------------------------------------------------------------------ */

/**
 * Everything the assemble stage may reach for. All ports are optional: the
 * engine falls back to the degenerate-but-correct defaults in `defaults.ts`
 * so a minimal host can assemble a prompt from a profile alone.
 */
export type AssembleCollaborators = {
  card?: CardResolver;
  macros?: MacroBinder;
  lore?: LoreProvider;
  state?: WorldStateProvider;
  regex?: RegexApplier;
  vector?: VectorFormatter;
  preset?: PresetResolver;
  /** Modern Agent Tools: function schemas and tool execution results. */
  tools?: ToolRegistryProvider;
  /** Modern MCP: Model Context Protocol resource & prompt provider. */
  mcp?: McpResourceProvider;
};

/** Minimal repr. of a role message used by ports that only rewrite content. */
export type ContentMessage = { role: string; content: string };

export type { PromptMessage, RpMessage, MessageRole, RpRole };
