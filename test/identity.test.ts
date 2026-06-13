import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { identify, resolveIdentity } from "@/lib/attribution/identity";
import { uuid, publicId } from "@/lib/ids";

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
