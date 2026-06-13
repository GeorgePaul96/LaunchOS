import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";
import { contactTimeline } from "@/lib/journey/timeline";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("journey timeline", () => {
  it("merges touchpoints and conversions for a contact in chronological order", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const contactId = uuid();
    await db.insert(schema.contacts).values({ id: contactId, publicId: publicId("contact"), orgId, profileId, name: "Jo" });
    const identityId = await identify(db as any, orgId, { anonymousId: "a1", contactId });

    await recordTouchpoint(db as any, orgId, { identityId, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" });
    await recordConversion(db as any, orgId, { identityId, eventName: "signup", valueCents: 0, occurredAt: "2026-06-03T00:00:00Z" });
    await recordTouchpoint(db as any, orgId, { identityId, channel: "email", occurredAt: "2026-06-02T00:00:00Z" });

    const timeline = await contactTimeline(db as any, orgId, contactId);
    expect(timeline.map(e => e.kind)).toEqual(["touchpoint", "touchpoint", "conversion"]);
    expect(timeline[0].occurredAt).toBe("2026-06-01T00:00:00Z");
    expect(timeline[2].kind).toBe("conversion");
  });

  it("returns empty for a contact with no identity", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const contactId = uuid();
    await db.insert(schema.contacts).values({ id: contactId, publicId: publicId("contact"), orgId, profileId, name: "Solo" });
    const timeline = await contactTimeline(db as any, orgId, contactId);
    expect(timeline).toEqual([]);
  });
});
