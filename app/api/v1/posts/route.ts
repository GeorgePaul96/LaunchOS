import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { createPost, listPosts } from "@/lib/publishing/service";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listPosts(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const idemKey = req.headers.get("Idempotency-Key");
    const body = await req.json();
    if (!body.profileId || !Array.isArray(body.accountIds)) {
      throw new ApiError(400, "invalid_request", "profileId and accountIds[] required");
    }
    const responseBody = await ctx.withOrg(async (db) => {
      if (idemKey) {
        const [hit] = await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, idemKey));
        if (hit) return JSON.parse(hit.responseJson);
      }
      const post = await createPost(db, ctx.orgId, {
        profileId: body.profileId,
        content: body.content ?? "",
        accountIds: body.accountIds,
        scheduledFor: body.scheduledFor ?? null,
        campaignId: body.campaignId ?? null,
        overrides: body.overrides,
      });
      const out = { post: { id: post.publicId, status: post.status } };
      if (idemKey) {
        await db.insert(schema.idempotencyKeys).values({ key: idemKey, orgId: ctx.orgId, responseJson: JSON.stringify(out) });
      }
      return out;
    });
    return ok(responseBody, 202);
  } catch (e) { return toProblemResponse(e); }
}
