import { cookies, headers } from "next/headers";
import { db, withOrg as withOrgScoped, type DB } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";
import { resolveApiKeyOrg } from "@/lib/apikey";

export interface RequestContext {
  orgId: string;
  userId: string;
  withOrg: <T>(fn: (db: DB) => Promise<T>) => Promise<T>;
}

function contextFor(orgId: string, userId: string): RequestContext {
  return { orgId, userId, withOrg: (fn) => withOrgScoped(orgId, fn) };
}

export async function requireContext(): Promise<RequestContext> {
  // 1. API key (Authorization: Bearer sk_...)
  const h = await headers();
  const auth = h.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const ctx = await resolveApiKeyOrg(db, auth.slice(7).trim());
    if (!ctx) throw new ApiError(401, "unauthorized", "Invalid API key");
    return contextFor(ctx.orgId, ctx.userId);
  }
  // 2. Session cookie
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "unauthorized", "No session");
  const payload = verifySession(token, sessionSecret());
  if (!payload) throw new ApiError(401, "unauthorized", "Invalid session");
  return contextFor(payload.orgId, payload.userId);
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
