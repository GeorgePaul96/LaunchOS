# Postgres + RLS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app off SQLite/libsql onto real Postgres (PGlite in-process for dev/test, managed Postgres via `DATABASE_URL` for prod) with **enforced** Row-Level Security multi-tenancy, with zero feature/behavior change.

**Architecture:** Drizzle `pg-core` schema with logical types preserved (text/integer/boolean — native uuid/timestamptz/jsonb fidelity deferred). Tenant isolation via a non-privileged `app_user` role + `SET LOCAL app.current_org`, applied through a `withOrg(orgId, fn)` transaction wrapper. Service signatures `(db, orgId, …)` and all 36 tests stay unchanged; the `org_id` query filters remain as defense-in-depth. Workers/auth use the base (service-role) connection that bypasses RLS.

**Tech Stack:** `@electric-sql/pglite` 0.5.2, `pg` 8.21, `drizzle-orm` 0.45 (`/pglite` + `/node-postgres`), `drizzle-kit` 0.31 (postgresql dialect, offline `generate`), Vitest 4, Next.js 16.

**Reference:** `docs/superpowers/specs/2026-06-15-postgres-rls-migration-design.md`.

**Conventions:** run commands from repo root `c:/Users/georg/OneDrive/Desktop/Projects/LaunchOS`. Commit after each task with the message shown. This is an infrastructure swap: the existing test suite cannot run between Task 2 and Task 5 (the DB layer is mid-rewrite) — that is expected; Task 5 restores green, Task 7 adds the new RLS tests.

---

## File Structure

```
package.json          deps: -@libsql/client +@electric-sql/pglite +pg +@types/pg; scripts: -db:push +db:generate +db:migrate
drizzle.config.ts     dialect postgresql
.gitignore            + .pgdata/
db/schema.ts          rewritten in pg-core (same logical types)
db/client.ts          driver select (pglite|pg) + db + scopeToOrg + withOrg + withServiceRole + runMigrations
db/migrate.ts         CLI wrapper that calls runMigrations()
db/migrations/        generated 0000_*.sql + custom 0001_rls.sql + meta/_journal.json
db/seed.ts            unchanged logic (uses base db / service role)
instrumentation.ts    run migrations on boot, then start scheduler
lib/request.ts        requireContext returns { orgId, userId, withOrg }
lib/page-data.ts      getOrgContextOrRedirect returns { orgId, userId, withOrg }
app/api/v1/**/route.ts   wrap DB work in ctx.withOrg (auth routes excepted)
app/(app)/**/page.tsx    wrap DB reads in ctx.withOrg
test/helpers.ts       in-memory PGlite + migrate; exposes scopeToOrg/withServiceRole
test/rls.test.ts      NEW: proves isolation + service-role bypass
test/schema.sql       DELETED (replaced by migrations)
```

---

## Task 1: Swap database dependencies and config

**Files:** Modify `package.json`, `drizzle.config.ts`, `.gitignore`

- [ ] **Step 1: Update `package.json` deps + scripts**

Replace the `@libsql/client` dependency and the `db:push`/`setup` scripts. The dependencies block becomes:
```json
  "dependencies": {
    "@electric-sql/pglite": "^0.5.2",
    "drizzle-orm": "^0.45.2",
    "next": "^16.2.9",
    "pg": "^8.21.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
```
Add `"@types/pg": "^8.20.0"` to `devDependencies` (keep the rest).
The scripts block becomes:
```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx db/migrate.ts",
    "db:seed": "tsx db/seed.ts",
    "setup": "npm run db:migrate && npm run db:seed",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 2: Replace `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
});
```

- [ ] **Step 3: Add PGlite data dir + remove old db files from ignore noise**

Append to `.gitignore`:
```
.pgdata/
```

- [ ] **Step 4: Install and remove the old SQLite DB file**

Run (Git Bash): `rm -f launchos.db launchos.db-shm launchos.db-wal && npm install`
Expected: installs `@electric-sql/pglite`, `pg`, `@types/pg`; removes `@libsql/client`.

- [ ] **Step 5: Smoke-test PGlite loads**

Run: `node --input-type=module -e "import {PGlite} from '@electric-sql/pglite'; const c=new PGlite(); await c.exec('create table t(x int); insert into t values (1);'); const r=await c.query('select count(*)::int as n from t'); console.log('pglite ok', r.rows[0].n)"`
Expected: `pglite ok 1`

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json drizzle.config.ts .gitignore
git commit -m "chore(db): swap libsql->pglite/pg deps + postgresql drizzle config"
```

