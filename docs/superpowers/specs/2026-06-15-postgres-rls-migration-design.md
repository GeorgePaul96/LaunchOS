# Postgres + RLS Migration — Design

**Date:** 2026-06-15
**Status:** Approved (pending written-spec review)
**Phase:** P1.1 (production foundation — first sub-project)
**Source:** `docs/IMPLEMENTATION-ROADMAP.md` §4.1, `LaunchOS-Spec.md` §2/§9, `launchos_schema.sql`

---

## 0. Context & decisions

The app currently runs on SQLite via libsql (the P0 flywheel slice), with `org_id` query
filters substituting for Row-Level Security. P1 hardens the foundation; this first sub-project
moves to **real Postgres with enforced RLS multi-tenancy**, with **zero feature change**.

Decisions locked during brainstorming:
- **First P1 sub-project:** Postgres + RLS migration (the foundation the other five P1
  subsystems depend on).
- **Where Postgres runs:** **PGlite** (`@electric-sql/pglite`, real Postgres compiled to
  WASM, zero native build) for local dev and tests; **managed Postgres** (Neon/RDS/Fly) for
  production via `DATABASE_URL`. Both go through Drizzle. This mirrors the libsql swap that
  already solved the no-native-toolchain constraint on this machine. PGlite supports RLS,
  policies, and pgvector.
- **RLS context binding:** Approach A — a request/job-scoped transaction sets
  `SET LOCAL app.current_org`; service signatures stay `(db, orgId, …)`; the existing `org_id`
  filters remain as defense-in-depth (spec §9 wants both).
- **Table scope now:** port the **current 19-table subset** in `db/schema.ts` to Postgres.
  The other ~40 canonical tables are added per-feature later, not in this sub-project.

Goal: same screens, same API, same 36 tests passing — on Postgres, with tenant isolation
provable at the database layer.

---

## 1. Architecture

### 1.1 Driver selection (`db/client.ts`)
Chosen by `DATABASE_URL`:
- unset, or `pglite://<path>` / a bare path → **PGlite** via `drizzle-orm/pglite`.
  - dev: persistent data directory `.pgdata/` (gitignored).
  - test: in-memory (`new PGlite()` with no path).
- `postgres://…` or `postgresql://…` → **node-postgres** (`pg`) via
  `drizzle-orm/node-postgres` for production.

The module exports the same `db` (default/service handle), `schema`, and a `DB` type so most
imports are unchanged. It additionally exports the org-scoping helpers below.

### 1.2 RLS context binding (Approach A)
```
withOrg(orgId, async (tx) => { ...services run here... })
```
- Opens a transaction, executes `SET LOCAL ROLE app_user; SET LOCAL app.current_org = '<orgId>'`,
  and invokes the callback with a transaction-bound Drizzle handle `tx`. All queries on `tx`
  run as the non-privileged `app_user` role and are therefore subject to the org's RLS
  policies. On commit/rollback the `SET LOCAL` role + GUC reset automatically.
- `withServiceRole(async (tx) => …)` — a path for cross-org workers (e.g. the publish
  scheduler) that must see all orgs. It runs in a transaction **without** switching to
  `app_user`, i.e. as the default connection role (superuser in PGlite / a `BYPASSRLS` role
  in managed Postgres), which bypasses RLS. This is the single, explicit, greppable escape
  hatch.

`lib/request.ts` (`requireContext`) and `lib/page-data.ts` (`getOrgContextOrRedirect`) resolve
the session, then return a context whose `db` is a handle already scoped via `withOrg`, so
existing calls `service(db, orgId, …)` run inside the right RLS scope with no signature changes.

### 1.3 Migrations
- `drizzle-kit generate` (dialect `postgresql`) emits SQL migrations into `db/migrations/`.
- A hand-written follow-on migration: (a) creates the non-privileged role
  `CREATE ROLE app_user NOLOGIN;` and grants it `SELECT/INSERT/UPDATE/DELETE` on all
  org-scoped tables + usage on sequences; (b) for each org-scoped table,
  `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` and
  `CREATE POLICY org_isolation_<t> ON <t> USING (org_id = current_setting('app.current_org', true)::uuid) WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);`
  The `WITH CHECK` clause also blocks cross-org *writes*.
- `db/migrate.ts` applies all migrations via the Drizzle migrator — used by dev boot, test
  setup, and the production deploy step. This **replaces** the `test/schema.sql` snapshot.

