import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { generateVariants } from "@/lib/viral/service";
import type { Intent } from "@/lib/viral/prompt";
import { recordAudit } from "@/lib/audit";

const INTENTS = new Set<Intent>(["hook", "thread", "reel_script", "carousel", "repurpose"]);

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.profileId || !body.prompt) throw new ApiError(400, "invalid_request", "profileId and prompt required");
    if (!INTENTS.has(body.intent)) throw new ApiError(400, "invalid_intent", `intent must be one of ${[...INTENTS].join(", ")}`);
    const out = await ctx.withOrg(async (db) => {
      const result = await generateVariants(db, ctx.orgId, {
        profileId: body.profileId, intent: body.intent, prompt: body.prompt,
        sourceRef: body.sourceRef, count: body.count,
      });
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "content.generate", targetType: "content_generation", targetId: result.generation.publicId });
      return result;
    });
    return ok(out, 201);
  } catch (e) { return toProblemResponse(e); }
}
