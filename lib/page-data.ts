import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withOrg as withOrgScoped, type DB } from "@/db/client";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export async function getOrgContextOrRedirect() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySession(token, sessionSecret()) : null;
  if (!payload) redirect("/login");
  const orgId = payload.orgId;
  return {
    orgId,
    userId: payload.userId,
    withOrg: <T,>(fn: (db: DB) => Promise<T>) => withOrgScoped(orgId, fn),
  };
}
