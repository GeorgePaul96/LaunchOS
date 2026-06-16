import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { recordConversion } from "@/lib/attribution/ingest";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.identityId || !body.eventName) throw new ApiError(400, "invalid_request", "identityId and eventName required");
    const id = await ctx.withOrg((db) => recordConversion(db, ctx.orgId, body));
    return ok({ conversion_id: id }, 201);
  } catch (e) { return toProblemResponse(e); }
}
