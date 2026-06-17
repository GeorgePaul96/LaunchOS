# Viral Content Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a short brief into several AI-generated, AI-scored content variants grounded in the profile's brand voice, persisted and usable in the composer, exposed via API + Content Studio UI + SDK + MCP.

**Architecture:** A `lib/viral` module (pure prompt builder + a service) is the only new business logic; it calls the existing `lib/ai/gateway.run` seam (no direct provider access). Two new org-scoped tables (`content_generations`, `content_variants`) follow the established text-id + RLS-policy + `app_user` GRANT pattern. New `/api/v1/content/*` routes reuse `requireContext()`/`withOrg`/`toProblemResponse`, are documented in the OpenAPI spec (drift guard), and surfaced through the SDK and a `generate_content` MCP tool. A `/content-studio` client page drives it and hands a chosen variant to the existing composer via a `?content=` query param.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM (pg-core), PGlite (dev/test) / node-postgres (prod), drizzle-kit migrations, Vitest, Zod (MCP), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-17-viral-content-generator-design.md`

---

## File Structure

**Create:**
- `lib/viral/prompt.ts` — pure prompt builder (brand voice + intent → system/user/jsonSchema).
- `lib/viral/service.ts` — `generateVariants`, `listGenerations`, `chooseVariant`.
- `app/api/v1/content/generate/route.ts` — POST generate.
- `app/api/v1/content/generations/route.ts` — GET list.
- `app/api/v1/content/variants/[id]/choose/route.ts` — POST choose.
- `app/(app)/content-studio/page.tsx` — Content Studio UI.
- `db/migrations/0011_content_rls.sql` — RLS + GRANTs (hand-written via `--custom`).
- Tests: `test/viral-prompt.test.ts`, `test/viral-service.test.ts`, `test/content-api.test.ts`.

**Modify:**
- `db/schema.ts` — add `bigint` import + two tables.
- `lib/ai/gateway.ts` — return `jobId`.
- `lib/ai/mock.ts` — non-empty array/string filler.
- `lib/sdk/types.ts` + `lib/sdk/client.ts` — `content` resource + types.
- `lib/openapi/spec.ts` — three new paths.
- `mcp/tools.ts` — `generate_content` tool.
- `app/(app)/compose/page.tsx` — read `?content=` prefill.
- `app/(app)/layout.tsx` — nav link.
- `test/helpers.ts` — add new tables to `ALL_TABLES`.
- `test/ai-gateway.test.ts`, `test/ai-mock.test.ts`, `test/sdk.test.ts`, `test/mcp.test.ts` — extend.
- `docs/IMPLEMENTATION-ROADMAP.md` — mark P2.1.

---

## Task 1: Schema + migration for the two tables

**Files:**
- Modify: `db/schema.ts` (import line + append two tables)
- Modify: `test/helpers.ts:10-15` (ALL_TABLES)
- Create: `db/migrations/0011_content_rls.sql` (after `db:generate`)

- [ ] **Step 1: Add the `bigint` import**

In `db/schema.ts` line 5, add `bigint` to the pg-core import:

```ts
import { pgTable, text, integer, boolean, jsonb, timestamp, bigserial, bigint } from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Append the two tables to `db/schema.ts`**

Add at the end of the file (after `aiJobs`). `now` is already defined at the top of the file.

```ts
export const contentGenerations = pgTable("content_generations", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  intent: text("intent").notNull(),
  prompt: text("prompt").notNull(),
  sourceRef: text("source_ref"),
  aiJobId: bigint("ai_job_id", { mode: "number" }).references(() => aiJobs.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const contentVariants = pgTable("content_variants", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  generationId: text("generation_id").notNull().references(() => contentGenerations.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id),
  body: text("body").notNull(),
  predictedScore: integer("predicted_score").notNull().default(0),
  rationale: text("rationale").notNull().default(""),
  chosen: boolean("chosen").notNull().default(false),
  postedPostId: text("posted_post_id").references(() => posts.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
```

- [ ] **Step 3: Add both tables to the test TRUNCATE list**

In `test/helpers.ts`, edit the `ALL_TABLES` array so the two new tables are truncated. Put them first (they reference orgs/profiles/posts/ai_jobs, and TRUNCATE … CASCADE handles order, but listing children first is the convention here):

