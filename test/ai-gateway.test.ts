import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { run } from "@/lib/ai/gateway";
import { MockAIProvider } from "@/lib/ai/mock";
import type { AIProvider } from "@/lib/ai/provider";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

const mock = new MockAIProvider();

describe("ai gateway", () => {
  it("runs, returns text, and records one succeeded ai_jobs row with cost", async () => {
    const { orgId } = await seedOrg(db);
    const result = await run(db as any, {
      orgId, feature: "viral_gen", task: "generate",
      messages: [{ role: "user", content: "write a hook" }],
      provider: mock,
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.costCents).toBeGreaterThan(0);

    const rows = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].feature).toBe("viral_gen");
    expect(rows[0].costCents).toBeGreaterThan(0);
    expect(rows[0].inputTokens).toBeGreaterThan(0);
  });

  it("parses JSON when a jsonSchema is provided", async () => {
    const { orgId } = await seedOrg(db);
    const result = await run(db as any, {
      orgId, feature: "campaign_brain", task: "plan",
      messages: [{ role: "user", content: "plan" }],
      jsonSchema: { type: "object", properties: { goal: { type: "string" } } },
      provider: mock,
    });
    expect(result.json).toMatchObject({ goal: expect.any(String) });
  });

  it("throws 402 and records a failed row when over budget", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 0 }) }).where(eq(schema.organizations.id, orgId));
    await expect(run(db as any, {
      orgId, feature: "viral_gen", task: "generate",
      messages: [{ role: "user", content: "x" }], provider: mock,
    })).rejects.toMatchObject({ status: 402, code: "budget_exceeded" });
    const rows = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });

  it("throws 502 and records a failed row on provider error", async () => {
    const { orgId } = await seedOrg(db);
    const boom: AIProvider = { name: "boom", async complete() { throw new Error("provider down"); } };
    await expect(run(db as any, {
      orgId, feature: "viral_gen", task: "generate",
      messages: [{ role: "user", content: "x" }], provider: boom,
    })).rejects.toMatchObject({ status: 502, code: "ai_provider_error" });
    const rows = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("provider down");
  });
});
