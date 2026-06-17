import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { listGenerations } from "@/lib/viral/service";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listGenerations(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}
