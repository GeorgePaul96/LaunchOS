import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { uuid, publicId } from "@/lib/ids";
import { run as runAI } from "@/lib/ai/gateway";
import type { AIProvider } from "@/lib/ai/provider";
import { buildPlanPrompt, type BrandVoice, type PlanChannel } from "./prompt";
import { createDraftPost } from "@/lib/publishing/service";

export interface CreateCampaignInput {
  profileId: string;
  name: string;
  objective: string;
  goalMetric?: string | null;
  goalTarget?: number | null;
  budgetCents?: number | null;
  accountIds: string[];
}

export interface ChannelMix { platform: string; budgetCents: number; share: number; }

export function channelMixOf(assets: { platform: string; budgetCents: number }[]): ChannelMix[] {
  const map = new Map<string, number>();
  for (const a of assets) map.set(a.platform, (map.get(a.platform) ?? 0) + a.budgetCents);
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  return [...map.entries()].map(([platform, budgetCents]) => ({
    platform, budgetCents, share: total > 0 ? Math.round((budgetCents / total) * 100) : 0,
  }));
}

export async function createCampaign(db: DB, orgId: string, input: CreateCampaignInput) {
  const [profile] = await db.select().from(schema.profiles)
    .where(and(eq(schema.profiles.id, input.profileId), eq(schema.profiles.orgId, orgId)));
  if (!profile) throw new ApiError(404, "profile_not_found", `No profile ${input.profileId}`);
  if (!input.accountIds || input.accountIds.length === 0) {
    throw new ApiError(400, "invalid_request", "At least one target account is required");
  }
  const accounts = await db.select().from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.orgId, orgId), inArray(schema.socialAccounts.id, input.accountIds)));
  if (accounts.length !== input.accountIds.length) {
    throw new ApiError(404, "not_found", "One or more accounts not found in this org");
  }

  const [campaign] = await db.insert(schema.campaigns).values({
    id: uuid(), publicId: publicId("camp"), orgId, profileId: input.profileId,
    name: input.name, objective: input.objective,
    goalMetric: input.goalMetric ?? null, goalTarget: input.goalTarget ?? null,
    budgetCents: input.budgetCents ?? null, status: "planning",
    accountIds: JSON.stringify(input.accountIds),
  }).returning();
  return campaign;
}

export async function listCampaigns(db: DB, orgId: string) {
  return db.select().from(schema.campaigns)
    .where(eq(schema.campaigns.orgId, orgId))
    .orderBy(desc(schema.campaigns.createdAt), desc(schema.campaigns.id));
}

export async function getCampaign(db: DB, orgId: string, campaignId: string) {
  const [campaign] = await db.select().from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)));
  if (!campaign) throw new ApiError(404, "campaign_not_found", `No campaign ${campaignId}`);
  const assets = await db.select().from(schema.campaignAssets)
    .where(and(eq(schema.campaignAssets.orgId, orgId), eq(schema.campaignAssets.campaignId, campaignId)))
    .orderBy(asc(schema.campaignAssets.dayOffset), asc(schema.campaignAssets.createdAt));
  return { campaign, assets, channelMix: channelMixOf(assets) };
}

const clampNonNeg = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export interface PlanOptions { horizonDays?: number; provider?: AIProvider; }

