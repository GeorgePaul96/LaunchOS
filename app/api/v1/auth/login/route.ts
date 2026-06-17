import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { verifyPassword, signSession, sessionSecret, sessionCookie } from "@/lib/auth";
import { ApiError, toProblemResponse } from "@/lib/errors";
import { ok } from "@/lib/request";
import { recordAudit } from "@/lib/audit";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email ?? ""));
    if (!user || !user.passwordHash || !(await verifyPassword(password ?? "", user.passwordHash))) {
      throw new ApiError(401, "unauthorized", "Invalid credentials");
    }
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.id));
    if (!membership) throw new ApiError(403, "forbidden", "No org membership");
    const token = signSession({ userId: user.id, orgId: membership.orgId }, sessionSecret());
    await recordAudit(db, { orgId: membership.orgId, actorType: "user", actorId: user.id, action: "auth.login" });
    const res = ok({ user: { id: user.id, email: user.email } });
    res.headers.append("set-cookie", sessionCookie(token));
    return res;
  } catch (e) { return toProblemResponse(e); }
}
