import { eq, and } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";

// Central place that enforces tenant isolation (RLS substitute, spec §9).
export async function listAccounts(db: DB, orgId: string) {
  return db
    .select()
    .from(schema.socialAccounts)
    .where(eq(schema.socialAccounts.orgId, orgId));
}

// Guard used by services: throws 404 (not 403) on cross-org access — no leakage.
export function assertSameOrg(orgId: string, rowOrgId: string | undefined | null): void {
  if (!rowOrgId || rowOrgId !== orgId) {
    throw new ApiError(404, "not_found", "Resource not found");
  }
}

export { eq, and };
