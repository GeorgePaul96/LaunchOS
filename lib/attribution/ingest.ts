import type { DB } from "@/db/client";
import { schema } from "@/db/client";

export interface TouchpointInput {
  identityId: string;
  channel: string;
  platform?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  campaignId?: string | null;
  utm?: Record<string, unknown>;
  occurredAt?: string;
}

export async function recordTouchpoint(db: DB, orgId: string, input: TouchpointInput): Promise<number> {
  const [row] = await db.insert(schema.touchpoints).values({
    orgId,
    identityId: input.identityId,
    channel: input.channel,
    platform: input.platform ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    campaignId: input.campaignId ?? null,
    utm: JSON.stringify(input.utm ?? {}),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  }).returning({ id: schema.touchpoints.id });
  return row.id;
}

export interface ConversionInput {
  identityId: string;
  eventName: string;
  valueCents?: number;
  currency?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export async function recordConversion(db: DB, orgId: string, input: ConversionInput): Promise<number> {
  const [row] = await db.insert(schema.conversions).values({
    orgId,
    identityId: input.identityId,
    eventName: input.eventName,
    valueCents: input.valueCents ?? 0,
    currency: input.currency ?? "USD",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    metadata: JSON.stringify(input.metadata ?? {}),
  }).returning({ id: schema.conversions.id });
  return row.id;
}
