import { listAccounts } from "@/lib/org-context";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";

export async function GET() {
  try {
    const { db, orgId } = await requireContext();
    return ok({ data: await listAccounts(db, orgId) });
  } catch (e) { return toProblemResponse(e); }
}
