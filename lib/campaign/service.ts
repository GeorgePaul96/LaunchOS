import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { uuid, publicId } from "@/lib/ids";

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
