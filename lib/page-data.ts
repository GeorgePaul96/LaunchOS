import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export async function getOrgContextOrRedirect() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySession(token, sessionSecret()) : null;
  if (!payload) redirect("/login");
  return { db, orgId: payload.orgId, userId: payload.userId };
}
