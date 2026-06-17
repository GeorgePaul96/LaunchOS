import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { recordAudit } from "@/lib/audit";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("recordAudit", () => {
  it("writes one audit row scoped to the org", async () => {
    const { orgId } = await seedOrg(db);
    await recordAudit(db as any, {
      orgId, actorType: "user", actorId: "u1", action: "post.create",
      targetType: "post", targetId: "post_1", metadata: { n: 2 },
    });
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("post.create");
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].targetId).toBe("post_1");
    expect(rows[0].metadata).toEqual({ n: 2 });
  });
});
