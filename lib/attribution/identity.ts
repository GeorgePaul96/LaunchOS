import { and, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { uuid } from "@/lib/ids";

export interface IdentifyInput {
  anonymousId: string;
  contactId?: string | null;
  externalUserId?: string | null;
  traits?: Record<string, unknown>;
}

export async function resolveIdentity(db: DB, orgId: string, anonymousId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(schema.identities)
    .where(and(eq(schema.identities.orgId, orgId), eq(schema.identities.anonymousId, anonymousId)));
  return row?.id ?? null;
}

// Find-or-create by anonymous id, then merge any newly-known contact/external links.
export async function identify(db: DB, orgId: string, input: IdentifyInput): Promise<string> {
  const existing = await resolveIdentity(db, orgId, input.anonymousId);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (input.contactId) patch.contactId = input.contactId;
    if (input.externalUserId) patch.externalUserId = input.externalUserId;
    if (input.traits) patch.traits = JSON.stringify(input.traits);
    if (Object.keys(patch).length) {
      await db.update(schema.identities).set(patch).where(eq(schema.identities.id, existing));
    }
    return existing;
  }
  const id = uuid();
  await db.insert(schema.identities).values({
    id,
    orgId,
    anonymousId: input.anonymousId,
    contactId: input.contactId ?? null,
    externalUserId: input.externalUserId ?? null,
    traits: JSON.stringify(input.traits ?? {}),
  });
  return id;
}
