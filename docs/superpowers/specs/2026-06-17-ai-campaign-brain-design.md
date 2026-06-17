# AI Campaign Brain v1 — Design

**Date:** 2026-06-17
**Phase:** P2 (MVP completion) — §5.3, second sub-project after the Viral Content Generator
**Status:** Approved

## 1. Purpose & Scope

Turn a goal into an AI-generated **campaign plan** — a calendar of content assets spread across
the operator's connected channels, with a budget split and KPIs — let the operator review and
re-plan it, then **approve** to materialize each asset as a **draft post** wired to the campaign.
A results panel reads campaign-scoped attribution (attributed outcomes, not vanity metrics).

A single AI gateway call produces the whole plan: each asset comes back with platform, day
offset, ready-to-edit draft copy, rationale, and an expected-outcome note. It must work fully
offline on the Mock provider (dev/test) and use real Claude when `ANTHROPIC_API_KEY` is set — no
behavioral branching in feature code; the gateway selects the provider. No feature code imports a
model SDK directly; every call goes through `lib/ai/gateway.ts` `run()` and writes an `ai_jobs`
cost-ledger row. This is the second real consumer of the AI gateway, after the Viral Generator.

### Lifecycle

`create (planning) → plan / re-plan (planning) → approve (active) → results`

### Out of scope (deferred)

- **Auto-publishing.** Approve creates `draft` posts only; the operator publishes them through the
  existing compose/calendar flow. Nothing is enqueued at approve time.
- **Per-asset Viral-Gen scored variants.** v1 produces draft copy inline in the single planning
  call. The richer "plan = briefs, then per-asset scored variants" path is left to P4.
- **Ad-spend execution.** Budget split is plan *data* only (allocated across channels); billing is
  deferred per the roadmap.
- **Experiment / A-B wiring** (that is the P4 Experiment engine).

## 2. Data Model

`campaigns` already exists and is reused as-is:
`id, public_id, org_id, profile_id, name, objective, goal_metric, goal_target, budget_cents,
status (default "planning"), created_at`.

### Changes to `campaigns`
- Add `ai_job_id` — `bigint` (mode number) → `ai_jobs.id` (ON DELETE SET NULL). Links the planning
  call to the cost ledger, matching the `content_generations.ai_job_id` pattern.
- Add `account_ids` — `text` NOT NULL DEFAULT `"[]"`. JSON array of the campaign's chosen target
  account ids, set at create and read by `planCampaign` to build the channel set.

The channel-mix / budget-split summary is **derived** from `campaign_assets` (sum `budget_cents`
per platform) rather than stored in a new column, keeping `campaigns` aligned with the canonical
schema. The campaign's own `goal_metric` / `goal_target` / `budget_cents` hold the top-line KPI and
total budget, written at plan time.

### `campaign_assets` (new table)

Follows the established per-feature pattern: text app-generated UUID ids, `org_id` for RLS +
defense-in-depth filtering, an `org_isolation_*` RLS policy, an `app_user` GRANT, and added to
`test/helpers.ts` `ALL_TABLES`.

| column | type | notes |
|---|---|---|
| id | text PK | `uuid()` |
| public_id | text unique | `publicId("casset")` |
| campaign_id | text NOT NULL → campaigns.id (ON DELETE CASCADE) | |
| org_id | text NOT NULL → organizations.id | RLS |
| account_id | text → social_accounts.id (ON DELETE SET NULL) | target channel; null until matched |
| platform | text NOT NULL | platform key for the asset |
| day_offset | integer NOT NULL DEFAULT 0 | days after launch → `scheduledFor` |
| draft_body | text NOT NULL DEFAULT '' | AI-drafted copy |
| rationale | text NOT NULL DEFAULT '' | why this asset |
| expected_outcome | text NOT NULL DEFAULT '' | per-asset KPI note |
| budget_cents | integer NOT NULL DEFAULT 0 | this asset's slice of the split |
| post_id | text → posts.id (ON DELETE SET NULL) | set on approve (materialized draft) |
| created_at | text | `$defaultFn(now)` |

## 3. Services — `lib/campaign/`

Mirrors `lib/viral/`: the prompt builder is split out so it is unit-testable in isolation.

### `lib/campaign/prompt.ts`

`buildPlanPrompt({ objective, goalMetric?, goalTarget?, budgetCents?, channels, brandVoice,
horizonDays })` → `{ system, messages, jsonSchema }`.

- `channels` is the list of `{ accountId, platform }` for the campaign's chosen accounts.
- System prompt grounds in brand voice (whatever keys are present) + the available channels +
  the objective; user message states the goal, horizon, and budget.