---

## Task 2: Rewrite the schema in pg-core (same logical types)

**Files:** Replace `db/schema.ts`

- [ ] **Step 1: Replace `db/schema.ts`**

```ts
// Postgres schema (drizzle-orm/pg-core), logical types preserved from the SQLite slice so
// service code + tests are unchanged. Native-type fidelity (uuid/timestamptz/jsonb/numeric)
// is deferred — see docs/superpowers/specs/2026-06-15-postgres-rls-migration-design.md §2.
// Driver: PGlite (dev/test) / node-postgres (prod). Canonical source: launchos_schema.sql.
import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";

const now = () => new Date().toISOString();

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  brandSettings: text("brand_settings").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("owner"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  brandVoice: text("brand_voice").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const platforms = pgTable("platforms", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),
  capabilities: text("capabilities").notNull().default("[]"),
  isActive: boolean("is_active").notNull().default(true),
});

export const socialAccounts = pgTable("social_accounts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  platform: text("platform").notNull().references(() => platforms.key),
  platformUserId: text("platform_user_id").notNull(),
  username: text("username"),
  displayName: text("display_name"),
  status: text("status").notNull().default("connected"),
  metadata: text("metadata").notNull().default("{}"),
  connectedAt: text("connected_at").notNull().$defaultFn(now),
});

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  goalMetric: text("goal_metric"),
  goalTarget: integer("goal_target"),
  budgetCents: integer("budget_cents"),
  status: text("status").notNull().default("planning"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  createdBy: text("created_by").references(() => users.id),
  content: text("content"),
  mediaIds: text("media_ids").notNull().default("[]"),
  status: text("status").notNull().default("draft"),
  scheduledFor: text("scheduled_for"),
  publishNow: boolean("publish_now").notNull().default(false),
  origin: text("origin").notNull().default("manual"),
  originRef: text("origin_ref"),
  campaignId: text("campaign_id").references(() => campaigns.id),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const postTargets = pgTable("post_targets", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull().references(() => posts.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  accountId: text("account_id").notNull().references(() => socialAccounts.id),
  platform: text("platform").notNull().references(() => platforms.key),
  contentOverride: text("content_override"),
  options: text("options").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  platformPostId: text("platform_post_id"),
  permalink: text("permalink"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  attempts: integer("attempts").notNull().default(0),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const accountMetricsDaily = pgTable("account_metrics_daily", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  accountId: text("account_id").notNull().references(() => socialAccounts.id),
  day: text("day").notNull(),
  followers: integer("followers"),
  impressions: integer("impressions"),
  reach: integer("reach"),
  engagement: integer("engagement"),
});

export const contacts = pgTable("contacts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").references(() => profiles.id),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  tags: text("tags").notNull().default("[]"),
  identityId: text("identity_id"),
  lifecycleStage: text("lifecycle_stage").notNull().default("lead"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const contactChannels = pgTable("contact_channels", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  accountId: text("account_id").references(() => socialAccounts.id),
  platform: text("platform").notNull().references(() => platforms.key),
  platformIdentifier: text("platform_identifier").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const identities = pgTable("identities", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  anonymousId: text("anonymous_id"),
  contactId: text("contact_id").references(() => contacts.id),
  externalUserId: text("external_user_id"),
  traits: text("traits").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const touchpoints = pgTable("touchpoints", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  identityId: text("identity_id").references(() => identities.id),
  channel: text("channel").notNull(),
  platform: text("platform"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  campaignId: text("campaign_id").references(() => campaigns.id),
  utm: text("utm").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull().$defaultFn(now),
});

export const conversions = pgTable("conversions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  identityId: text("identity_id").references(() => identities.id),
  eventName: text("event_name").notNull(),
  valueCents: integer("value_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  occurredAt: text("occurred_at").notNull().$defaultFn(now),
  metadata: text("metadata").notNull().default("{}"),
});

export const attributionResults = pgTable("attribution_results", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  conversionId: integer("conversion_id").notNull().references(() => conversions.id),
  model: text("model").notNull(),
  touchpointId: integer("touchpoint_id").references(() => touchpoints.id),
  credit: integer("credit").notNull(), // basis points 0..10000 (numeric fidelity deferred)
  creditedValueCents: integer("credited_value_cents").notNull().default(0),
});

export const journeys = pgTable("journeys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").references(() => profiles.id),
  name: text("name").notNull(),
  stages: text("stages").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  orgId: text("org_id").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
```

