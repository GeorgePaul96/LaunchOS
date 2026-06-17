# DATABASE.md — LaunchOS

Active schema: **`db/schema.ts`** (Drizzle pg-core). `launchos_schema.sql` is the larger *canonical
vision* schema and is a subset-source, not the running truth. Driver/RLS helpers: `db/client.ts`.

## Engine & drivers
One Postgres schema, two drivers chosen by `DATABASE_URL`:
- **unset →** PGlite (`@electric-sql/pglite`, WASM, in-process) for dev/test. Single connection per `.pgdata`.
- **set →** node-postgres (`pg`) for managed Postgres in production.

Same migrations, same RLS, same code. Logical types are preserved from the original SQLite slice
(text ids/timestamps); newer infra tables (`jobs`, `ai_jobs`, `audit_log`) use native
bigserial/jsonb/timestamptz. Native uuid/timestamptz fidelity for the older tables is a deferred follow-up.

## Tables (24)
**Tenancy & identity:** `organizations`, `users`, `memberships`, `api_keys`, `profiles`, `platforms` (global catalog).
**Social/content:** `social_accounts`, `campaigns`, `posts`, `post_targets`, `account_metrics_daily`.
**Contacts & attribution:** `contacts`, `contact_channels`, `identities`, `touchpoints`, `conversions`, `attribution_results`, `journeys`.
**AI / Viral:** `ai_jobs` (cost ledger), `content_generations`, `content_variants`.
**Infra:** `jobs` (durable queue), `idempotency_keys`, `audit_log`.

## Multi-tenancy = Postgres RLS (read this before writing queries)
- A non-privileged role **`app_user`** carries every org-scoped policy: `org_id = current_setting('app.current_org', true)` with both `USING` and `WITH CHECK`. Tables are `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- Run org-scoped work through **`withOrg(orgId, fn)`** (prod, in `db/client.ts`) / **`scopeToOrg`** (tests, in `test/helpers.ts`): they open a transaction, `set_config('app.current_org', orgId, true)`, `SET LOCAL ROLE app_user`, then run `fn(tx)`.
- **`withServiceRole(fn)`** and the base `db` handle are the superuser/service role → RLS bypassed (used by workers/seed). Use deliberately.
- Always keep explicit `eq(table.orgId, orgId)` filters in queries too — defense-in-depth, and required for the service-role paths.

## Migrations workflow
1. Edit `db/schema.ts`.
2. `npm run db:generate` → drizzle emits a numbered SQL migration + a `meta/*` snapshot (snapshot dir is in `.claudeignore`; don't read it).
3. For RLS on a new table, generate a **custom** migration: `npx drizzle-kit generate --custom --name <x>_rls`, then hand-write:
   ```sql
   GRANT SELECT, INSERT, UPDATE, DELETE ON <t> TO app_user;   -- (+ sequence grant only if the PK is serial/bigserial)
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
   CREATE POLICY org_isolation_<t> ON <t>
     USING (org_id = current_setting('app.current_org', true))
     WITH CHECK (org_id = current_setting('app.current_org', true));
   ```
4. Add the new table to `test/helpers.ts` `ALL_TABLES` (so TRUNCATE-between-tests covers it).
5. `npm run db:migrate` applies; `npm test` proves migrations apply against a fresh PGlite.

Worked example: `db/migrations/0010_*.sql` (tables) + `0011_content_rls.sql` (RLS) for the Viral feature.

## Conventions
- IDs: app-generated `uuid()` text PKs + a `publicId("prefix")` external id (`lib/ids.ts`).
- `created_at` on the older tables is a text ISO string (`$defaultFn`); infra tables use `timestamptz`.
- RLS isolation is regression-tested in `test/rls.test.ts` (and per-feature, e.g. the cross-org test in `test/viral-service.test.ts`).
