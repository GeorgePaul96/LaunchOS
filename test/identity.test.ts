import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { identify, resolveIdentity, stitchContact } from "@/lib/attribution/identity";
import { uuid, publicId } from "@/lib/ids";
import { contactTimeline } from "@/lib/journey/timeline";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("identity", () => {
  it("creates a new identity for an unseen anonymous id", async () => {
    const { orgId } = await seedOrg(db);
    const id = await identify(db as any, orgId, { anonymousId: "anon-1" });
    const [row] = await db.select().from(schema.identities).where(eq(schema.identities.id, id));
    expect(row.anonymousId).toBe("anon-1");
  });

  it("returns the same identity for a repeated anonymous id", async () => {
    const { orgId } = await seedOrg(db);
    const a = await identify(db as any, orgId, { anonymousId: "anon-1" });
    const b = await identify(db as any, orgId, { anonymousId: "anon-1" });
    expect(a).toBe(b);
  });

  it("links an identity to a contact when provided", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const contactId = uuid();
    await db.insert(schema.contacts).values({ id: contactId, publicId: publicId("contact"), orgId, profileId, name: "Jo" });
    const id = await identify(db as any, orgId, { anonymousId: "anon-2", contactId });
    const [row] = await db.select().from(schema.identities).where(eq(schema.identities.id, id));
    expect(row.contactId).toBe(contactId);
  });

  it("resolveIdentity finds by anonymous id within org only", async () => {
    const { orgId } = await seedOrg(db);
    await identify(db as any, orgId, { anonymousId: "anon-3" });
    const found = await resolveIdentity(db as any, orgId, "anon-3");
    expect(found).not.toBeNull();
    const missing = await resolveIdentity(db as any, "other-org", "anon-3");
    expect(missing).toBeNull();
  });
});

describe("stitchContact", () => {
  it("creates a contact by email and links the identity both ways", async () => {
    const { orgId } = await seedOrg(db);
    const idA = await identify(db as any, orgId, { anonymousId: "anon-1" });
    const contactId = await stitchContact(db as any, orgId, { identityId: idA, email: "Jo@Example.com ", traits: { name: "Jo" } });
    expect(contactId).toBeTruthy();
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, idA));
    expect(identity.contactId).toBe(contactId);
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId!));
    expect(contact.email).toBe("jo@example.com"); // normalized
    expect(contact.identityId).toBe(idA);
  });

  it("merges two devices (same email) into one contact and one merged timeline", async () => {
    const { orgId } = await seedOrg(db);
    const id1 = await identify(db as any, orgId, { anonymousId: "dev-1" });
    const id2 = await identify(db as any, orgId, { anonymousId: "dev-2" });
    const c1 = await stitchContact(db as any, orgId, { identityId: id1, email: "x@y.com" });
    const c2 = await stitchContact(db as any, orgId, { identityId: id2, email: "x@y.com" });
    expect(c2).toBe(c1); // same contact reused
    // both identities now point to the same contact → timeline fans both in
    await db.insert(schema.touchpoints).values({ orgId, identityId: id1, channel: "web", occurredAt: "2026-01-01T00:00:00.000Z" });
    await db.insert(schema.touchpoints).values({ orgId, identityId: id2, channel: "email", occurredAt: "2026-01-02T00:00:00.000Z" });
    const tl = await contactTimeline(db as any, orgId, c1!);
    expect(tl.map((e) => e.channel)).toEqual(["web", "email"]);
  });

  it("ignores a contactId from another org and is a no-op without email/contactId", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const idA = await identify(db as any, a.orgId, { anonymousId: "anon-a" });
    // create a contact in org B
    const idB = await identify(db as any, b.orgId, { anonymousId: "anon-b" });
    const cB = await stitchContact(db as any, b.orgId, { identityId: idB, email: "b@b.com" });
    // org A identify referencing org B's contactId → ignored (treated as no match → no-op since no email)
    const res = await stitchContact(db as any, a.orgId, { identityId: idA, contactId: cB! });
    expect(res).toBeNull();
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, idA));
    expect(identity.contactId).toBeNull();
  });

  it("returns null and creates no contact for a non-existent identity", async () => {
    const { orgId } = await seedOrg(db);
    const before = await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId));
    const res = await stitchContact(db as any, orgId, { identityId: "ghost-id", email: "nobody@example.com" });
    expect(res).toBeNull();
    const after = await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId));
    expect(after.length).toBe(before.length); // no orphan contact created
  });
});
