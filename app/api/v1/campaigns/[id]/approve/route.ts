import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { approveCampaign } from "@/lib/campaign/service";
import { recordAudit } from "@/lib/audit";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const out = await ctx.withOrg(async (db) => {
      const result = await approveCampaign(db, ctx.orgId, id);
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "campaign.approve", targetType: "campaign", targetId: result.campaign.publicId });
      return result;
    });
    return ok(out);
  } catch (e) { return toProblemResponse(e); }
}
