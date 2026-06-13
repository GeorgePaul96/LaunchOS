import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, seedAccount, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { createPost, publishTarget, rollupPostStatus, retryTarget } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("publishing service", () => {
  it("createPost writes a post and one target per account", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc1 = await seedAccount(db, orgId, profileId, "twitter");
    const acc2 = await seedAccount(db, orgId, profileId, "linkedin");
    const post = await createPost(db as any, orgId, {
      profileId, content: "Launch day!", accountIds: [acc1, acc2],
    });
    expect(post.status).toBe("scheduled");
    const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    expect(targets).toHaveLength(2);
    expect(targets.every(t => t.status === "pending")).toBe(true);
  });

  it("publishTarget marks a target published via the provider", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const post = await createPost(db as any, orgId, { profileId, content: "hi", accountIds: [acc] });
    const [t] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    await publishTarget(db as any, t.id, new MockChannelProvider());
    const [updated] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, t.id));
    expect(updated.status).toBe("published");
    expect(updated.platformPostId).toBeTruthy();
    expect(updated.attempts).toBe(1);
  });

  it("rolls up to partial when one target fails", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const good = await seedAccount(db, orgId, profileId, "twitter");
    const bad = await seedAccount(db, orgId, profileId, "linkedin");
    const post = await createPost(db as any, orgId, { profileId, content: "hi", accountIds: [good, bad] });
    const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    const badAccount = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, bad));
    const provider = new MockChannelProvider({ failAccounts: [badAccount[0].platformUserId] });
    for (const t of targets) await publishTarget(db as any, t.id, provider);
    const status = await rollupPostStatus(db as any, post.id);
    expect(status).toBe("partial");
  });

  it("retryTarget re-attempts a failed target and can succeed", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const post = await createPost(db as any, orgId, { profileId, content: "hi", accountIds: [acc] });
    const [t] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    const account = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acc));
    // first attempt fails
    await publishTarget(db as any, t.id, new MockChannelProvider({ failAccounts: [account[0].platformUserId] }));
    let [after] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, t.id));
    expect(after.status).toBe("failed");
    // retry with a working provider succeeds
    await retryTarget(db as any, orgId, t.id, new MockChannelProvider());
    [after] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, t.id));
    expect(after.status).toBe("published");
    expect(after.attempts).toBe(2);
  });
});
