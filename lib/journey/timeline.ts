import { and, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";

export interface TimelineEvent {
  kind: "touchpoint" | "conversion";
  occurredAt: string;
  channel?: string;
  platform?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  eventName?: string;
  valueCents?: number;
}

export async function contactTimeline(db: DB, orgId: string, contactId: string): Promise<TimelineEvent[]> {
  const ids = await db.select().from(schema.identities)
    .where(and(eq(schema.identities.orgId, orgId), eq(schema.identities.contactId, contactId)));
  if (ids.length === 0) return [];

  const events: TimelineEvent[] = [];
  for (const identity of ids) {
    const tps = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identity.id));
    for (const t of tps) {
      events.push({
        kind: "touchpoint", occurredAt: t.occurredAt, channel: t.channel,
        platform: t.platform, sourceType: t.sourceType, sourceId: t.sourceId,
      });
    }
    const convs = await db.select().from(schema.conversions).where(eq(schema.conversions.identityId, identity.id));
    for (const c of convs) {
      events.push({ kind: "conversion", occurredAt: c.occurredAt, eventName: c.eventName, valueCents: c.valueCents });
    }
  }
  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
