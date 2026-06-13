import { cookies } from "next/headers";
import { db } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export interface RequestContext { db: typeof db; orgId: string; userId: string; }

export async function requireContext(): Promise<RequestContext> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "unauthorized", "No session");
  const payload = verifySession(token, sessionSecret());
  if (!payload) throw new ApiError(401, "unauthorized", "Invalid session");
  return { db, orgId: payload.orgId, userId: payload.userId };
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
