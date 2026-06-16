import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { recordTouchpoint } from "@/lib/attribution/ingest";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.identityId || !body.channel) throw new ApiError(400, "invalid_request", "identityId and channel required");
    const id = await ctx.withOrg((db) => recordTouchpoint(db, ctx.orgId, body));
    return ok({ touchpoint_id: id }, 201);
  } catch (e) { return toProblemResponse(e); }
}
