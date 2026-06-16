import { listAccounts } from "@/lib/org-context";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listAccounts(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}
