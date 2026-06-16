import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { hashApiKey } from "@/lib/auth";

export interface ApiKeyContext {
  orgId: string;
  userId: string;
}

// Resolve a Bearer secret to its org via the service-role db (keys are pre-org-context).
export async function resolveApiKeyOrg(db: DB, secret: string): Promise<ApiKeyContext | null> {
  if (!secret.startsWith("sk_")) return null;
  const hash = hashApiKey(secret);
  const [row] = await db.select().from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.keyHash, hash), isNull(schema.apiKeys.revokedAt)));
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
  // best-effort touch of last_used_at
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, row.id));
  return { orgId: row.orgId, userId: row.createdBy ?? "" };
}
