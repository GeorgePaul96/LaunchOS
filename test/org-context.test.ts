import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import { listAccounts } from "@/lib/org-context";
import { uuid, publicId } from "@/lib/ids";
import { generateWriteKey } from "@/lib/auth";
import * as schema from "@/db/schema";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("org-context", () => {
  it("listAccounts only returns rows for the given org", async () => {
    const a = await seedOrg(db);
    // a second org with its own account
    const orgB = uuid(), profB = uuid();
    await db.insert(schema.organizations).values({ id: orgB, publicId: publicId("org"), name: "B", slug: "b-" + orgB.slice(0, 8), writeKey: generateWriteKey() });
    await db.insert(schema.profiles).values({ id: profB, publicId: publicId("prof"), orgId: orgB, name: "B brand" });
    await db.insert(schema.socialAccounts).values({ id: uuid(), publicId: publicId("acc"), orgId: orgB, profileId: profB, platform: "twitter", platformUserId: "x" });
    // org A account
    await db.insert(schema.socialAccounts).values({ id: uuid(), publicId: publicId("acc"), orgId: a.orgId, profileId: a.profileId, platform: "twitter", platformUserId: "y" });

    const rows = await listAccounts(db, a.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(a.orgId);
  });
});
