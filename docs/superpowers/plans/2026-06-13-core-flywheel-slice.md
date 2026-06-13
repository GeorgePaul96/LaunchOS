# Core Flywheel Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable vertical slice of LaunchOS — compose a post, publish it across mock channels, ingest touchpoints/conversions, and see multi-touch revenue attribution + a contact journey in a seeded dashboard.

**Architecture:** Next.js (App Router) modular monolith. UI → `app/api/v1/*` route handlers → `lib/*` UI-agnostic services → Drizzle/SQLite. The `ChannelProvider` interface and the attribution model functions are the swap seams later slices depend on. SQLite is Postgres-shaped; `org_id` filtering substitutes for RLS.

**Tech Stack:** Next.js 16, React, TypeScript, Tailwind CSS, Drizzle ORM 0.45 + better-sqlite3 12, drizzle-kit 0.31 (push), Vitest 4. Node 20.

**Reference docs:** `LaunchOS-Spec.md` (§3 API conventions, §3.2 endpoint map, §9 security), `launchos_schema.sql` (canonical Postgres schema — the SQLite schema is a faithful subset), `docs/superpowers/specs/2026-06-13-core-flywheel-slice-design.md` (the spec this plan implements).

**Conventions for every task:**
- All money is integer cents. All timestamps are ISO-8601 UTC strings.
- Public IDs are prefixed (`post_`, `acc_`, …) via `lib/ids.ts`.
- API errors are RFC-9457 problem+json via `lib/errors.ts`.
- Every DB query that touches a tenant table filters by `org_id`.
- Run commands from the repo root `c:/Users/georg/OneDrive/Desktop/Projects/LaunchOS`.
- Commit after every task with the message shown.

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, drizzle.config.ts, vitest.config.ts,
  tailwind.config.ts, postcss.config.mjs, instrumentation.ts, .env.local
db/
  schema.ts        all Drizzle tables (subset of launchos_schema.sql)
  client.ts        better-sqlite3 + drizzle instance
  seed.ts          demo org + realistic multi-touch dataset
lib/
  ids.ts           prefixed public id generator
  errors.ts        problem+json helpers + ApiError
  org-context.ts   org-scoped helpers + assertSameOrg
  auth.ts          scrypt password hash + signed-cookie session
  channel/provider.ts   ChannelProvider interface + types
  channel/mock.ts       MockChannelProvider
  publishing/service.ts createPost / listPosts / retryTarget / rollup
  publishing/scheduler.ts  in-process due-target poller
  attribution/identity.ts  identify + identity resolution
  attribution/ingest.ts    recordTouchpoint / recordConversion
  attribution/models.ts    first/last/linear credit allocation
  attribution/report.ts    channel/campaign revenue rollup + recompute
  journey/timeline.ts      merged touchpoints+conversions per contact
app/
  globals.css, layout.tsx
  (auth)/login/page.tsx, (auth)/signup/page.tsx
  (app)/layout.tsx
  (app)/dashboard/page.tsx
  (app)/compose/page.tsx
  (app)/calendar/page.tsx
  (app)/analytics/page.tsx
  (app)/contacts/[id]/page.tsx
  (app)/settings/connections/page.tsx
  api/v1/auth/signup/route.ts, api/v1/auth/login/route.ts, api/v1/auth/logout/route.ts
  api/v1/accounts/route.ts
  api/v1/posts/route.ts, api/v1/posts/[id]/retry/route.ts
  api/v1/attribution/identify/route.ts
  api/v1/attribution/touchpoints/route.ts
  api/v1/attribution/conversions/route.ts
  api/v1/attribution/report/route.ts
  api/v1/journeys/contacts/[cid]/timeline/route.ts
test/
  ids.test.ts, errors.test.ts, org-context.test.ts, auth.test.ts,
  channel-mock.test.ts, publishing.test.ts, identity.test.ts,
  ingest.test.ts, models.test.ts, report.test.ts, journey.test.ts,
  api-flywheel.test.ts, helpers.ts
```

---

## Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `.env.local`, `app/globals.css`, `app/layout.tsx`, `app/(app)/dashboard/page.tsx` (placeholder)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "launchos",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "db:push": "drizzle-kit push",
    "db:seed": "tsx db/seed.ts",
    "setup": "npm run db:push && npm run db:seed",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "drizzle-orm": "^0.45.2",
    "next": "^16.2.9",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "autoprefixer": "^10.4.20",
    "drizzle-kit": "^0.31.10",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create config files**

`next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = { serverExternalPackages: ["better-sqlite3"] };
export default nextConfig;
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
```

`tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

`postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`.env.local`:
```
DATABASE_URL=./launchos.db
SESSION_SECRET=dev-only-secret-change-me
```

- [ ] **Step 4: Create base app shell**

`app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
:root { color-scheme: light dark; }
body { @apply bg-neutral-50 text-neutral-900; }
```

`app/layout.tsx`:
```tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "LaunchOS", description: "Autonomous growth layer" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/(app)/dashboard/page.tsx` (temporary placeholder, replaced in Task 16):
```tsx
export default function DashboardPage() {
  return <main className="p-8">LaunchOS dashboard (placeholder)</main>;
}
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes; `node_modules/` present. (Native `better-sqlite3` compiles or fetches a prebuilt binary for Node 20.)

- [ ] **Step 6: Verify the app builds the type graph**