- [ ] **Step 2: Commit (type-check deferred to Task 3 — `db/client.ts` still references libsql)**

```bash
git add db/schema.ts
git commit -m "feat(db): rewrite schema in pg-core (logical types preserved)"
```

---

## Task 3: Driver-selecting client + RLS scoping + migration runner

**Files:** Replace `db/client.ts`; Create `db/migrate.ts`

- [ ] **Step 1: Replace `db/client.ts`**

```ts
import { sql } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// A query handle: the base db OR a transaction. Services accept this.
export type DB = PgDatabase<any, any, any>;

const url = process.env.DATABASE_URL ?? "";
const isPg = url.startsWith("postgres://") || url.startsWith("postgresql://");

// Lazily resolve the driver so the unused one is never imported at runtime.
function makeDb() {
  if (isPg) {
    // production: managed Postgres
    const { drizzle } = require("drizzle-orm/node-postgres");
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: url });
    return { db: drizzle(pool, { schema }) as unknown as DB, kind: "pg" as const };
  }
  // dev/test: PGlite (in-process). url forms: "" (default dir), "pglite://<dir>", or a path.
  const { drizzle } = require("drizzle-orm/pglite");
  const { PGlite } = require("@electric-sql/pglite");
  const dir = url.startsWith("pglite://") ? url.slice("pglite://".length) : (url || ".pgdata");
  const client = new PGlite(dir);
  return { db: drizzle(client, { schema }) as unknown as DB, kind: "pglite" as const };
}

const resolved = makeDb();
export const db = resolved.db;
export const driverKind = resolved.kind;
export { schema };

// Run all migrations (schema + RLS). Idempotent (drizzle journal tracks applied ones).
export async function runMigrations(): Promise<void> {
  if (driverKind === "pg") {
    const { migrate } = require("drizzle-orm/node-postgres/migrator");
    await migrate(db as any, { migrationsFolder: "db/migrations" });
  } else {
    const { migrate } = require("drizzle-orm/pglite/migrator");
    await migrate(db as any, { migrationsFolder: "db/migrations" });
  }
}

// Tenant-scoped execution: runs `fn` in a transaction as the non-privileged app_user role
// with app.current_org set, so RLS policies apply. Used for all per-org request/page work.
export async function scopeToOrg<T>(database: DB, orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    await tx.execute(sql`set local role app_user`);
    return fn(tx as unknown as DB);
  });
}

export function withOrg<T>(orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return scopeToOrg(db, orgId, fn);
}

// Service-role execution: cross-org work (workers/auth). No role switch → RLS bypassed
// (superuser in PGlite / BYPASSRLS role in managed Postgres).
export function withServiceRole<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as DB));
}
```

Note: `require(...)` is used for the drivers so only the selected one loads (avoids pulling `pg` into the PGlite path and vice-versa). `serverExternalPackages` already lists nothing DB-specific; add `"pg"` and `"@electric-sql/pglite"` there if Next complains (see Task 6).

- [ ] **Step 2: Create `db/migrate.ts`**

```ts
import { runMigrations } from "./client";

runMigrations()
  .then(() => { console.log("[migrate] done"); process.exit(0); })
  .catch((e) => { console.error("[migrate] failed", e); process.exit(1); });
```

- [ ] **Step 3: Commit**

```bash
git add db/client.ts db/migrate.ts
git commit -m "feat(db): driver-selecting client + RLS scoping helpers + migration runner"
```

---

## Task 4: Generate migrations + author the RLS migration

**Files:** Create `db/migrations/*` (generated + custom)

- [ ] **Step 1: Generate the schema migration**

Run: `npm run db:generate`
Expected: creates `db/migrations/0000_*.sql` (CREATE TABLE for all 19 tables) and `db/migrations/meta/_journal.json`.

- [ ] **Step 2: Create an empty custom migration for RLS**

Run: `npx drizzle-kit generate --custom --name rls_policies`
Expected: creates `db/migrations/0001_rls_policies.sql` (empty) and updates the journal.

- [ ] **Step 3: Fill `db/migrations/0001_rls_policies.sql`**