- `jsonSchema` describes:
  ```
  { goalMetric: string, goalTarget: integer,
    channelMix: [{ platform: string, budgetCents: integer, rationale: string }],
    assets: [{ platform: string, dayOffset: integer, draftBody: string,
               rationale: string, expectedOutcome: string, budgetCents: integer }] }
  ```

### `lib/campaign/service.ts`

```
createCampaign(db, orgId, { profileId, name, objective, goalMetric?, goalTarget?, budgetCents?, accountIds })
  -> campaign (status="planning")
planCampaign(db, orgId, campaignId, { horizonDays?, provider? })
  -> { campaign, assets }
getCampaign(db, orgId, campaignId)        -> { campaign, assets, channelMix }
listCampaigns(db, orgId)                  -> campaigns (newest first)
approveCampaign(db, orgId, campaignId)    -> { campaign (status="active"), posts }
campaignResults(db, orgId, campaignId, model) -> campaign-scoped AttributionReport
```

- **`createCampaign`** — validates the profile belongs to the org (404 otherwise) and that each
  `accountId` is an org account (404 otherwise); requires ≥1 account (400). Inserts a campaign in
  `planning`. The chosen `accountIds` define the campaign's channel set and are persisted in the
  `campaigns.account_ids` column (a JSON array `text`, added in the same migration as `ai_job_id`).
  `planCampaign` reads `account_ids` to build the channel set passed to the prompt.
- **`planCampaign`** — loads the campaign (404), resolves its `account_ids` to live org accounts,
  builds the prompt, calls `runAI(db, { orgId, feature: "campaign_brain", task: "plan", system,
  messages, jsonSchema, provider })`. Parses `assets`; 502 (`ai_invalid_output`) if missing/empty.
  Matches each asset's `platform` to one of the campaign's accounts (first match → `account_id`;
  unmatched platforms keep `account_id = null`). Writes `campaigns.ai_job_id` and the top-line
  `goal_metric`/`goal_target`/`budget_cents` from the plan. **Deletes prior assets that have no
  `post_id`** and inserts the new set (idempotent re-plan; materialized assets are preserved). Only
  allowed while status is `planning` (400 otherwise). Clamps `budgetCents`/`dayOffset` to ≥0.
- **`getCampaign`** — campaign (404) + its assets (newest day first, then created order) +
  `channelMix` derived by summing `budget_cents` per platform with a share percentage.
- **`approveCampaign`** — only from `planning` (400 otherwise). For each asset without a `post_id`,
  create a **draft** post via `createDraftPost` (below) with `scheduledFor = launch + dayOffset`
  (launch = now at approve time), set `asset.post_id`. Requires ≥1 asset with a matched account
  (400 if none). Flips campaign to `active`. Returns the created posts. Allowed only from
  `planning`; approve when already `active` returns 400 (the status guard makes approve safe to
  call once).
- **`campaignResults`** — `buildReport(db, orgId, model, { campaignId, persist: false })`.

### Publishing service change — `lib/publishing/service.ts`

Extract `createDraftPost(db, orgId, { profileId, content, accountId, scheduledFor, campaignId,
origin, originRef })`:
- Validates the account belongs to the org (404).
- Inserts a post with `status="draft"`, `publishNow=false`, the given `origin`/`originRef`/
  `campaignId`/`scheduledFor`, and one `pending` `post_target` for the account.
- **Enqueues nothing.**

`createPost` (the publish path: `status="scheduled"` + `enqueue`) is unchanged.

### Attribution change — `lib/attribution/report.ts`

`buildReport` gains an optional 4th arg `{ campaignId?: string; persist?: boolean }`
(default `{ persist: true }`):
- When `campaignId` is set, the touchpoint query adds `eq(touchpoints.campaignId, campaignId)` so
  only this campaign's touchpoints earn credit.
