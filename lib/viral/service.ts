import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { uuid, publicId } from "@/lib/ids";
import { run as runAI } from "@/lib/ai/gateway";
import type { AIProvider } from "@/lib/ai/provider";
import { buildPrompt, type Intent, type BrandVoice } from "./prompt";

export interface GenerateInput {
  profileId: string;
  intent: Intent;
  prompt: string;
  sourceRef?: string;
  count?: number;
  provider?: AIProvider; // injectable for tests
}

function clampScore(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export async function generateVariants(db: DB, orgId: string, input: GenerateInput) {
  const [profile] = await db.select().from(schema.profiles)
    .where(and(eq(schema.profiles.id, input.profileId), eq(schema.profiles.orgId, orgId)));
  if (!profile) throw new ApiError(404, "profile_not_found", `No profile ${input.profileId}`);

  let brandVoice: BrandVoice = {};
  try { brandVoice = JSON.parse(profile.brandVoice || "{}"); } catch { brandVoice = {}; }

  const count = Math.max(1, Math.min(10, input.count ?? 3));
  const { system, messages, jsonSchema } = buildPrompt({
    intent: input.intent, prompt: input.prompt, brandVoice, count, sourceRef: input.sourceRef,
  });

  const result = await runAI(db, {
    orgId, feature: "viral_generator", task: "generate",
    system, messages, jsonSchema, provider: input.provider,
  });

  const parsed = result.json as { variants?: { body?: string; predictedScore?: unknown; rationale?: string }[] } | undefined;
  if (!parsed || !Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    throw new ApiError(502, "ai_invalid_output", "Model did not return any variants");
  }

  const genId = uuid();
  const [generation] = await db.insert(schema.contentGenerations).values({
    id: genId, publicId: publicId("gen"), orgId, profileId: input.profileId,
    intent: input.intent, prompt: input.prompt, sourceRef: input.sourceRef ?? null,
    aiJobId: result.jobId,
  }).returning();

  const variantRows = parsed.variants.map((v) => ({
    id: uuid(), publicId: publicId("var"), generationId: genId, orgId,
    body: String(v.body ?? ""), predictedScore: clampScore(v.predictedScore), rationale: String(v.rationale ?? ""),
  }));
  const variants = await db.insert(schema.contentVariants).values(variantRows).returning();

  return { generation, variants };
}

export async function listGenerations(db: DB, orgId: string) {
  const gens = await db.select().from(schema.contentGenerations)
    .where(eq(schema.contentGenerations.orgId, orgId))
    .orderBy(desc(schema.contentGenerations.createdAt));
  if (gens.length === 0) return [];
  const ids = gens.map((g) => g.id);
  const vars = await db.select().from(schema.contentVariants)
    .where(and(eq(schema.contentVariants.orgId, orgId), inArray(schema.contentVariants.generationId, ids)));
  return gens.map((g) => ({ ...g, variants: vars.filter((v) => v.generationId === g.id) }));
}

export async function chooseVariant(db: DB, orgId: string, variantId: string) {
  const [updated] = await db.update(schema.contentVariants)
    .set({ chosen: true })
    .where(and(eq(schema.contentVariants.id, variantId), eq(schema.contentVariants.orgId, orgId)))
    .returning();
  if (!updated) throw new ApiError(404, "variant_not_found", `No variant ${variantId}`);
  return updated;
}
