import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { chooseVariant } from "@/lib/viral/service";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const variant = await ctx.withOrg((db) => chooseVariant(db, ctx.orgId, id));
    return ok({ variant });
  } catch (e) { return toProblemResponse(e); }
}