- When `persist === false`, skip the `attribution_results` delete + inserts (read-only compute that
  does not clobber the org's persisted global results).
- Existing callers pass nothing and are unaffected.

## 4. API + SDK + MCP

New routes (all behind `requireContext()` — session cookie or `Bearer sk_…`; work inside
`ctx.withOrg(...)`; return via `ok()`; convert thrown `ApiError` with `toProblemResponse()`; audit
on every mutation via `recordAudit`):

| Method + path | Body / query | Returns |
|---|---|---|
| `POST /api/v1/campaigns` | `{ profileId, name, objective, goalMetric?, goalTarget?, budgetCents?, accountIds[] }` | `{ campaign }` |
| `GET /api/v1/campaigns` | — | `{ data: campaigns[] }` |
| `GET /api/v1/campaigns/{id}` | — | `{ campaign, assets, channelMix }` |
| `POST /api/v1/campaigns/{id}/plan` | `{ horizonDays? }` | `{ campaign, assets }` |
| `POST /api/v1/campaigns/{id}/approve` | — | `{ campaign, posts }` |
| `GET /api/v1/campaigns/{id}/results` | `?model=first_touch\|last_touch\|linear` | campaign-scoped `AttributionReport` |

- **OpenAPI**: all six added to `lib/openapi/spec.ts` so the drift guard (`test/openapi.test.ts`,
  `routeApiPaths()` vs. spec) stays green.
- **SDK**: `client.campaigns.create / list / get / plan / approve / results` in
  `lib/sdk/client.ts` (+ `lib/sdk/types.ts`).
- **MCP**: `create_campaign` (wraps `POST /campaigns`) and `plan_campaign` (wraps
  `POST /campaigns/{id}/plan`) tools in `mcp/tools.ts`, same HTTP-path style as existing tools, so
  an agent can do goal→plan end-to-end.
- **Errors** via problem+json: 400 invalid body / no channels / approve-when-not-planning, 402
  budget exceeded (from the gateway), 404 unknown campaign/profile/account, 502 provider /
  invalid-output.
- **PGlite note**: no worker drain needed — approve creates drafts, so nothing is enqueued.

## 5. UI — `/campaigns`

Client screens mirroring the compose / content-studio data-loading style.

- **`/campaigns`** — list of campaigns (name, objective, status) + a "New campaign" form: name,
  objective, goal metric + target, budget, and a multi-select of connected accounts (same accounts
  call compose uses). Create → navigate to the detail screen.
- **`/campaigns/[id]`** — header (objective, goal, status badge); **Generate plan / Re-plan**
  button; a channel-mix summary (platform → budget + share %); asset cards (platform badge, day
  offset, draft copy, rationale, expected outcome, budget); **Approve plan** (disabled once
  `active`) → shows the created drafts with links into `/calendar`; a **Results** panel with a
  model toggle reading `/campaigns/{id}/results`.
- A nav link "Campaigns" is added alongside the existing links.
- Over-budget (402) and provider (502) errors render as an inline message.

## 6. Testing (TDD)

- `lib/campaign/prompt` — objective, brand-voice keys, and channel platforms appear in the built
  prompt; `jsonSchema` has the `assets` + `channelMix` shape.
- `lib/campaign/service` (PGlite):
  - `createCampaign` sets `planning`, persists `account_ids`, 404 on unknown profile/account, 400
    on empty accounts.
  - `planCampaign` persists assets, links `ai_job_id` to a real `ai_jobs` row, matches platforms to
    accounts, writes top-line goal/budget; a spy/mock provider asserts brand voice + channels
    reached the gateway call; clamps negatives; re-plan replaces un-materialized assets but keeps
    materialized ones; plan-when-active → 400; empty `assets` → 502.
  - `approveCampaign` creates `draft` posts (status=draft, **no enqueue**), sets each `post_id`,
    sets `scheduledFor` from `dayOffset`, flips to `active`; approve-when-active → 400; no matched
    accounts → 400.
  - `getCampaign` returns assets + derived `channelMix`; `listCampaigns` newest-first.
  - `campaignResults` returns a campaign-scoped rollup; cross-org isolation (org A cannot read org
    B's campaign/assets/results).
- `lib/publishing/service` — `createDraftPost` inserts a draft post + one pending target and
  enqueues nothing; `createPost` behavior unchanged.
- `lib/attribution/report` — `buildReport` with `{ campaignId, persist: false }` filters
  touchpoints by campaign and leaves the org's global `attribution_results` untouched; default-arg
  callers behave exactly as before.
- SDK — `campaigns.*` hit the right method + path (fetch stub).
- MCP — `create_campaign` / `plan_campaign` registered and route to the right paths.
- OpenAPI — drift guard stays green with the six new paths.
- All 117 existing tests remain green.

## 7. Migration

`db:generate` produces `campaign_assets` and the `campaigns.ai_job_id` + `campaigns.account_ids`
columns. A follow-up hand-written custom SQL migration (`drizzle-kit generate --custom`) adds the
`org_isolation_campaign_assets` policy + `app_user` GRANT on the new table (the `campaigns` table
already has its RLS policy + grant). `db:migrate` applies both. `campaign_assets` is added to
`test/helpers.ts` `ALL_TABLES` ahead of `campaigns` so the TRUNCATE CASCADE order stays valid.