```sql
-- Non-privileged application role: RLS policies apply to it (unlike the superuser/owner).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Enable + FORCE RLS and add an org-isolation policy on every org-scoped table.
-- org_id stays text, so compare directly to the GUC (no ::uuid cast).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'memberships','api_keys','profiles','social_accounts','campaigns','posts',
    'post_targets','account_metrics_daily','contacts','contact_channels','identities',
    'touchpoints','conversions','attribution_results','journeys','idempotency_keys'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY org_isolation_%1$s ON %1$I
        USING (org_id = current_setting('app.current_org', true))
        WITH CHECK (org_id = current_setting('app.current_org', true))
    $f$, t);
  END LOOP;
END $$;
```

- [ ] **Step 4: Verify migrations apply to a scratch PGlite**

Run: `node --input-type=module -e "
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
const db = drizzle(new PGlite(), {});
await migrate(db, {migrationsFolder:'db/migrations'});
const r = await db.execute(\"select count(*)::int as n from pg_policies where policyname like 'org_isolation_%'\");
console.log('policies', r.rows[0].n);
"`
Expected: `policies 16`

- [ ] **Step 5: Commit**

```bash
git add db/migrations
git commit -m "feat(db): generated schema migration + RLS role/policies migration"
```

---

## Task 5: Port the test harness to PGlite + restore the suite

**Files:** Replace `test/helpers.ts`; Delete `test/schema.sql`

- [ ] **Step 1: Replace `test/helpers.ts`**

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";
import type { DB } from "@/db/client";

// Fresh in-memory Postgres per call: migrate (schema + RLS) and return the base handle.
export async function makeTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db as any, { migrationsFolder: "db/migrations" });
  return db;
}

export type TestDB = Awaited<ReturnType<typeof makeTestDb>>;

// Org-scoped execution against a specific test db (mirrors lib/db client.scopeToOrg).
export async function scopeToOrg<T>(database: TestDB, orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    await tx.execute(sql`set local role app_user`);
    return fn(tx as unknown as DB);
  });
}

// Existing tests use the base handle directly (service role; RLS bypassed) — unchanged.
export async function seedOrg(db: TestDB) {
  const orgId = uuid();
  const profileId = uuid();
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Acme", slug: "acme-" + orgId.slice(0, 8),
  });
  await db.insert(schema.profiles).values({
    id: profileId, publicId: publicId("prof"), orgId, name: "Acme Brand",
  });
  await db.insert(schema.platforms).values([
    { key: "twitter", displayName: "X", category: "social" },
    { key: "linkedin", displayName: "LinkedIn", category: "social" },
  ]);
  return { orgId, profileId };
}

export async function seedAccount(db: TestDB, orgId: string, profileId: string, platform = "twitter") {
  const id = uuid();
  await db.insert(schema.socialAccounts).values({
    id, publicId: publicId("acc"), orgId, profileId, platform,
    platformUserId: "u_" + id.slice(0, 6), username: platform + "_acme",
  });
  return id;
}
```

- [ ] **Step 2: Delete the obsolete snapshot**

Run: `rm -f test/schema.sql`

- [ ] **Step 3: Run the full existing suite against Postgres**

Run: `npm test`
Expected: all 12 files / 36 tests PASS (logical types preserved → assertions unchanged).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0. (If errors reference `test/schema.sql` or libsql, ensure no stragglers import them.)

- [ ] **Step 5: Commit**

```bash
git add test/helpers.ts
git rm --cached test/schema.sql 2>/dev/null; true
git commit -m "test: PGlite-backed harness + migrations; drop sqlite snapshot"
```

---

## Task 6: Wire RLS context into requests, pages, and workers

**Files:** Modify `lib/request.ts`, `lib/page-data.ts`, all `app/api/v1/**/route.ts`, all `app/(app)/**/page.tsx` server pages, `lib/publishing/scheduler.ts` (already uses base db — verify), `next.config.ts`

- [ ] **Step 1: `lib/request.ts` — return a bound `withOrg`**

```ts
import { cookies } from "next/headers";
import { withOrg as withOrgScoped, type DB } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export interface RequestContext {
  orgId: string;
  userId: string;
  withOrg: <T>(fn: (db: DB) => Promise<T>) => Promise<T>;
}

