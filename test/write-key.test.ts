import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { generateWriteKey } from "@/lib/auth";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("write key", () => {
  it("generateWriteKey returns a pk_ key", () => {
    const k = generateWriteKey();
    expect(k.startsWith("pk_")).toBe(true);
    expect(k.length).toBeGreaterThan(20);
    expect(generateWriteKey()).not.toBe(k); // unique each call
  });

  it("seedOrg gives every org a distinct non-empty write key (unique index holds)", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const rows = await db.select().from(schema.organizations);
    const keys = rows.map((r) => r.writeKey);
    expect(keys.every((k) => k.startsWith("pk_"))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // all distinct
    const [orgA] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, a.orgId));
    expect(orgA.writeKey).not.toBe("");
    expect(b.orgId).not.toBe(a.orgId);
  });
});
