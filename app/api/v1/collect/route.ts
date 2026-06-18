import { db, withOrg } from "@/db/client";
import { ApiError, toProblemResponse } from "@/lib/errors";
import { assertRateLimit } from "@/lib/ratelimit";
import { resolveWriteKeyOrg } from "@/lib/apikey";
import { collectEvent, parseCollectBody } from "@/lib/attribution/collect";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export function withCors(res: Response): Response {
  const next = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) next.headers.set(k, v);
  return next;
}

export async function OPTIONS(): Promise<Response> {
  return withCors(new Response(null, { status: 204 }));
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local").trim();
    const raw = await req.text();
    const payload = parseCollectBody(raw);
    const writeKey = payload.writeKey ?? "";
    // Throttle per write key + IP before doing any DB work.
    assertRateLimit(`collect:${writeKey}:${ip}`, 120, 60_000);
    const orgId = await resolveWriteKeyOrg(db, writeKey);
    if (!orgId) throw new ApiError(401, "invalid_write_key", "Unknown or missing write key");
    const result = await withOrg(orgId, (sdb) => collectEvent(sdb, orgId, payload));
    return withCors(new Response(JSON.stringify({ ok: true, identityId: result.identityId }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  } catch (e) {
    return withCors(toProblemResponse(e));
  }
}
