import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { planCampaign } from "@/lib/campaign/service";
import { recordAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const out = await ctx.withOrg(async (db) => {
      const result = await planCampaign(db, ctx.orgId, id, { horizonDays: body.horizonDays });
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "campaign.plan", targetType: "campaign", targetId: result.campaign.publicId });
      return result;
    });
    return ok(out);
  } catch (e) { return toProblemResponse(e); }
}
