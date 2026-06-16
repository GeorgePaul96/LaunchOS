import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { orgBudgetCents, assertWithinBudget } from "@/lib/ai/budget";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("budget", () => {
  it("uses the env default when no per-org override", async () => {
    const { orgId } = await seedOrg(db);
    process.env.AI_BUDGET_CENTS_DEFAULT = "5000";
    expect(await orgBudgetCents(db as any, orgId)).toBe(5000);
    delete process.env.AI_BUDGET_CENTS_DEFAULT;
  });

  it("per-org feature_flags override beats the default", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 250 }) }).where(eq(schema.organizations.id, orgId));
    expect(await orgBudgetCents(db as any, orgId)).toBe(250);
  });

  it("passes when spend + add is within cap", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 100 }) }).where(eq(schema.organizations.id, orgId));
    await expect(assertWithinBudget(db as any, orgId, 10)).resolves.toBeUndefined();
  });

  it("throws 402 when spend + add exceeds cap", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 5 }) }).where(eq(schema.organizations.id, orgId));
    // existing spend this month
    await db.insert(schema.aiJobs).values({ orgId, feature: "f", task: "generate", model: "claude-opus-4-8", status: "succeeded", costCents: 4 });
    await expect(assertWithinBudget(db as any, orgId, 5)).rejects.toMatchObject({ status: 402, code: "budget_exceeded" });
  });
});
