import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LaunchOSClient } from "@/lib/sdk/client";
import { LaunchOSApiError } from "@/lib/sdk/errors";
import { tools } from "./tools";

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown; // satisfies the MCP SDK's CallToolResult index signature
}

// Wrap an SDK call into an MCP tool result; surface problem+json detail on error.
export async function toMcpResult(work: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    const out = await work();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    const detail = e instanceof LaunchOSApiError ? e.detail : e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: detail }], isError: true };
  }
}

export function buildServer(client: LaunchOSClient): McpServer {
  const server = new McpServer({ name: "launchos", version: "0.1.0" });
  for (const t of tools) {
    server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) =>
      toMcpResult(() => t.run(client, args)),
    );
  }
  return server;
}
