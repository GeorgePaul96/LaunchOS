import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("ingest", () => {
  it("records a touchpoint against an identity", async () => {
    const { orgId } = await seedOrg(db);
    const identityId = await identify(db as any, orgId, { anonymousId: "a1" });
    await recordTouchpoint(db as any, orgId, {
      identityId, channel: "organic_social", platform: "twitter", sourceType: "post", sourceId: "post_1",
    });
    const rows = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("organic_social");
  });

  it("records a conversion with value", async () => {
    const { orgId } = await seedOrg(db);
    const identityId = await identify(db as any, orgId, { anonymousId: "a2" });
    const convId = await recordConversion(db as any, orgId, {
      identityId, eventName: "purchase", valueCents: 4999,
    });
    const [row] = await db.select().from(schema.conversions).where(eq(schema.conversions.id, convId));
    expect(row.eventName).toBe("purchase");
    expect(row.valueCents).toBe(4999);
  });
});
