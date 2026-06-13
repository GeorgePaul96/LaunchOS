import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { contactTimeline } from "@/lib/journey/timeline";

export async function GET(_req: Request, { params }: { params: Promise<{ cid: string }> }) {
  try {
    const { db, orgId } = await requireContext();
    const { cid } = await params;
    return ok({ data: await contactTimeline(db, orgId, cid) });
  } catch (e) { return toProblemResponse(e); }
}
