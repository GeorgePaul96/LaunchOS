# AI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single AI gateway every feature calls instead of a model SDK — provider interface + task→model router + `ai_jobs` cost ledger + per-org budget caps + structured JSON, with a deterministic MockAIProvider (dev/test) and a real AnthropicProvider (prod).

**Architecture:** `lib/ai/*` pure helpers (pricing, router) + provider seam (`AIProvider`: Mock + Anthropic, selected by `ANTHROPIC_API_KEY`) + `budget.ts` (per-org cap from env default or `organizations.feature_flags.ai_budget_cents`) + `gateway.run()` which routes, budget-checks, dispatches, and writes one `ai_jobs` row per call. Builds on P1.1 (Postgres+RLS) and P1.2 (jobs table grant/RLS pattern).

**Tech Stack:** `@anthropic-ai/sdk` 0.104, drizzle-orm/pg-core, PGlite (dev/test) / node-postgres (prod), Vitest. Model `claude-opus-4-8` (adaptive thinking on planning), `claude-haiku-4-5` for classification.

**Reference:** `docs/superpowers/specs/2026-06-16-ai-gateway-design.md`; claude-api skill for SDK shapes.

**Conventions:** run from repo root. Commit after each task. Tests use the base test DB (service role) + `MockAIProvider`. New tables use native `jsonb`/`timestamptz`.

---

## File Structure

```
db/schema.ts           + ai_jobs table; + feature_flags column on organizations
db/migrations/          + 0004_*.sql (generated) + 0005_ai_jobs_rls.sql (grants/RLS/index)
lib/ai/provider.ts      AIProvider interface + CompletionRequest / AIResult / Usage
lib/ai/pricing.ts       PRICING + costCents(model, usage)
lib/ai/router.ts        route(task) -> { model, effort?, thinking }
lib/ai/mock.ts          MockAIProvider (deterministic, no network)
lib/ai/anthropic.ts     AnthropicProvider (@anthropic-ai/sdk)
lib/ai/budget.ts        defaultBudgetCents / orgBudgetCents / spentThisMonthCents / assertWithinBudget
lib/ai/gateway.ts       getProvider() + run(db, input)
test/ai-pricing.test.ts, ai-router.test.ts, ai-mock.test.ts, ai-budget.test.ts, ai-gateway.test.ts
test/helpers.ts         + "ai_jobs" in ALL_TABLES
package.json            + @anthropic-ai/sdk dependency
```

---

## Task 1: `ai_jobs` table + `feature_flags` column + migration

**Files:** Modify `db/schema.ts`, `test/helpers.ts`; Create `db/migrations/0004_*.sql` (generated), `db/migrations/0005_ai_jobs_rls.sql`

- [ ] **Step 1: Add `feature_flags` to `organizations` and the `ai_jobs` table in `db/schema.ts`**

In the `organizations` table definition, add a `featureFlags` column right after `brandSettings`:
```ts
  brandSettings: text("brand_settings").notNull().default("{}"),
  featureFlags: text("feature_flags").notNull().default("{}"),
```
Append at the end of `db/schema.ts` (the `jsonb`, `timestamp`, `bigserial`, `integer`, `text` imports already exist from P1.2):
```ts
// AI gateway cost/audit ledger (every model call writes one row).
export const aiJobs = pgTable("ai_jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  feature: text("feature").notNull(),
  task: text("task").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("succeeded"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add `"ai_jobs"` to the test truncation list**

In `test/helpers.ts`, add `"ai_jobs"` to the front of the `ALL_TABLES` array:
```ts
const ALL_TABLES = [
  "ai_jobs", "jobs", "attribution_results", "conversions", "touchpoints", "identities", "contact_channels",
  "contacts", "account_metrics_daily", "post_targets", "posts", "campaigns",
  "social_accounts", "profiles", "api_keys", "memberships", "journeys",
  "idempotency_keys", "platforms", "users", "organizations",
].join(", ");
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: creates `db/migrations/0004_*.sql` containing `CREATE TABLE "ai_jobs"` and `ALTER TABLE "organizations" ADD COLUMN "feature_flags"`.

- [ ] **Step 4: Create the custom grants/RLS migration**

