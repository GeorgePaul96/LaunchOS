# Viral Content Generator — Design

**Date:** 2026-06-17
**Phase:** P2 (MVP completion) — first sub-project
**Status:** Approved

## 1. Purpose & Scope

Give the operator a way to turn a short brief into several AI-generated, AI-scored
content variants, grounded in the profile's brand voice, then carry a chosen variant
into the composer. This is the first real consumer of the AI gateway built in P1.

It must work fully offline on the Mock provider (dev/test) and use real Claude when
`ANTHROPIC_API_KEY` is set — no behavioral branching in feature code; the gateway
already selects the provider.

### Supported intents

`hook`, `thread`, `reel_script`, `carousel`, `repurpose` — each maps to a distinct
instruction block in the prompt builder. `repurpose` additionally takes a `sourceRef`
(free text / existing content to rework).

### Out of scope (deferred)

- RAG over past winners / embeddings (gateway spec defers this).
- Closed-loop training (predicted score vs. actual engagement).
- Image/video generation.
- Auto-creating a draft post from a variant (composer is **prefilled** only).
- Multi-variant A/B publish wiring (that is the P4 Experiment engine).

## 2. Data Model (new tables)

Both follow the existing per-feature-table pattern: text app-generated UUID ids,
`org_id` for RLS + defense-in-depth filtering, an `org_isolation_*` RLS policy, and an
`app_user` GRANT. Added to `test/helpers.ts` `ALL_TABLES` (front of the list, before
`ai_jobs`, so TRUNCATE CASCADE order stays valid).

### `content_generations`
| column | type | notes |
|---|---|---|
| id | text PK | `uuid()` |
| public_id | text unique | `publicId("gen")` |
| org_id | text NOT NULL → organizations.id | RLS |
| profile_id | text NOT NULL → profiles.id | brand-voice source |
| intent | text NOT NULL | one of the supported intents |
| prompt | text NOT NULL | the user brief |
| source_ref | text | optional, for `repurpose` |
| ai_job_id | bigint (mode number) → ai_jobs.id (ON DELETE SET NULL) | cost-ledger link; matches bigserial ai_jobs.id |
| created_at | text | `$defaultFn(now)` |

### `content_variants`
| column | type | notes |
|---|---|---|
| id | text PK | `uuid()` |
| public_id | text unique | `publicId("var")` |
| generation_id | text NOT NULL → content_generations.id (ON DELETE CASCADE) | |
| org_id | text NOT NULL → organizations.id | RLS |
| body | text NOT NULL | generated content |
| predicted_score | integer NOT NULL DEFAULT 0 | 0–100 |
| rationale | text NOT NULL DEFAULT '' | why this scores as it does |
| chosen | boolean NOT NULL DEFAULT false | set by "use in composer" |
| posted_post_id | text → posts.id (ON DELETE SET NULL) | reserved for closed loop; null for now |
| created_at | text | `$defaultFn(now)` |

## 3. Services — `lib/viral/service.ts`

```
generateVariants(db, orgId, { profileId, intent, prompt, sourceRef?, count? })
  -> { generation, variants }
listGenerations(db, orgId)                 -> generations (newest first) with variants
chooseVariant(db, orgId, variantId)        -> updated variant (chosen = true)
```

`generateVariants`:
1. Load `profiles.brandVoice` (JSON string) for `profileId` within the org; 404 if missing.
2. Build a **system** prompt from brand voice (tone, banned words, audience — whatever
   keys are present) + the intent's instruction block, and a **user** message from the
   brief (+ `sourceRef` for repurpose). Prompt building lives in `lib/viral/prompt.ts`
   so it is unit-testable in isolation.
3. Call `gateway.run(db, { orgId, feature: "viral_generator", task: "generate", system,
   messages, jsonSchema })` where `jsonSchema` describes
   `{ variants: [{ body: string, predictedScore: integer, rationale: string }] }`.
   `count` (default 3) is requested in the prompt text; the model returns up to that many.