export async function requireContext(): Promise<RequestContext> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "unauthorized", "No session");
  const payload = verifySession(token, sessionSecret());
  if (!payload) throw new ApiError(401, "unauthorized", "Invalid session");
  const orgId = payload.orgId;
  return { orgId, userId: payload.userId, withOrg: (fn) => withOrgScoped(orgId, fn) };
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 2: `lib/page-data.ts` — return a bound `withOrg`**

```ts
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withOrg as withOrgScoped, type DB } from "@/db/client";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export async function getOrgContextOrRedirect() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySession(token, sessionSecret()) : null;
  if (!payload) redirect("/login");
  const orgId = payload.orgId;
  return {
    orgId,
    userId: payload.userId,
    withOrg: <T,>(fn: (db: DB) => Promise<T>) => withOrgScoped(orgId, fn),
  };
}
```

- [ ] **Step 3: `app/api/v1/accounts/route.ts`**

```ts
import { listAccounts } from "@/lib/org-context";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listAccounts(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 4: `app/api/v1/posts/route.ts`**

```ts
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { createPost, listPosts } from "@/lib/publishing/service";

export async function GET() {
  try {
    const ctx = await requireContext();
    const data = await ctx.withOrg((db) => listPosts(db, ctx.orgId));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const idemKey = req.headers.get("Idempotency-Key");
    const body = await req.json();
    if (!body.profileId || !Array.isArray(body.accountIds)) {
      throw new ApiError(400, "invalid_request", "profileId and accountIds[] required");
    }
    const responseBody = await ctx.withOrg(async (db) => {
      if (idemKey) {
        const [hit] = await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, idemKey));
        if (hit) return JSON.parse(hit.responseJson);
      }
      const post = await createPost(db, ctx.orgId, {
        profileId: body.profileId,
        content: body.content ?? "",
        accountIds: body.accountIds,
        scheduledFor: body.scheduledFor ?? null,
        campaignId: body.campaignId ?? null,
        overrides: body.overrides,
      });
      const out = { post: { id: post.publicId, status: post.status } };
      if (idemKey) {
        await db.insert(schema.idempotencyKeys).values({ key: idemKey, orgId: ctx.orgId, responseJson: JSON.stringify(out) });
      }
      return out;
    });
    return ok(responseBody, 202);
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 5: `app/api/v1/posts/[id]/retry/route.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { retryTarget } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext();
    const { id } = await params;
    const retried = await ctx.withOrg(async (db) => {
      const [post] = await db.select().from(schema.posts).where(and(eq(schema.posts.publicId, id), eq(schema.posts.orgId, ctx.orgId)));
      if (!post) throw new ApiError(404, "not_found", "Post not found");
      const failed = await db.select().from(schema.postTargets).where(and(eq(schema.postTargets.postId, post.id), eq(schema.postTargets.status, "failed")));
      const provider = new MockChannelProvider();
      for (const t of failed) await retryTarget(db, ctx.orgId, t.id, provider);
      return failed.length;
    });
    return ok({ retried });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 6: `app/api/v1/attribution/identify/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { identify } from "@/lib/attribution/identity";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.anonymousId) throw new ApiError(400, "invalid_request", "anonymousId required");
    const id = await ctx.withOrg((db) => identify(db, ctx.orgId, body));
    return ok({ identity_id: id });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 7: `app/api/v1/attribution/touchpoints/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { recordTouchpoint } from "@/lib/attribution/ingest";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.identityId || !body.channel) throw new ApiError(400, "invalid_request", "identityId and channel required");
    const id = await ctx.withOrg((db) => recordTouchpoint(db, ctx.orgId, body));
    return ok({ touchpoint_id: id }, 201);
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 8: `app/api/v1/attribution/conversions/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { recordConversion } from "@/lib/attribution/ingest";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.identityId || !body.eventName) throw new ApiError(400, "invalid_request", "identityId and eventName required");
    const id = await ctx.withOrg((db) => recordConversion(db, ctx.orgId, body));
    return ok({ conversion_id: id }, 201);
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 9: `app/api/v1/attribution/report/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { buildReport } from "@/lib/attribution/report";
import type { AttributionModel } from "@/lib/attribution/models";

const MODELS = ["first_touch", "last_touch", "linear"];

export async function GET(req: Request) {
  try {
    const ctx = await requireContext();
    const model = (new URL(req.url).searchParams.get("model") ?? "linear") as AttributionModel;
    if (!MODELS.includes(model)) throw new ApiError(400, "invalid_request", `model must be one of ${MODELS.join(", ")}`);
    const report = await ctx.withOrg((db) => buildReport(db, ctx.orgId, model));
    return ok(report);
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 10: `app/api/v1/journeys/contacts/[cid]/timeline/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { contactTimeline } from "@/lib/journey/timeline";

