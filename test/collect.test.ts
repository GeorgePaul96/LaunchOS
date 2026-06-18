import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";
import { collectEvent, parseCollectBody } from "@/lib/attribution/collect";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("parseCollectBody", () => {
  it("parses JSON and returns {} on garbage", () => {
    expect(parseCollectBody('{"type":"page","anonymousId":"a"}')).toMatchObject({ type: "page", anonymousId: "a" });
    expect(parseCollectBody("not json")).toEqual({});
  });
});

describe("collectEvent", () => {
  it("page records a web touchpoint with utm + matched campaign", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const campId = uuid();
    await db.insert(schema.campaigns).values({ id: campId, publicId: publicId("camp"), orgId, profileId, name: "C", objective: "o", status: "planning" });
    const { identityId } = await collectEvent(db as any, orgId, {
      type: "page", anonymousId: "a1", url: "https://site/x", referrer: "https://google.com",
      utm: { utm_source: "x" }, campaignId: campId,
    });
    const tps = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId));
    expect(tps).toHaveLength(1);
    expect(tps[0].channel).toBe("web");
    expect(tps[0].campaignId).toBe(campId);
    expect(JSON.parse(tps[0].utm)).toMatchObject({ utm_source: "x", referrer: "https://google.com" });
  });

  it("page with an unknown campaignId stores null campaign", async () => {
    const { orgId } = await seedOrg(db);
    const { identityId } = await collectEvent(db as any, orgId, { type: "page", anonymousId: "a2", campaignId: "ghost" });
    const [tp] = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId));
    expect(tp.campaignId).toBeNull();
  });

  it("track records a conversion with valueCents", async () => {
    const { orgId } = await seedOrg(db);
    const { identityId } = await collectEvent(db as any, orgId, { type: "track", anonymousId: "a3", event: "signup", valueCents: 5000 });
    const [c] = await db.select().from(schema.conversions).where(eq(schema.conversions.identityId, identityId));
    expect(c.eventName).toBe("signup");
    expect(c.valueCents).toBe(5000);
  });

  it("identify stitches a contact and records no event", async () => {
    const { orgId } = await seedOrg(db);
    const { identityId } = await collectEvent(db as any, orgId, { type: "identify", anonymousId: "a4", email: "z@z.com" });
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, identityId));
    expect(identity.contactId).toBeTruthy();
    expect(await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId))).toHaveLength(0);
    expect(await db.select().from(schema.conversions).where(eq(schema.conversions.identityId, identityId))).toHaveLength(0);
  });

  it("reuses one identity across calls with the same anonymousId", async () => {
    const { orgId } = await seedOrg(db);
    const r1 = await collectEvent(db as any, orgId, { type: "page", anonymousId: "same" });
    const r2 = await collectEvent(db as any, orgId, { type: "track", anonymousId: "same", event: "x" });
    expect(r2.identityId).toBe(r1.identityId);
  });

  it("400s on missing anonymousId, unknown type, and track without event", async () => {
    const { orgId } = await seedOrg(db);
    await expect(collectEvent(db as any, orgId, { type: "page" })).rejects.toMatchObject({ status: 400 });
    await expect(collectEvent(db as any, orgId, { type: "nope", anonymousId: "a" } as any)).rejects.toMatchObject({ status: 400 });
    await expect(collectEvent(db as any, orgId, { type: "track", anonymousId: "a" })).rejects.toMatchObject({ status: 400 });
  });
});
