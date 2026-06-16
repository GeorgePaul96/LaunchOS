import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { schema } from "@/db/client";
import { generateApiKey } from "@/lib/auth";
import { uuid } from "@/lib/ids";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.name || typeof body.name !== "string") {
      throw new ApiError(400, "invalid_request", "name is required");
    }
    const { secret, hash, prefix } = generateApiKey();
    const id = uuid();
    await ctx.withOrg((db) =>
      db.insert(schema.apiKeys).values({
        id, orgId: ctx.orgId, name: body.name, keyHash: hash, keyPrefix: prefix,
        scopes: JSON.stringify(Array.isArray(body.scopes) ? body.scopes : []),
        createdBy: ctx.userId || null,
      }),
    );
    return ok({ id, key: secret, key_prefix: prefix }, 201);
  } catch (e) { return toProblemResponse(e); }
}
