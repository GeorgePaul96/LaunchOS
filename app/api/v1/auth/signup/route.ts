import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { uuid, publicId } from "@/lib/ids";
import { hashPassword, signSession, sessionSecret, sessionCookie } from "@/lib/auth";
import { ApiError, toProblemResponse } from "@/lib/errors";
import { ok } from "@/lib/request";
import { recordAudit } from "@/lib/audit";

export async function POST(req: Request) {
  try {
    const { email, password, name } = await req.json();
    if (!email || !password) throw new ApiError(400, "invalid_request", "email and password required");
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing.length) throw new ApiError(409, "conflict", "Email already registered");

    const orgId = uuid(), userId = uuid(), profileId = uuid();
    await db.insert(schema.organizations).values({ id: orgId, publicId: publicId("org"), name: name ? `${name}'s Org` : "My Org", slug: "org-" + orgId.slice(0, 8) });
    await db.insert(schema.users).values({ id: userId, publicId: publicId("user"), email, name: name ?? null, passwordHash: await hashPassword(password) });
    await db.insert(schema.memberships).values({ id: uuid(), orgId, userId, role: "owner", status: "active" });
    await db.insert(schema.profiles).values({ id: profileId, publicId: publicId("prof"), orgId, name: "Default" });

    await recordAudit(db, { orgId, actorType: "user", actorId: userId, action: "auth.signup" });
    const token = signSession({ userId, orgId }, sessionSecret());
    const res = ok({ user: { id: userId, email }, org: { id: orgId } }, 201);
    res.headers.append("set-cookie", sessionCookie(token));
    return res;
  } catch (e) { return toProblemResponse(e); }
}
