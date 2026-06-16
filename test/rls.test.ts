import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, seedOrg, seedAccount, scopeToOrg, type TestDB } from "./helpers";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("row-level security", () => {
  it("blocks cross-org reads even when the app filter is bypassed", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    await seedAccount(db, a.orgId, a.profileId, "twitter");
    await seedAccount(db, b.orgId, b.profileId, "twitter");

    // Within org A's scope, a RAW select with no org_id filter must see only org A's row.
    const rowsForA = await scopeToOrg(db, a.orgId, async (tx) => {
      const r = await tx.execute(sql`select org_id from social_accounts`);
      return r.rows as { org_id: string }[];
    });
    expect(rowsForA.length).toBe(1);
    expect(rowsForA[0].org_id).toBe(a.orgId);

    // Switching scope to org B sees only org B's row.
    const rowsForB = await scopeToOrg(db, b.orgId, async (tx) => {
      const r = await tx.execute(sql`select org_id from social_accounts`);
      return r.rows as { org_id: string }[];
    });
    expect(rowsForB.length).toBe(1);
    expect(rowsForB[0].org_id).toBe(b.orgId);
  });

  it("blocks cross-org writes (WITH CHECK)", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    // Inside org A's scope, inserting a row tagged with org B must fail the policy.
    await expect(
      scopeToOrg(db, a.orgId, async (tx) => {
        await tx.execute(sql`insert into journeys (id, org_id, name) values ('j1', ${b.orgId}, 'x')`);
      }),
    ).rejects.toThrow();
  });

  it("service role (base db) sees across orgs", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    await seedAccount(db, a.orgId, a.profileId, "twitter");
    await seedAccount(db, b.orgId, b.profileId, "twitter");
    // The base handle is the superuser/service role → RLS bypassed → sees both.
    const r = await db.execute(sql`select count(*)::int as n from social_accounts`);
    expect((r.rows[0] as { n: number }).n).toBe(2);
  });
});
