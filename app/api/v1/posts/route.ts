import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { createPost, listPosts } from "@/lib/publishing/service";

export async function GET() {
  try {
    const { db, orgId } = await requireContext();
    return ok({ data: await listPosts(db, orgId) });
  } catch (e) { return toProblemResponse(e); }
}

export async function POST(req: Request) {
  try {
    const { db, orgId, userId } = await requireContext();
    const idemKey = req.headers.get("Idempotency-Key");
    if (idemKey) {
      const [hit] = await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, idemKey));
      if (hit) return ok(JSON.parse(hit.responseJson), 200);
    }
    const body = await req.json();
    if (!body.profileId || !Array.isArray(body.accountIds)) {
      throw new ApiError(400, "invalid_request", "profileId and accountIds[] required");
    }
    const post = await createPost(db, orgId, {
      profileId: body.profileId,
      content: body.content ?? "",
      accountIds: body.accountIds,
      scheduledFor: body.scheduledFor ?? null,
      campaignId: body.campaignId ?? null,
      overrides: body.overrides,
    });
    void userId;
    const responseBody = { post: { id: post.publicId, status: post.status } };
    if (idemKey) {
      await db.insert(schema.idempotencyKeys).values({ key: idemKey, orgId, responseJson: JSON.stringify(responseBody) });
    }
    return ok(responseBody, 202);
  } catch (e) { return toProblemResponse(e); }
}
