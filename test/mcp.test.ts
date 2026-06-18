import { describe, it, expect } from "vitest";
import { tools } from "@/mcp/tools";
import { toMcpResult, buildServer } from "@/mcp/server";
import { LaunchOSApiError } from "@/lib/sdk/errors";
import { LaunchOSClient } from "@/lib/sdk/client";

describe("mcp", () => {
  it("registers the curated tool set", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "attribution_report", "contact_journey", "create_campaign", "create_post", "generate_content",
      "list_accounts", "list_posts", "plan_campaign", "record_conversion", "record_touchpoint",
    ]);
  });

  it("generate_content routes to the SDK content resource", async () => {
    let got: unknown;
    const stub = { content: { generate: async (a: unknown) => { got = a; return { generation: {}, variants: [] }; } } } as unknown as LaunchOSClient;
    const tool = tools.find((t) => t.name === "generate_content")!;
    await tool.run(stub, { profileId: "p", intent: "hook", prompt: "x" });
    expect(got).toMatchObject({ profileId: "p", intent: "hook", prompt: "x" });
  });

  it("create_campaign routes to the SDK campaigns resource", async () => {
    let got: unknown;
    const stub = { campaigns: { create: async (a: unknown) => { got = a; return { campaign: {} }; } } } as unknown as LaunchOSClient;
    const tool = tools.find((t) => t.name === "create_campaign")!;
    await tool.run(stub, { profileId: "p", name: "C", objective: "o", accountIds: ["a"] });
    expect(got).toMatchObject({ profileId: "p", name: "C", accountIds: ["a"] });
  });

  it("routes a tool call through the client", async () => {
    const stub = { accounts: { list: async () => ({ data: [{ id: "acc_1" }] }) } } as unknown as LaunchOSClient;
    const listAccounts = tools.find((t) => t.name === "list_accounts")!;
    const out = await listAccounts.run(stub, {});
    expect(out).toEqual({ data: [{ id: "acc_1" }] });
  });

  it("toMcpResult surfaces errors with isError", async () => {
    const ok = await toMcpResult(async () => ({ a: 1 }));
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("\"a\": 1");

    const err = await toMcpResult(async () => { throw new LaunchOSApiError(401, "unauthorized", "Invalid API key"); });
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toBe("Invalid API key");
  });

  it("buildServer constructs without a transport", () => {
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test" });
    expect(buildServer(client)).toBeTruthy();
  });
});
