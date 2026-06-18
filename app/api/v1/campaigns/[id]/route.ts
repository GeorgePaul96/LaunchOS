import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { getCampaign } from "@/lib/campaign/service";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const data = await ctx.withOrg((db) => getCampaign(db, ctx.orgId, id));
    return ok(data);
  } catch (e) { return toProblemResponse(e); }
}
