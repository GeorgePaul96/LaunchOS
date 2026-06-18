import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { campaignResults } from "@/lib/campaign/service";
import type { AttributionModel } from "@/lib/attribution/models";

const MODELS = ["first_touch", "last_touch", "linear"];

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const model = (new URL(req.url).searchParams.get("model") ?? "linear") as AttributionModel;
    if (!MODELS.includes(model)) throw new ApiError(400, "invalid_request", `model must be one of ${MODELS.join(", ")}`);
    const report = await ctx.withOrg((db) => campaignResults(db, ctx.orgId, id, model));
    return ok(report);
  } catch (e) { return toProblemResponse(e); }
}