```ts
const ALL_TABLES = [
  "content_variants", "content_generations",
  "audit_log", "ai_jobs", "jobs", "attribution_results", "conversions", "touchpoints", "identities", "contact_channels",
  "contacts", "account_metrics_daily", "post_targets", "posts", "campaigns",
  "social_accounts", "profiles", "api_keys", "memberships", "journeys",
  "idempotency_keys", "platforms", "users", "organizations",
].join(", ");
```

- [ ] **Step 4: Generate the table migration**

Run: `npm run db:generate`
Expected: a new `db/migrations/0010_*.sql` containing `CREATE TABLE "content_generations"` and `CREATE TABLE "content_variants"`, plus a `0010_snapshot.json` and a journal entry.

- [ ] **Step 5: Generate an empty custom migration for RLS**

Run: `npx drizzle-kit generate --custom --name content_rls`
Expected: an empty `db/migrations/0011_content_rls.sql`, a `0011_snapshot.json`, and a journal entry. (Mirrors how `0009_audit_log_rls` was created.)

- [ ] **Step 6: Fill in `0011_content_rls.sql`**

Replace its contents with (text-id tables → no sequence grants; mirror `0001`/`0009`):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON content_generations TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON content_variants TO app_user;
--> statement-breakpoint
ALTER TABLE content_generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE content_generations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_content_generations ON content_generations
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
ALTER TABLE content_variants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE content_variants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_content_variants ON content_variants
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX content_generations_org_created_idx ON content_generations (org_id, created_at);
--> statement-breakpoint
CREATE INDEX content_variants_generation_idx ON content_variants (generation_id);
```

- [ ] **Step 7: Apply migrations against a real Postgres-less dev (sanity) — run the test suite**

The test harness migrates a fresh PGlite from `db/migrations` on first use, so running any DB test exercises both new migrations.

Run: `npm test -- test/rls.test.ts`
Expected: PASS (proves migrations apply cleanly, including the new RLS files).

- [ ] **Step 8: Commit**

```bash
git add db/schema.ts db/migrations test/helpers.ts
git commit -m "feat(viral): content_generations + content_variants tables + RLS (P2.1)"
```

---

## Task 2: Gateway returns `jobId`; mock fills arrays/strings

**Files:**
- Modify: `lib/ai/gateway.ts:39-74`
- Modify: `lib/ai/mock.ts:22-36`
- Modify: `test/ai-gateway.test.ts` (one new assertion)
- Modify: `test/ai-mock.test.ts` (one new test)

- [ ] **Step 1: Write the failing gateway test (jobId)**

Add to the first test in `test/ai-gateway.test.ts`, after the existing `rows` assertions (inside `it("runs, returns text, …")`):

```ts
    expect(result.jobId).toBe(rows[0].id);
```

- [ ] **Step 2: Write the failing mock test (array fill)**

Add a new test to `test/ai-mock.test.ts`:

```ts
  it("fills arrays with shaped, non-empty items", async () => {
    const p = new MockAIProvider();
    const r = await p.complete({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "gen" }],
      jsonSchema: {
        type: "object",
        properties: {
          variants: {
            type: "array",
            items: {
              type: "object",
              properties: { body: { type: "string" }, predictedScore: { type: "integer" }, rationale: { type: "string" } },
            },
          },
        },
      },
    });
    const parsed = JSON.parse(r.text);
    expect(Array.isArray(parsed.variants)).toBe(true);
    expect(parsed.variants.length).toBeGreaterThan(0);
    expect(typeof parsed.variants[0].body).toBe("string");
    expect(parsed.variants[0].body.length).toBeGreaterThan(0);
    expect(typeof parsed.variants[0].predictedScore).toBe("number");
  });
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm test -- test/ai-gateway.test.ts test/ai-mock.test.ts`
Expected: FAIL — `result.jobId` is `undefined`; `parsed.variants` is `[]`.

- [ ] **Step 4: Implement gateway `jobId`**

In `lib/ai/gateway.ts`, add `jobId: number;` to the `AIRunResult` interface, capture the inserted id on the succeeded path, and include it in the returned object:

```ts
export interface AIRunResult {
  text: string;
  json?: unknown;
  model: string;
  usage: Usage;
  costCents: number;
  jobId: number;
}
```

Change the succeeded insert + return inside `run`:

```ts
    const [job] = await db.insert(schema.aiJobs).values({
      orgId: input.orgId, feature: input.feature, task: input.task, model: r.model,
      status: "succeeded", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      costCents: cost, latencyMs: Date.now() - t0,
    }).returning({ id: schema.aiJobs.id });
    return {
      text: result.text,
      json: input.jsonSchema ? JSON.parse(result.text) : undefined,
      model: r.model,
      usage: result.usage,
      costCents: cost,
      jobId: job.id,
    };
