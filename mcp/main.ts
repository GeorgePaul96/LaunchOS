import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LaunchOSClient } from "@/lib/sdk/client";
import { buildServer } from "./server";

const apiKey = process.env.LAUNCHOS_API_KEY;
if (!apiKey) {
  console.error("LAUNCHOS_API_KEY is required. Mint one with `npm run apikey`.");
  process.exit(1);
}
const client = new LaunchOSClient({ baseUrl: process.env.LAUNCHOS_BASE_URL ?? "http://localhost:3000", apiKey });
const server = buildServer(client);
await server.connect(new StdioServerTransport());
console.error("[mcp] launchos server running on stdio");
