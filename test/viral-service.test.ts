import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { generateVariants, listGenerations, chooseVariant } from "@/lib/viral/service";
import { MockAIProvider } from "@/lib/ai/mock";
import type { AIProvider } from "@/lib/ai/provider";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });
const mock = new MockAIProvider();

describe("viral service", () => {
  it("generates + persists a generation and variants linked to an ai_jobs row", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await db.update(schema.profiles)
      .set({ brandVoice: JSON.stringify({ tone: "punchy", bannedWords: ["synergy"] }) })
      .where(eq(schema.profiles.id, profileId));

    const { generation, variants } = await generateVariants(db as any, orgId, {
      profileId, intent: "hook", prompt: "launch our pricing", provider: mock,
    });

    expect(generation.intent).toBe("hook");
    expect(generation.aiJobId).not.toBeNull();
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(typeof v.predictedScore).toBe("number");
      expect(v.predictedScore).toBeGreaterThanOrEqual(0);
      expect(v.predictedScore).toBeLessThanOrEqual(100);
      expect(v.generationId).toBe(generation.id);
    }
    const job = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.id, generation.aiJobId!));
    expect(job).toHaveLength(1);
    expect(job[0].feature).toBe("viral_generator");
  });

  it("passes brand voice into the model call", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await db.update(schema.profiles)
      .set({ brandVoice: JSON.stringify({ tone: "deadpan-xyz" }) })
      .where(eq(schema.profiles.id, profileId));
    let seenSystem = "";
    const spy: AIProvider = {
      name: "spy",
      async complete(req) {
        seenSystem = req.system ?? "";
        return { text: JSON.stringify({ variants: [{ body: "b", predictedScore: 50, rationale: "r" }] }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: spy });
    expect(seenSystem).toContain("deadpan-xyz");
  });

  it("clamps out-of-range scores to 0..100", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const wild: AIProvider = {
      name: "wild",
      async complete(req) {
        return { text: JSON.stringify({ variants: [{ body: "a", predictedScore: 250, rationale: "r" }, { body: "b", predictedScore: -8, rationale: "r" }] }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { variants } = await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: wild });
    const scores = variants.map((v) => v.predictedScore).sort((a, b) => a - b);
    expect(scores[0]).toBe(0);
    expect(scores[scores.length - 1]).toBe(100);
  });

  it("throws 502 ai_invalid_output when the model returns no variants array", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const bad: AIProvider = { name: "bad", async complete(req) { return { text: JSON.stringify({ nope: true }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    await expect(generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: bad }))
      .rejects.toMatchObject({ status: 502, code: "ai_invalid_output" });
  });

  it("throws 404 for an unknown profile", async () => {
    const { orgId } = await seedOrg(db);
    await expect(generateVariants(db as any, orgId, { profileId: "missing", intent: "hook", prompt: "x", provider: mock }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("lists generations newest-first with nested variants", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "one", provider: mock });
    await generateVariants(db as any, orgId, { profileId, intent: "thread", prompt: "two", provider: mock });
    const gens = await listGenerations(db as any, orgId);
    expect(gens).toHaveLength(2);
    expect(gens[0].prompt).toBe("two"); // newest first
    expect(gens[0].variants.length).toBeGreaterThan(0);
  });

  it("chooseVariant flips chosen and 404s on unknown id", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const { variants } = await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: mock });
    const updated = await chooseVariant(db as any, orgId, variants[0].id);
    expect(updated.chosen).toBe(true);
    await expect(chooseVariant(db as any, orgId, "missing")).rejects.toMatchObject({ status: 404 });
  });
});
