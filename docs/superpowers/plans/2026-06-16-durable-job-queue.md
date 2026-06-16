# Durable Job Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-process `setInterval` scheduler with a durable, Postgres-backed job queue (retries, exponential backoff, dead-letter, SKIP LOCKED claiming) and route publishing through it.

**Architecture:** A `jobs` table drained via `SELECT … FOR UPDATE SKIP LOCKED`. A typed handler registry; `runWorkerOnce` claims a batch and runs handlers. Two drain strategies behind one interface: a background worker process (`npm run worker`) + in-process loop on managed Postgres; inline drain in the POST /posts route on PGlite (single-connection-safe). `createPost` enqueues a `publish_post` job in the same transaction.

**Tech Stack:** drizzle-orm/pg-core, PGlite (dev/test) / node-postgres (prod), Vitest. Builds on P1.1 (Postgres + RLS).

**Reference:** `docs/superpowers/specs/2026-06-16-durable-job-queue-design.md`.

**Conventions:** run from repo root `c:/Users/georg/OneDrive/Desktop/Projects/LaunchOS`. Commit after each task. Tests use the base test db (service role; RLS bypassed) unless testing org scoping. The `jobs` table uses native `jsonb`/`timestamptz` (new table, no legacy assertions).

---

## File Structure

```
db/schema.ts            + jobs table (pg-core, native jsonb/timestamptz)
db/migrations/           + 0002_*.sql (generated jobs table) + 0003_jobs_rls.sql (grants + RLS)
lib/jobs/backoff.ts      attempt -> delay ms (pure)
lib/jobs/queue.ts        enqueue / claimJobs / completeJob / failJob / reclaimStuck
lib/jobs/registry.ts     registerJob / getHandler
lib/jobs/handlers.ts     registers "publish_post" (side-effect import)
lib/jobs/worker.ts       runWorkerOnce / startWorker (imports ./handlers)
lib/publishing/service.ts  + publishPost(); createPost enqueues publish_post
lib/publishing/scheduler.ts  DELETED
app/api/v1/posts/route.ts    POST drains inline on PGlite after createPost
instrumentation.ts       start job worker on pg (replaces scheduler)
bin/worker.ts            `npm run worker` entry (managed Postgres only)
package.json             + "worker" script
test/backoff.test.ts, test/queue.test.ts, test/worker.test.ts  NEW
test/api-flywheel.test.ts  + publish-via-queue integration
```

---

## Task 1: `jobs` table + migration (grants + RLS)

**Files:** Modify `db/schema.ts`; Create `db/migrations/0002_*.sql` (generated), `db/migrations/0003_jobs_rls.sql`

- [ ] **Step 1: Add the `jobs` table to `db/schema.ts`**

