import { and, asc, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { uuid, publicId } from "@/lib/ids";

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

export interface StitchInput {
  identityId: string;
  email?: string | null;
  contactId?: string | null;
  traits?: Record<string, unknown>;
}

// Link an identity to a contact (found/created by email or contactId), merge traits,
// and set contacts.identityId if it was null. Returns the contactId (null = no-op).
export async function stitchContact(db: DB, orgId: string, input: StitchInput): Promise<string | null> {
  let contactId: string | null = null;

  if (input.contactId) {
    const [c] = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, input.contactId), eq(schema.contacts.orgId, orgId)));
    if (c) contactId = c.id;
  }

  if (!contactId && input.email) {
    const email = input.email.trim().toLowerCase();
    const matches = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.email, email)))
      .orderBy(asc(schema.contacts.createdAt));
    if (matches.length) {
      contactId = matches[0].id;
    } else {
      contactId = uuid();
      await db.insert(schema.contacts).values({
        id: contactId, publicId: publicId("contact"), orgId,
        name: (input.traits?.name as string | undefined) ?? null,
        email, lifecycleStage: "lead",
      });
    }
  }

  if (!contactId) return null;

  const [identity] = await db.select().from(schema.identities)
    .where(and(eq(schema.identities.id, input.identityId), eq(schema.identities.orgId, orgId)));
  const patch: Record<string, unknown> = { contactId };
  if (input.traits && Object.keys(input.traits).length) {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(identity?.traits || "{}"); } catch { existing = {}; }
    patch.traits = JSON.stringify({ ...existing, ...input.traits });
  }
  await db.update(schema.identities).set(patch)
    .where(and(eq(schema.identities.id, input.identityId), eq(schema.identities.orgId, orgId)));

  const [contact] = await db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)));
  if (contact && !contact.identityId) {
    await db.update(schema.contacts).set({ identityId: input.identityId })
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)));
  }
  return contactId;
}
