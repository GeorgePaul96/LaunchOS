import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTestDb, seedOrg, scopeToOrg, type TestDB } from "./helpers";

let db: TestDB;
let currentOrg = "";
beforeEach(async () => { db = await makeTestDb(); });

vi.mock("@/lib/request", async (orig) => {
  const actual = await orig<typeof import("@/lib/request")>();
  return {
    ...actual,
    requireContext: async () => ({
      orgId: currentOrg,
      userId: "u_test",
      withOrg: <T,>(fn: (d: any) => Promise<T>) => scopeToOrg(db, currentOrg, fn as any),
    }),
  };
});

describe("content API", () => {
  it("POST /content/generate creates variants; GET lists; choose marks chosen", async () => {
    const { orgId, profileId } = await seedOrg(db);
    currentOrg = orgId;

    const { POST: generate } = await import("@/app/api/v1/content/generate/route");
    const genRes = await generate(new Request("http://x/api/v1/content/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, intent: "hook", prompt: "launch" }),
    }));
    expect(genRes.status).toBe(201);
    const genBody = await genRes.json();
    expect(genBody.variants.length).toBeGreaterThan(0);

    const { GET: list } = await import("@/app/api/v1/content/generations/route");
    const listBody = await (await list()).json();
    expect(listBody.data).toHaveLength(1);

    const variantId = genBody.variants[0].id;
    const { POST: choose } = await import("@/app/api/v1/content/variants/[id]/choose/route");
    const chooseRes = await choose(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: variantId }) });
    expect(chooseRes.status).toBe(200);
    expect((await chooseRes.json()).variant.chosen).toBe(true);
  });

  it("POST /content/generate 400s on a bad intent", async () => {
    const { orgId, profileId } = await seedOrg(db);
    currentOrg = orgId;
    const { POST: generate } = await import("@/app/api/v1/content/generate/route");
    const res = await generate(new Request("http://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, intent: "haiku", prompt: "x" }),
    }));
    expect(res.status).toBe(400);
  });
});
