import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { identify } from "@/lib/attribution/identity";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.anonymousId) throw new ApiError(400, "invalid_request", "anonymousId required");
    const id = await ctx.withOrg((db) => identify(db, ctx.orgId, body));
    return ok({ identity_id: id });
  } catch (e) { return toProblemResponse(e); }
}
