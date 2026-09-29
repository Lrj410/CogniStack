import test from "node:test";
import assert from "node:assert/strict";

import {
  CogniStackEngine,
  PORT_NAMES,
  MODERN_PORT_NAMES,
  CONTEXT_PORT_NAMES,
  type ToolDefinitionLike,
  type ToolRegistryProvider,
  type McpResourceProvider,
} from "../src/index";

test("modern-ports — PORT_NAMES contains tools and mcp", () => {
  assert.ok(PORT_NAMES.includes("tools"));
  assert.ok(PORT_NAMES.includes("mcp"));
  assert.ok(MODERN_PORT_NAMES.includes("tools"));
  assert.ok(MODERN_PORT_NAMES.includes("mcp"));
  assert.ok(CONTEXT_PORT_NAMES.includes("card"));
});

test("modern-ports — engine connects and reports tools and mcp ports", () => {
  const engine = new CogniStackEngine();

  const mockToolProvider: ToolRegistryProvider = {
    getToolDefinitions() {
      const tool: ToolDefinitionLike = {
        name: "calculator",
        description: "Evaluates basic math expressions",
      };
      return [tool];
    },
  };

  const mockMcpProvider: McpResourceProvider = {
    getResources() {
      return [
        {
          uri: "mcp://system/specs",
          name: "System Specs",
        },
      ];
    },
  };

  // Connect modern tool provider
  const conn = engine.connect({
    id: "tool-service",
    name: "Tool Service",
    provides: {
      tools: mockToolProvider,
      mcp: mockMcpProvider,
    },
  });

  const diagnostics = engine.portDiagnostics();
  const toolDiag = diagnostics.find((d) => d.port === "tools");
  const mcpDiag = diagnostics.find((d) => d.port === "mcp");

  assert.ok(toolDiag);
  assert.equal(toolDiag.bound, true);
  assert.equal(toolDiag.winner.providerId, "tool-service");

  assert.ok(mcpDiag);
  assert.equal(mcpDiag.bound, true);
  assert.equal(mcpDiag.winner.providerId, "tool-service");

  // Close connection and verify fallback
  conn.close();
  const postDiag = engine.portDiagnostics();
  const postToolDiag = postDiag.find((d) => d.port === "tools");
  assert.equal(postToolDiag?.bound, false);
});