```

(The failed-path insert is unchanged — it throws before returning, so no `jobId` is needed there.)

- [ ] **Step 5: Implement the mock filler**

Replace the body of `mockJsonForSchema` in `lib/ai/mock.ts`:

```ts
function mockJsonForSchema(schema: Record<string, unknown>): unknown {
  const type = schema.type as string | undefined;
  if (type === "object") {
    const out: Record<string, unknown> = {};
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      out[key] = mockJsonForSchema(propSchema);
    }
    return out;
  }
  if (type === "array") {
    const items = (schema.items ?? { type: "string" }) as Record<string, unknown>;
    return [mockJsonForSchema(items), mockJsonForSchema(items)]; // two deterministic items
  }
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return "mock"; // non-empty string for unspecified/string
}
```

- [ ] **Step 6: Run the suite to verify pass**

Run: `npm test -- test/ai-gateway.test.ts test/ai-mock.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 7: Commit**

```bash
git add lib/ai/gateway.ts lib/ai/mock.ts test/ai-gateway.test.ts test/ai-mock.test.ts
git commit -m "feat(ai): gateway returns jobId; mock fills arrays + non-empty strings"
```

---

## Task 3: Prompt builder (`lib/viral/prompt.ts`)

**Files:**
- Create: `lib/viral/prompt.ts`
- Test: `test/viral-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/viral-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPrompt, VARIANT_SCHEMA, type Intent } from "@/lib/viral/prompt";

describe("buildPrompt", () => {
  it("injects brand voice fields into the system prompt", () => {
    const { system } = buildPrompt({
      intent: "hook",
      prompt: "launch our new pricing",
      brandVoice: { tone: "punchy", bannedWords: ["synergy"], audience: "founders" },
      count: 3,
    });
    expect(system).toContain("punchy");
    expect(system).toContain("synergy");
    expect(system).toContain("founders");
  });

  it("includes an intent-specific instruction", () => {
    const a = buildPrompt({ intent: "thread", prompt: "x", brandVoice: {}, count: 3 });
    const b = buildPrompt({ intent: "reel_script", prompt: "x", brandVoice: {}, count: 3 });
    expect(a.system).not.toBe(b.system);
    expect(a.system.toLowerCase()).toContain("thread");
    expect(b.system.toLowerCase()).toContain("reel");
  });

  it("puts the brief and requested count in the user message", () => {
    const { messages } = buildPrompt({ intent: "hook", prompt: "launch day", brandVoice: {}, count: 5 });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("launch day");
    expect(messages[0].content).toContain("5");
  });

  it("includes sourceRef for repurpose", () => {
    const { messages } = buildPrompt({ intent: "repurpose", prompt: "make it shorter", brandVoice: {}, count: 2, sourceRef: "ORIGINAL BLOG TEXT" });
    expect(messages[0].content).toContain("ORIGINAL BLOG TEXT");
  });

  it("exposes a variants json schema with body/predictedScore/rationale", () => {
    const items = (VARIANT_SCHEMA.properties as any).variants.items.properties;
    expect(items).toHaveProperty("body");
    expect(items).toHaveProperty("predictedScore");
    expect(items).toHaveProperty("rationale");
  });

  it("rejects an unknown intent", () => {
    expect(() => buildPrompt({ intent: "haiku" as Intent, prompt: "x", brandVoice: {}, count: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/viral-prompt.test.ts`
Expected: FAIL — cannot resolve `@/lib/viral/prompt`.

- [ ] **Step 3: Implement `lib/viral/prompt.ts`**

