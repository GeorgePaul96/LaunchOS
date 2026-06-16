import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { buildReport } from "@/lib/attribution/report";
import type { AttributionModel } from "@/lib/attribution/models";

const MODELS = ["first_touch", "last_touch", "linear"];

export async function GET(req: Request) {
  try {
    const ctx = await requireContext();
    const model = (new URL(req.url).searchParams.get("model") ?? "linear") as AttributionModel;
    if (!MODELS.includes(model)) throw new ApiError(400, "invalid_request", `model must be one of ${MODELS.join(", ")}`);
    const report = await ctx.withOrg((db) => buildReport(db, ctx.orgId, model));
    return ok(report);
  } catch (e) { return toProblemResponse(e); }
}
