import { cookies } from "next/headers";
import { withOrg as withOrgScoped, type DB } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export interface RequestContext {
  orgId: string;
  userId: string;
  withOrg: <T>(fn: (db: DB) => Promise<T>) => Promise<T>;
}

export async function requireContext(): Promise<RequestContext> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "unauthorized", "No session");
  const payload = verifySession(token, sessionSecret());
  if (!payload) throw new ApiError(401, "unauthorized", "Invalid session");
  const orgId = payload.orgId;
  return { orgId, userId: payload.userId, withOrg: (fn) => withOrgScoped(orgId, fn) };
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
