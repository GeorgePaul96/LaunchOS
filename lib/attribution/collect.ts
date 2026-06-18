import { and, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { identify, stitchContact } from "./identity";
import { recordTouchpoint, recordConversion } from "./ingest";

export type CollectType = "page" | "track" | "identify";

export interface CollectPayload {
  writeKey?: string;
  anonymousId?: string;
  type?: string;
  // page
  url?: string;
  referrer?: string;
  utm?: Record<string, unknown>;
  campaignId?: string;
  // track
  event?: string;
  valueCents?: number;
  metadata?: Record<string, unknown>;
  // identify
  email?: string;
  contactId?: string;
  traits?: Record<string, unknown>;
}

// Tolerant body parse: JSON for both application/json and text/plain (sendBeacon) bodies.
export function parseCollectBody(raw: string): CollectPayload {
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === "object") ? (v as CollectPayload) : {};
  } catch {
    return {};
  }
}

async function resolveCampaignId(db: DB, orgId: string, campaignId?: string): Promise<string | null> {
  if (!campaignId) return null;
  const [c] = await db.select().from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)));
  return c?.id ?? null;
}

// Assumes an org-scoped db. Identifies the visitor by anonymousId then dispatches the event.
export async function collectEvent(db: DB, orgId: string, payload: CollectPayload): Promise<{ identityId: string }> {
  if (!payload.anonymousId) throw new ApiError(400, "invalid_request", "anonymousId required");
  const type = payload.type;
  if (type !== "page" && type !== "track" && type !== "identify") {
    throw new ApiError(400, "invalid_request", "type must be page, track, or identify");
  }

  const identityId = await identify(db, orgId, { anonymousId: payload.anonymousId });

  if (type === "page") {
    const campaignId = await resolveCampaignId(db, orgId, payload.campaignId);
    const utm = { ...(payload.utm ?? {}), ...(payload.referrer ? { referrer: payload.referrer } : {}) };
    await recordTouchpoint(db, orgId, {
      identityId, channel: "web", platform: null, sourceType: "pixel",
      sourceId: payload.url ?? null, campaignId, utm,
    });
  } else if (type === "track") {
    if (!payload.event) throw new ApiError(400, "invalid_request", "event required for track");
    await recordConversion(db, orgId, {
      identityId, eventName: payload.event, valueCents: payload.valueCents, metadata: payload.metadata,
    });
  } else {
    await stitchContact(db, orgId, { identityId, email: payload.email, contactId: payload.contactId, traits: payload.traits });
  }

  return { identityId };
}