```ts
import { ApiError } from "@/lib/errors";

export type Intent = "hook" | "thread" | "reel_script" | "carousel" | "repurpose";

const INTENT_INSTRUCTIONS: Record<Intent, string> = {
  hook: "Write scroll-stopping one-line hooks that open a short social post.",
  thread: "Write multi-tweet threads; number each tweet; first tweet is the hook.",
  reel_script: "Write a short-form video (reel) script with an on-screen hook and spoken voiceover beats.",
  carousel: "Write a swipeable carousel; one slide per line, slide 1 is the hook, last slide is a CTA.",
  repurpose: "Rework the supplied source content into fresh native posts for social.",
};

export interface BrandVoice {
  tone?: string;
  bannedWords?: string[];
  audience?: string;
  [k: string]: unknown;
}

export interface BuildPromptInput {
  intent: Intent;
  prompt: string;
  brandVoice: BrandVoice;
  count: number;
  sourceRef?: string;
}

// JSON schema the gateway enforces on the model's output.
export const VARIANT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          body: { type: "string" },
          predictedScore: { type: "integer" },
          rationale: { type: "string" },
        },
        required: ["body", "predictedScore", "rationale"],
      },
    },
  },
  required: ["variants"],
} as const;

export function buildPrompt(input: BuildPromptInput): {
  system: string;
  messages: { role: "user"; content: string }[];
  jsonSchema: Record<string, unknown>;
} {
  const instruction = INTENT_INSTRUCTIONS[input.intent];
  if (!instruction) throw new ApiError(400, "invalid_intent", `Unknown intent: ${input.intent}`);

  const bv = input.brandVoice ?? {};
  const voiceLines = [
    bv.tone ? `Tone: ${bv.tone}.` : "",
    bv.audience ? `Audience: ${bv.audience}.` : "",
    bv.bannedWords?.length ? `Never use these words: ${bv.bannedWords.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  const system = [
    "You are a senior social media copywriter for LaunchOS.",
    instruction,
    voiceLines,
    "For each variant, give an honest predictedScore from 0-100 estimating its virality/engagement, and a one-sentence rationale.",
    "Return only JSON matching the schema.",
  ].filter(Boolean).join(" ");

  const userParts = [
    `Brief: ${input.prompt}`,
    input.sourceRef ? `Source content to repurpose:\n${input.sourceRef}` : "",
    `Generate up to ${input.count} distinct variants.`,
  ].filter(Boolean);

  return {
    system,
    messages: [{ role: "user", content: userParts.join("\n\n") }],
    jsonSchema: VARIANT_SCHEMA as unknown as Record<string, unknown>,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- test/viral-prompt.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/viral/prompt.ts test/viral-prompt.test.ts
git commit -m "feat(viral): brand-voice + intent prompt builder"
```

---

## Task 4: Service (`lib/viral/service.ts`)

**Files:**
- Create: `lib/viral/service.ts`
- Test: `test/viral-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/viral-service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { generateVariants, listGenerations, chooseVariant } from "@/lib/viral/service";
import { MockAIProvider } from "@/lib/ai/mock";
import type { AIProvider } from "@/lib/ai/provider";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });
const mock = new MockAIProvider();