### 1.4 Why a separate role (not just FORCE)
Postgres **always** bypasses RLS for superusers and `BYPASSRLS` roles, and skips RLS for a
table's owner unless `FORCE ROW LEVEL SECURITY` is set. PGlite's only connection is a
superuser, so running app queries directly would silently bypass RLS — making isolation
untestable and unsafe. Therefore app queries switch to the non-privileged `app_user` role
(`SET LOCAL ROLE app_user`), for which RLS is fully enforced; `FORCE RLS` is still set so the
posture is correct even where the app connects as a table owner in managed Postgres. The
default (superuser/`BYPASSRLS`) role is reserved for `withServiceRole` cross-org jobs.

---

## 2. Data model (sqlite-core → pg-core)

Port `db/schema.ts` (19 tables) to `drizzle-orm/pg-core`, matching `launchos_schema.sql`
native types:

| SQLite (current) | Postgres (target) |
|---|---|
| `text` PK | `uuid` PK, default `gen_random_uuid()` |
| ISO-8601 text timestamps | `timestamptz` (default `now()`) |
| JSON-in-text | `jsonb` |
| JSON-array-in-text (`text[]` cols) | native `text[]` |
| integer autoincrement (`touchpoints`, `conversions`, `attribution_results`) | `bigint generated always as identity` |
| integer-as-boolean (`platforms.is_active`, `posts.publish_now`) | `boolean` |
| `attribution_results.credit` as basis points (int) | `numeric` fraction (revert workaround) |
| money cents | unchanged (`integer`/`bigint` cents) |

- Add `pgcrypto` extension (for `gen_random_uuid()`).
- Every org-scoped table: RLS enabled + forced + `org_isolation` policy (§1.3).
- `app.current_org` GUC must be registered/usable — `current_setting('app.current_org', true)`
  with the `true` (missing_ok) flag means an unset GUC returns NULL → policy fails closed.
- Keep `org_id` filters in services (`lib/org-context.ts`, all `lib/*` services) unchanged.

The basis-points→numeric revert touches `lib/attribution/report.ts` (store the fraction
directly) and its test expectation — the only feature-code change in this sub-project.

---

## 3. Data flow (unchanged for features)

A request: resolve session → `withOrg(orgId)` opens tx + sets GUC → existing route/service
code runs identical queries → RLS + `org_id` filter both scope the data → response. The
publish scheduler runs under `withServiceRole` so it can fire due posts across all orgs, then
calls the same `publishTarget` service.

---

## 4. Error handling

- Unset/invalid `app.current_org`: policies fail closed (zero rows). Surfaces as existing
  empty/404 behavior; never a cross-org leak.
- Connection/driver/transaction errors: mapped to the existing RFC-9457 `internal_error`.
- Migration failure on boot: abort loudly with the failing migration name.
- `withServiceRole` is the only way to read cross-org; using it is explicit and greppable.

---

## 5. Testing

- **Test harness:** fresh in-memory PGlite per test file; run migrations; expose `withOrg` /
  `withServiceRole` and the existing `seedOrg`/`seedAccount` helpers (now writing through an
  org scope).
- **Headline isolation test (new):** with `app.current_org = orgA`, a raw `SELECT` against an
  org-B table row (bypassing the app-level `org_id` filter) returns **zero rows**; switching
  the GUC to orgB returns it. Proves RLS independent of the filters.
- **Service-role test (new):** `withServiceRole` reads rows across two orgs (scheduler path).
- **Regression:** all 36 existing tests pass against the Postgres-backed test DB (signatures
  unchanged; only the attribution credit assertion changes from basis points to fraction).
- **Build/boot:** `npm run setup` (migrate + seed) on PGlite, `npm run dev` boots, production
  build green.

---

## 6. Out of scope

Other P1 sub-projects (durable runtime, AI gateway, billing, OpenAPI→SDK→MCP, observability);
the ~40 not-yet-used canonical tables; provisioning an actual managed Postgres instance (prod
is wired by `DATABASE_URL` only, not stood up here); pgvector-backed features (extension
available but no RAG yet).

---

## 7. Acceptance criteria

- App runs on PGlite locally with zero install: `npm run setup && npm run dev` works; login +
  all screens render against Postgres-backed data.
- RLS is **enforced and proven**: the isolation test passes; cross-org reads return nothing
  even when the app-level filter is bypassed.
- `withServiceRole` enables the scheduler to operate across orgs.
- All 36 prior tests pass (plus the 2 new RLS tests); production build green.
- Swapping `DATABASE_URL` to a `postgres://` URL runs the same migrations against managed
  Postgres with no code change.
- No feature behavior changed; no secrets/tokens logged or returned.
