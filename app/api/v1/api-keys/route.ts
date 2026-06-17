import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { schema } from "@/db/client";
import { generateApiKey } from "@/lib/auth";
import { uuid } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.name || typeof body.name !== "string") {
      throw new ApiError(400, "invalid_request", "name is required");
    }
    const { secret, hash, prefix } = generateApiKey();
    const id = uuid();
    await ctx.withOrg(async (db) => {
      await db.insert(schema.apiKeys).values({
        id, orgId: ctx.orgId, name: body.name, keyHash: hash, keyPrefix: prefix,
        scopes: JSON.stringify(Array.isArray(body.scopes) ? body.scopes : []),
        createdBy: ctx.userId || null,
      });
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "api_key.create", targetType: "api_key", targetId: id });
    });
    return ok({ id, key: secret, key_prefix: prefix }, 201);
  } catch (e) { return toProblemResponse(e); }
}
