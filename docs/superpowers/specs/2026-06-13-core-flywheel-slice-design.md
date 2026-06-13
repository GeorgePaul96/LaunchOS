# LaunchOS — Core Flywheel Slice: Design

**Date:** 2026-06-13
**Status:** Approved (pending written-spec review)
**Source spec:** `LaunchOS-Spec.md` (§11 MVP wedge), `launchos_schema.sql` (canonical schema)

---

## 0. Context & scope decision

`LaunchOS-Spec.md` is a complete product specification for a venture-scale SaaS platform.
The spec itself estimates the MVP (Part 11) at 6–8 weeks and V1 at 3–4 months for a senior
team. Building "the whole project" in one pass is explicitly warned against by the spec
("If you ignore this and try to build all 21 native integrations and all 12 new AI systems
in one go, you will not ship").

We therefore build **one coherent, runnable vertical slice** now and iterate. The chosen
slice is the **core flywheel / wedge** from §11:

> compose → publish (mock provider) → touchpoint → revenue attribution → see it in a dashboard.

Each later system from the spec (AI, agents, ads, billing, native integrations) slots in
behind a named seam this slice establishes.

### Decisions locked during brainstorming
- **Scope:** core flywheel slice only.
- **Database:** SQLite locally via Drizzle, *Postgres-shaped*. `org_id` filtering in every
  query as the RLS substitute (the spec's "defense in depth: also filter by org_id", §9).
  `launchos_schema.sql` is preserved untouched as the canonical Postgres target.
- **Stack:** Next.js (App Router) full-stack — React UI + route handlers as the modular
  monolith API, one deployable, runs locally (§4/§5).
- **Publish:** `MockChannelProvider` behind the real `ChannelProvider` interface
  (the `[BUILD-VS-WRAP]` seam). No real platform credentials.
- **Scheduling:** lightweight in-process poller (not Temporal). Interface preserved.
- **No AI** in this slice (Viral Generator / Campaign Brain / AI gateway deferred).
- **Attribution depth:** real ingest API + seeded demo dataset (no browser pixel).
- **Architecture:** Approach A — layered Next.js monolith.

---

## 1. What this slice proves

The wedge: an operator can write a post once, publish it across multiple (mock) channels,
have visits/conversions ingested, and see **which post/channel/campaign drove revenue**
via a multi-touch attribution report — the thing Zernio structurally cannot do.

Runnable with `npm install && npm run dev`, seeded with a demo org so every screen shows
real data on first load.

---

## 2. Architecture (layers)

```
launchos/
  db/
    schema.ts              Drizzle schema — SQLite subset of launchos_schema.sql
    client.ts              db connection
    seed.ts                demo org, profile, accounts, campaign, posts, identities,
                           touchpoints, conversions (realistic multi-touch dataset)
    migrate.ts             drizzle-kit push / migration runner
  lib/
    auth.ts                email/password + signed cookie session; getSession()
    org-context.ts         every query takes org_id (RLS substitute, §9)
    ids.ts                 prefixed public ids (post_, acc_, cmp_, contact_, …)
    errors.ts              RFC-9457 problem+json helper
    channel/
      provider.ts          ChannelProvider interface
      mock.ts              MockChannelProvider — simulated platform_post_id + permalink
    publishing/
      scheduler.ts         in-process poller: fires due post_targets via provider
      service.ts           createPost, retryTarget, listPosts, rollupStatus
    attribution/
      identity.ts          identify() — stitch anonymous_id <-> contact <-> external id
      ingest.ts            recordTouchpoint(), recordConversion()
      models.ts            first / last / linear credit allocation
      report.ts            channel->revenue rollup by model
    journey/
      timeline.ts          merged touchpoints + conversions per contact
  app/
    api/v1/...             REST handlers mirroring spec endpoint map (§3.2)
    (auth)/login, signup
    (app)/dashboard
    (app)/compose
    (app)/calendar
    (app)/analytics        (analytics + attribution report)
    (app)/contacts/[id]    (CRM + journey timeline)
    (app)/settings/connections
  test/                    vitest unit tests for lib/* services
```

**Seam discipline (the spec's whole point):**
UI → `app/api/v1/*` → `lib/*` services → `db`. The `ChannelProvider` interface and the
attribution model functions are the swap points later slices depend on. Services never
import React; route handlers stay thin (parse → call service → format response/error).

---

## 3. Data model (SQLite subset of the canonical schema)

Tables included in this slice:
`organizations, users, memberships, api_keys, profiles, platforms, social_accounts,
posts, post_targets, contacts, contact_channels, identities, touchpoints, conversions,
attribution_results, campaigns, journeys, account_metrics_daily`.

Postgres → SQLite adaptations (documented in a header comment in `schema.ts`):

| Canonical (Postgres) | SQLite slice |
|---|---|
| `uuid` PK + `gen_random_uuid()` | text PK, app-generated uuidv4 |
| `timestamptz` | ISO-8601 text (UTC) |
| `jsonb` | text holding JSON |
| `text[]` | text holding JSON array |
| `bigint GENERATED … IDENTITY` | integer autoincrement |
| Row-Level Security policies | `org_id` filter enforced in `lib/org-context.ts` |
| `pgvector` / `citext` / `pg_trgm` | omitted (knowledge/embeddings out of slice) |
| money: integer minor units + currency | unchanged (kept faithful) |

`launchos_schema.sql` is **not modified**. `schema.ts` maps every divergence so the
migration path back to Postgres is mechanical.

---

## 4. Data flow — the flywheel

1. **Compose** → `POST /api/v1/posts` → `publishing/service` writes `posts` + one
   `post_targets` per selected account (status `pending` for now / `scheduled` for later).
2. **Publish** → `scheduler` poller (every few seconds) picks due targets →
   `MockChannelProvider.publish()` → sets `platform_post_id`, `permalink`, status
   `published`; the parent post status rolls up to `published` / `partial` / `failed`.
3. **Touchpoint** → `POST /api/v1/attribution/identify` and
   `POST /api/v1/attribution/touchpoints` → `identities` + `touchpoints`, tagged with
   `channel`, `platform`, `source_type='post'`, `source_id`, optional `campaign_id`/`utm`.
4. **Conversion** → `POST /api/v1/attribution/conversions` → `conversions` row
   (event_name, value_cents).
5. **Attribute** → `GET /api/v1/attribution/report?model=first|last|linear` → `models.ts`
   allocates credit across each conversion's prior touchpoints (within the identity) →
   persists `attribution_results` → returns channel→revenue / campaign→revenue table.
6. **See it** → dashboard KPI tiles, analytics attribution report (model switcher),
   contact journey timeline (`GET /api/v1/journeys/{id}/contacts/{cid}/timeline`).

The **seed** pre-populates a coherent dataset (one campaign, several published posts,
~30 identities with multi-touch paths ending in signups/purchases) so all three
attribution models produce different, sensible numbers immediately.

---

## 5. Error handling

- All API errors as RFC-9457 problem+json `{type,title,status,detail,code,request_id}`
  (§3.1) via `lib/errors.ts`. Codes are stable strings.
- Per-target publish failures are isolated and retryable (`POST /posts/{id}/retry`); the
  mock provider exposes a deterministic "fail this handle" hook so partial/failed/retry
  states are demonstrable.
- `Idempotency-Key` honored on `POST /posts` (dedupe table) per §3.1.
- Auth: unauthenticated → 401 problem+json; cross-org access → 404 (no existence leakage).

---

## 6. Testing (TDD)

Vitest unit tests drive the service layer, written before implementation:

- `attribution/models` — first/last/linear credit always sums to 1.0; known fixtures →
  known allocations. (Highest-value tests; this is the differentiator.)
- `attribution/identity` — anonymous→contact stitching merges prior touchpoint history.
- `publishing/service` — multi-target create; partial-failure rollup; retry transitions.
- `channel/mock` — deterministic publish + forced-failure hook.
- `org-context` — queries never cross org boundaries.

Plus a few API route smoke tests over the flywheel. No UI E2E in this slice (manual
verification against the seeded dataset).

---

## 7. Explicitly out of this slice (each has a named seam)

AI gateway / Viral Generator / Campaign Brain; real platform OAuth; Stripe billing;
inbox / messaging / CRM write flows beyond contacts read; ads; agents + autonomy;
Temporal; pgvector / RAG; SDK / MCP generation; white-label theming;
time-decay & data-driven attribution models; browser pixel + public landing pages.

---

## 8. Acceptance criteria

- `npm install && npm run dev` boots the app against a seeded SQLite DB with zero manual
  setup; login with the seeded demo user works.
- Composer publishes one post to N (mock) accounts; per-target chips show
  published/partial/failed; a failed target retries successfully.
- Attribution report switches between first/last/linear and the credited revenue
  re-allocates correctly and reconciles to total ingested conversion value.
- A contact detail page shows a chronological journey across channels ending in a
  conversion.
- All `lib/*` service tests pass (`npm test`).
- No secret/token ever reaches the client; all errors are problem+json.
```
