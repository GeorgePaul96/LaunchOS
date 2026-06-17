import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, seedAccount, type TestDB } from "./helpers";
import { createCampaign, listCampaigns, getCampaign, channelMixOf, planCampaign } from "@/lib/campaign/service";
import type { AIProvider } from "@/lib/ai/provider";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("campaign service: create/list/get", () => {
  it("creates a planning campaign and persists accountIds", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const c = await createCampaign(db as any, orgId, {
      profileId, name: "Beta launch", objective: "signups",
      goalMetric: "signups", goalTarget: 500, budgetCents: 100000, accountIds: [acc],
    });
    expect(c.status).toBe("planning");
    expect(JSON.parse(c.accountIds)).toEqual([acc]);
  });

  it("404s for an unknown profile and 404s for an account outside the org", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await expect(createCampaign(db as any, orgId, { profileId: "nope", name: "n", objective: "o", accountIds: [] }))
      .rejects.toMatchObject({ status: 404 });
    await expect(createCampaign(db as any, orgId, { profileId, name: "n", objective: "o", accountIds: ["ghost"] }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("400s when no accounts are given", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await expect(createCampaign(db as any, orgId, { profileId, name: "n", objective: "o", accountIds: [] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("lists newest-first and gets with derived channelMix", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    await createCampaign(db as any, orgId, { profileId, name: "one", objective: "o", accountIds: [acc] });
    const second = await createCampaign(db as any, orgId, { profileId, name: "two", objective: "o", accountIds: [acc] });
    const list = await listCampaigns(db as any, orgId);
    expect(list[0].name).toBe("two");
    const got = await getCampaign(db as any, orgId, second.id);
    expect(got.campaign.id).toBe(second.id);
    expect(got.assets).toEqual([]);
    expect(got.channelMix).toEqual([]);
  });

  it("404s getting an unknown campaign", async () => {
    const { orgId } = await seedOrg(db);
    await expect(getCampaign(db as any, orgId, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("channelMixOf", () => {
  it("aggregates budget per platform with share percentages", () => {
    const mix = channelMixOf([
      { platform: "twitter", budgetCents: 300 },
      { platform: "twitter", budgetCents: 100 },
      { platform: "linkedin", budgetCents: 600 },
    ]);
    const tw = mix.find((m) => m.platform === "twitter")!;
    const li = mix.find((m) => m.platform === "linkedin")!;
    expect(tw.budgetCents).toBe(400);
    expect(tw.share).toBe(40);
    expect(li.budgetCents).toBe(600);
    expect(li.share).toBe(60);
  });

  it("returns share 0 for all-zero budgets (no divide-by-zero)", () => {
    const mix = channelMixOf([{ platform: "twitter", budgetCents: 0 }]);
    expect(mix[0].share).toBe(0);
  });
});

describe("campaign service: plan", () => {
  // A deterministic provider returning two assets (one per seeded platform).
  const planProvider: AIProvider = {
    name: "plan-spy",
    async complete(req) {
      return {
        text: JSON.stringify({
          goalMetric: "signups", goalTarget: 300,
          channelMix: [{ platform: "twitter", budgetCents: 6000, rationale: "reach" }],
          assets: [
            { platform: "twitter", dayOffset: 0, draftBody: "tw post", rationale: "hook", expectedOutcome: "clicks", budgetCents: 6000 },
            { platform: "linkedin", dayOffset: 2, draftBody: "li post", rationale: "trust", expectedOutcome: "leads", budgetCents: 4000 },
          ],
        }),
        model: req.model, usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  it("plans, persists assets matched to accounts, and links an ai_jobs row", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await db.update(schema.profiles).set({ brandVoice: JSON.stringify({ tone: "bold-xyz" }) }).where(eq(schema.profiles.id, profileId));
    const tw = await seedAccount(db, orgId, profileId, "twitter");
    const li = await seedAccount(db, orgId, profileId, "linkedin");
    const c = await createCampaign(db as any, orgId, { profileId, name: "C", objective: "signups", accountIds: [tw, li] });

    const { campaign, assets } = await planCampaign(db as any, orgId, c.id, { provider: planProvider });
    expect(assets).toHaveLength(2);
    expect(campaign.aiJobId).not.toBeNull();
    expect(campaign.goalMetric).toBe("signups");
    const byPlatform = Object.fromEntries(assets.map((a) => [a.platform, a.accountId]));
    expect(byPlatform.twitter).toBe(tw);
    expect(byPlatform.linkedin).toBe(li);
    const job = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.id, campaign.aiJobId!));
    expect(job[0].feature).toBe("campaign_brain");
  });

  it("passes brand voice + channels into the model call", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await db.update(schema.profiles).set({ brandVoice: JSON.stringify({ tone: "wry-zzz" }) }).where(eq(schema.profiles.id, profileId));
    const tw = await seedAccount(db, orgId, profileId, "twitter");
    const c = await createCampaign(db as any, orgId, { profileId, name: "C", objective: "o", accountIds: [tw] });
    let seenSystem = "";
    const spy: AIProvider = {
      name: "spy",
      async complete(req) {
        seenSystem = req.system ?? "";
        return { text: JSON.stringify({ assets: [{ platform: "twitter", dayOffset: 0, draftBody: "b", rationale: "r", expectedOutcome: "o", budgetCents: 1 }] }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await planCampaign(db as any, orgId, c.id, { provider: spy });
    expect(seenSystem).toContain("wry-zzz");
    expect(seenSystem).toContain("twitter");
  });

  it("502s when the model returns no assets", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const tw = await seedAccount(db, orgId, profileId, "twitter");
    const c = await createCampaign(db as any, orgId, { profileId, name: "C", objective: "o", accountIds: [tw] });
    const bad: AIProvider = { name: "bad", async complete(req) { return { text: JSON.stringify({ assets: [] }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    await expect(planCampaign(db as any, orgId, c.id, { provider: bad })).rejects.toMatchObject({ status: 502, code: "ai_invalid_output" });
  });

  it("re-plan replaces un-materialized assets", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const tw = await seedAccount(db, orgId, profileId, "twitter");
    const li = await seedAccount(db, orgId, profileId, "linkedin");
    const c = await createCampaign(db as any, orgId, { profileId, name: "C", objective: "o", accountIds: [tw, li] });
    const first = await planCampaign(db as any, orgId, c.id, { provider: planProvider });
    const second = await planCampaign(db as any, orgId, c.id, { provider: planProvider });
    expect(second.assets).toHaveLength(2);
    // Old asset ids are gone (replaced).
    const oldIds = new Set(first.assets.map((a) => a.id));
    expect(second.assets.every((a) => !oldIds.has(a.id))).toBe(true);
  });

  it("re-plan keeps materialized assets (those with a postId) and replaces the rest", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const tw = await seedAccount(db, orgId, profileId, "twitter");
    const li = await seedAccount(db, orgId, profileId, "linkedin");
    const c = await createCampaign(db as any, orgId, { profileId, name: "C", objective: "o", accountIds: [tw, li] });

    const first = await planCampaign(db as any, orgId, c.id, { provider: planProvider });
    // Materialize one asset by creating a post and linking it.
    const kept = first.assets[0];
    const post = (await db.insert(schema.posts).values({
      id: "post_fixed_1",
      publicId: "pub_fixed_1",
      orgId,
      profileId,
      content: "test",
    }).returning())[0];
    await db.update(schema.campaignAssets).set({ postId: post.id }).where(eq(schema.campaignAssets.id, kept.id));

    const second = await planCampaign(db as any, orgId, c.id, { provider: planProvider });
    const allIds = (await db.select().from(schema.campaignAssets).where(eq(schema.campaignAssets.campaignId, c.id))).map((a) => a.id);
    // The materialized asset survived the re-plan.
    expect(allIds).toContain(kept.id);
    // The other original (un-materialized) asset was replaced.
    const otherOriginal = first.assets[1];
    expect(allIds).not.toContain(otherOriginal.id);
    // New plan's freshly-inserted assets are present too.
    expect(second.assets.length).toBeGreaterThan(0);
  });

  it("400s planning a non-planning campaign", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const tw = await seedAccount(db, orgId, profileId, "twitter");
    const c = await createCampaign(db as any, orgId, { profileId, name: "C", objective: "o", accountIds: [tw] });
    await db.update(schema.campaigns).set({ status: "active" }).where(eq(schema.campaigns.id, c.id));
    await expect(planCampaign(db as any, orgId, c.id, { provider: planProvider })).rejects.toMatchObject({ status: 400 });
  });
});
