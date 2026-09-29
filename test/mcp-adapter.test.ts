import test from "node:test";
import assert from "node:assert/strict";

import {
  mcpResourceToLoreEntry,
  createMcpLoreProvider,
  mcpToolToToolDefinition,
  createMcpToolProvider,
  type McpResource,
} from "../src/host/mcpAdapter";

test("mcpAdapter — mcpResourceToLoreEntry with text content", () => {
  const resource: McpResource = {
    uri: "file:///workspace/docs/architecture.md",
    name: "Architecture Spec",
    description: "Core architecture specification",
    mimeType: "text/markdown",
    content: {
      uri: "file:///workspace/docs/architecture.md",
      text: "# CogniStack Architecture\nCore context engine details...",
    },
  };

  const entry = mcpResourceToLoreEntry(resource);
  assert.equal(entry.id, "mcp:file:///workspace/docs/architecture.md");
  assert.equal(entry.name, "Architecture Spec");
  assert.ok(entry.content.includes("Core context engine details"));
  assert.ok(entry.keys.includes("Architecture Spec"));
  assert.equal(entry.enabled, true);
});

test("mcpAdapter — createMcpLoreProvider matches keywords", () => {
  const resources: McpResource[] = [
    {
      uri: "memo://policy/refund",
      name: "Refund Policy",
      content: "Users may request refund within 14 days.",
    },
    {
      uri: "memo://faq/shipping",
      name: "Shipping FAQ",
      content: "Orders ship within 24 hours.",
    },
  ];

  const provider = createMcpLoreProvider(resources);
  const matched = provider.selectEntries([], "Can you explain the refund policy?");
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.name, "Refund Policy");
  assert.ok(matched[0]!.content.includes("14 days"));
});

test("mcpAdapter — mcpToolToToolDefinition & createMcpToolProvider", () => {
  const tool = {
    name: "calculate_tax",
    description: "Calculates tax for order",
    inputSchema: { type: "object", properties: { amount: { type: "number" } } },
  };
  const def = mcpToolToToolDefinition(tool);
  assert.equal(def.name, "calculate_tax");
  assert.equal(def.description, "Calculates tax for order");
  assert.equal(def.type, "function");

  const provider = createMcpToolProvider([tool]);
  assert.ok(provider.getToolDefinitions);
  const defs = provider.getToolDefinitions();
  assert.equal(defs.length, 1);
  assert.equal(defs[0]?.name, "calculate_tax");

  assert.ok(provider.formatToolsForPrompt);
  const guidance = provider.formatToolsForPrompt(defs);
  assert.ok(guidance.includes("calculate_tax"));
  assert.ok(guidance.includes("MCP Tools Guidance"));
});