Add these imports to the existing `import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";` line so it reads:
```ts
import { pgTable, text, integer, boolean, jsonb, timestamp, bigserial } from "drizzle-orm/pg-core";
```
Append at the end of `db/schema.ts`:
```ts
// Durable job queue (new infra → native jsonb/timestamptz types).
export const jobs = pgTable("jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: text("org_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  runAfter: timestamp("run_after", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate the table migration**

Run: `npm run db:generate`
Expected: creates `db/migrations/0002_*.sql` containing `CREATE TABLE "jobs" …` and updates the journal.

- [ ] **Step 3: Create the custom grants + RLS migration**

Run: `npx drizzle-kit generate --custom --name jobs_rls`
Expected: creates an empty `db/migrations/0003_jobs_rls.sql`.

- [ ] **Step 4: Fill `db/migrations/0003_jobs_rls.sql`**

```sql
-- New table needs its own grants (the P1.1 grant only covered tables existing then).
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE jobs_id_seq TO app_user;
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_jobs ON jobs
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX jobs_status_run_after_idx ON jobs (status, run_after);
```

- [ ] **Step 5: Verify migrations apply (17 policies, jobs table present)**

Run:
```
node --input-type=module -e "
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
const db = drizzle(new PGlite(), {});
await migrate(db, {migrationsFolder:'db/migrations'});
const p = await db.execute(\"select count(*)::int n from pg_policies where policyname like 'org_isolation_%'\");
const j = await db.execute(\"select count(*)::int n from information_schema.tables where table_name='jobs'\");
console.log('policies', p.rows[0].n, '| jobs table', j.rows[0].n);
"
```
Expected: `policies 17 | jobs table 1`

- [ ] **Step 6: Reseed and run the existing suite (schema change shouldn't break it)**

Run (Git Bash): `rm -rf .pgdata && npm run setup && npx vitest run 2>&1 | tail -4`
Expected: setup completes; 39 tests pass.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations
git commit -m "feat(jobs): jobs table + grants/RLS migration"
```

---

## Task 2: Backoff (pure)

**Files:** Create `lib/jobs/backoff.ts`, `test/backoff.test.ts`

- [ ] **Step 1: Write the failing test**

`test/backoff.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { backoffMs } from "@/lib/jobs/backoff";

describe("backoffMs", () => {
  it("first attempt is the base delay", () => {
    expect(backoffMs(1, 1000, 60000)).toBe(1000);
  });
  it("doubles each attempt", () => {
    expect(backoffMs(2, 1000, 60000)).toBe(2000);
    expect(backoffMs(3, 1000, 60000)).toBe(4000);
    expect(backoffMs(4, 1000, 60000)).toBe(8000);
  });
  it("caps at max", () => {
    expect(backoffMs(20, 1000, 60000)).toBe(60000);
  });
  it("uses defaults", () => {
    expect(backoffMs(1)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- backoff`
Expected: FAIL — cannot resolve `@/lib/jobs/backoff`.

- [ ] **Step 3: Implement**

`lib/jobs/backoff.ts`:
```ts
// Exponential backoff with a cap. attempt is 1-based.
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60000): number {
  const delay = baseMs * 2 ** (attempt - 1);
  return Math.min(delay, maxMs);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- backoff`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/backoff.ts test/backoff.test.ts
git commit -m "feat(jobs): exponential backoff helper"
```

---

## Task 3: Queue (enqueue / claim / complete / fail / reclaim)

**Files:** Create `lib/jobs/queue.ts`, `test/queue.test.ts`

- [ ] **Step 1: Write the failing test**

`test/queue.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { enqueue, claimJobs, completeJob, failJob, reclaimStuck } from "@/lib/jobs/queue";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("job queue", () => {
  it("enqueue inserts a pending job", async () => {
    const id = await enqueue(db as any, { type: "test", payload: { a: 1 } });
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("pending");
    expect(row.type).toBe("test");
    expect(row.payload).toEqual({ a: 1 });
  });

  it("claim marks running, increments attempts, and is not re-claimable", async () => {
    await enqueue(db as any, { type: "test", payload: {} });
    const first = await claimJobs(db as any, 10);
    expect(first).toHaveLength(1);
    expect(first[0].attempts).toBe(1);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, first[0].id));
    expect(row.status).toBe("running");
    const second = await claimJobs(db as any, 10);
    expect(second).toHaveLength(0); // already running → not pending
  });

  it("does not claim jobs scheduled in the future", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await enqueue(db as any, { type: "test", runAfter: future });
    expect(await claimJobs(db as any, 10)).toHaveLength(0);
  });

  it("completeJob marks succeeded", async () => {
    const id = await enqueue(db as any, { type: "test" });
    const [c] = await claimJobs(db as any, 10);
    await completeJob(db as any, c.id);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("succeeded");
  });

  it("failJob under max retries with a future run_after", async () => {
    const id = await enqueue(db as any, { type: "test", maxAttempts: 3 });
    const [c] = await claimJobs(db as any, 10); // attempts = 1
    await failJob(db as any, c.id, c.attempts, c.maxAttempts, "boom");
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("boom");
    expect(new Date(row.runAfter!).getTime()).toBeGreaterThan(Date.now());
  });

  it("failJob at max attempts dead-letters", async () => {
    const id = await enqueue(db as any, { type: "test", maxAttempts: 1 });
    const [c] = await claimJobs(db as any, 10); // attempts = 1 = max
    await failJob(db as any, c.id, c.attempts, c.maxAttempts, "fatal");
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toBe("fatal");
  });

  it("reclaimStuck resets long-running jobs to pending", async () => {
    await enqueue(db as any, { type: "test" });
    const [c] = await claimJobs(db as any, 10);
    // force locked_at into the past
    await db.update(schema.jobs).set({ lockedAt: new Date(Date.now() - 600_000).toISOString() }).where(eq(schema.jobs.id, c.id));
    const n = await reclaimStuck(db as any, 60_000);
    expect(n).toBe(1);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, c.id));
    expect(row.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- queue`
Expected: FAIL — cannot resolve `@/lib/jobs/queue`.

- [ ] **Step 3: Implement `lib/jobs/queue.ts`**

```ts
import { sql, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { backoffMs } from "./backoff";

export interface EnqueueInput {
  type: string;
  payload?: unknown;
  orgId?: string | null;
  runAfter?: string;       // ISO string
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: number;
  orgId: string | null;
  type: string;
  payload: any;
  attempts: number;
  maxAttempts: number;
}

export async function enqueue(db: DB, input: EnqueueInput): Promise<number> {
  const [row] = await db.insert(schema.jobs).values({
    type: input.type,
    payload: (input.payload ?? {}) as any,
    orgId: input.orgId ?? null,
    runAfter: input.runAfter ?? new Date().toISOString(),
    maxAttempts: input.maxAttempts ?? 5,
  }).returning({ id: schema.jobs.id });
  return row.id;
}

export async function claimJobs(db: DB, batch = 10): Promise<ClaimedJob[]> {
  const res = await db.execute(sql`
    UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status='pending' AND run_after <= now()
      ORDER BY run_after
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, type, payload, attempts, max_attempts
  `);
  return (res.rows as any[]).map((r) => ({
    id: Number(r.id),
    orgId: r.org_id,
    type: r.type,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function completeJob(db: DB, id: number): Promise<void> {
  await db.update(schema.jobs).set({ status: "succeeded", updatedAt: new Date().toISOString() }).where(eq(schema.jobs.id, id));
}

export async function failJob(db: DB, id: number, attempts: number, maxAttempts: number, error: string): Promise<void> {
  if (attempts >= maxAttempts) {
    await db.update(schema.jobs).set({ status: "dead", lastError: error, updatedAt: new Date().toISOString() }).where(eq(schema.jobs.id, id));
    return;
  }
  const delay = backoffMs(attempts);
  await db.execute(sql`
    UPDATE jobs
    SET status='pending', last_error=${error}, locked_at=NULL,
        run_after = now() + ${delay} * interval '1 millisecond', updated_at=now()
    WHERE id=${id}
  `);
}

// Resets jobs stuck in 'running' (locked_at older than stuckMs) back to pending.
export async function reclaimStuck(db: DB, stuckMs: number): Promise<number> {
  const res = await db.execute(sql`
    UPDATE jobs SET status='pending', locked_at=NULL, updated_at=now()
    WHERE status='running' AND locked_at < now() - ${stuckMs} * interval '1 millisecond'
    RETURNING id
  `);
  return res.rows.length;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- queue`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/queue.ts test/queue.test.ts
git commit -m "feat(jobs): Postgres queue (enqueue/claim/complete/fail/reclaim)"
```

---

## Task 4: Registry + worker

**Files:** Create `lib/jobs/registry.ts`, `lib/jobs/worker.ts`, `test/worker.test.ts`

Note: `worker.ts` imports `./handlers` for side-effect registration; `handlers.ts` is created in Task 5. To keep Task 4 self-contained and green, `worker.ts` imports `./handlers` with a guard that tolerates it not existing yet is NOT allowed (no placeholders). Instead, create a minimal `lib/jobs/handlers.ts` here that registers nothing yet (Task 5 fills it).

- [ ] **Step 1: Create `lib/jobs/registry.ts`**

```ts
import type { DB } from "@/db/client";
import type { ClaimedJob } from "./queue";

export type JobHandler = (db: DB, payload: any, job: ClaimedJob) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}
```

- [ ] **Step 2: Create an empty `lib/jobs/handlers.ts` (filled in Task 5)**

```ts
// Job handler registrations (side-effect import). Filled in as features are added.
// Importing this module registers all built-in job handlers.
export {};
```

- [ ] **Step 3: Write the failing test**

`test/worker.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { enqueue } from "@/lib/jobs/queue";
import { registerJob } from "@/lib/jobs/registry";
import { runWorkerOnce } from "@/lib/jobs/worker";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("worker", () => {
  it("runs a registered handler and marks the job succeeded", async () => {
    const seen: any[] = [];
    registerJob("t_ok", async (_db, payload) => { seen.push(payload); });
    const id = await enqueue(db as any, { type: "t_ok", payload: { x: 1 } });
    const { processed } = await runWorkerOnce(db as any, 10);
    expect(processed).toBe(1);
    expect(seen).toEqual([{ x: 1 }]);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("succeeded");
  });

  it("retries a throwing handler then dead-letters at max", async () => {
    registerJob("t_boom", async () => { throw new Error("nope"); });
    const id = await enqueue(db as any, { type: "t_boom", maxAttempts: 2 });
    await runWorkerOnce(db as any, 10); // attempt 1 → pending (future run_after)
    let [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("pending");
    // make it due again, then second pass dead-letters
    await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.jobs.id, id));
    await runWorkerOnce(db as any, 10); // attempt 2 = max → dead
    [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("nope");
  });

  it("dead-letters an unknown job type", async () => {
    const id = await enqueue(db as any, { type: "t_unknown", maxAttempts: 1 });
    await runWorkerOnce(db as any, 10);
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("no handler");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — cannot resolve `@/lib/jobs/worker`.

- [ ] **Step 5: Implement `lib/jobs/worker.ts`**

```ts
import type { DB } from "@/db/client";
import { claimJobs, completeJob, failJob } from "./queue";
import { getHandler } from "./registry";
import "./handlers"; // side-effect: register built-in handlers

export async function runWorkerOnce(db: DB, batch = 10): Promise<{ processed: number }> {
  const jobs = await claimJobs(db, batch);
  for (const job of jobs) {
    try {
      const handler = getHandler(job.type);
      if (!handler) throw new Error(`no handler for job type "${job.type}"`);
      await handler(db, job.payload, job);
      await completeJob(db, job.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failJob(db, job.id, job.attempts, job.maxAttempts, msg);
    }
  }
  return { processed: jobs.length };
}

let timer: NodeJS.Timeout | null = null;

export function startWorker(db: DB, intervalMs = 2000): void {
  if (timer) return;
  timer = setInterval(() => {
    runWorkerOnce(db).catch((err) => console.error("[worker]", err));
  }, intervalMs);
  console.log("[worker] started");
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -- worker`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/jobs/registry.ts lib/jobs/handlers.ts lib/jobs/worker.ts test/worker.test.ts
git commit -m "feat(jobs): handler registry + worker (runWorkerOnce/startWorker)"
```

---

## Task 5: Route publishing through the queue

**Files:** Modify `lib/publishing/service.ts`, `lib/jobs/handlers.ts`, `app/api/v1/posts/route.ts`, `instrumentation.ts`; Create `bin/worker.ts`; Delete `lib/publishing/scheduler.ts`; Modify `package.json`, `test/api-flywheel.test.ts`

- [ ] **Step 1: Add `publishPost` to `lib/publishing/service.ts` and enqueue in `createPost`**

Add the import at the top of `lib/publishing/service.ts` (after the existing imports):
```ts
import { enqueue } from "@/lib/jobs/queue";
```
At the end of `createPost`, replace the final `return post;` with:
```ts
  await enqueue(db, { type: "publish_post", orgId, payload: { postId } });
  return post;
```
Append a new exported function at the end of the file:
```ts
// Publishes all still-pending targets of a post (the publish_post job handler). Idempotent:
// only touches pending targets, so a retry after a partial success won't double-publish.
export async function publishPost(db: DB, postId: string, provider: ChannelProvider = new MockChannelProvider()) {
  const targets = await db.select().from(schema.postTargets)
    .where(and(eq(schema.postTargets.postId, postId), eq(schema.postTargets.status, "pending")));
  for (const t of targets) {
    await publishTarget(db, t.id, provider);
  }
  await rollupPostStatus(db, postId);
}
```
Add `MockChannelProvider` to the imports at the top of `lib/publishing/service.ts`:
```ts
import { MockChannelProvider } from "@/lib/channel/mock";
```
(`and`, `eq`, `schema`, `DB`, `ChannelProvider`, `publishTarget`, `rollupPostStatus` are already imported/defined in this file.)

- [ ] **Step 2: Register the handler in `lib/jobs/handlers.ts`**

```ts
// Job handler registrations (side-effect import). Importing this module registers handlers.
import { registerJob } from "./registry";
import { publishPost } from "@/lib/publishing/service";

registerJob("publish_post", async (db, payload) => {
  await publishPost(db, payload.postId);
});
```

- [ ] **Step 3: Drain inline on PGlite in the POST /posts route**

Replace `app/api/v1/posts/route.ts` entirely:
```ts
import { eq } from "drizzle-orm";
import { schema, driverKind } from "@/db/client";
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { createPost, listPosts } from "@/lib/publishing/service";
import { runWorkerOnce } from "@/lib/jobs/worker";

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
      // PGlite dev: no background worker (single connection) → drain the just-enqueued job
      // inline within this same request/connection. Managed Postgres uses the worker process.
      if (driverKind === "pglite") {
        await runWorkerOnce(db);
      }
      return out;
    });
    return ok(responseBody, 202);
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 4: Replace the scheduler with the worker in `instrumentation.ts`**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Migrations are applied by `npm run setup` / `npm run db:migrate` (dev) or the deploy step.
    const { driverKind, db } = await import("@/db/client");
    if (driverKind === "pg") {
      // Managed Postgres allows concurrent connections → run the in-process job worker.
      // PGlite (dev) is single-connection; jobs drain inline in the POST /posts route instead.
      const { startWorker } = await import("@/lib/jobs/worker");
      startWorker(db);
    } else {
      console.log("[worker] inline mode on PGlite dev (jobs drain in-request)");
    }
  }
}
```

- [ ] **Step 5: Delete the old scheduler**

Run: `rm -f lib/publishing/scheduler.ts`

- [ ] **Step 6: Create `bin/worker.ts`**

```ts
import { db, driverKind } from "../db/client";
import { startWorker } from "../lib/jobs/worker";

if (driverKind !== "pg") {
  console.error("`npm run worker` requires managed Postgres (set DATABASE_URL=postgres://…).");
  console.error("On PGlite dev, jobs drain inline in the POST /posts route — no worker needed.");
  process.exit(1);
}

startWorker(db);
console.log("[worker] running against managed Postgres");
```
Note: `bin/worker.ts` uses relative imports (run via tsx, like `db/seed.ts`).

- [ ] **Step 7: Add the `worker` script to `package.json`**

In the `scripts` block, add after `"db:seed"`:
```json
    "worker": "tsx bin/worker.ts",
```

- [ ] **Step 8: Add the publish-via-queue integration test**

Append to `test/api-flywheel.test.ts` (inside the existing `describe("flywheel end-to-end", …)` block, add a new `it`). First add the import at the top of the file:
```ts
import { runWorkerOnce } from "@/lib/jobs/worker";
import * as schemaAll from "@/db/schema";
```
Then add this test:
```ts
  it("createPost enqueues a publish_post job that the worker publishes", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const acc = await seedAccount(db, orgId, profileId, "twitter");
    const post = await createPost(db as any, orgId, { profileId, content: "Queued!", accountIds: [acc] });

    // a publish_post job exists and the post is not yet published
    const jobsBefore = await db.select().from(schemaAll.jobs);
    expect(jobsBefore.some((j) => j.type === "publish_post")).toBe(true);

    // worker drains it → targets published, post rolled up
    const { processed } = await runWorkerOnce(db as any, 10);
    expect(processed).toBeGreaterThanOrEqual(1);
    const [updated] = await db.select().from(schemaAll.posts).where(eq(schemaAll.posts.id, post.id));
    expect(updated.status).toBe("published");
  });
```

- [ ] **Step 9: Run the full suite + type-check**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -6`
Expected: tsc exit 0; all tests pass (39 prior + backoff 4 + queue 7 + worker 3 + 1 integration). Note the existing publishing.test still asserts targets are `pending` right after `createPost` — that remains true because `createPost` only enqueues (it does not drain).

- [ ] **Step 10: Commit**

```bash
git add lib/publishing/service.ts lib/jobs/handlers.ts app/api/v1/posts/route.ts instrumentation.ts bin/worker.ts package.json test/api-flywheel.test.ts
git rm --cached lib/publishing/scheduler.ts 2>/dev/null; true
git commit -m "feat(jobs): publish via durable queue; inline drain (PGlite) + worker (Postgres)"
```

---

## Task 6: Verify end-to-end + docs

**Files:** Modify `README.md`, `docs/IMPLEMENTATION-ROADMAP.md`

- [ ] **Step 1: Fresh setup + full suite + build**

Run (Git Bash): `rm -rf .pgdata && npm run setup && npx tsc --noEmit && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -4`
Expected: setup ok; tsc exit 0; all tests pass; build exits 0.

- [ ] **Step 2: Manual dev smoke (publish works inline on PGlite)**

Run: `npm run dev` (background). Then:
```
curl -s -c cj.txt -X POST localhost:3000/api/v1/auth/login -H "content-type: application/json" -d '{"email":"demo@launchos.com","password":"demo1234"}' -o /dev/null -w "login %{http_code}\n"
read PROFILE ACC1 ACC2 <<<$(curl -s -b cj.txt localhost:3000/api/v1/accounts | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.data[0].profileId,j.data[0].id,j.data[1].id)})")
curl -s -b cj.txt -X POST localhost:3000/api/v1/posts -H "content-type: application/json" -H "Idempotency-Key: q-$(date +%s)" -d "{\"profileId\":\"$PROFILE\",\"content\":\"queue smoke\",\"accountIds\":[\"$ACC1\",\"$ACC2\"]}" -o /dev/null -w "create %{http_code}\n"
curl -s -b cj.txt localhost:3000/api/v1/posts | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const p=j.data.find(x=>x.content==='queue smoke');console.log('status',p?.status,'targets',JSON.stringify((p?.targets||[]).map(t=>t.platform+':'+t.status)))})"
```
Expected: `login 200`, `create 202`, and the post shows `status published` with both targets `published` — **inline drain works on PGlite** (no background worker, no aborts). Stop the server: `taskkill //F //T //PID $(netstat -ano | grep -E ":3000\b" | grep LISTENING | head -1 | awk '{print $NF}')`; `rm -f cj.txt dev.log`.

- [ ] **Step 3: Update README (worker + queue)**

In `README.md`, under the architecture bullets, replace the publishing line:
```
- `lib/publishing/*` — post/target lifecycle + in-process scheduler (Temporal seam).
```
with:
```
- `lib/jobs/*` — durable Postgres-backed job queue (enqueue/claim/retry/backoff/DLQ).
- `lib/publishing/*` — post/target lifecycle; publishing runs as a `publish_post` job.
```
And add a "Background worker" subsection after the PGlite dev note:
````markdown
### Background worker

Publishing runs through a durable job queue (`jobs` table). On **managed Postgres**, run a
worker to drain it (the Next server also runs an in-process worker):

```bash
npm run worker     # requires DATABASE_URL=postgres://…
```

On **PGlite dev**, there is no separate worker (single-connection); the POST /posts route
drains the just-enqueued job inline, so publishing works in dev.
````

- [ ] **Step 4: Mark P1.2 in the roadmap**

In `docs/IMPLEMENTATION-ROADMAP.md`, change `### 4.2 ⬜ Durable job/workflow runtime` to `### 4.2 ✅ Durable job/workflow runtime (Postgres-backed queue)`, and update the P1 row in the §2 table to add `✅ durable jobs` alongside `✅ Postgres+RLS`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/IMPLEMENTATION-ROADMAP.md
git commit -m "docs: durable job queue run notes + roadmap status (P1.2 done)"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** Postgres-backed queue with SKIP LOCKED (Task 3) ✓; backoff (Task 2) ✓;
  retries → DLQ + reclaim stuck (Task 3) ✓; registry + worker (Task 4) ✓; `jobs` table native
  types + grants + RLS for `app_user` (Task 1) ✓; publish migrated, scheduler removed (Task 5)
  ✓; dual drain — worker process (`bin/worker.ts` + instrumentation on pg) + inline on PGlite
  (route) (Task 5) ✓; idempotent `publishPost` (only pending targets) (Task 5) ✓; outbox
  deferred (not built) ✓; all tests + build green (Tasks 5–6) ✓.
- **No placeholders:** every step has complete code; `handlers.ts` is created empty in Task 4
  and filled in Task 5 (explicit, not a placeholder).
- **Type consistency:** `ClaimedJob` shape (`id, orgId, type, payload, attempts, maxAttempts`)
  is consistent across queue/worker/registry; `enqueue(db, {type,payload,orgId?,runAfter?,
  maxAttempts?})` matches its callers (`createPost`, tests); `runWorkerOnce(db, batch)` and
  `startWorker(db, intervalMs)` signatures match route/instrumentation/bin usage; `publishPost(
  db, postId, provider?)` matches the handler.
- **Existing-test safety:** `createPost` only enqueues (no inline drain), so the existing
  publishing.test "targets pending after createPost" assertion still holds; inline drain lives
  in the route.
```
