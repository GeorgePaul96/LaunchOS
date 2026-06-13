import { and, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { retryTarget } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, orgId } = await requireContext();
    const { id } = await params;
    const [post] = await db.select().from(schema.posts).where(and(eq(schema.posts.publicId, id), eq(schema.posts.orgId, orgId)));
    if (!post) throw new ApiError(404, "not_found", "Post not found");
    const failed = await db.select().from(schema.postTargets).where(and(eq(schema.postTargets.postId, post.id), eq(schema.postTargets.status, "failed")));
    const provider = new MockChannelProvider();
    for (const t of failed) await retryTarget(db, orgId, t.id, provider);
    return ok({ retried: failed.length });
  } catch (e) { return toProblemResponse(e); }
}
