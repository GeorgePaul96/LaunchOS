import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, seedAccount, scopeToOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("campaign schema + RLS", () => {
  it("stores aiJobId + accountIds on campaigns and isolates campaign_assets across orgs", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const accA = await seedAccount(db, a.orgId, a.profileId, "twitter");
    const campId = uuid();

    await scopeToOrg(db, a.orgId, async (tx) => {
      await tx.insert(schema.campaigns).values({
        id: campId, publicId: publicId("camp"), orgId: a.orgId, profileId: a.profileId,
        name: "Launch", objective: "signups", status: "planning",
        accountIds: JSON.stringify([accA]),
      });
      await tx.insert(schema.campaignAssets).values({
        id: uuid(), publicId: publicId("casset"), campaignId: campId, orgId: a.orgId,
        accountId: accA, platform: "twitter", dayOffset: 1, draftBody: "hi",
      });
    });

    await scopeToOrg(db, b.orgId, async (tx) => {
      const seen = await tx.select().from(schema.campaignAssets);
      expect(seen).toHaveLength(0);
    });
    await scopeToOrg(db, a.orgId, async (tx) => {
      const seen = await tx.select().from(schema.campaignAssets);
      expect(seen).toHaveLength(1);
      const [c] = await tx.select().from(schema.campaigns).where(eq(schema.campaigns.id, campId));
      expect(JSON.parse(c.accountIds)).toEqual([accA]);
    });
  });
});
