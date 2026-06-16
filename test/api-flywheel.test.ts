import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, seedAccount, type TestDB } from "./helpers";
import { createPost, publishTarget, rollupPostStatus } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";
import { buildReport } from "@/lib/attribution/report";
import { runWorkerOnce } from "@/lib/jobs/worker";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("flywheel end-to-end", () => {
  it("compose -> publish -> touchpoint -> conversion -> attribution reconciles", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");

    // compose + publish
    const post = await createPost(db as any, orgId, { profileId, content: "Launch!", accountIds: [acc] });
    const [target] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    await publishTarget(db as any, target.id, new MockChannelProvider());
    expect(await rollupPostStatus(db as any, post.id)).toBe("published");

    // a visitor sees the post, then converts
    const identityId = await identify(db as any, orgId, { anonymousId: "visitor-1" });
    await recordTouchpoint(db as any, orgId, {
      identityId, channel: "organic_social", platform: "twitter",
      sourceType: "post", sourceId: post.id, occurredAt: "2026-06-10T00:00:00Z",
    });
    await recordConversion(db as any, orgId, {
      identityId, eventName: "purchase", valueCents: 5000, occurredAt: "2026-06-11T00:00:00Z",
    });

    const report = await buildReport(db as any, orgId, "linear");
    expect(report.totalConversionValueCents).toBe(5000);
    expect(report.channels.find(c => c.channel === "organic_social")?.creditedValueCents).toBe(5000);
  });

  it("createPost enqueues a publish_post job that the worker publishes", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const post = await createPost(db as any, orgId, { profileId, content: "Queued!", accountIds: [acc] });

    // a publish_post job exists and the post is not yet published
    const jobsBefore = await db.select().from(schema.jobs);
    expect(jobsBefore.some((j) => j.type === "publish_post")).toBe(true);

    // worker drains it → targets published, post rolled up
    const { processed } = await runWorkerOnce(db as any, 10);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [updated] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(updated.status).toBe("published");
  });
});
