import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { contactTimeline } from "@/lib/journey/timeline";

export async function GET(_req: Request, { params }: { params: Promise<{ cid: string }> }) {
  try {
    const ctx = await requireContext();
    const { cid } = await params;
    const data = await ctx.withOrg((db) => contactTimeline(db, ctx.orgId, cid));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}