export async function planCampaign(db: DB, orgId: string, campaignId: string, opts: PlanOptions = {}) {
  const [campaign] = await db.select().from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)));
  if (!campaign) throw new ApiError(404, "campaign_not_found", `No campaign ${campaignId}`);
  if (campaign.status !== "planning") {
    throw new ApiError(400, "invalid_state", `Campaign is ${campaign.status}; can only plan while planning`);
  }

  let accountIds: string[] = [];
  try { accountIds = JSON.parse(campaign.accountIds || "[]"); } catch { accountIds = []; }
  const accounts = accountIds.length
    ? await db.select().from(schema.socialAccounts)
        .where(and(eq(schema.socialAccounts.orgId, orgId), inArray(schema.socialAccounts.id, accountIds)))
    : [];
  const channels: PlanChannel[] = accounts.map((a) => ({ accountId: a.id, platform: a.platform }));
  if (channels.length === 0) throw new ApiError(400, "invalid_request", "Campaign has no resolvable target channels");

  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, campaign.profileId));
  let brandVoice: BrandVoice = {};
  try { brandVoice = JSON.parse(profile?.brandVoice || "{}"); } catch { brandVoice = {}; }

  const { system, messages, jsonSchema } = buildPlanPrompt({
    objective: campaign.objective, goalMetric: campaign.goalMetric, goalTarget: campaign.goalTarget,
    budgetCents: campaign.budgetCents, channels, brandVoice, horizonDays: opts.horizonDays ?? 14,
  });

  const result = await runAI(db, {
    orgId, feature: "campaign_brain", task: "plan", system, messages, jsonSchema, provider: opts.provider,
  });
  const parsed = result.json as {
    goalMetric?: string; goalTarget?: unknown;
    assets?: { platform?: string; dayOffset?: unknown; draftBody?: string; rationale?: string; expectedOutcome?: string; budgetCents?: unknown }[];
  } | undefined;
  if (!parsed || !Array.isArray(parsed.assets) || parsed.assets.length === 0) {
    throw new ApiError(502, "ai_invalid_output", "Model did not return any assets");
  }

  // Replace prior un-materialized assets; keep ones already turned into posts.
  const existing = await db.select().from(schema.campaignAssets)
    .where(and(eq(schema.campaignAssets.orgId, orgId), eq(schema.campaignAssets.campaignId, campaignId)));
  const toDelete = existing.filter((a) => !a.postId).map((a) => a.id);
  if (toDelete.length) {
    await db.delete(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.orgId, orgId), inArray(schema.campaignAssets.id, toDelete)));
  }

  const platformToAccount = new Map<string, string>();
  for (const c of channels) if (!platformToAccount.has(c.platform)) platformToAccount.set(c.platform, c.accountId);

  const rows = parsed.assets.map((a) => ({
    id: uuid(), publicId: publicId("casset"), campaignId, orgId,
    accountId: platformToAccount.get(String(a.platform)) ?? null,
    platform: String(a.platform), dayOffset: clampNonNeg(a.dayOffset),
    draftBody: String(a.draftBody ?? ""), rationale: String(a.rationale ?? ""),
    expectedOutcome: String(a.expectedOutcome ?? ""), budgetCents: clampNonNeg(a.budgetCents),
  }));
  const assets = await db.insert(schema.campaignAssets).values(rows).returning();

  const totalAssetBudget = rows.reduce((s, r) => s + r.budgetCents, 0);
  const [updated] = await db.update(schema.campaigns).set({
    aiJobId: result.jobId,
    goalMetric: parsed.goalMetric ? String(parsed.goalMetric) : campaign.goalMetric,
    goalTarget: Number.isFinite(Number(parsed.goalTarget)) ? Math.round(Number(parsed.goalTarget)) : campaign.goalTarget,
    budgetCents: campaign.budgetCents ?? totalAssetBudget,
  }).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId))).returning();

  return { campaign: updated, assets };
}

export async function approveCampaign(db: DB, orgId: string, campaignId: string) {
  const [campaign] = await db.select().from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)));
  if (!campaign) throw new ApiError(404, "campaign_not_found", `No campaign ${campaignId}`);
  if (campaign.status !== "planning") {
    throw new ApiError(400, "invalid_state", `Campaign is ${campaign.status}; can only approve while planning`);
  }

  const assets = await db.select().from(schema.campaignAssets)
    .where(and(eq(schema.campaignAssets.orgId, orgId), eq(schema.campaignAssets.campaignId, campaignId)));
  const materializable = assets.filter((a) => a.accountId && !a.postId);
  if (materializable.length === 0) {
    throw new ApiError(400, "invalid_request", "No assets with a matched channel to materialize");
  }

  const launch = Date.now();
  const posts = [];
  for (const asset of materializable) {
    const scheduledFor = new Date(launch + asset.dayOffset * 86400000).toISOString();
    const post = await createDraftPost(db, orgId, {
      profileId: campaign.profileId, content: asset.draftBody, accountId: asset.accountId!,
      scheduledFor, campaignId, origin: "campaign", originRef: asset.publicId,
    });
    await db.update(schema.campaignAssets).set({ postId: post.id })
      .where(and(eq(schema.campaignAssets.id, asset.id), eq(schema.campaignAssets.orgId, orgId)));
    posts.push(post);
  }

  const [updatedCampaign] = await db.update(schema.campaigns).set({ status: "active" })
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId))).returning();
  return { campaign: updatedCampaign, posts };
}