export async function GET(_req: Request, { params }: { params: Promise<{ cid: string }> }) {
  try {
    const ctx = await requireContext();
    const { cid } = await params;
    const data = await ctx.withOrg((db) => contactTimeline(db, ctx.orgId, cid));
    return ok({ data });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 11: Auth routes use the base service-role db (no withOrg)**

Auth has no org context yet, so it must use the base connection. Edit the three auth routes to import `db` from `@/db/client` (they already do) and leave their logic unchanged — they create/read across orgs as the service role. **No code change needed** beyond confirming `app/api/v1/auth/{signup,login,logout}/route.ts` import `db` from `@/db/client` (they do). Verify by reading each; make no edits if already correct.

- [ ] **Step 12: `app/(app)/dashboard/page.tsx` — wrap reads in withOrg**

```tsx
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { buildReport } from "@/lib/attribution/report";
import { listPosts } from "@/lib/publishing/service";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ctx = await getOrgContextOrRedirect();
  const { report, posts, accounts } = await ctx.withOrg(async (db) => ({
    report: await buildReport(db, ctx.orgId, "linear"),
    posts: await listPosts(db, ctx.orgId),
    accounts: await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, ctx.orgId)),
  }));
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const attributedRevenue = report.channels.reduce((s, c) => s + c.creditedValueCents, 0);

  const tiles = [
    ["Connected accounts", String(accounts.length)],
    ["Posts", String(posts.length)],
    ["Conversions", String(report.totalConversions)],
    ["Attributed revenue", `$${(attributedRevenue / 100).toFixed(2)}`],
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-4 gap-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-white p-4">
            <div className="text-sm text-neutral-500">{label}</div>
            <div className="text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 mt-8 text-lg font-semibold">Scheduled posts ({scheduled.length})</h2>
      <ul className="space-y-1 text-sm">
        {scheduled.map((p) => <li key={p.id} className="rounded border bg-white px-3 py-2">{p.content} — {p.scheduledFor}</li>)}
        {scheduled.length === 0 && <li className="text-neutral-500">Nothing scheduled.</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 13: `app/(app)/calendar/page.tsx`**

```tsx
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { listPosts } from "@/lib/publishing/service";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const ctx = await getOrgContextOrRedirect();
  const posts = (await ctx.withOrg((db) => listPosts(db, ctx.orgId)))
    .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Calendar</h1>
      <table className="w-full border-collapse text-sm">
        <thead><tr className="text-left text-neutral-500"><th className="p-2">When</th><th className="p-2">Content</th><th className="p-2">Status</th><th className="p-2">Targets</th></tr></thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className="border-t">
              <td className="p-2">{p.scheduledFor?.slice(0, 16).replace("T", " ")}</td>
              <td className="p-2">{p.content}</td>
              <td className="p-2"><span className="rounded bg-neutral-100 px-2 py-0.5">{p.status}</span></td>
              <td className="p-2">
                {p.targets.map((t) => (
                  <span key={t.id} className={`mr-1 rounded px-2 py-0.5 text-xs ${t.status === "published" ? "bg-green-100" : t.status === "failed" ? "bg-red-100" : "bg-neutral-100"}`}>
                    {t.platform}:{t.status}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 14: `app/(app)/contacts/[id]/page.tsx`**

```tsx
import { eq, and } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { contactTimeline } from "@/lib/journey/timeline";

export const dynamic = "force-dynamic";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getOrgContextOrRedirect();
  const { id } = await params;
  const { contact, timeline } = await ctx.withOrg(async (db) => {
    const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, id), eq(schema.contacts.orgId, ctx.orgId)));
    const timeline = contact ? await contactTimeline(db, ctx.orgId, id) : [];
    return { contact, timeline };
  });
  if (!contact) return <div>Contact not found.</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold">{contact.name ?? "Contact"}</h1>
      <div className="mb-6 text-sm text-neutral-500">{contact.email} · {contact.lifecycleStage}</div>
      <h2 className="mb-2 text-lg font-semibold">Journey</h2>
      <ol className="relative space-y-3 border-l pl-4">
        {timeline.map((e, i) => (
          <li key={i} className="text-sm">
            <span className="text-neutral-400">{e.occurredAt.slice(0, 16).replace("T", " ")}</span>{" — "}
            {e.kind === "touchpoint"
              ? <span><b>{e.channel}</b>{e.platform ? ` (${e.platform})` : ""} touch</span>
              : <span className="text-green-700"><b>{e.eventName}</b>{e.valueCents ? ` $${(e.valueCents / 100).toFixed(2)}` : ""}</span>}
          </li>
        ))}
        {timeline.length === 0 && <li className="text-neutral-500">No journey events.</li>}
      </ol>
    </div>
  );
}
```

- [ ] **Step 15: `app/(app)/settings/connections/page.tsx`**

```tsx
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const ctx = await getOrgContextOrRedirect();
  const { accounts, contacts } = await ctx.withOrg(async (db) => ({
    accounts: await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, ctx.orgId)),
    contacts: await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, ctx.orgId)).limit(20),
  }));
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Connections</h1>
      <div className="mb-8 grid grid-cols-3 gap-4">
        {accounts.map((a) => (
          <div key={a.id} className="rounded-lg border bg-white p-4">
            <div className="font-medium">{a.platform}</div>
            <div className="text-sm text-neutral-500">{a.username}</div>
            <div className="mt-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs">{a.status}</div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 text-lg font-semibold">Contacts</h2>
      <ul className="text-sm">
        {contacts.map((c) => (
          <li key={c.id}><a className="underline" href={`/contacts/${c.id}`}>{c.name} · {c.email}</a></li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 16: Confirm the scheduler uses the base (service-role) db**

`lib/publishing/scheduler.ts` already imports `{ db }` from `@/db/client` and calls `publishTarget(db, …)`. The base db is the service role (RLS bypassed), so it correctly fires due posts across all orgs. **No change needed** — verify by reading the file.

- [ ] **Step 17: Add DB packages to `next.config.ts` external list**

```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};
export default nextConfig;
```

- [ ] **Step 18: Type-check + full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc exit 0; all 36 tests still pass (services unchanged; routes/pages now wrap in withOrg but behavior identical).

- [ ] **Step 19: Commit**

```bash
git add lib/request.ts lib/page-data.ts app/api app/\(app\) next.config.ts
git commit -m "feat(rls): bind tenant context via withOrg in requests, pages; service role for workers"
```

---

## Task 7: Prove RLS works (new tests)

**Files:** Create `test/rls.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/rls.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, seedOrg, seedAccount, scopeToOrg, type TestDB } from "./helpers";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("row-level security", () => {
  it("blocks cross-org reads even when the app filter is bypassed", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    await seedAccount(db, a.orgId, a.profileId, "twitter");
    await seedAccount(db, b.orgId, b.profileId, "twitter");

    // Within org A's scope, a RAW select with no org_id filter must see only org A's row.
    const rowsForA = await scopeToOrg(db, a.orgId, async (tx) => {
      const r = await tx.execute(sql`select org_id from social_accounts`);
      return r.rows as { org_id: string }[];
    });
    expect(rowsForA.length).toBe(1);
    expect(rowsForA[0].org_id).toBe(a.orgId);

    // Switching scope to org B sees only org B's row.
    const rowsForB = await scopeToOrg(db, b.orgId, async (tx) => {
      const r = await tx.execute(sql`select org_id from social_accounts`);
      return r.rows as { org_id: string }[];
    });
    expect(rowsForB.length).toBe(1);
    expect(rowsForB[0].org_id).toBe(b.orgId);
  });

  it("blocks cross-org writes (WITH CHECK)", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    // Inside org A's scope, inserting a row tagged with org B must fail the policy.
    await expect(
      scopeToOrg(db, a.orgId, async (tx) => {
        await tx.execute(sql`insert into journeys (id, org_id, name) values ('j1', ${b.orgId}, 'x')`);
      }),
    ).rejects.toThrow();
  });

  it("service role (base db) sees across orgs", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    await seedAccount(db, a.orgId, a.profileId, "twitter");
    await seedAccount(db, b.orgId, b.profileId, "twitter");
    // The base handle is the superuser/service role → RLS bypassed → sees both.
    const r = await db.execute(sql`select count(*)::int as n from social_accounts`);
    expect((r.rows[0] as { n: number }).n).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `npm test -- rls`
Expected: PASS (3 tests). If the first test returns 2 rows, RLS is not enforced — check that `0001_rls_policies.sql` ran (Task 4 Step 4) and that `scopeToOrg` issues `set local role app_user`.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: 13 files / 39 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/rls.test.ts
git commit -m "test(rls): prove org isolation (read+write) and service-role bypass"
```

---

## Task 8: Boot migrations, fresh setup, end-to-end verify, docs

**Files:** Modify `instrumentation.ts`, `README.md`, `docs/IMPLEMENTATION-ROADMAP.md`

- [ ] **Step 1: Run migrations on server boot**

`instrumentation.ts`:
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrations } = await import("@/db/client");
    await runMigrations();
    const { startScheduler } = await import("@/lib/publishing/scheduler");
    startScheduler();
  }
}
```

- [ ] **Step 2: Fresh setup on PGlite**

Run (Git Bash): `rm -rf .pgdata && npm run setup`
Expected: `[migrate] done` then `Seed complete. Login: demo@launchos.com / demo1234`.

- [ ] **Step 3: Update README run instructions**

In `README.md`, replace the "Run it" section body with:
````markdown
```bash
npm install
npm run setup     # runs migrations (creates .pgdata via PGlite) + seeds a demo org
npm run dev       # http://localhost:3000
```

Log in at `/login` with **demo@launchos.com / demo1234**.

Database: PGlite (in-process Postgres) for local dev/test — no install needed. Set
`DATABASE_URL=postgres://…` to point at managed Postgres in production (same migrations,
same code). Tenant isolation is enforced by Postgres Row-Level Security.
````

- [ ] **Step 4: Mark P1.1 done in the roadmap**

In `docs/IMPLEMENTATION-ROADMAP.md`, change the §4.1 heading `### 4.1 ⬜ Postgres + RLS migration` to `### 4.1 ✅ Postgres + RLS migration` and update the P1 row note in the §2 table to reflect that the migration is complete (leave the other P1 items ⬜).

- [ ] **Step 5: Full verification — tests, build**

Run: `npm test && npm run build`
Expected: 39 tests pass; production build exits 0.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Run: `npm run dev`, log in with the seeded creds, confirm `/dashboard`, `/analytics` (toggle models), `/calendar`, a contact page, and `/settings/connections` all render real data; publishing from `/compose` shows published targets on `/calendar` within ~5s. Then stop the server (`taskkill //F //T //PID <pid-on-3000>`).

- [ ] **Step 7: Commit**

```bash
git add instrumentation.ts README.md docs/IMPLEMENTATION-ROADMAP.md
git commit -m "feat(db): boot migrations; docs: PGlite/RLS run notes + roadmap status"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** driver selection (Task 3) ✓; PGlite dev/test + pg prod (Tasks 1,3) ✓;
  `withOrg`/`withServiceRole` Approach A with `app_user` role + `SET LOCAL` (Tasks 3,6) ✓;
  pg-core schema with logical types preserved (Task 2) ✓; RLS enable+force+policy on all 16
  org-scoped tables (Task 4) ✓; migrations replace `test/schema.sql` (Tasks 4,5) ✓;
  `org_id` defense-in-depth filters kept (services untouched) ✓; headline RLS isolation +
  write-block + service-role tests (Task 7) ✓; all 36 prior tests pass unchanged (Task 5) ✓;
  fresh setup + build + `DATABASE_URL` prod path (Tasks 1,3,8) ✓.
- **No placeholders:** every file/route/page edit shows complete code; the only "no change"
  steps (auth routes Step 11, scheduler Step 16) are verifications with the reason stated.
- **Type consistency:** `DB = PgDatabase<any,any,any>` is the single service handle type
  across client, request, page-data, and tests; `scopeToOrg(database, orgId, fn)` and
  `withOrg(orgId, fn)` signatures match between `db/client.ts` and `test/helpers.ts`;
  `requireContext`/`getOrgContextOrRedirect` both return `{ orgId, userId, withOrg }`.
- **Known infra window:** the suite is red between Task 2 and Task 5 (DB layer mid-swap); this
  is inherent to an engine migration and is restored to green in Task 5, with new RLS coverage
  in Task 7.
```