4. Parse `result.json`. If it is missing/has no `variants` array → throw
   `ApiError(502, "ai_invalid_output", ...)`.
5. Insert one `content_generations` (with `ai_job_id = result.jobId`) and N
   `content_variants`, clamping `predictedScore` to 0–100. Return them.

### Gateway change
`AIRunResult` gains `jobId: number`. The succeeded-insert uses
`.returning({ id: schema.aiJobs.id })` and the result carries that id. Additive — existing
gateway assertions (`text`, `model`, `costCents`, ledger rows) are unaffected.

### Mock provider change
`MockAIProvider`'s `mockJsonForSchema` currently returns `[]` for arrays and `""` for
strings, which would yield zero usable variants offline. Change it to:
- array → **two** items built from the `items` schema,
- string → `"mock"` (non-empty),
- integer/number → `0`, boolean → `false`, object → recurse (unchanged).

This keeps determinism and makes Content Studio usable offline (two variants, score 0,
body/rationale `"mock"`). Real scores require `ANTHROPIC_API_KEY`. A new test locks the
array-fill behavior; existing mock/gateway tests still pass (their assertions are
type-based, not value-based).

## 4. API + SDK + MCP

New routes (all behind `requireContext()` — session cookie or `Bearer sk_…`):
- `POST /api/v1/content/generate` — body `{ profileId, intent, prompt, sourceRef?, count? }`
  → `{ generation, variants }`.
- `GET  /api/v1/content/generations` — list with nested variants.
- `POST /api/v1/content/variants/{id}/choose` — mark chosen → updated variant.

Each is:
- documented in the **OpenAPI spec** (`lib/openapi/spec.ts`) so the existing drift guard
  (`routeApiPaths()` vs. spec) stays green;
- added to the **SDK** as `client.content.generate/list/choose`;
- the **`generate_content` MCP tool** wraps `POST /content/generate` (same HTTP path the
  other MCP tools use), so Claude/Cursor can generate content directly.

Errors flow through the existing `problem+json`: 400 invalid intent/body, 402 budget
exceeded, 404 unknown profile/variant, 502 provider/invalid-output.

## 5. UI — `/content-studio`

Client screen (mirrors the existing compose screen's data-loading style):
- Loads accounts to obtain a `profileId` (same call compose uses).
- Form: intent select, brief textarea, optional source-ref (shown for `repurpose`),
  count, **Generate**.
- Renders returned variants as cards: score badge, body, rationale, **Use in composer**.
- "Use in composer" → `POST .../choose` then `router.push("/compose?content=" +
  encodeURIComponent(body))`. The compose page reads the `content` query param to prefill
  its textarea (small additive change to the existing compose page).
- A nav link "Content Studio" is added alongside the existing links.

Over-budget (402) and provider (502) errors render as an inline message.

## 6. Testing (TDD)

- `lib/viral/prompt` — brand voice keys + intent instructions appear in the built prompt;
  `repurpose` includes `sourceRef`.
- `lib/viral/service` (PGlite) — `generateVariants` persists one generation + ≥1 variant
  with numeric `predictedScore`, links `ai_job_id` to a real `ai_jobs` row, and clamps
  scores; passes a spy/mock provider and asserts brand voice reached the gateway call;
  `chooseVariant` flips `chosen`; `listGenerations` returns nested variants newest-first;
  unknown profile → 404, unknown variant → 404.
- gateway — `run` returns `jobId` matching the inserted ledger row.
- mock — `mockJsonForSchema` yields a non-empty array of correctly-shaped items.
- SDK — `content.generate/list/choose` hit the right method+path (fetch stub).
- MCP — `generate_content` tool is registered and routes to `/content/generate`.
- OpenAPI — drift guard stays green with the three new paths.
- All 98 existing tests remain green.

## 7. Migration

`db:generate` produces the new tables; a follow-up SQL migration adds the two
`org_isolation_*` RLS policies + `app_user` GRANTs (same hand-written pattern as prior
feature tables). `db:migrate` applies both.
