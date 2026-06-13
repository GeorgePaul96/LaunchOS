import { and, eq, lte } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { allocate, type AttributionModel, type Touch } from "./models";

export interface ChannelRollup {
  channel: string;
  creditedValueCents: number;
  conversions: number;
}

export interface AttributionReport {
  model: AttributionModel;
  totalConversionValueCents: number;
  totalConversions: number;
  channels: ChannelRollup[];
}

export async function buildReport(db: DB, orgId: string, model: AttributionModel): Promise<AttributionReport> {
  const conversions = await db.select().from(schema.conversions).where(eq(schema.conversions.orgId, orgId));
  const channelMap = new Map<string, ChannelRollup>();
  let totalValue = 0;

  // clear prior persisted results for this org+model (idempotent recompute)
  await db.delete(schema.attributionResults).where(and(eq(schema.attributionResults.orgId, orgId), eq(schema.attributionResults.model, model)));

  for (const conv of conversions) {
    totalValue += conv.valueCents;
    if (!conv.identityId) continue;
    const prior = await db.select().from(schema.touchpoints).where(
      and(
        eq(schema.touchpoints.orgId, orgId),
        eq(schema.touchpoints.identityId, conv.identityId),
        lte(schema.touchpoints.occurredAt, conv.occurredAt),
      ),
    );
    const touches: Touch[] = prior.map(t => ({ touchpointId: t.id, channel: t.channel, occurredAt: t.occurredAt }));
    const allocations = allocate(model, touches, conv.valueCents);
    const channelOf = new Map(prior.map(t => [t.id, t.channel]));

    for (const a of allocations) {
      const channel = channelOf.get(a.touchpointId) ?? "unknown";
      await db.insert(schema.attributionResults).values({
        orgId,
        conversionId: conv.id,
        model,
        touchpointId: a.touchpointId,
        credit: Math.round(a.credit * 10000), // basis points
        creditedValueCents: a.creditedValueCents,
      });
      const roll = channelMap.get(channel) ?? { channel, creditedValueCents: 0, conversions: 0 };
      roll.creditedValueCents += a.creditedValueCents;
      roll.conversions += 1;
      channelMap.set(channel, roll);
    }
  }

  return {
    model,
    totalConversionValueCents: totalValue,
    totalConversions: conversions.length,
    channels: [...channelMap.values()].sort((a, b) => b.creditedValueCents - a.creditedValueCents),
  };
}
