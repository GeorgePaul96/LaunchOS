import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { createCampaign, listCampaigns } from "@/lib/campaign/service";
import { recordAudit } from "@/lib/audit";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listCampaigns(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json().catch(() => ({}));
    if (!body.profileId || !body.name || !body.objective || !Array.isArray(body.accountIds)) {
      throw new ApiError(400, "invalid_request", "profileId, name, objective and accountIds[] are required");
    }
    const campaign = await ctx.withOrg(async (db) => {
      const c = await createCampaign(db, ctx.orgId, {
        profileId: body.profileId, name: body.name, objective: body.objective,
        goalMetric: body.goalMetric ?? null, goalTarget: body.goalTarget ?? null,
        budgetCents: body.budgetCents ?? null, accountIds: body.accountIds,
      });
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "campaign.create", targetType: "campaign", targetId: c.publicId });
      return c;
    });
    return ok({ campaign }, 201);
  } catch (e) { return toProblemResponse(e); }
}