Run: `npx drizzle-kit generate --custom --name ai_jobs_rls`
Expected: creates an empty `db/migrations/0005_ai_jobs_rls.sql`.

- [ ] **Step 5: Fill `db/migrations/0005_ai_jobs_rls.sql`**

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_jobs TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE ai_jobs_id_seq TO app_user;
--> statement-breakpoint
ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_ai_jobs ON ai_jobs
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX ai_jobs_org_created_idx ON ai_jobs (org_id, created_at);
```

- [ ] **Step 6: Verify migrations apply (18 policies, ai_jobs + feature_flags present)**

Run:
```
node --input-type=module -e "
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
const db = drizzle(new PGlite(), {});
await migrate(db, {migrationsFolder:'db/migrations'});
const p = await db.execute(\"select count(*)::int n from pg_policies where policyname like 'org_isolation_%'\");
const c = await db.execute(\"select count(*)::int n from information_schema.columns where table_name='organizations' and column_name='feature_flags'\");
console.log('policies', p.rows[0].n, '| feature_flags col', c.rows[0].n);
"
```
Expected: `policies 18 | feature_flags col 1`

- [ ] **Step 7: Reseed + run existing suite**

Run (Git Bash): `rm -rf .pgdata && npm run setup && npx vitest run 2>&1 | tail -4`
Expected: setup completes; 54 tests pass.

- [ ] **Step 8: Commit**

```bash
git add db/schema.ts db/migrations test/helpers.ts
git commit -m "feat(ai): ai_jobs ledger table + org feature_flags column + RLS"
```

---

## Task 2: Pricing (pure)

**Files:** Create `lib/ai/pricing.ts`, `test/ai-pricing.test.ts`

- [ ] **Step 1: Write the failing test**

`test/ai-pricing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { costCents, PRICING } from "@/lib/ai/pricing";

describe("pricing", () => {
  it("prices opus-4-8 input+output", () => {
    // 1M input @ 500c + 1M output @ 2500c = 3000c
    expect(costCents("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3000);
  });
  it("rounds up to the next cent", () => {
    expect(costCents("claude-opus-4-8", { inputTokens: 1000, outputTokens: 0 })).toBe(1); // 0.5c -> 1
  });
  it("has a 1-cent minimum so every call is metered", () => {
    expect(costCents("claude-haiku-4-5", { inputTokens: 1, outputTokens: 1 })).toBe(1);
  });
  it("throws on an unknown model", () => {
    expect(() => costCents("gpt-foo", { inputTokens: 1, outputTokens: 1 })).toThrow();
  });
  it("has pricing for the routed models", () => {
    expect(PRICING["claude-opus-4-8"]).toBeDefined();
    expect(PRICING["claude-haiku-4-5"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- ai-pricing`
Expected: FAIL — cannot resolve `@/lib/ai/pricing`.

- [ ] **Step 3: Implement `lib/ai/pricing.ts`**

```ts
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// Cents per million tokens (from the claude-api model table).
export const PRICING: Record<string, { inputCentsPerMTok: number; outputCentsPerMTok: number }> = {
  "claude-opus-4-8": { inputCentsPerMTok: 500, outputCentsPerMTok: 2500 },
  "claude-haiku-4-5": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 },
  "claude-sonnet-4-6": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
};

// Integer cents, rounded up, with a 1-cent floor so every successful call is metered.
export function costCents(model: string, usage: Usage): number {
  const p = PRICING[model];
  if (!p) throw new Error(`no pricing for model ${model}`);
  const raw = (usage.inputTokens * p.inputCentsPerMTok + usage.outputTokens * p.outputCentsPerMTok) / 1_000_000;
  return Math.max(1, Math.ceil(raw));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- ai-pricing`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ai/pricing.ts test/ai-pricing.test.ts
git commit -m "feat(ai): model pricing + cost calculation"
```

---

## Task 3: Router (pure)

**Files:** Create `lib/ai/router.ts`, `test/ai-router.test.ts`

- [ ] **Step 1: Write the failing test**

`test/ai-router.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { route } from "@/lib/ai/router";

describe("router", () => {
  it("routes plan to opus with high effort + adaptive thinking", () => {
    expect(route("plan")).toEqual({ model: "claude-opus-4-8", effort: "high", thinking: true });
  });
  it("routes generate to opus, medium, no thinking", () => {
    expect(route("generate")).toEqual({ model: "claude-opus-4-8", effort: "medium", thinking: false });
  });
  it("routes classify to haiku with no effort (haiku rejects effort)", () => {
    expect(route("classify")).toEqual({ model: "claude-haiku-4-5", thinking: false });
  });
  it("falls back to a safe default for unknown tasks", () => {
    expect(route("something-new")).toEqual({ model: "claude-opus-4-8", effort: "medium", thinking: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- ai-router`
Expected: FAIL — cannot resolve `@/lib/ai/router`.

- [ ] **Step 3: Implement `lib/ai/router.ts`**

```ts
export type Effort = "low" | "medium" | "high" | "max";

export interface Route {
  model: string;
  effort?: Effort; // omitted for models that reject effort (e.g. Haiku)
  thinking: boolean;
}

const ROUTES: Record<string, Route> = {
  plan: { model: "claude-opus-4-8", effort: "high", thinking: true },
  generate: { model: "claude-opus-4-8", effort: "medium", thinking: false },
  classify: { model: "claude-haiku-4-5", thinking: false },
};

export function route(task: string): Route {
  return ROUTES[task] ?? { model: "claude-opus-4-8", effort: "medium", thinking: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- ai-router`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ai/router.ts test/ai-router.test.ts
git commit -m "feat(ai): task -> model router"
```

---

## Task 4: Provider interface + MockAIProvider

**Files:** Create `lib/ai/provider.ts`, `lib/ai/mock.ts`, `test/ai-mock.test.ts`

- [ ] **Step 1: Create `lib/ai/provider.ts`**

```ts
import type { Usage } from "./pricing";
import type { Effort } from "./router";

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  effort?: Effort;
  thinking?: boolean;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface AIResult {
  text: string;
  model: string;
  usage: Usage;
}

export interface AIProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<AIResult>;
}
```

- [ ] **Step 2: Write the failing test**

`test/ai-mock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MockAIProvider } from "@/lib/ai/mock";

describe("MockAIProvider", () => {
  it("returns deterministic text + usage for a request", async () => {
    const p = new MockAIProvider();
    const req = { model: "claude-opus-4-8", messages: [{ role: "user" as const, content: "hello" }] };
    const a = await p.complete(req);
    const b = await p.complete(req);
    expect(a.text).toBe(b.text);
    expect(a.model).toBe("claude-opus-4-8");
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(a.usage.outputTokens).toBeGreaterThan(0);
  });

  it("returns valid parseable JSON when a jsonSchema is given", async () => {
    const p = new MockAIProvider();
    const r = await p.complete({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "extract" }],
      jsonSchema: { type: "object", properties: { name: { type: "string" }, count: { type: "integer" } } },
    });
    const parsed = JSON.parse(r.text);
    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("count");
    expect(typeof parsed.name).toBe("string");
    expect(typeof parsed.count).toBe("number");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- ai-mock`
Expected: FAIL — cannot resolve `@/lib/ai/mock`.

- [ ] **Step 4: Implement `lib/ai/mock.ts`**

```ts
import { createHash } from "node:crypto";
import type { AIProvider, CompletionRequest, AIResult } from "./provider";

// Deterministic, offline provider for dev/test.
export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  async complete(req: CompletionRequest): Promise<AIResult> {
    const prompt = (req.system ? req.system + "\n" : "") + req.messages.map((m) => `${m.role}:${m.content}`).join("\n");
    const text = req.jsonSchema
      ? JSON.stringify(mockJsonForSchema(req.jsonSchema))
      : `mock(${req.model}):${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`;
    return { text, model: req.model, usage: { inputTokens: tokens(prompt), outputTokens: tokens(text) } };
  }
}

function tokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

// Build a minimal valid object for a JSON schema (objects/properties only; enough for tests).
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
  if (type === "array") return [];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return ""; // string and unspecified
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- ai-mock`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/ai/provider.ts lib/ai/mock.ts test/ai-mock.test.ts
git commit -m "feat(ai): AIProvider interface + deterministic MockAIProvider"
```

---

## Task 5: Budget enforcement

**Files:** Create `lib/ai/budget.ts`, `test/ai-budget.test.ts`

- [ ] **Step 1: Write the failing test**

`test/ai-budget.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { orgBudgetCents, assertWithinBudget } from "@/lib/ai/budget";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("budget", () => {
  it("uses the env default when no per-org override", async () => {
    const { orgId } = await seedOrg(db);
    process.env.AI_BUDGET_CENTS_DEFAULT = "5000";
    expect(await orgBudgetCents(db as any, orgId)).toBe(5000);
    delete process.env.AI_BUDGET_CENTS_DEFAULT;
  });

  it("per-org feature_flags override beats the default", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 250 }) }).where(eq(schema.organizations.id, orgId));
    expect(await orgBudgetCents(db as any, orgId)).toBe(250);
  });

  it("passes when spend + add is within cap", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 100 }) }).where(eq(schema.organizations.id, orgId));
    await expect(assertWithinBudget(db as any, orgId, 10)).resolves.toBeUndefined();
  });

  it("throws 402 when spend + add exceeds cap", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 5 }) }).where(eq(schema.organizations.id, orgId));
    // existing spend this month
    await db.insert(schema.aiJobs).values({ orgId, feature: "f", task: "generate", model: "claude-opus-4-8", status: "succeeded", costCents: 4 });
    await expect(assertWithinBudget(db as any, orgId, 5)).rejects.toMatchObject({ status: 402, code: "budget_exceeded" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- ai-budget`
Expected: FAIL — cannot resolve `@/lib/ai/budget`.

- [ ] **Step 3: Implement `lib/ai/budget.ts`**

```ts
import { sql, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";

export function defaultBudgetCents(): number {
  const v = Number(process.env.AI_BUDGET_CENTS_DEFAULT);
  return Number.isFinite(v) && v > 0 ? v : 100_000; // $1,000/mo default
}

export async function orgBudgetCents(db: DB, orgId: string): Promise<number> {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (org) {
    try {
      const ff = JSON.parse(org.featureFlags) as Record<string, unknown>;
      if (typeof ff.ai_budget_cents === "number") return ff.ai_budget_cents;
    } catch { /* fall through to default */ }
  }
  return defaultBudgetCents();
}

// Sum of cost_cents for this org in the current calendar month (DB-side time math).
export async function spentThisMonthCents(db: DB, orgId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT coalesce(sum(cost_cents), 0)::int AS spent
    FROM ai_jobs
    WHERE org_id = ${orgId} AND created_at >= date_trunc('month', now())
  `);
  return Number((res.rows[0] as { spent: number }).spent);
}

export async function assertWithinBudget(db: DB, orgId: string, addCents: number): Promise<void> {
  const cap = await orgBudgetCents(db, orgId);
  const spent = await spentThisMonthCents(db, orgId);
  if (spent + addCents > cap) {
    throw new ApiError(402, "budget_exceeded", `AI budget exceeded: ${spent + addCents}c would exceed cap ${cap}c`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- ai-budget`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ai/budget.ts test/ai-budget.test.ts
git commit -m "feat(ai): per-org budget caps (env default + feature_flags override)"
```

---

## Task 6: AnthropicProvider (real)

**Files:** Modify `package.json`; Create `lib/ai/anthropic.ts`

No unit test (it makes network calls); verified by type-check. The gateway tests use the Mock.

- [ ] **Step 1: Add the SDK dependency**

In `package.json`, add to `dependencies` (keep alphabetical-ish):
```json
    "@anthropic-ai/sdk": "^0.104.2",
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `@anthropic-ai/sdk` added.

- [ ] **Step 3: Implement `lib/ai/anthropic.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, CompletionRequest, AIResult } from "./provider";

// Real provider. Constructed only when ANTHROPIC_API_KEY is present (see gateway.getProvider).
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client = new Anthropic();

  async complete(req: CompletionRequest): Promise<AIResult> {
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system) params.system = req.system;
    if (req.thinking) params.thinking = { type: "adaptive" };
    const outputConfig: Record<string, unknown> = {};
    if (req.effort) outputConfig.effort = req.effort;
    if (req.jsonSchema) outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;

    // output_config is newer than the installed SDK's types; cast at the boundary.
    const resp = (await this.client.messages.create(params as any)) as Anthropic.Message;
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: resp.model,
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
    };
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/ai/anthropic.ts
git commit -m "feat(ai): real AnthropicProvider via @anthropic-ai/sdk"
```

---

## Task 7: Gateway

**Files:** Create `lib/ai/gateway.ts`, `test/ai-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

`test/ai-gateway.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { run } from "@/lib/ai/gateway";
import { MockAIProvider } from "@/lib/ai/mock";
import type { AIProvider } from "@/lib/ai/provider";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

const mock = new MockAIProvider();

describe("ai gateway", () => {
  it("runs, returns text, and records one succeeded ai_jobs row with cost", async () => {
    const { orgId } = await seedOrg(db);
    const result = await run(db as any, {
      orgId, feature: "viral_gen", task: "generate",
      messages: [{ role: "user", content: "write a hook" }],
      provider: mock,
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.costCents).toBeGreaterThan(0);

    const rows = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].feature).toBe("viral_gen");
    expect(rows[0].costCents).toBeGreaterThan(0);
    expect(rows[0].inputTokens).toBeGreaterThan(0);
  });

  it("parses JSON when a jsonSchema is provided", async () => {
    const { orgId } = await seedOrg(db);
    const result = await run(db as any, {
      orgId, feature: "campaign_brain", task: "plan",
      messages: [{ role: "user", content: "plan" }],
      jsonSchema: { type: "object", properties: { goal: { type: "string" } } },
      provider: mock,
    });
    expect(result.json).toMatchObject({ goal: expect.any(String) });
  });

  it("throws 402 and records a failed row when over budget", async () => {
    const { orgId } = await seedOrg(db);
    await db.update(schema.organizations).set({ featureFlags: JSON.stringify({ ai_budget_cents: 0 }) }).where(eq(schema.organizations.id, orgId));
    await expect(run(db as any, {
      orgId, feature: "viral_gen", task: "generate",
      messages: [{ role: "user", content: "x" }], provider: mock,
    })).rejects.toMatchObject({ status: 402, code: "budget_exceeded" });
    const rows = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });

  it("throws 502 and records a failed row on provider error", async () => {
    const { orgId } = await seedOrg(db);
    const boom: AIProvider = { name: "boom", async complete() { throw new Error("provider down"); } };
    await expect(run(db as any, {
      orgId, feature: "viral_gen", task: "generate",
      messages: [{ role: "user", content: "x" }], provider: boom,
    })).rejects.toMatchObject({ status: 502, code: "ai_provider_error" });
    const rows = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("provider down");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- ai-gateway`
Expected: FAIL — cannot resolve `@/lib/ai/gateway`.

- [ ] **Step 3: Implement `lib/ai/gateway.ts`**

```ts
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import type { AIProvider } from "./provider";
import type { Usage } from "./pricing";
import { route } from "./router";
import { costCents } from "./pricing";
import { assertWithinBudget } from "./budget";
import { MockAIProvider } from "./mock";
import { AnthropicProvider } from "./anthropic";

// Conservative pre-dispatch budget estimate (exact cost recorded post-call).
const ESTIMATE_CENTS = 5;

let cachedProvider: AIProvider | null = null;
export function getProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;
  if (process.env.ANTHROPIC_API_KEY) {
    cachedProvider = new AnthropicProvider();
  } else {
    console.warn("[ai] ANTHROPIC_API_KEY not set — using MockAIProvider");
    cachedProvider = new MockAIProvider();
  }
  return cachedProvider;
}

export interface AIRunInput {
  orgId: string;
  feature: string;
  task: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  provider?: AIProvider; // injectable for tests
}

export interface AIRunResult {
  text: string;
  json?: unknown;
  model: string;
  usage: Usage;
  costCents: number;
}

export async function run(db: DB, input: AIRunInput): Promise<AIRunResult> {
  const r = route(input.task);
  const provider = input.provider ?? getProvider();
  const t0 = Date.now();
  try {
    await assertWithinBudget(db, input.orgId, ESTIMATE_CENTS); // throws 402 if over
    const result = await provider.complete({
      model: r.model,
      system: input.system,
      messages: input.messages,
      effort: r.effort,
      thinking: r.thinking,
      jsonSchema: input.jsonSchema,
      maxTokens: input.maxTokens,
    });
    const cost = costCents(r.model, result.usage);
    await db.insert(schema.aiJobs).values({
      orgId: input.orgId, feature: input.feature, task: input.task, model: r.model,
      status: "succeeded", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      costCents: cost, latencyMs: Date.now() - t0,
    });
    return {
      text: result.text,
      json: input.jsonSchema ? JSON.parse(result.text) : undefined,
      model: r.model,
      usage: result.usage,
      costCents: cost,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.insert(schema.aiJobs).values({
      orgId: input.orgId, feature: input.feature, task: input.task, model: r.model,
      status: "failed", costCents: 0, latencyMs: Date.now() - t0, error: msg,
    });
    if (e instanceof ApiError) throw e; // budget_exceeded passes through as 402
    throw new ApiError(502, "ai_provider_error", msg);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- ai-gateway`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check + full suite**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -6`
Expected: tsc exit 0; all tests pass (54 prior + pricing 5 + router 4 + mock 2 + budget 4 + gateway 4 = 73).

- [ ] **Step 6: Commit**

```bash
git add lib/ai/gateway.ts test/ai-gateway.test.ts
git commit -m "feat(ai): gateway run() — route, budget, dispatch, ledger"
```

---

## Task 8: Verify + docs

**Files:** Modify `README.md`, `docs/IMPLEMENTATION-ROADMAP.md`

- [ ] **Step 1: Fresh setup + full suite + build**

Run (Git Bash): `rm -rf .pgdata && npm run setup && npx tsc --noEmit && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -4`
Expected: setup ok; tsc exit 0; all tests pass; build exits 0.

- [ ] **Step 2: Update README architecture bullets**

In `README.md`, add an `lib/ai/*` bullet after the `lib/jobs/*` line:
```
- `lib/ai/*` — AI gateway: provider seam (Mock dev/test, Anthropic prod via `ANTHROPIC_API_KEY`), task router, `ai_jobs` cost ledger, per-org budget caps.
```
And add a line under the database/env notes:
```
Set `ANTHROPIC_API_KEY` to use real Claude calls (model `claude-opus-4-8`); without it the AI
gateway runs on a deterministic mock. Per-org monthly AI spend is capped via
`AI_BUDGET_CENTS_DEFAULT` (env) or `organizations.feature_flags.ai_budget_cents`.
```

- [ ] **Step 3: Mark P1.3 in the roadmap**

In `docs/IMPLEMENTATION-ROADMAP.md`, change `### 4.3 ⬜ AI gateway` to `### 4.3 ✅ AI gateway`, and update the P1 row in the §2 table to add `✅ AI gateway` alongside the others.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/IMPLEMENTATION-ROADMAP.md
git commit -m "docs: AI gateway run notes + roadmap status (P1.3 done)"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** `AIProvider` interface (Task 4) ✓; Mock + Anthropic providers selected by
  `ANTHROPIC_API_KEY` (Tasks 4,6,7) ✓; router (Task 3) ✓; pricing/cost (Task 2) ✓; `ai_jobs`
  ledger native types + RLS + `app_user` grant (Task 1) ✓; budget cap from env default +
  `feature_flags.ai_budget_cents` override, DB-side month sum (Task 5) ✓; `gateway.run()` routes
  → budget-checks → dispatches → records one row, JSON parse on `jsonSchema`, 402 over budget,
  502 provider error, failed row in both cases (Task 7) ✓; offline dev/test on Mock ✓; deferred
  RAG/prompt-registry/guardrails not built ✓.
- **No placeholders:** every step has complete code; Task 6 has no unit test by design (network),
  stated explicitly with type-check verification.
- **Type consistency:** `Usage {inputTokens,outputTokens}` shared by pricing/provider/gateway;
  `Route {model,effort?,thinking}` from router consumed by gateway; `CompletionRequest`/`AIResult`
  consistent across provider/mock/anthropic/gateway; `AIRunInput`/`AIRunResult` stable; `costCents`
  / `route` / `assertWithinBudget` signatures match their call sites in the gateway.
- **Schema note:** the design referenced `organizations.feature_flags` as "already exists" — it
  exists in the *canonical* schema but not the P1 subset, so Task 1 adds the column (fidelity-positive).
```
