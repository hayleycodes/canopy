#!/usr/bin/env node
// Canopy permission gate — a stdio MCP server the Claude Code CLI spawns for a
// single turn (via --mcp-config + --permission-prompt-tool).
//
// The CLI calls our one tool, `approve`, for every permission decision. Rather
// than decide here, we bridge the request back to the Canopy server over
// localhost HTTP — which surfaces it to the human in the UI and waits for a
// click. The turn's identity travels in env (set by engine.mjs) so the server
// knows which node's stream to raise the prompt on.
//
// The tool must return the CLI's permission-result shape:
//   { behavior: "allow", updatedInput }  |  { behavior: "deny", message }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const PORT = process.env.CANOPY_PORT;
const TURN_ID = process.env.CANOPY_TURN_ID;

// Ask the Canopy server (and thus the human) to rule on one tool use. Blocks
// until the UI answers. Any failure fails safe: deny.
async function ask(toolName, input) {
  const requestId = randomUUID();
  try {
    const res = await fetch(`http://localhost:${PORT}/api/permission/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: TURN_ID, requestId, tool_name: toolName, input }),
    });
    if (!res.ok) return { behavior: "deny", message: `Canopy gate error ${res.status}` };
    return await res.json();
  } catch (e) {
    return { behavior: "deny", message: `Canopy gate unreachable: ${e.message}` };
  }
}

const server = new McpServer({ name: "canopy", version: "0.0.1" });

server.tool(
  "approve",
  "Route a Claude Code permission request to the Canopy UI for a human decision.",
  { tool_name: z.string(), input: z.any() },
  async ({ tool_name, input }) => {
    const decision = await ask(tool_name, input ?? {});
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  }
);

await server.connect(new StdioServerTransport());
