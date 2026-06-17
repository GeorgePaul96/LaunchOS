import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, seedAccount, type TestDB } from "./helpers";
import { createCampaign, listCampaigns, getCampaign } from "@/lib/campaign/service";

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
