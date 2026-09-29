/**
 * CogniStack Engine — Model Context Protocol (MCP) Adapter.
 *
 * Maps MCP (Model Context Protocol) resources, prompts, and context
 * into CogniStack-native ports (LoreEntryLike, AgentProfileLike).
 * Zero runtime dependencies.
 */
import type { LoreEntryLike, AgentProfileLike, LoreSlot, ToolDefinitionLike } from "../types";
import type { LoreProvider, ToolRegistryProvider } from "../ports";

export type McpResourceContent = {
  uri: string;
  mimeType?: string | undefined;
  text?: string | undefined;
  blob?: string | undefined;
};

export type McpResource = {
  uri: string;
  name: string;
  description?: string | undefined;
  mimeType?: string | undefined;
  content?: McpResourceContent | string | undefined;
};

export type McpPromptMessage = {
  role: "user" | "assistant";
  content: {
    type: "text" | "resource" | "image";
    text?: string | undefined;
    resource?: McpResourceContent | undefined;
  };
};

export type McpGetPromptResult = {
  description?: string | undefined;
  messages: McpPromptMessage[];
};

/**
 * Converts an MCP Resource to a CogniStack LoreEntryLike knowledge item.
 */
export function mcpResourceToLoreEntry(
  resource: McpResource,
  opts?: {
    keys?: string[] | undefined;
    constant?: boolean | undefined;
    position?: LoreSlot | undefined;
    insertionOrder?: number | undefined;
  },
): LoreEntryLike {
  let content = "";
  if (typeof resource.content === "string") {
    content = resource.content;
  } else if (resource.content && typeof resource.content.text === "string") {
    content = resource.content.text;
  } else if (resource.description) {
    content = resource.description;
  }

  // Derive keys from uri or name if not explicitly provided
  const keys = opts?.keys && opts.keys.length > 0
    ? opts.keys
    : [resource.name, resource.uri.split("/").pop() || ""].filter(Boolean);

  return {
    id: `mcp:${resource.uri}`,
    name: resource.name || resource.uri,
    keys,
    content,
    enabled: true,
    constant: opts?.constant ?? false,
    insertionOrder: opts?.insertionOrder ?? 100,
    position: opts?.position ?? "before_char",
  };
}

/**
 * Converts an MCP GetPromptResult to a CogniStack AgentProfileLike.
 */
export function mcpPromptToCard(
  promptResult: McpGetPromptResult,
  opts?: { name?: string | undefined },
): AgentProfileLike {
  const examples: string[] = [];

  for (const m of promptResult.messages) {
    if (m.content.type === "text" && m.content.text) {
      if (m.role === "user") {
        examples.push(`User: ${m.content.text}`);
      } else {
        examples.push(`Assistant: ${m.content.text}`);
      }
    }
  }

  const card: AgentProfileLike = {
    name: opts?.name || "MCP Agent",
    description: promptResult.description || "",
  };
  if (examples.length > 0) {
    card.mes_example = examples.join("\n");
  }
  return card;
}

/**
 * Creates a LoreProvider backed by an array of MCP resources.
 */
export function createMcpLoreProvider(resources: McpResource[]): LoreProvider {
  const entries = resources.map((r) => mcpResourceToLoreEntry(r));

  return {
    selectEntries(
      _existingEntries,
      scanText: string,
      opts?: { maxEntries?: number },
    ): LoreEntryLike[] {
      const max = opts?.maxEntries ?? 10;
      const lowerScan = scanText.toLowerCase();

      const matched: LoreEntryLike[] = [];
      for (const entry of entries) {
        if (!entry.enabled) continue;
        if (entry.constant) {
          matched.push(entry);
          continue;
        }
        const hit = entry.keys.some((k) => lowerScan.includes(k.toLowerCase()));
        if (hit) {
          matched.push(entry);
        }
        if (matched.length >= max) break;
      }
      return matched;
    },
  };
}

export type McpTool = {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
};

/**
 * Converts an MCP Tool to a CogniStack ToolDefinitionLike item.
 */
export function mcpToolToToolDefinition(tool: McpTool): ToolDefinitionLike {
  return {
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema || { type: "object", properties: {} },
  };
}

/**
 * Creates a ToolRegistryProvider backed by an array of MCP tools.
 */
export function createMcpToolProvider(tools: McpTool[]): ToolRegistryProvider {
  const defs = tools.map(mcpToolToToolDefinition);

  return {
    getToolDefinitions(): ToolDefinitionLike[] {
      return defs;
    },
    formatToolsForPrompt(activeTools: ToolDefinitionLike[]): string {
      if (!activeTools.length) return "";
      const lines = [
        "## 可用工具与函数说明 (MCP Tools Guidance):",
        ...activeTools.map(
          (t) => `- \`${t.name}\`: ${t.description || "无描述"} (入参: ${JSON.stringify(t.parameters || {})})`
        ),
      ];
      return lines.join("\n");
    },
  };
}

