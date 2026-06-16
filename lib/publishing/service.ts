import { eq, and, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { uuid, publicId } from "@/lib/ids";
import { ApiError } from "@/lib/errors";
import { assertSameOrg } from "@/lib/org-context";
import type { ChannelProvider } from "@/lib/channel/provider";
import { MockChannelProvider } from "@/lib/channel/mock";
import { enqueue } from "@/lib/jobs/queue";

export interface CreatePostInput {
  profileId: string;
  content: string;
  accountIds: string[];
  scheduledFor?: string | null;
  campaignId?: string | null;
  overrides?: Record<string, string>; // accountId -> content override
}

export async function createPost(db: DB, orgId: string, input: CreatePostInput) {
  if (input.accountIds.length === 0) {
    throw new ApiError(400, "invalid_request", "At least one target account is required");
  }
  const accounts = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.orgId, orgId), inArray(schema.socialAccounts.id, input.accountIds)));
  if (accounts.length !== input.accountIds.length) {
    throw new ApiError(404, "not_found", "One or more accounts not found in this org");
  }

  const postId = uuid();
  const post = {
    id: postId,
    publicId: publicId("post"),
    orgId,
    profileId: input.profileId,
    content: input.content,
    mediaIds: "[]",
    status: "scheduled",
    scheduledFor: input.scheduledFor ?? new Date().toISOString(),
    publishNow: !input.scheduledFor,
    origin: "manual",
    campaignId: input.campaignId ?? null,
  };
  await db.insert(schema.posts).values(post);

  for (const acc of accounts) {
    await db.insert(schema.postTargets).values({
      id: uuid(),
      postId,
      orgId,
      accountId: acc.id,
      platform: acc.platform,
      contentOverride: input.overrides?.[acc.id] ?? null,
      status: "pending",
    });
  }
  await enqueue(db, { type: "publish_post", orgId, payload: { postId } });
  return post;
}

export async function publishTarget(db: DB, targetId: string, provider: ChannelProvider) {
  const [target] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, targetId));
  if (!target) throw new ApiError(404, "not_found", "Target not found");
  const [account] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, target.accountId));

  await db.update(schema.postTargets).set({ status: "publishing", attempts: target.attempts + 1 }).where(eq(schema.postTargets.id, targetId));
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, target.postId));

  const result = await provider.publish({
    platform: target.platform,
    accountPlatformUserId: account.platformUserId,
    content: target.contentOverride ?? post.content ?? "",
    options: JSON.parse(target.options),
  });

  if (result.ok) {
    await db.update(schema.postTargets).set({
      status: "published",
      platformPostId: result.platformPostId,
      permalink: result.permalink,
      publishedAt: new Date().toISOString(),
      errorCode: null,
      errorDetail: null,
    }).where(eq(schema.postTargets.id, targetId));
  } else {
    await db.update(schema.postTargets).set({
      status: "failed",
      errorCode: result.errorCode,
      errorDetail: result.errorDetail,
    }).where(eq(schema.postTargets.id, targetId));
  }
  await rollupPostStatus(db, target.postId);
  return result;
}

export async function rollupPostStatus(db: DB, postId: string): Promise<string> {
  const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId));
  const statuses = targets.map(t => t.status);
  let status = "scheduled";
  if (statuses.every(s => s === "published")) status = "published";
  else if (statuses.some(s => s === "published") && statuses.some(s => s === "failed")) status = "partial";
  else if (statuses.every(s => s === "failed")) status = "failed";
  else if (statuses.some(s => s === "publishing" || s === "published")) status = "publishing";
  await db.update(schema.posts).set({ status, updatedAt: new Date().toISOString() }).where(eq(schema.posts.id, postId));
  return status;
}

export async function retryTarget(db: DB, orgId: string, targetId: string, provider: ChannelProvider) {
  const [target] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, targetId));
  if (!target) throw new ApiError(404, "not_found", "Target not found");
  assertSameOrg(orgId, target.orgId);
  return publishTarget(db, targetId, provider);
}

export async function listPosts(db: DB, orgId: string) {
  const rows = await db.select().from(schema.posts).where(eq(schema.posts.orgId, orgId));
  const result = [];
  for (const p of rows) {
    const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, p.id));
    result.push({ ...p, targets });
  }
  return result;
}

// Publishes all still-pending targets of a post (the publish_post job handler). Idempotent:
// only touches pending targets, so a retry after a partial success won't double-publish.
export async function publishPost(db: DB, postId: string, provider: ChannelProvider = new MockChannelProvider()) {
  const targets = await db.select().from(schema.postTargets)
    .where(and(eq(schema.postTargets.postId, postId), eq(schema.postTargets.status, "pending")));
  for (const t of targets) {
    await publishTarget(db, t.id, provider);
  }
  await rollupPostStatus(db, postId);
}