Run: `npx tsc --noEmit`
Expected: no errors (a `next-env.d.ts` is generated on first `next dev`/`build`; if tsc complains it is missing, run `npx next build` once or create an empty `next-env.d.ts` containing `/// <reference types="next" />` and `/// <reference types="next/image-types/global" />`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + Drizzle + Vitest project"
```

---

## Task 2: Database schema (Drizzle, SQLite subset of canonical schema)

**Files:**
- Create: `db/schema.ts`, `db/client.ts`, `drizzle.config.ts`

- [ ] **Step 1: Create `db/schema.ts`**

```ts
// SQLite subset of launchos_schema.sql (canonical Postgres remains source of truth).
// Divergences from Postgres:
//   uuid PK            -> text (app-generated uuidv4, see lib/ids.ts)
//   timestamptz        -> text (ISO-8601 UTC)
//   jsonb / text[]     -> text holding JSON
//   bigint identity    -> integer autoincrement
//   RLS policies       -> org_id filtering in lib/org-context.ts
//   pgvector/citext    -> omitted (out of slice)
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

const now = () => new Date().toISOString();

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  brandSettings: text("brand_settings").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("owner"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  brandVoice: text("brand_voice").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const platforms = sqliteTable("platforms", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),
  capabilities: text("capabilities").notNull().default("[]"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const socialAccounts = sqliteTable("social_accounts", {
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

export const campaigns = sqliteTable("campaigns", {
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

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  createdBy: text("created_by").references(() => users.id),
  content: text("content"),
  mediaIds: text("media_ids").notNull().default("[]"),
  status: text("status").notNull().default("draft"),
  scheduledFor: text("scheduled_for"),
  publishNow: integer("publish_now", { mode: "boolean" }).notNull().default(false),
  origin: text("origin").notNull().default("manual"),
  originRef: text("origin_ref"),
  campaignId: text("campaign_id").references(() => campaigns.id),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const postTargets = sqliteTable("post_targets", {
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

export const accountMetricsDaily = sqliteTable("account_metrics_daily", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  accountId: text("account_id").notNull().references(() => socialAccounts.id),
  day: text("day").notNull(),
  followers: integer("followers"),
  impressions: integer("impressions"),
  reach: integer("reach"),
  engagement: integer("engagement"),
});

export const contacts = sqliteTable("contacts", {
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

export const contactChannels = sqliteTable("contact_channels", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  accountId: text("account_id").references(() => socialAccounts.id),
  platform: text("platform").notNull().references(() => platforms.key),
  platformIdentifier: text("platform_identifier").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const identities = sqliteTable("identities", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  anonymousId: text("anonymous_id"),
  contactId: text("contact_id").references(() => contacts.id),
  externalUserId: text("external_user_id"),
  traits: text("traits").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const touchpoints = sqliteTable("touchpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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

export const conversions = sqliteTable("conversions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: text("org_id").notNull().references(() => organizations.id),
  identityId: text("identity_id").references(() => identities.id),
  eventName: text("event_name").notNull(),
  valueCents: integer("value_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  occurredAt: text("occurred_at").notNull().$defaultFn(now),
  metadata: text("metadata").notNull().default("{}"),
});

export const attributionResults = sqliteTable("attribution_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: text("org_id").notNull().references(() => organizations.id),
  conversionId: integer("conversion_id").notNull().references(() => conversions.id),
  model: text("model").notNull(),
  touchpointId: integer("touchpoint_id").references(() => touchpoints.id),
  credit: integer("credit").notNull(), // stored as basis points (0..10000) to stay integer
  creditedValueCents: integer("credited_value_cents").notNull().default(0),
});

export const journeys = sqliteTable("journeys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").references(() => profiles.id),
  name: text("name").notNull(),
  stages: text("stages").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  orgId: text("org_id").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
```

Note: `attribution_results.credit` is stored as **basis points (integer 0..10000)** to avoid floats in SQLite; `models.ts` converts to/from fractions. This is a deliberate, documented divergence from the canonical `numeric` column.

- [ ] **Step 2: Create `db/client.ts`**

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "./launchos.db";
const sqlite = new Database(url);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
export { schema };
```

- [ ] **Step 3: Create `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "./launchos.db" },
});
```

- [ ] **Step 4: Push schema to create the database**

Run: `npm run db:push`
Expected: prompts may appear for the first push; accept creating all tables. A `launchos.db` file is created. (drizzle-kit reads `.env.local`? It does NOT automatically — set the var inline if needed: `DATABASE_URL=./launchos.db npm run db:push` via Git Bash, or rely on the config default `./launchos.db`.)

- [ ] **Step 5: Verify tables exist**

Run: `node -e "const d=require('better-sqlite3')('./launchos.db');console.log(d.prepare(\"select name from sqlite_master where type='table' order by name\").all().map(r=>r.name).join(','))"`
Expected: lists `account_metrics_daily,api_keys,attribution_results,campaigns,contact_channels,contacts,conversions,identities,idempotency_keys,journeys,memberships,organizations,platforms,post_targets,posts,profiles,social_accounts,touchpoints,users`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): Drizzle SQLite schema (subset of canonical schema)"
```

---

## Task 3: ID generator (`lib/ids.ts`)

**Files:**
- Create: `lib/ids.ts`, `test/ids.test.ts`

- [ ] **Step 1: Write the failing test**

`test/ids.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { uuid, publicId } from "@/lib/ids";

describe("ids", () => {
  it("uuid returns a v4 uuid", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("uuid values are unique", () => {
    expect(uuid()).not.toBe(uuid());
  });
  it("publicId prefixes and strips dashes", () => {
    const id = publicId("post");
    expect(id.startsWith("post_")).toBe(true);
    expect(id.includes("-")).toBe(false);
    expect(id.length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ids`
Expected: FAIL — cannot resolve `@/lib/ids`.

- [ ] **Step 3: Write minimal implementation**

`lib/ids.ts`:
```ts
import { randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

export function publicId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ids`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ids.ts test/ids.test.ts
git commit -m "feat(lib): prefixed public id generator"
```

---

## Task 4: Error helpers (`lib/errors.ts`)

**Files:**
- Create: `lib/errors.ts`, `test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

`test/errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ApiError, problem, toProblemResponse } from "@/lib/errors";

describe("errors", () => {
  it("problem() builds an RFC-9457 body", () => {
    const body = problem({ status: 400, code: "invalid_request", detail: "bad" });
    expect(body).toMatchObject({
      type: "about:blank",
      title: "invalid_request",
      status: 400,
      detail: "bad",
      code: "invalid_request",
    });
    expect(typeof body.request_id).toBe("string");
  });

  it("ApiError carries status + code", () => {
    const e = new ApiError(404, "not_found", "missing");
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
  });

  it("toProblemResponse maps an ApiError to a Response", async () => {
    const res = toProblemResponse(new ApiError(401, "unauthorized", "no session"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const json = await res.json();
    expect(json.code).toBe("unauthorized");
  });

  it("toProblemResponse maps unknown errors to 500", async () => {
    const res = toProblemResponse(new Error("boom"));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("internal_error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- errors`
Expected: FAIL — cannot resolve `@/lib/errors`.

- [ ] **Step 3: Write minimal implementation**

`lib/errors.ts`:
```ts
import { randomUUID } from "node:crypto";

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  request_id: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export function problem(opts: { status: number; code: string; detail: string }): ProblemBody {
  return {
    type: "about:blank",
    title: opts.code,
    status: opts.status,
    detail: opts.detail,
    code: opts.code,
    request_id: randomUUID(),
  };
}

export function toProblemResponse(err: unknown): Response {
  const e =
    err instanceof ApiError
      ? err
      : new ApiError(500, "internal_error", "An unexpected error occurred");
  const body = problem({ status: e.status, code: e.code, detail: e.detail });
  return new Response(JSON.stringify(body), {
    status: e.status,
    headers: { "content-type": "application/problem+json" },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- errors`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/errors.ts test/errors.test.ts
git commit -m "feat(lib): RFC-9457 problem+json error helpers"
```

---

## Task 5: Test helpers + org-context (`lib/org-context.ts`)

**Files:**
- Create: `test/helpers.ts`, `lib/org-context.ts`, `test/org-context.test.ts`

- [ ] **Step 1: Create the shared test helper (fresh in-memory DB per test file)**

`test/helpers.ts`:
```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";

export type TestDB = ReturnType<typeof drizzle<typeof schema>>;

// Build an isolated in-memory DB whose tables are generated from the Drizzle schema.
// We push the schema by generating SQL via drizzle-kit at dev time; for tests we
// create tables from a checked-in snapshot to keep tests hermetic and fast.
export function makeTestDb(): TestDB {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(readFileSync("test/schema.sql", "utf8"));
  return drizzle(sqlite, { schema });
}

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

- [ ] **Step 2: Generate the test schema snapshot**

Run (Git Bash, from repo root, after Task 2's `db:push` created `launchos.db`):
`node -e "const d=require('better-sqlite3')('./launchos.db');const rows=d.prepare(\"select sql from sqlite_master where type='table' and sql is not null and name not like 'sqlite_%'\").all();require('fs').writeFileSync('test/schema.sql',rows.map(r=>r.sql+';').join('\n'))"`
Expected: creates `test/schema.sql` containing `CREATE TABLE` statements for every table.

- [ ] **Step 3: Write the failing test**

`test/org-context.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import { listAccounts } from "@/lib/org-context";
import { uuid, publicId } from "@/lib/ids";
import * as schema from "@/db/schema";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

describe("org-context", () => {
  it("listAccounts only returns rows for the given org", async () => {
    const a = await seedOrg(db);
    // a second org with its own account
    const orgB = uuid(), profB = uuid();
    await db.insert(schema.organizations).values({ id: orgB, publicId: publicId("org"), name: "B", slug: "b-" + orgB.slice(0,8) });
    await db.insert(schema.profiles).values({ id: profB, publicId: publicId("prof"), orgId: orgB, name: "B brand" });
    await db.insert(schema.socialAccounts).values({ id: uuid(), publicId: publicId("acc"), orgId: orgB, profileId: profB, platform: "twitter", platformUserId: "x" });
    // org A account
    await db.insert(schema.socialAccounts).values({ id: uuid(), publicId: publicId("acc"), orgId: a.orgId, profileId: a.profileId, platform: "twitter", platformUserId: "y" });

    const rows = await listAccounts(db, a.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(a.orgId);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- org-context`
Expected: FAIL — cannot resolve `@/lib/org-context`.

- [ ] **Step 5: Write minimal implementation**

`lib/org-context.ts`:
```ts
import { eq, and } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";

// Central place that enforces tenant isolation (RLS substitute, spec §9).
export async function listAccounts(db: DB, orgId: string) {
  return db
    .select()
    .from(schema.socialAccounts)
    .where(eq(schema.socialAccounts.orgId, orgId));
}

// Guard used by services: throws 404 (not 403) on cross-org access — no leakage.
export function assertSameOrg(orgId: string, rowOrgId: string | undefined | null): void {
  if (!rowOrgId || rowOrgId !== orgId) {
    throw new ApiError(404, "not_found", "Resource not found");
  }
}

export { eq, and };
```

Note: `listAccounts` takes a `DB`-shaped argument; the test passes a Drizzle instance built on the same schema, which is structurally compatible.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- org-context`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add lib/org-context.ts test/org-context.test.ts test/helpers.ts test/schema.sql
git commit -m "feat(lib): org-scoped query helpers + tenant isolation guard"
```

---

## Task 6: Auth — password hashing + signed-cookie session (`lib/auth.ts`)

**Files:**
- Create: `lib/auth.ts`, `test/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`test/auth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, signSession, verifySession } from "@/lib/auth";

describe("auth", () => {
  it("hash + verify round-trips", async () => {
    const h = await hashPassword("hunter2");
    expect(h).not.toBe("hunter2");
    expect(await verifyPassword("hunter2", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("signs and verifies a session token", () => {
    const token = signSession({ userId: "u1", orgId: "o1" }, "secret");
    const payload = verifySession(token, "secret");
    expect(payload).toMatchObject({ userId: "u1", orgId: "o1" });
  });

  it("rejects a tampered token", () => {
    const token = signSession({ userId: "u1", orgId: "o1" }, "secret");
    expect(verifySession(token + "x", "secret")).toBeNull();
    expect(verifySession(token, "other-secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth`
Expected: FAIL — cannot resolve `@/lib/auth`.

- [ ] **Step 3: Write minimal implementation**

`lib/auth.ts`:
```ts
import { scrypt, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const hashBuf = Buffer.from(hash, "hex");
  return hashBuf.length === derived.length && timingSafeEqual(hashBuf, derived);
}

export interface SessionPayload { userId: string; orgId: string; }

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "launchos_session";
export function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? "dev-only-secret-change-me";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth.ts test/auth.test.ts
git commit -m "feat(lib): scrypt password hashing + signed-cookie sessions"
```

---

## Task 7: ChannelProvider interface (`lib/channel/provider.ts`)

**Files:**
- Create: `lib/channel/provider.ts`

This task has no test of its own (it is types + an interface); it is exercised by Task 8.

- [ ] **Step 1: Write the interface**

`lib/channel/provider.ts`:
```ts
// The single seam between "what to post" and "how each platform wants it" (spec §5).
// V1 wraps a provider (Zernio/Ayrshare/Unipile); this slice ships a MockChannelProvider.
export interface PublishInput {
  platform: string;
  accountPlatformUserId: string;
  content: string;
  options?: Record<string, unknown>;
}

export interface PublishResult {
  ok: boolean;
  platformPostId?: string;
  permalink?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface ChannelProvider {
  readonly name: string;
  publish(input: PublishInput): Promise<PublishResult>;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/channel/provider.ts
git commit -m "feat(channel): ChannelProvider interface (the wrap/native seam)"
```

---

## Task 8: MockChannelProvider (`lib/channel/mock.ts`)

**Files:**
- Create: `lib/channel/mock.ts`, `test/channel-mock.test.ts`

- [ ] **Step 1: Write the failing test**

`test/channel-mock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MockChannelProvider } from "@/lib/channel/mock";

describe("MockChannelProvider", () => {
  it("publishes successfully with a platform id + permalink", async () => {
    const p = new MockChannelProvider();
    const r = await p.publish({ platform: "twitter", accountPlatformUserId: "u1", content: "hi" });
    expect(r.ok).toBe(true);
    expect(r.platformPostId).toMatch(/^twitter_/);
    expect(r.permalink).toContain("twitter");
  });

  it("forces failure for accounts in the fail set", async () => {
    const p = new MockChannelProvider({ failAccounts: ["badacc"] });
    const r = await p.publish({ platform: "x", accountPlatformUserId: "badacc", content: "hi" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("provider_rejected");
  });

  it("is deterministic for a given account id", async () => {
    const p = new MockChannelProvider();
    const r1 = await p.publish({ platform: "li", accountPlatformUserId: "u9", content: "a" });
    const r2 = await p.publish({ platform: "li", accountPlatformUserId: "u9", content: "b" });
    expect(r1.platformPostId).toBe(r2.platformPostId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- channel-mock`
Expected: FAIL — cannot resolve `@/lib/channel/mock`.

- [ ] **Step 3: Write minimal implementation**

`lib/channel/mock.ts`:
```ts
import { createHash } from "node:crypto";
import type { ChannelProvider, PublishInput, PublishResult } from "./provider";

export class MockChannelProvider implements ChannelProvider {
  readonly name = "mock";
  private failAccounts: Set<string>;

  constructor(opts: { failAccounts?: string[] } = {}) {
    this.failAccounts = new Set(opts.failAccounts ?? []);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (this.failAccounts.has(input.accountPlatformUserId)) {
      return { ok: false, errorCode: "provider_rejected", errorDetail: "Mock provider rejected this account" };
    }
    const hash = createHash("sha256")
      .update(`${input.platform}:${input.accountPlatformUserId}`)
      .digest("hex")
      .slice(0, 16);
    const platformPostId = `${input.platform}_${hash}`;
    return {
      ok: true,
      platformPostId,
      permalink: `https://mock.local/${input.platform}/${platformPostId}`,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- channel-mock`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/channel/mock.ts test/channel-mock.test.ts
git commit -m "feat(channel): MockChannelProvider with deterministic ids + failure hook"
```

---

## Task 9: Publishing service (`lib/publishing/service.ts`)

**Files:**
- Create: `lib/publishing/service.ts`, `test/publishing.test.ts`

The service: `createPost` writes a post + one target per account; `publishTarget` calls a provider and updates a target; `rollupPostStatus` derives the parent status; `retryTarget` re-attempts a failed target.

- [ ] **Step 1: Write the failing test**

`test/publishing.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, seedAccount, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { createPost, publishTarget, rollupPostStatus, retryTarget } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

describe("publishing service", () => {
  it("createPost writes a post and one target per account", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc1 = await seedAccount(db, orgId, profileId, "twitter");
    const acc2 = await seedAccount(db, orgId, profileId, "linkedin");
    const post = await createPost(db as any, orgId, {
      profileId, content: "Launch day!", accountIds: [acc1, acc2],
    });
    expect(post.status).toBe("scheduled");
    const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    expect(targets).toHaveLength(2);
    expect(targets.every(t => t.status === "pending")).toBe(true);
  });

  it("publishTarget marks a target published via the provider", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const post = await createPost(db as any, orgId, { profileId, content: "hi", accountIds: [acc] });
    const [t] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    await publishTarget(db as any, t.id, new MockChannelProvider());
    const [updated] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, t.id));
    expect(updated.status).toBe("published");
    expect(updated.platformPostId).toBeTruthy();
    expect(updated.attempts).toBe(1);
  });

  it("rolls up to partial when one target fails", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const good = await seedAccount(db, orgId, profileId, "twitter");
    const bad = await seedAccount(db, orgId, profileId, "linkedin");
    const post = await createPost(db as any, orgId, { profileId, content: "hi", accountIds: [good, bad] });
    const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    const badAccount = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, bad));
    const provider = new MockChannelProvider({ failAccounts: [badAccount[0].platformUserId] });
    for (const t of targets) await publishTarget(db as any, t.id, provider);
    const status = await rollupPostStatus(db as any, post.id);
    expect(status).toBe("partial");
  });

  it("retryTarget re-attempts a failed target and can succeed", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const post = await createPost(db as any, orgId, { profileId, content: "hi", accountIds: [acc] });
    const [t] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    const account = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acc));
    // first attempt fails
    await publishTarget(db as any, t.id, new MockChannelProvider({ failAccounts: [account[0].platformUserId] }));
    let [after] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, t.id));
    expect(after.status).toBe("failed");
    // retry with a working provider succeeds
    await retryTarget(db as any, orgId, t.id, new MockChannelProvider());
    [after] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, t.id));
    expect(after.status).toBe("published");
    expect(after.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- publishing`
Expected: FAIL — cannot resolve `@/lib/publishing/service`.

- [ ] **Step 3: Write minimal implementation**

`lib/publishing/service.ts`:
```ts
import { eq, and, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { uuid, publicId } from "@/lib/ids";
import { ApiError } from "@/lib/errors";
import { assertSameOrg } from "@/lib/org-context";
import type { ChannelProvider } from "@/lib/channel/provider";

export interface CreatePostInput {
  profileId: string;
  content: string;
  accountIds: string[];
  scheduledFor?: string | null;
  campaignId?: string | null;
  overrides?: Record<string, string>; // accountId -> content override
}

export async function createPost(db: DB, orgId: string, input: CreatePostInput) {
  if (input.accountIds.length === 0) {
    throw new ApiError(400, "invalid_request", "At least one target account is required");
  }
  const accounts = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.orgId, orgId), inArray(schema.socialAccounts.id, input.accountIds)));
  if (accounts.length !== input.accountIds.length) {
    throw new ApiError(404, "not_found", "One or more accounts not found in this org");
  }

  const postId = uuid();
  const post = {
    id: postId,
    publicId: publicId("post"),
    orgId,
    profileId: input.profileId,
    content: input.content,
    mediaIds: "[]",
    status: "scheduled",
    scheduledFor: input.scheduledFor ?? new Date().toISOString(),
    publishNow: !input.scheduledFor,
    origin: "manual",
    campaignId: input.campaignId ?? null,
  };
  await db.insert(schema.posts).values(post);

  for (const acc of accounts) {
    await db.insert(schema.postTargets).values({
      id: uuid(),
      postId,
      orgId,
      accountId: acc.id,
      platform: acc.platform,
      contentOverride: input.overrides?.[acc.id] ?? null,
      status: "pending",
    });
  }
  return post;
}

export async function publishTarget(db: DB, targetId: string, provider: ChannelProvider) {
  const [target] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, targetId));
  if (!target) throw new ApiError(404, "not_found", "Target not found");
  const [account] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, target.accountId));

  await db.update(schema.postTargets).set({ status: "publishing", attempts: target.attempts + 1 }).where(eq(schema.postTargets.id, targetId));
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, target.postId));

  const result = await provider.publish({
    platform: target.platform,
    accountPlatformUserId: account.platformUserId,
    content: target.contentOverride ?? post.content ?? "",
    options: JSON.parse(target.options),
  });

  if (result.ok) {
    await db.update(schema.postTargets).set({
      status: "published",
      platformPostId: result.platformPostId,
      permalink: result.permalink,
      publishedAt: new Date().toISOString(),
      errorCode: null,
      errorDetail: null,
    }).where(eq(schema.postTargets.id, targetId));
  } else {
    await db.update(schema.postTargets).set({
      status: "failed",
      errorCode: result.errorCode,
      errorDetail: result.errorDetail,
    }).where(eq(schema.postTargets.id, targetId));
  }
  await rollupPostStatus(db, target.postId);
  return result;
}

export async function rollupPostStatus(db: DB, postId: string): Promise<string> {
  const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId));
  const statuses = targets.map(t => t.status);
  let status = "scheduled";
  if (statuses.every(s => s === "published")) status = "published";
  else if (statuses.some(s => s === "published") && statuses.some(s => s === "failed")) status = "partial";
  else if (statuses.every(s => s === "failed")) status = "failed";
  else if (statuses.some(s => s === "publishing" || s === "published")) status = "publishing";
  await db.update(schema.posts).set({ status, updatedAt: new Date().toISOString() }).where(eq(schema.posts.id, postId));
  return status;
}

export async function retryTarget(db: DB, orgId: string, targetId: string, provider: ChannelProvider) {
  const [target] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.id, targetId));
  if (!target) throw new ApiError(404, "not_found", "Target not found");
  assertSameOrg(orgId, target.orgId);
  return publishTarget(db, targetId, provider);
}

export async function listPosts(db: DB, orgId: string) {
  const rows = await db.select().from(schema.posts).where(eq(schema.posts.orgId, orgId));
  const result = [];
  for (const p of rows) {
    const targets = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, p.id));
    result.push({ ...p, targets });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- publishing`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/publishing/service.ts test/publishing.test.ts
git commit -m "feat(publishing): post/target create, publish, status rollup, retry"
```

---

## Task 10: Publish scheduler (`lib/publishing/scheduler.ts`)

**Files:**
- Create: `lib/publishing/scheduler.ts`

No unit test (it is a thin timer over the tested `publishTarget`); verified manually in Task 17/final run.

- [ ] **Step 1: Write the scheduler**

`lib/publishing/scheduler.ts`:
```ts
import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { publishTarget } from "./service";
import { MockChannelProvider } from "@/lib/channel/mock";

let timer: NodeJS.Timeout | null = null;
const provider = new MockChannelProvider();

// Fires due, pending targets whose parent post is scheduled at/under now.
export async function runDueTargetsOnce(): Promise<number> {
  const nowIso = new Date().toISOString();
  const duePosts = await db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.status, "scheduled"), lte(schema.posts.scheduledFor, nowIso)));
  let fired = 0;
  for (const post of duePosts) {
    const targets = await db.select().from(schema.postTargets)
      .where(and(eq(schema.postTargets.postId, post.id), eq(schema.postTargets.status, "pending")));
    for (const t of targets) {
      await publishTarget(db, t.id, provider);
      fired++;
    }
  }
  return fired;
}

export function startScheduler(intervalMs = 4000): void {
  if (timer) return;
  timer = setInterval(() => {
    runDueTargetsOnce().catch((err) => console.error("[scheduler]", err));
  }, intervalMs);
  console.log("[scheduler] started");
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/publishing/scheduler.ts
git commit -m "feat(publishing): in-process due-target scheduler (Temporal seam)"
```

---

## Task 11: Identity resolution (`lib/attribution/identity.ts`)

**Files:**
- Create: `lib/attribution/identity.ts`, `test/identity.test.ts`

- [ ] **Step 1: Write the failing test**

`test/identity.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { identify, resolveIdentity } from "@/lib/attribution/identity";
import { uuid, publicId } from "@/lib/ids";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

describe("identity", () => {
  it("creates a new identity for an unseen anonymous id", async () => {
    const { orgId } = await seedOrg(db);
    const id = await identify(db as any, orgId, { anonymousId: "anon-1" });
    const [row] = await db.select().from(schema.identities).where(eq(schema.identities.id, id));
    expect(row.anonymousId).toBe("anon-1");
  });

  it("returns the same identity for a repeated anonymous id", async () => {
    const { orgId } = await seedOrg(db);
    const a = await identify(db as any, orgId, { anonymousId: "anon-1" });
    const b = await identify(db as any, orgId, { anonymousId: "anon-1" });
    expect(a).toBe(b);
  });

  it("links an identity to a contact when provided", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const contactId = uuid();
    await db.insert(schema.contacts).values({ id: contactId, publicId: publicId("contact"), orgId, profileId, name: "Jo" });
    const id = await identify(db as any, orgId, { anonymousId: "anon-2", contactId });
    const [row] = await db.select().from(schema.identities).where(eq(schema.identities.id, id));
    expect(row.contactId).toBe(contactId);
  });

  it("resolveIdentity finds by anonymous id within org only", async () => {
    const { orgId } = await seedOrg(db);
    await identify(db as any, orgId, { anonymousId: "anon-3" });
    const found = await resolveIdentity(db as any, orgId, "anon-3");
    expect(found).not.toBeNull();
    const missing = await resolveIdentity(db as any, "other-org", "anon-3");
    expect(missing).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- identity`
Expected: FAIL — cannot resolve `@/lib/attribution/identity`.

- [ ] **Step 3: Write minimal implementation**

`lib/attribution/identity.ts`:
```ts
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { uuid } from "@/lib/ids";

export interface IdentifyInput {
  anonymousId: string;
  contactId?: string | null;
  externalUserId?: string | null;
  traits?: Record<string, unknown>;
}

export async function resolveIdentity(db: DB, orgId: string, anonymousId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(schema.identities)
    .where(and(eq(schema.identities.orgId, orgId), eq(schema.identities.anonymousId, anonymousId)));
  return row?.id ?? null;
}

// Find-or-create by anonymous id, then merge any newly-known contact/external links.
export async function identify(db: DB, orgId: string, input: IdentifyInput): Promise<string> {
  const existing = await resolveIdentity(db, orgId, input.anonymousId);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (input.contactId) patch.contactId = input.contactId;
    if (input.externalUserId) patch.externalUserId = input.externalUserId;
    if (input.traits) patch.traits = JSON.stringify(input.traits);
    if (Object.keys(patch).length) {
      await db.update(schema.identities).set(patch).where(eq(schema.identities.id, existing));
    }
    return existing;
  }
  const id = uuid();
  await db.insert(schema.identities).values({
    id,
    orgId,
    anonymousId: input.anonymousId,
    contactId: input.contactId ?? null,
    externalUserId: input.externalUserId ?? null,
    traits: JSON.stringify(input.traits ?? {}),
  });
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- identity`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/attribution/identity.ts test/identity.test.ts
git commit -m "feat(attribution): identity find-or-create + contact stitching"
```

---

## Task 12: Touchpoint + conversion ingest (`lib/attribution/ingest.ts`)

**Files:**
- Create: `lib/attribution/ingest.ts`, `test/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

`test/ingest.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

describe("ingest", () => {
  it("records a touchpoint against an identity", async () => {
    const { orgId } = await seedOrg(db);
    const identityId = await identify(db as any, orgId, { anonymousId: "a1" });
    await recordTouchpoint(db as any, orgId, {
      identityId, channel: "organic_social", platform: "twitter", sourceType: "post", sourceId: "post_1",
    });
    const rows = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("organic_social");
  });

  it("records a conversion with value", async () => {
    const { orgId } = await seedOrg(db);
    const identityId = await identify(db as any, orgId, { anonymousId: "a2" });
    const convId = await recordConversion(db as any, orgId, {
      identityId, eventName: "purchase", valueCents: 4999,
    });
    const [row] = await db.select().from(schema.conversions).where(eq(schema.conversions.id, convId));
    expect(row.eventName).toBe("purchase");
    expect(row.valueCents).toBe(4999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ingest`
Expected: FAIL — cannot resolve `@/lib/attribution/ingest`.

- [ ] **Step 3: Write minimal implementation**

`lib/attribution/ingest.ts`:
```ts
import type { DB } from "@/db/client";
import { schema } from "@/db/client";

export interface TouchpointInput {
  identityId: string;
  channel: string;
  platform?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  campaignId?: string | null;
  utm?: Record<string, unknown>;
  occurredAt?: string;
}

export async function recordTouchpoint(db: DB, orgId: string, input: TouchpointInput): Promise<number> {
  const [row] = await db.insert(schema.touchpoints).values({
    orgId,
    identityId: input.identityId,
    channel: input.channel,
    platform: input.platform ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    campaignId: input.campaignId ?? null,
    utm: JSON.stringify(input.utm ?? {}),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  }).returning({ id: schema.touchpoints.id });
  return row.id;
}

export interface ConversionInput {
  identityId: string;
  eventName: string;
  valueCents?: number;
  currency?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export async function recordConversion(db: DB, orgId: string, input: ConversionInput): Promise<number> {
  const [row] = await db.insert(schema.conversions).values({
    orgId,
    identityId: input.identityId,
    eventName: input.eventName,
    valueCents: input.valueCents ?? 0,
    currency: input.currency ?? "USD",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    metadata: JSON.stringify(input.metadata ?? {}),
  }).returning({ id: schema.conversions.id });
  return row.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ingest`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/attribution/ingest.ts test/ingest.test.ts
git commit -m "feat(attribution): touchpoint + conversion ingest"
```

---

## Task 13: Attribution models (`lib/attribution/models.ts`)

**Files:**
- Create: `lib/attribution/models.ts`, `test/models.test.ts`

This is the differentiator. Credit is returned as fractions (0..1) summing to 1.0; the
report layer converts fractions to basis points for storage.

- [ ] **Step 1: Write the failing test**

`test/models.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { allocate, type Touch } from "@/lib/attribution/models";

const touches: Touch[] = [
  { touchpointId: 1, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" },
  { touchpointId: 2, channel: "paid_social", occurredAt: "2026-06-02T00:00:00Z" },
  { touchpointId: 3, channel: "email", occurredAt: "2026-06-03T00:00:00Z" },
];

describe("attribution models", () => {
  it("first_touch gives all credit to the earliest", () => {
    const a = allocate("first_touch", touches, 1000);
    expect(a).toEqual([{ touchpointId: 1, credit: 1, creditedValueCents: 1000 }]);
  });

  it("last_touch gives all credit to the latest", () => {
    const a = allocate("last_touch", touches, 1000);
    expect(a).toEqual([{ touchpointId: 3, credit: 1, creditedValueCents: 1000 }]);
  });

  it("linear splits credit evenly and conserves total value", () => {
    const a = allocate("linear", touches, 1000);
    expect(a).toHaveLength(3);
    expect(a.reduce((s, x) => s + x.credit, 0)).toBeCloseTo(1, 9);
    expect(a.reduce((s, x) => s + x.creditedValueCents, 0)).toBe(1000);
  });

  it("handles a single touch", () => {
    const a = allocate("linear", [touches[0]], 500);
    expect(a).toEqual([{ touchpointId: 1, credit: 1, creditedValueCents: 500 }]);
  });

  it("returns empty for no touches", () => {
    expect(allocate("first_touch", [], 1000)).toEqual([]);
  });

  it("linear remainder cents go to the last touch (conservation)", () => {
    // 1000 / 3 = 333.33 -> 333,333,334
    const a = allocate("linear", touches, 1000);
    const cents = a.map(x => x.creditedValueCents);
    expect(cents).toEqual([333, 333, 334]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- models`
Expected: FAIL — cannot resolve `@/lib/attribution/models`.

- [ ] **Step 3: Write minimal implementation**

`lib/attribution/models.ts`:
```ts
export type AttributionModel = "first_touch" | "last_touch" | "linear";

export interface Touch {
  touchpointId: number;
  channel: string;
  occurredAt: string; // ISO
}

export interface Allocation {
  touchpointId: number;
  credit: number;            // fraction 0..1
  creditedValueCents: number;
}

// Allocates `valueCents` across prior touches per model. Touches need not be sorted.
export function allocate(model: AttributionModel, touches: Touch[], valueCents: number): Allocation[] {
  if (touches.length === 0) return [];
  const sorted = [...touches].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  if (model === "first_touch") {
    return [{ touchpointId: sorted[0].touchpointId, credit: 1, creditedValueCents: valueCents }];
  }
  if (model === "last_touch") {
    const last = sorted[sorted.length - 1];
    return [{ touchpointId: last.touchpointId, credit: 1, creditedValueCents: valueCents }];
  }
  // linear: even split, with cent remainder assigned to the last touch to conserve total
  const n = sorted.length;
  const base = Math.floor(valueCents / n);
  const remainder = valueCents - base * n;
  return sorted.map((t, i) => ({
    touchpointId: t.touchpointId,
    credit: 1 / n,
    creditedValueCents: i === n - 1 ? base + remainder : base,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- models`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/attribution/models.ts test/models.test.ts
git commit -m "feat(attribution): first/last/linear credit allocation"
```

---

## Task 14: Attribution report (`lib/attribution/report.ts`)

**Files:**
- Create: `lib/attribution/report.ts`, `test/report.test.ts`

`buildReport` walks every conversion in the org, gathers the converting identity's prior
touchpoints, allocates credit via the chosen model, persists `attribution_results` (credit
as basis points), and returns a channel→revenue rollup that reconciles to total conversion
value.

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";
import { buildReport } from "@/lib/attribution/report";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

async function scenario(db: TestDB, orgId: string) {
  const id = await identify(db as any, orgId, { anonymousId: "a1" });
  await recordTouchpoint(db as any, orgId, { identityId: id, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" });
  await recordTouchpoint(db as any, orgId, { identityId: id, channel: "paid_social", occurredAt: "2026-06-02T00:00:00Z" });
  await recordConversion(db as any, orgId, { identityId: id, eventName: "purchase", valueCents: 1000, occurredAt: "2026-06-03T00:00:00Z" });
}

describe("attribution report", () => {
  it("first_touch credits the first channel fully", async () => {
    const { orgId } = await seedOrg(db);
    await scenario(db, orgId);
    const report = await buildReport(db as any, orgId, "first_touch");
    expect(report.totalConversionValueCents).toBe(1000);
    const byChannel = Object.fromEntries(report.channels.map(c => [c.channel, c.creditedValueCents]));
    expect(byChannel["organic_social"]).toBe(1000);
    expect(byChannel["paid_social"] ?? 0).toBe(0);
  });

  it("linear splits across channels and reconciles to total", async () => {
    const { orgId } = await seedOrg(db);
    await scenario(db, orgId);
    const report = await buildReport(db as any, orgId, "linear");
    const sum = report.channels.reduce((s, c) => s + c.creditedValueCents, 0);
    expect(sum).toBe(1000);
    const byChannel = Object.fromEntries(report.channels.map(c => [c.channel, c.creditedValueCents]));
    expect(byChannel["organic_social"]).toBe(500);
    expect(byChannel["paid_social"]).toBe(500);
  });

  it("only counts touches that precede the conversion", async () => {
    const { orgId } = await seedOrg(db);
    const id = await identify(db as any, orgId, { anonymousId: "a9" });
    await recordTouchpoint(db as any, orgId, { identityId: id, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" });
    await recordConversion(db as any, orgId, { identityId: id, eventName: "signup", valueCents: 0, occurredAt: "2026-06-02T00:00:00Z" });
    // a later touch must NOT receive credit
    await recordTouchpoint(db as any, orgId, { identityId: id, channel: "email", occurredAt: "2026-06-03T00:00:00Z" });
    const report = await buildReport(db as any, orgId, "last_touch");
    const channels = report.channels.map(c => c.channel);
    expect(channels).toContain("organic_social");
    expect(channels).not.toContain("email");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- report`
Expected: FAIL — cannot resolve `@/lib/attribution/report`.

- [ ] **Step 3: Write minimal implementation**

`lib/attribution/report.ts`:
```ts
import { and, eq, lte } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { allocate, type AttributionModel, type Touch } from "./models";

export interface ChannelRollup {
  channel: string;
  creditedValueCents: number;
  conversions: number;
}

export interface AttributionReport {
  model: AttributionModel;
  totalConversionValueCents: number;
  totalConversions: number;
  channels: ChannelRollup[];
}

export async function buildReport(db: DB, orgId: string, model: AttributionModel): Promise<AttributionReport> {
  const conversions = await db.select().from(schema.conversions).where(eq(schema.conversions.orgId, orgId));
  const channelMap = new Map<string, ChannelRollup>();
  let totalValue = 0;

  // clear prior persisted results for this org+model (idempotent recompute)
  await db.delete(schema.attributionResults).where(and(eq(schema.attributionResults.orgId, orgId), eq(schema.attributionResults.model, model)));

  for (const conv of conversions) {
    totalValue += conv.valueCents;
    if (!conv.identityId) continue;
    const prior = await db.select().from(schema.touchpoints).where(
      and(
        eq(schema.touchpoints.orgId, orgId),
        eq(schema.touchpoints.identityId, conv.identityId),
        lte(schema.touchpoints.occurredAt, conv.occurredAt),
      ),
    );
    const touches: Touch[] = prior.map(t => ({ touchpointId: t.id, channel: t.channel, occurredAt: t.occurredAt }));
    const allocations = allocate(model, touches, conv.valueCents);
    const channelOf = new Map(prior.map(t => [t.id, t.channel]));

    for (const a of allocations) {
      const channel = channelOf.get(a.touchpointId) ?? "unknown";
      await db.insert(schema.attributionResults).values({
        orgId,
        conversionId: conv.id,
        model,
        touchpointId: a.touchpointId,
        credit: Math.round(a.credit * 10000), // basis points
        creditedValueCents: a.creditedValueCents,
      });
      const roll = channelMap.get(channel) ?? { channel, creditedValueCents: 0, conversions: 0 };
      roll.creditedValueCents += a.creditedValueCents;
      roll.conversions += 1;
      channelMap.set(channel, roll);
    }
  }

  return {
    model,
    totalConversionValueCents: totalValue,
    totalConversions: conversions.length,
    channels: [...channelMap.values()].sort((a, b) => b.creditedValueCents - a.creditedValueCents),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- report`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/attribution/report.ts test/report.test.ts
git commit -m "feat(attribution): channel revenue report + persisted results"
```

---

## Task 15: Journey timeline (`lib/journey/timeline.ts`)

**Files:**
- Create: `lib/journey/timeline.ts`, `test/journey.test.ts`

- [ ] **Step 1: Write the failing test**

`test/journey.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";
import { contactTimeline } from "@/lib/journey/timeline";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

describe("journey timeline", () => {
  it("merges touchpoints and conversions for a contact in chronological order", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const contactId = uuid();
    await db.insert(schema.contacts).values({ id: contactId, publicId: publicId("contact"), orgId, profileId, name: "Jo" });
    const identityId = await identify(db as any, orgId, { anonymousId: "a1", contactId });

    await recordTouchpoint(db as any, orgId, { identityId, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" });
    await recordConversion(db as any, orgId, { identityId, eventName: "signup", valueCents: 0, occurredAt: "2026-06-03T00:00:00Z" });
    await recordTouchpoint(db as any, orgId, { identityId, channel: "email", occurredAt: "2026-06-02T00:00:00Z" });

    const timeline = await contactTimeline(db as any, orgId, contactId);
    expect(timeline.map(e => e.kind)).toEqual(["touchpoint", "touchpoint", "conversion"]);
    expect(timeline[0].occurredAt).toBe("2026-06-01T00:00:00Z");
    expect(timeline[2].kind).toBe("conversion");
  });

  it("returns empty for a contact with no identity", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const contactId = uuid();
    await db.insert(schema.contacts).values({ id: contactId, publicId: publicId("contact"), orgId, profileId, name: "Solo" });
    const timeline = await contactTimeline(db as any, orgId, contactId);
    expect(timeline).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- journey`
Expected: FAIL — cannot resolve `@/lib/journey/timeline`.

- [ ] **Step 3: Write minimal implementation**

`lib/journey/timeline.ts`:
```ts
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";

export interface TimelineEvent {
  kind: "touchpoint" | "conversion";
  occurredAt: string;
  channel?: string;
  platform?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  eventName?: string;
  valueCents?: number;
}

export async function contactTimeline(db: DB, orgId: string, contactId: string): Promise<TimelineEvent[]> {
  const ids = await db.select().from(schema.identities)
    .where(and(eq(schema.identities.orgId, orgId), eq(schema.identities.contactId, contactId)));
  if (ids.length === 0) return [];

  const events: TimelineEvent[] = [];
  for (const identity of ids) {
    const tps = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identity.id));
    for (const t of tps) {
      events.push({
        kind: "touchpoint", occurredAt: t.occurredAt, channel: t.channel,
        platform: t.platform, sourceType: t.sourceType, sourceId: t.sourceId,
      });
    }
    const convs = await db.select().from(schema.conversions).where(eq(schema.conversions.identityId, identity.id));
    for (const c of convs) {
      events.push({ kind: "conversion", occurredAt: c.occurredAt, eventName: c.eventName, valueCents: c.valueCents });
    }
  }
  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- journey`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/journey/timeline.ts test/journey.test.ts
git commit -m "feat(journey): merged contact timeline across channels"
```

---

## Task 16: Seed script (`db/seed.ts`)

**Files:**
- Create: `db/seed.ts`

Produces a coherent demo org so every screen shows data: 1 org, 1 owner user
(email `demo@launchos.com` / password `demo1234`), 1 profile, 4 platforms, 3 connected
accounts, 1 campaign, several published posts, ~30 identities with multi-touch paths, and
conversions — so first/last/linear each produce different, sensible numbers.

- [ ] **Step 1: Write the seed script**

`db/seed.ts`:
```ts
import { eq } from "drizzle-orm";
import { db, schema } from "./client";
import { uuid, publicId } from "@/lib/ids";
import { hashPassword } from "@/lib/auth";

const CHANNELS = ["organic_social", "paid_social", "email"] as const;
const PLATFORMS = ["twitter", "linkedin", "instagram", "tiktok"] as const;

async function main() {
  // Idempotent: wipe demo data by recreating the file is simplest; here we no-op if org exists.
  const existing = await db.select().from(schema.organizations).limit(1);
  if (existing.length > 0) {
    console.log("Seed: organization already present; skipping. Delete launchos.db to reseed.");
    return;
  }

  const orgId = uuid();
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Demo Co", slug: "demo-co",
  });

  const userId = uuid();
  await db.insert(schema.users).values({
    id: userId, publicId: publicId("user"), email: "demo@launchos.com",
    name: "Demo Operator", passwordHash: await hashPassword("demo1234"),
  });
  await db.insert(schema.memberships).values({
    id: uuid(), orgId, userId, role: "owner", status: "active",
  });

  const profileId = uuid();
  await db.insert(schema.profiles).values({
    id: profileId, publicId: publicId("prof"), orgId, name: "Demo Co Brand",
  });

  await db.insert(schema.platforms).values(
    PLATFORMS.map(p => ({ key: p, displayName: p, category: "social" as const })),
  );

  const accountIds: string[] = [];
  for (const platform of ["twitter", "linkedin", "instagram"]) {
    const id = uuid();
    accountIds.push(id);
    await db.insert(schema.socialAccounts).values({
      id, publicId: publicId("acc"), orgId, profileId, platform,
      platformUserId: `u_${platform}`, username: `${platform}_demo`, displayName: `Demo on ${platform}`,
    });
    // daily metric rollup for the dashboard
    await db.insert(schema.accountMetricsDaily).values({
      id: uuid(), orgId, accountId: id, day: new Date().toISOString().slice(0, 10),
      followers: 1000 + Math.floor(Math.random() * 5000), impressions: 8000, reach: 6000, engagement: 400,
    });
  }

  const campaignId = uuid();
  await db.insert(schema.campaigns).values({
    id: campaignId, publicId: publicId("cmp"), orgId, profileId,
    name: "Summer Launch", objective: "launch", goalMetric: "signups", goalTarget: 300,
    budgetCents: 200000, status: "running",
  });

  // a few published posts
  const postSourceIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const postId = uuid();
    postSourceIds.push(postId);
    await db.insert(schema.posts).values({
      id: postId, publicId: publicId("post"), orgId, profileId, createdBy: userId,
      content: `Launch update #${i + 1}`, status: "published", origin: "manual",
      campaignId, scheduledFor: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    });
    for (const accId of accountIds) {
      const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, accId));
      await db.insert(schema.postTargets).values({
        id: uuid(), postId, orgId, accountId: accId, platform: acc.platform,
        status: "published", platformPostId: `${acc.platform}_${postId.slice(0, 8)}`,
        permalink: `https://mock.local/${acc.platform}/${postId.slice(0, 8)}`,
        publishedAt: new Date().toISOString(),
      });
    }
  }

  // ~30 identities with multi-touch journeys; ~40% convert
  for (let i = 0; i < 30; i++) {
    const identityId = uuid();
    let contactId: string | null = null;
    if (i % 2 === 0) {
      contactId = uuid();
      await db.insert(schema.contacts).values({
        id: contactId, publicId: publicId("contact"), orgId, profileId,
        name: `Lead ${i}`, email: `lead${i}@example.com`, lifecycleStage: "lead",
      });
    }
    await db.insert(schema.identities).values({
      id: identityId, orgId, anonymousId: `anon-${i}`, contactId,
    });

    const touchCount = 1 + (i % 3); // 1..3 touches
    const baseTime = Date.now() - (10 - (i % 10)) * 86400000;
    for (let t = 0; t < touchCount; t++) {
      await db.insert(schema.touchpoints).values({
        orgId, identityId,
        channel: CHANNELS[(i + t) % CHANNELS.length],
        platform: PLATFORMS[(i + t) % PLATFORMS.length],
        sourceType: "post", sourceId: postSourceIds[(i + t) % postSourceIds.length],
        campaignId,
        occurredAt: new Date(baseTime + t * 3600000).toISOString(),
      });
    }
    if (i % 5 < 2) { // ~40% convert
      await db.insert(schema.conversions).values({
        orgId, identityId, eventName: i % 2 === 0 ? "signup" : "purchase",
        valueCents: i % 2 === 0 ? 0 : 2500 + i * 100,
        occurredAt: new Date(baseTime + touchCount * 3600000 + 7200000).toISOString(),
      });
    }
  }

  console.log("Seed complete. Login: demo@launchos.com / demo1234");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

NOTE for the implementer: `tsx` loads `.env.local` only if you pass it; this script reads
`DATABASE_URL` via `db/client.ts` which defaults to `./launchos.db`, so no dotenv is needed.
If you point at a different DB file, run with the var inline: `DATABASE_URL=./launchos.db npm run db:seed`.

- [ ] **Step 2: Run setup (push + seed) on a fresh DB**

Run (Git Bash): `rm -f launchos.db && npm run setup`
Expected: tables created, "Seed complete. Login: demo@launchos.com / demo1234".

- [ ] **Step 3: Sanity-check the data**

Run: `node -e "const d=require('better-sqlite3')('./launchos.db');for(const t of ['organizations','social_accounts','posts','post_targets','identities','touchpoints','conversions'])console.log(t,d.prepare('select count(*) c from '+t).get().c)"`
Expected: organizations 1, social_accounts 3, posts 4, post_targets 12, identities 30, touchpoints >30, conversions >0.

- [ ] **Step 4: Commit**

```bash
git add db/seed.ts
git commit -m "feat(db): seed demo org with multi-touch attribution dataset"
```

---

## Task 17: API route layer + request context (`lib/request.ts` + routes)

**Files:**
- Create: `lib/request.ts`, and all route handlers under `app/api/v1/`

`lib/request.ts` resolves the session from the cookie and returns `{ db, orgId, userId }`,
throwing `ApiError(401)` when unauthenticated. Routes stay thin: parse → service → respond,
wrapping everything in `toProblemResponse` on throw.

- [ ] **Step 1: Write the request context helper**

`lib/request.ts`:
```ts
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export interface RequestContext { db: typeof db; orgId: string; userId: string; }

export async function requireContext(): Promise<RequestContext> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "unauthorized", "No session");
  const payload = verifySession(token, sessionSecret());
  if (!payload) throw new ApiError(401, "unauthorized", "Invalid session");
  return { db, orgId: payload.orgId, userId: payload.userId };
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 2: Auth routes**

`app/api/v1/auth/signup/route.ts`:
```ts
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { uuid, publicId } from "@/lib/ids";
import { hashPassword, signSession, sessionSecret, SESSION_COOKIE } from "@/lib/auth";
import { ApiError, toProblemResponse } from "@/lib/errors";
import { ok } from "@/lib/request";

export async function POST(req: Request) {
  try {
    const { email, password, name } = await req.json();
    if (!email || !password) throw new ApiError(400, "invalid_request", "email and password required");
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing.length) throw new ApiError(409, "conflict", "Email already registered");

    const orgId = uuid(), userId = uuid(), profileId = uuid();
    await db.insert(schema.organizations).values({ id: orgId, publicId: publicId("org"), name: name ? `${name}'s Org` : "My Org", slug: "org-" + orgId.slice(0, 8) });
    await db.insert(schema.users).values({ id: userId, publicId: publicId("user"), email, name: name ?? null, passwordHash: await hashPassword(password) });
    await db.insert(schema.memberships).values({ id: uuid(), orgId, userId, role: "owner", status: "active" });
    await db.insert(schema.profiles).values({ id: profileId, publicId: publicId("prof"), orgId, name: "Default" });

    const token = signSession({ userId, orgId }, sessionSecret());
    const res = ok({ user: { id: userId, email }, org: { id: orgId } }, 201);
    res.headers.append("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res;
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/auth/login/route.ts`:
```ts
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { verifyPassword, signSession, sessionSecret, SESSION_COOKIE } from "@/lib/auth";
import { ApiError, toProblemResponse } from "@/lib/errors";
import { ok } from "@/lib/request";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email ?? ""));
    if (!user || !user.passwordHash || !(await verifyPassword(password ?? "", user.passwordHash))) {
      throw new ApiError(401, "unauthorized", "Invalid credentials");
    }
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.id));
    if (!membership) throw new ApiError(403, "forbidden", "No org membership");
    const token = signSession({ userId: user.id, orgId: membership.orgId }, sessionSecret());
    const res = ok({ user: { id: user.id, email: user.email } });
    res.headers.append("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res;
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/auth/logout/route.ts`:
```ts
import { SESSION_COOKIE } from "@/lib/auth";
import { ok } from "@/lib/request";

export async function POST() {
  const res = ok({ ok: true });
  res.headers.append("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  return res;
}
```

- [ ] **Step 3: Accounts + posts routes**

`app/api/v1/accounts/route.ts`:
```ts
import { listAccounts } from "@/lib/org-context";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";

export async function GET() {
  try {
    const { db, orgId } = await requireContext();
    return ok({ data: await listAccounts(db, orgId) });
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/posts/route.ts`:
```ts
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { createPost, listPosts } from "@/lib/publishing/service";

export async function GET() {
  try {
    const { db, orgId } = await requireContext();
    return ok({ data: await listPosts(db, orgId) });
  } catch (e) { return toProblemResponse(e); }
}

export async function POST(req: Request) {
  try {
    const { db, orgId, userId } = await requireContext();
    const idemKey = req.headers.get("Idempotency-Key");
    if (idemKey) {
      const [hit] = await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, idemKey));
      if (hit) return ok(JSON.parse(hit.responseJson), 200);
    }
    const body = await req.json();
    if (!body.profileId || !Array.isArray(body.accountIds)) {
      throw new ApiError(400, "invalid_request", "profileId and accountIds[] required");
    }
    const post = await createPost(db, orgId, {
      profileId: body.profileId,
      content: body.content ?? "",
      accountIds: body.accountIds,
      scheduledFor: body.scheduledFor ?? null,
      campaignId: body.campaignId ?? null,
      overrides: body.overrides,
    });
    void userId;
    const responseBody = { post: { id: post.publicId, status: post.status } };
    if (idemKey) {
      await db.insert(schema.idempotencyKeys).values({ key: idemKey, orgId, responseJson: JSON.stringify(responseBody) });
    }
    return ok(responseBody, 202);
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/posts/[id]/retry/route.ts` (retries all failed targets of a post):
```ts
import { and, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { retryTarget } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, orgId } = await requireContext();
    const { id } = await params;
    const [post] = await db.select().from(schema.posts).where(and(eq(schema.posts.publicId, id), eq(schema.posts.orgId, orgId)));
    if (!post) throw new ApiError(404, "not_found", "Post not found");
    const failed = await db.select().from(schema.postTargets).where(and(eq(schema.postTargets.postId, post.id), eq(schema.postTargets.status, "failed")));
    const provider = new MockChannelProvider();
    for (const t of failed) await retryTarget(db, orgId, t.id, provider);
    return ok({ retried: failed.length });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 4: Attribution + journey routes**

`app/api/v1/attribution/identify/route.ts`:
```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { identify } from "@/lib/attribution/identity";

export async function POST(req: Request) {
  try {
    const { db, orgId } = await requireContext();
    const body = await req.json();
    if (!body.anonymousId) throw new ApiError(400, "invalid_request", "anonymousId required");
    const id = await identify(db, orgId, body);
    return ok({ identity_id: id });
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/attribution/touchpoints/route.ts`:
```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { recordTouchpoint } from "@/lib/attribution/ingest";

export async function POST(req: Request) {
  try {
    const { db, orgId } = await requireContext();
    const body = await req.json();
    if (!body.identityId || !body.channel) throw new ApiError(400, "invalid_request", "identityId and channel required");
    const id = await recordTouchpoint(db, orgId, body);
    return ok({ touchpoint_id: id }, 201);
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/attribution/conversions/route.ts`:
```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { recordConversion } from "@/lib/attribution/ingest";

export async function POST(req: Request) {
  try {
    const { db, orgId } = await requireContext();
    const body = await req.json();
    if (!body.identityId || !body.eventName) throw new ApiError(400, "invalid_request", "identityId and eventName required");
    const id = await recordConversion(db, orgId, body);
    return ok({ conversion_id: id }, 201);
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/attribution/report/route.ts`:
```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { buildReport } from "@/lib/attribution/report";
import type { AttributionModel } from "@/lib/attribution/models";

const MODELS = ["first_touch", "last_touch", "linear"];

export async function GET(req: Request) {
  try {
    const { db, orgId } = await requireContext();
    const model = (new URL(req.url).searchParams.get("model") ?? "linear") as AttributionModel;
    if (!MODELS.includes(model)) throw new ApiError(400, "invalid_request", `model must be one of ${MODELS.join(", ")}`);
    return ok(await buildReport(db, orgId, model));
  } catch (e) { return toProblemResponse(e); }
}
```

`app/api/v1/journeys/contacts/[cid]/timeline/route.ts`:
```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse } from "@/lib/errors";
import { contactTimeline } from "@/lib/journey/timeline";

export async function GET(_req: Request, { params }: { params: Promise<{ cid: string }> }) {
  try {
    const { db, orgId } = await requireContext();
    const { cid } = await params;
    return ok({ data: await contactTimeline(db, orgId, cid) });
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/request.ts app/api
git commit -m "feat(api): v1 auth, accounts, posts, attribution, journey routes"
```

---

## Task 18: API flywheel integration test (`test/api-flywheel.test.ts`)

**Files:**
- Create: `test/api-flywheel.test.ts`

Because route handlers depend on Next's `cookies()` and the singleton `db`, this test
exercises the **service composition** end-to-end (the same calls the routes make) against a
fresh in-memory DB, asserting the whole flywheel produces a reconciling report.

- [ ] **Step 1: Write the test**

`test/api-flywheel.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb, seedOrg, seedAccount, type TestDB } from "./helpers";
import { createPost, publishTarget, rollupPostStatus } from "@/lib/publishing/service";
import { MockChannelProvider } from "@/lib/channel/mock";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { identify } from "@/lib/attribution/identity";
import { recordTouchpoint, recordConversion } from "@/lib/attribution/ingest";
import { buildReport } from "@/lib/attribution/report";

let db: TestDB;
beforeEach(() => { db = makeTestDb(); });

describe("flywheel end-to-end", () => {
  it("compose -> publish -> touchpoint -> conversion -> attribution reconciles", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");

    // compose + publish
    const post = await createPost(db as any, orgId, { profileId, content: "Launch!", accountIds: [acc] });
    const [target] = await db.select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    await publishTarget(db as any, target.id, new MockChannelProvider());
    expect(await rollupPostStatus(db as any, post.id)).toBe("published");

    // a visitor sees the post, then converts
    const identityId = await identify(db as any, orgId, { anonymousId: "visitor-1" });
    await recordTouchpoint(db as any, orgId, {
      identityId, channel: "organic_social", platform: "twitter",
      sourceType: "post", sourceId: post.id, occurredAt: "2026-06-10T00:00:00Z",
    });
    await recordConversion(db as any, orgId, {
      identityId, eventName: "purchase", valueCents: 5000, occurredAt: "2026-06-11T00:00:00Z",
    });

    const report = await buildReport(db as any, orgId, "linear");
    expect(report.totalConversionValueCents).toBe(5000);
    expect(report.channels.find(c => c.channel === "organic_social")?.creditedValueCents).toBe(5000);
  });
});
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: ALL test files PASS (ids, errors, org-context, auth, channel-mock, publishing, identity, ingest, models, report, journey, api-flywheel).

- [ ] **Step 3: Commit**

```bash
git add test/api-flywheel.test.ts
git commit -m "test: end-to-end flywheel reconciliation"
```

---

## Task 19: App shell, instrumentation, and login/signup UI

**Files:**
- Create: `instrumentation.ts`, `app/(app)/layout.tsx`, `app/(auth)/login/page.tsx`, `app/(auth)/signup/page.tsx`
- Modify: `app/(app)/dashboard/page.tsx` (replaced in Task 20)

- [ ] **Step 1: Start the scheduler at server boot**

`instrumentation.ts`:
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/lib/publishing/scheduler");
    startScheduler();
  }
}
```

- [ ] **Step 2: App layout with nav**

`app/(app)/layout.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  ["Dashboard", "/dashboard"], ["Compose", "/compose"], ["Calendar", "/calendar"],
  ["Analytics", "/analytics"], ["Connections", "/settings/connections"],
];

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-neutral-200 bg-white p-4">
        <div className="mb-6 text-lg font-bold">LaunchOS</div>
        <nav className="flex flex-col gap-1">
          {NAV.map(([label, href]) => (
            <Link key={href} href={href} className="rounded px-3 py-2 text-sm hover:bg-neutral-100">{label}</Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: Login + signup pages (client components hitting the API)**

`app/(auth)/login/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@launchos.com");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) router.push("/dashboard");
    else setError((await res.json()).detail ?? "Login failed");
  }

  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border bg-white p-6">
      <h1 className="mb-4 text-xl font-bold">Sign in to LaunchOS</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input className="rounded border px-3 py-2" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
        <input className="rounded border px-3 py-2" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-black px-3 py-2 text-white">Sign in</button>
      </form>
      <p className="mt-3 text-sm">No account? <a className="underline" href="/signup">Sign up</a></p>
    </main>
  );
}
```

`app/(auth)/signup/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/v1/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    if (res.ok) router.push("/dashboard");
    else setError((await res.json()).detail ?? "Signup failed");
  }

  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border bg-white p-6">
      <h1 className="mb-4 text-xl font-bold">Create your LaunchOS org</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input className="rounded border px-3 py-2" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
        <input className="rounded border px-3 py-2" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
        <input className="rounded border px-3 py-2" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-black px-3 py-2 text-white">Create org</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Verify dev server boots + login works**

Run: `npm run dev` (background), then in a browser open `http://localhost:3000/login`, sign in with the seeded credentials.
Expected: redirect to `/dashboard`; the scheduler logs `[scheduler] started` in the terminal.

- [ ] **Step 5: Commit**

```bash
git add instrumentation.ts "app/(app)/layout.tsx" "app/(auth)"
git commit -m "feat(ui): app shell, scheduler boot, login/signup"
```

---

## Task 20: App screens (dashboard, compose, calendar, analytics, contact, connections)

**Files:**
- Create: `lib/page-data.ts` (server-side read helpers that resolve session + data)
- Modify/Create: the six page components

These pages are React Server Components that read the session cookie directly and call the
`lib/*` services (no internal HTTP round-trip). Compose is a client component using the API.

- [ ] **Step 1: Server-side page-data helper**

`lib/page-data.ts`:
```ts
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";

export async function getOrgContextOrRedirect() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySession(token, sessionSecret()) : null;
  if (!payload) redirect("/login");
  return { db, orgId: payload.orgId, userId: payload.userId };
}
```

- [ ] **Step 2: Dashboard**

`app/(app)/dashboard/page.tsx`:
```tsx
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { buildReport } from "@/lib/attribution/report";
import { listPosts } from "@/lib/publishing/service";

export default async function DashboardPage() {
  const { db, orgId } = await getOrgContextOrRedirect();
  const report = await buildReport(db, orgId, "linear");
  const posts = await listPosts(db, orgId);
  const accounts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, orgId));
  const scheduled = posts.filter(p => p.status === "scheduled");
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
        {scheduled.map(p => <li key={p.id} className="rounded border bg-white px-3 py-2">{p.content} — {p.scheduledFor}</li>)}
        {scheduled.length === 0 && <li className="text-neutral-500">Nothing scheduled.</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Compose (client component)**

`app/(app)/compose/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";

interface Account { id: string; publicId: string; platform: string; username: string | null; profileId: string; }

export default function ComposePage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    fetch("/api/v1/accounts").then(r => r.json()).then(d => setAccounts(d.data ?? []));
  }, []);

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  async function publish() {
    setResult("");
    if (!accounts.length || !selected.length) { setResult("Select at least one account."); return; }
    const profileId = accounts.find(a => selected.includes(a.id))!.profileId;
    const res = await fetch("/api/v1/posts", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ profileId, content, accountIds: selected }),
    });
    const json = await res.json();
    setResult(res.ok ? `Queued ${json.post.id} (${json.post.status}); the scheduler will publish within a few seconds.` : json.detail);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold">Compose</h1>
      <textarea className="mb-4 h-32 w-full rounded border p-3" value={content} onChange={e => setContent(e.target.value)} placeholder="Write once, publish everywhere…" />
      <div className="mb-4">
        <div className="mb-2 text-sm font-medium">Target accounts</div>
        <div className="flex flex-wrap gap-2">
          {accounts.map(a => (
            <button key={a.id} onClick={() => toggle(a.id)}
              className={`rounded-full border px-3 py-1 text-sm ${selected.includes(a.id) ? "bg-black text-white" : "bg-white"}`}>
              {a.platform} · {a.username}
            </button>
          ))}
        </div>
      </div>
      <button onClick={publish} className="rounded bg-black px-4 py-2 text-white">Publish</button>
      {result && <p className="mt-3 text-sm">{result}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Calendar**

`app/(app)/calendar/page.tsx`:
```tsx
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { listPosts } from "@/lib/publishing/service";

export default async function CalendarPage() {
  const { db, orgId } = await getOrgContextOrRedirect();
  const posts = (await listPosts(db, orgId)).sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Calendar</h1>
      <table className="w-full border-collapse text-sm">
        <thead><tr className="text-left text-neutral-500"><th className="p-2">When</th><th className="p-2">Content</th><th className="p-2">Status</th><th className="p-2">Targets</th></tr></thead>
        <tbody>
          {posts.map(p => (
            <tr key={p.id} className="border-t">
              <td className="p-2">{p.scheduledFor?.slice(0, 16).replace("T", " ")}</td>
              <td className="p-2">{p.content}</td>
              <td className="p-2"><span className="rounded bg-neutral-100 px-2 py-0.5">{p.status}</span></td>
              <td className="p-2">
                {p.targets.map(t => (
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

- [ ] **Step 5: Analytics + attribution (client component with model switcher)**

`app/(app)/analytics/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";

const MODELS = ["first_touch", "last_touch", "linear"];

interface Report {
  model: string; totalConversionValueCents: number; totalConversions: number;
  channels: { channel: string; creditedValueCents: number; conversions: number }[];
}

export default function AnalyticsPage() {
  const [model, setModel] = useState("linear");
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    fetch(`/api/v1/attribution/report?model=${model}`).then(r => r.json()).then(setReport);
  }, [model]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Analytics & Attribution</h1>
      <div className="mb-4 flex gap-2">
        {MODELS.map(m => (
          <button key={m} onClick={() => setModel(m)}
            className={`rounded border px-3 py-1 text-sm ${model === m ? "bg-black text-white" : "bg-white"}`}>{m}</button>
        ))}
      </div>
      {report && (
        <>
          <div className="mb-4 text-sm text-neutral-600">
            {report.totalConversions} conversions · total value ${(report.totalConversionValueCents / 100).toFixed(2)}
          </div>
          <table className="w-full border-collapse text-sm">
            <thead><tr className="text-left text-neutral-500"><th className="p-2">Channel</th><th className="p-2">Attributed revenue</th><th className="p-2">Credited conversions</th></tr></thead>
            <tbody>
              {report.channels.map(c => (
                <tr key={c.channel} className="border-t">
                  <td className="p-2">{c.channel}</td>
                  <td className="p-2">${(c.creditedValueCents / 100).toFixed(2)}</td>
                  <td className="p-2">{c.conversions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Contact detail + journey timeline**

`app/(app)/contacts/[id]/page.tsx`:
```tsx
import { eq, and } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { contactTimeline } from "@/lib/journey/timeline";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, orgId } = await getOrgContextOrRedirect();
  const { id } = await params;
  const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, id), eq(schema.contacts.orgId, orgId)));
  if (!contact) return <div>Contact not found.</div>;
  const timeline = await contactTimeline(db, orgId, id);

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
              : <span className="text-green-700"><b>{e.eventName}</b>{e.valueCents ? ` $${(e.valueCents/100).toFixed(2)}` : ""}</span>}
          </li>
        ))}
        {timeline.length === 0 && <li className="text-neutral-500">No journey events.</li>}
      </ol>
    </div>
  );
}
```

- [ ] **Step 7: Connections (lists seeded accounts; contacts list for navigation)**

`app/(app)/settings/connections/page.tsx`:
```tsx
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";

export default async function ConnectionsPage() {
  const { db, orgId } = await getOrgContextOrRedirect();
  const accounts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, orgId));
  const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId)).limit(20);
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Connections</h1>
      <div className="mb-8 grid grid-cols-3 gap-4">
        {accounts.map(a => (
          <div key={a.id} className="rounded-lg border bg-white p-4">
            <div className="font-medium">{a.platform}</div>
            <div className="text-sm text-neutral-500">{a.username}</div>
            <div className="mt-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs">{a.status}</div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 text-lg font-semibold">Contacts</h2>
      <ul className="text-sm">
        {contacts.map(c => (
          <li key={c.id}><a className="underline" href={`/contacts/${c.id}`}>{c.name} · {c.email}</a></li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 8: Verify all screens render against seeded data**

Run: `npm run dev` (if not already running), and visit `/dashboard`, `/compose`,
`/calendar`, `/analytics` (toggle all three models — numbers must change), `/settings/connections`,
and a `/contacts/<id>` link from connections.
Expected: every screen shows seeded data; analytics totals reconcile to the conversions sum;
publishing a post in `/compose` results in published targets on `/calendar` within ~5s.

- [ ] **Step 9: Commit**

```bash
git add lib/page-data.ts "app/(app)"
git commit -m "feat(ui): dashboard, compose, calendar, analytics, contact, connections"
```

---

## Task 21: README + final verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# LaunchOS — Core Flywheel Slice

The first runnable vertical slice: compose → publish (mock) → touchpoint → attribution → dashboard.
See `docs/superpowers/specs/2026-06-13-core-flywheel-slice-design.md` for scope and rationale,
and `LaunchOS-Spec.md` / `launchos_schema.sql` for the full product vision and canonical schema.

## Run it

```bash
npm install
npm run setup     # creates launchos.db (drizzle-kit push) + seeds a demo org
npm run dev       # http://localhost:3000
```

Log in at `/login` with **demo@launchos.com / demo1234**.

## Test

```bash
npm test
```

## Architecture

UI → `app/api/v1/*` route handlers → `lib/*` services → Drizzle/SQLite.
- `lib/channel/*` — `ChannelProvider` seam (`MockChannelProvider` now; wrap/native later).
- `lib/publishing/*` — post/target lifecycle + in-process scheduler (Temporal seam).
- `lib/attribution/*` — identity stitching, ingest, first/last/linear models, channel report.
- `lib/journey/*` — per-contact timeline.

SQLite is a Postgres-shaped subset of `launchos_schema.sql`; `org_id` filtering substitutes
for Postgres RLS. To target Postgres later, port `db/schema.ts` back per its header notes.
````

- [ ] **Step 2: Reseed cleanly and run the whole suite**

Run (Git Bash): `rm -f launchos.db && npm run setup && npm test`
Expected: setup completes with the seed message; all tests pass.

- [ ] **Step 3: Manual smoke of the full flywheel**

Run: `npm run dev`, then: log in → `/compose` publish a post to 2 accounts → wait ~5s →
`/calendar` shows the post `published` with per-target chips → `/analytics` shows reconciling
numbers across all three models → open a contact and see its journey.
Expected: all steps succeed; terminal shows `[scheduler] started` and no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README with run + architecture notes"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** compose (`/compose` + `createPost`), publish (`MockChannelProvider` +
  `publishTarget` + scheduler), touchpoint/conversion ingest (Task 12 + routes), identity
  stitching (Task 11), first/last/linear models (Task 13), channel report with model switch
  (Task 14 + `/analytics`), journey timeline (Task 15 + contact page), dashboard (Task 20),
  RFC-9457 errors (Task 4), Idempotency-Key (Task 17), org isolation (Task 5), seeded data
  (Task 16). All design §8 acceptance criteria map to a task.
- **Out of scope** items from the design (AI, OAuth, Stripe, ads, agents, Temporal, pgvector,
  SDK/MCP, white-label, time-decay/data-driven, browser pixel) are intentionally absent.
- **Type consistency:** `allocate()` shape (`{touchpointId, credit, creditedValueCents}`) is
  consistent across Tasks 13/14; `publishTarget`/`retryTarget`/`rollupPostStatus` signatures
  match between Tasks 9, 10, 17; `requireContext()`/`getOrgContextOrRedirect()` return the same
  `{db, orgId, userId}` shape.
- **No placeholders:** every code step contains complete, runnable code.
```