describe("viral service", () => {
  it("generates + persists a generation and variants linked to an ai_jobs row", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await db.update(schema.profiles)
      .set({ brandVoice: JSON.stringify({ tone: "punchy", bannedWords: ["synergy"] }) })
      .where(eq(schema.profiles.id, profileId));

    const { generation, variants } = await generateVariants(db as any, orgId, {
      profileId, intent: "hook", prompt: "launch our pricing", provider: mock,
    });

    expect(generation.intent).toBe("hook");
    expect(generation.aiJobId).not.toBeNull();
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(typeof v.predictedScore).toBe("number");
      expect(v.predictedScore).toBeGreaterThanOrEqual(0);
      expect(v.predictedScore).toBeLessThanOrEqual(100);
      expect(v.generationId).toBe(generation.id);
    }
    const job = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.id, generation.aiJobId!));
    expect(job).toHaveLength(1);
    expect(job[0].feature).toBe("viral_generator");
  });

  it("passes brand voice into the model call", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await db.update(schema.profiles)
      .set({ brandVoice: JSON.stringify({ tone: "deadpan-xyz" }) })
      .where(eq(schema.profiles.id, profileId));
    let seenSystem = "";
    const spy: AIProvider = {
      name: "spy",
      async complete(req) {
        seenSystem = req.system ?? "";
        return { text: JSON.stringify({ variants: [{ body: "b", predictedScore: 50, rationale: "r" }] }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: spy });
    expect(seenSystem).toContain("deadpan-xyz");
  });

  it("clamps out-of-range scores to 0..100", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const wild: AIProvider = {
      name: "wild",
      async complete(req) {
        return { text: JSON.stringify({ variants: [{ body: "a", predictedScore: 250, rationale: "r" }, { body: "b", predictedScore: -8, rationale: "r" }] }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { variants } = await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: wild });
    const scores = variants.map((v) => v.predictedScore).sort((a, b) => a - b);
    expect(scores[0]).toBe(0);
    expect(scores[scores.length - 1]).toBe(100);
  });

  it("throws 502 ai_invalid_output when the model returns no variants array", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const bad: AIProvider = { name: "bad", async complete(req) { return { text: JSON.stringify({ nope: true }), model: req.model, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    await expect(generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: bad }))
      .rejects.toMatchObject({ status: 502, code: "ai_invalid_output" });
  });

  it("throws 404 for an unknown profile", async () => {
    const { orgId } = await seedOrg(db);
    await expect(generateVariants(db as any, orgId, { profileId: "missing", intent: "hook", prompt: "x", provider: mock }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("lists generations newest-first with nested variants", async () => {
    const { orgId, profileId } = await seedOrg(db);
    await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "one", provider: mock });
    await generateVariants(db as any, orgId, { profileId, intent: "thread", prompt: "two", provider: mock });
    const gens = await listGenerations(db as any, orgId);
    expect(gens).toHaveLength(2);
    expect(gens[0].prompt).toBe("two"); // newest first
    expect(gens[0].variants.length).toBeGreaterThan(0);
  });

  it("chooseVariant flips chosen and 404s on unknown id", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const { variants } = await generateVariants(db as any, orgId, { profileId, intent: "hook", prompt: "x", provider: mock });
    const updated = await chooseVariant(db as any, orgId, variants[0].id);
    expect(updated.chosen).toBe(true);
    await expect(chooseVariant(db as any, orgId, "missing")).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/viral-service.test.ts`
Expected: FAIL — cannot resolve `@/lib/viral/service`.

- [ ] **Step 3: Implement `lib/viral/service.ts`**

```ts
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
```

Note: `listGenerations` orders by `createdAt` (an ISO string from `$defaultFn(now)`); ISO strings sort lexicographically by time. If two generations land in the same millisecond the order is undefined — acceptable for this list. (The test inserts sequentially so timestamps differ.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- test/viral-service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/viral/service.ts test/viral-service.test.ts
git commit -m "feat(viral): generateVariants/listGenerations/chooseVariant service"
```

---

## Task 5: API routes + OpenAPI spec

**Files:**
- Create: `app/api/v1/content/generate/route.ts`
- Create: `app/api/v1/content/generations/route.ts`
- Create: `app/api/v1/content/variants/[id]/choose/route.ts`
- Modify: `lib/openapi/spec.ts`
- Test: `test/content-api.test.ts`

- [ ] **Step 1: Write the failing API test**

Create `test/content-api.test.ts`. It calls the route handlers directly with a faked auth context, mirroring how other route tests stub `requireContext`. (Check `test/api-flywheel.test.ts` for the exact mocking idiom in this repo and follow it; the version below uses `vi.mock`.)

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTestDb, seedOrg, scopeToOrg, type TestDB } from "./helpers";

let db: TestDB;
let currentOrg = "";
beforeEach(async () => { db = await makeTestDb(); });

// Route handlers resolve the caller via requireContext(); stub it to our test db + org.
vi.mock("@/lib/request", async (orig) => {
  const actual = await orig<typeof import("@/lib/request")>();
  return {
    ...actual,
    requireContext: async () => ({
      orgId: currentOrg,
      userId: "u_test",
      withOrg: <T,>(fn: (d: any) => Promise<T>) => scopeToOrg(db, currentOrg, fn as any),
    }),
  };
});

describe("content API", () => {
  it("POST /content/generate creates variants; GET lists; choose marks chosen", async () => {
    const { orgId, profileId } = await seedOrg(db);
    currentOrg = orgId;

    const { POST: generate } = await import("@/app/api/v1/content/generate/route");
    const genRes = await generate(new Request("http://x/api/v1/content/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, intent: "hook", prompt: "launch" }),
    }));
    expect(genRes.status).toBe(201);
    const genBody = await genRes.json();
    expect(genBody.variants.length).toBeGreaterThan(0);

    const { GET: list } = await import("@/app/api/v1/content/generations/route");
    const listBody = await (await list()).json();
    expect(listBody.data).toHaveLength(1);

    const variantId = genBody.variants[0].id;
    const { POST: choose } = await import("@/app/api/v1/content/variants/[id]/choose/route");
    const chooseRes = await choose(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: variantId }) });
    expect(chooseRes.status).toBe(200);
    expect((await chooseRes.json()).variant.chosen).toBe(true);
  });

  it("POST /content/generate 400s on a bad intent", async () => {
    const { orgId, profileId } = await seedOrg(db);
    currentOrg = orgId;
    const { POST: generate } = await import("@/app/api/v1/content/generate/route");
    const res = await generate(new Request("http://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, intent: "haiku", prompt: "x" }),
    }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/content-api.test.ts`
Expected: FAIL — route modules do not exist.

- [ ] **Step 3: Implement `app/api/v1/content/generate/route.ts`**

```ts
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
```

- [ ] **Step 4: Implement `app/api/v1/content/generations/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { listGenerations } from "@/lib/viral/service";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listGenerations(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 5: Implement `app/api/v1/content/variants/[id]/choose/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { chooseVariant } from "@/lib/viral/service";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const variant = await ctx.withOrg((db) => chooseVariant(db, ctx.orgId, id));
    return ok({ variant });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 6: Add the three paths to `lib/openapi/spec.ts`**

Insert these entries into the `paths` object (after the `/api-keys` line, before the closing brace):

```ts
    "/content/generate": {
      post: {
        summary: "Generate scored content variants",
        requestBody: jsonBody({
          profileId: { type: "string" }, intent: { type: "string" }, prompt: { type: "string" },
          sourceRef: { type: "string" }, count: { type: "integer" },
        }, ["profileId", "intent", "prompt"]),
        responses: resp(201),
      },
    },
    "/content/generations": { get: { summary: "List content generations", responses: resp() } },
    "/content/variants/{id}/choose": { post: { summary: "Mark a variant chosen", parameters: [pathParam("id")], responses: resp() } },
```

- [ ] **Step 7: Run the API + drift-guard tests**

Run: `npm test -- test/content-api.test.ts test/openapi.test.ts`
Expected: PASS — content-api green, and the drift guard's documented==implemented set still matches.

- [ ] **Step 8: Commit**

```bash
git add app/api/v1/content lib/openapi/spec.ts test/content-api.test.ts
git commit -m "feat(viral): /v1/content routes + OpenAPI entries"
```

---

## Task 6: SDK `content` resource

**Files:**
- Modify: `lib/sdk/types.ts`
- Modify: `lib/sdk/client.ts`
- Modify: `test/sdk.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/sdk.test.ts`:

```ts
  it("posts content.generate with the body", async () => {
    const { fn, calls } = stubFetch(201, { generation: { id: "gen_1" }, variants: [] });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.content.generate({ profileId: "p", intent: "hook", prompt: "hi" });
    expect(calls[0].url).toBe("http://x/api/v1/content/generate");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ profileId: "p", intent: "hook", prompt: "hi" });
  });

  it("posts content.choose to the variant path", async () => {
    const { fn, calls } = stubFetch(200, { variant: { id: "var_1", chosen: true } });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.content.choose("var_1");
    expect(calls[0].url).toBe("http://x/api/v1/content/variants/var_1/choose");
    expect(calls[0].init.method).toBe("POST");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/sdk.test.ts`
Expected: FAIL — `client.content` is undefined.

- [ ] **Step 3: Add the input type**

In `lib/sdk/types.ts`, add:

```ts
export type ContentIntent = "hook" | "thread" | "reel_script" | "carousel" | "repurpose";
export interface GenerateContentInput {
  profileId: string;
  intent: ContentIntent;
  prompt: string;
  sourceRef?: string;
  count?: number;
}
```

- [ ] **Step 4: Add the `content` resource to the client**

In `lib/sdk/client.ts`, extend the imports and add a resource (place after `apiKeys`):

```ts
import type {
  ClientOptions, CreatePostInput, IdentifyInput, TouchpointInput, ConversionInput,
  CreateApiKeyInput, AttributionModel, GenerateContentInput,
} from "./types";
```

```ts
  content = {
    generate: (input: GenerateContentInput) => this.req<{ generation: unknown; variants: unknown[] }>("POST", "/content/generate", input),
    list: () => this.req<{ data: unknown[] }>("GET", "/content/generations"),
    choose: (variantId: string) => this.req<{ variant: { id: string; chosen: boolean } }>("POST", `/content/variants/${encodeURIComponent(variantId)}/choose`),
  };
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- test/sdk.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/sdk/types.ts lib/sdk/client.ts test/sdk.test.ts
git commit -m "feat(sdk): content.generate/list/choose"
```

---

## Task 7: `generate_content` MCP tool

**Files:**
- Modify: `mcp/tools.ts`
- Modify: `test/mcp.test.ts`

- [ ] **Step 1: Update the failing registration test**

In `test/mcp.test.ts`, update the expected names array to include the new tool:

```ts
    expect(names).toEqual([
      "attribution_report", "contact_journey", "create_post", "generate_content",
      "list_accounts", "list_posts", "record_conversion", "record_touchpoint",
    ]);
```

Add a routing test:

```ts
  it("generate_content routes to the SDK content resource", async () => {
    let got: unknown;
    const stub = { content: { generate: async (a: unknown) => { got = a; return { generation: {}, variants: [] }; } } } as unknown as LaunchOSClient;
    const tool = tools.find((t) => t.name === "generate_content")!;
    await tool.run(stub, { profileId: "p", intent: "hook", prompt: "x" });
    expect(got).toMatchObject({ profileId: "p", intent: "hook", prompt: "x" });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/mcp.test.ts`
Expected: FAIL — no `generate_content` tool.

- [ ] **Step 3: Add the tool**

In `mcp/tools.ts`, extend the type import and append the tool to the `tools` array:

```ts
import type { AttributionModel, ContentIntent } from "@/lib/sdk/types";
```

```ts
  { name: "generate_content", description: "Generate scored social content variants for a profile (intents: hook, thread, reel_script, carousel, repurpose).",
    schema: { profileId: z.string(), intent: z.enum(["hook", "thread", "reel_script", "carousel", "repurpose"]), prompt: z.string(), sourceRef: z.string().optional(), count: z.number().optional() },
    run: (c, a) => c.content.generate({ profileId: a.profileId as string, intent: a.intent as ContentIntent, prompt: a.prompt as string, sourceRef: a.sourceRef as string | undefined, count: a.count as number | undefined }) },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- test/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/tools.ts test/mcp.test.ts
git commit -m "feat(mcp): generate_content tool"
```

---

## Task 8: Content Studio UI + composer prefill + nav

**Files:**
- Create: `app/(app)/content-studio/page.tsx`
- Modify: `app/(app)/compose/page.tsx`
- Modify: `app/(app)/layout.tsx`

- [ ] **Step 1: Add the nav link**

In `app/(app)/layout.tsx`, update the `NAV` array to include Content Studio after Compose:

```ts
const NAV = [
  ["Dashboard", "/dashboard"], ["Compose", "/compose"], ["Content Studio", "/content-studio"],
  ["Calendar", "/calendar"], ["Analytics", "/analytics"], ["Connections", "/settings/connections"],
];
```

- [ ] **Step 2: Make the composer read a `?content=` prefill**

In `app/(app)/compose/page.tsx`, initialize `content` from the URL query param. Replace the `const [content, setContent] = useState("");` line and add an import:

```ts
"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
```

```ts
  const params = useSearchParams();
  const [content, setContent] = useState(params.get("content") ?? "");
```

- [ ] **Step 3: Create the Content Studio page**

Create `app/(app)/content-studio/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Account { id: string; profileId: string; }
interface Variant { id: string; body: string; predictedScore: number; rationale: string; }

const INTENTS = ["hook", "thread", "reel_script", "carousel", "repurpose"] as const;
type Intent = typeof INTENTS[number];

export default function ContentStudioPage() {
  const router = useRouter();
  const [profileId, setProfileId] = useState("");
  const [intent, setIntent] = useState<Intent>("hook");
  const [prompt, setPrompt] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/v1/accounts").then(r => r.json()).then((d: { data?: Account[] }) => {
      if (d.data?.length) setProfileId(d.data[0].profileId);
    });
  }, []);

  async function generate() {
    setError(""); setVariants([]); setLoading(true);
    try {
      const res = await fetch("/api/v1/content/generate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId, intent, prompt, sourceRef: intent === "repurpose" ? sourceRef : undefined }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.detail ?? "Generation failed"); return; }
      setVariants(json.variants ?? []);
    } finally { setLoading(false); }
  }

  async function useInComposer(v: Variant) {
    await fetch(`/api/v1/content/variants/${encodeURIComponent(v.id)}/choose`, { method: "POST" });
    router.push(`/compose?content=${encodeURIComponent(v.body)}`);
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold">Content Studio</h1>
      <div className="mb-3 flex gap-2">
        <select className="rounded border p-2" value={intent} onChange={e => setIntent(e.target.value as Intent)}>
          {INTENTS.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
      </div>
      <textarea className="mb-3 h-24 w-full rounded border p-3" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="What should this content be about?" />
      {intent === "repurpose" && (
        <textarea className="mb-3 h-24 w-full rounded border p-3" value={sourceRef} onChange={e => setSourceRef(e.target.value)} placeholder="Paste the source content to repurpose…" />
      )}
      <button onClick={generate} disabled={loading || !prompt || !profileId} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {loading ? "Generating…" : "Generate"}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-6 space-y-3">
        {variants.map(v => (
          <div key={v.id} className="rounded border p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium">score {v.predictedScore}</span>
              <button onClick={() => useInComposer(v)} className="text-sm text-blue-600 hover:underline">Use in composer →</button>
            </div>
            <p className="whitespace-pre-wrap text-sm">{v.body}</p>
            {v.rationale && <p className="mt-2 text-xs text-neutral-500">{v.rationale}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Type-check + build**

Run: `npm run build`
Expected: build succeeds (no TS errors). `useSearchParams` requires the consuming page to be under a Suspense boundary in some Next configs — if the build complains about `useSearchParams`, wrap the compose page's default export body in `<Suspense>` (Next prints the exact remedy). Apply only if the build asks for it.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/content-studio/page.tsx" "app/(app)/compose/page.tsx" "app/(app)/layout.tsx"
git commit -m "feat(viral): Content Studio screen + composer prefill + nav"
```

---

## Task 9: Roadmap update + full green gate

**Files:**
- Modify: `docs/IMPLEMENTATION-ROADMAP.md`

- [ ] **Step 1: Mark P2.1 in the roadmap**

Open `docs/IMPLEMENTATION-ROADMAP.md`, find the P2 section, and mark the Viral Content Generator sub-project as ✅ done (matching the formatting used for P1 rows). Add a one-line note pointing at the spec + plan files.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all prior 98 tests plus the new viral-prompt (6), viral-service (7), content-api (2), and the added gateway/mock/sdk/mcp assertions.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add docs/IMPLEMENTATION-ROADMAP.md
git commit -m "docs: mark P2.1 viral content generator done"
```

---

## Self-Review Notes

- **Spec coverage:** tables (T1), gateway jobId + mock (T2), prompt grounding + intents + schema (T3), service generate/list/choose + scoring + errors (T4), API + OpenAPI drift (T5), SDK (T6), MCP (T7), UI + composer prefill + nav (T8), docs + green gate (T9). All spec sections map to a task.
- **Type consistency:** `Intent` union is defined once in `lib/viral/prompt.ts` and re-declared as `ContentIntent` in the SDK (SDK has no dependency on app code by design); both list the same five values. `generateVariants` returns `{ generation, variants }` consumed identically by the route and tests. `chooseVariant` returns the variant row; route wraps it as `{ variant }`; UI/SDK read `.variant`.
- **Deferred (per spec):** `postedPostId` stays null (closed loop is P4); composer prefill only (no auto-draft); no RAG.
- **Risk noted:** `useSearchParams` Suspense requirement is handled conditionally in T8 Step 4.
