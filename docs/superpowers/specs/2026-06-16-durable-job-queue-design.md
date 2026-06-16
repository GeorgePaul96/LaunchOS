# Durable Job Queue — Design

**Date:** 2026-06-16
**Status:** Approved (pending written-spec review)
**Phase:** P1.2 (production foundation — second sub-project)
**Source:** `docs/IMPLEMENTATION-ROADMAP.md` §4.2, `LaunchOS-Spec.md` §5/§10

---

## 0. Context & decisions

The app currently fires scheduled publishing with an in-process `setInterval` poller
(`lib/publishing/scheduler.ts`), gated to managed Postgres because PGlite is single-connection
and aborts when a background timer and request handlers touch it concurrently. There is no job
durability, no retry/backoff, no dead-letter queue.

This sub-project replaces that with a **durable, Postgres-backed job queue** and migrates the
publish flow onto it. No new product features — same publish behavior, now durable and
retryable.

Decisions locked during brainstorming:
- **Queue tech:** Postgres-backed (`jobs` table drained with `SELECT … FOR UPDATE SKIP
  LOCKED`). No Redis/Temporal (neither is available — no Docker). Runs on the Postgres we
  already have (PGlite dev / managed prod). The queue lives behind a small interface so
  Temporal/BullMQ could replace it later.
- **Worker model:** dual-strategy behind one interface — a background worker process for
  managed Postgres, and **inline** drain on PGlite (jobs run in the enqueuing request,
  single-connection-safe) so dev publishing works again.
- **Migrate now:** the publish flow only. Other workers (broadcast, sequence, competitor,
  agent, experiment) are added when those features exist (YAGNI).
- **Outbox deferred:** the transactional outbox moves to the webhooks sub-project (P3) — an
  outbox with no event consumer yet is speculative. The `jobs` queue already provides
  durability for the one real producer (publish).

---

## 1. Architecture

```
lib/jobs/
  backoff.ts    attempt -> delay ms (exponential, capped)
  queue.ts      enqueue / claimJobs / completeJob / failJob / reclaimStuck
  registry.ts   Map<type, handler>; registers "publish_post"
  worker.ts     runWorkerOnce(db, opts?) ; startWorker(intervalMs)
bin/worker.ts   `npm run worker` entry (managed Postgres only)
```

### 1.1 `jobs` table (new)
Native types (no legacy test constraints on new tables):
- `id` bigserial PK
- `org_id` text NULL (NULL = system job)
- `type` text NOT NULL
- `payload` jsonb NOT NULL default `'{}'`
- `status` text NOT NULL default `'pending'` — `pending | running | succeeded | failed | dead`
- `attempts` int NOT NULL default 0
- `max_attempts` int NOT NULL default 5
- `run_after` timestamptz NOT NULL default now()
- `locked_at` timestamptz NULL
- `last_error` text NULL
- `created_at` / `updated_at` timestamptz NOT NULL default now()
- Index on `(status, run_after)` for the claim scan.
- RLS: enabled + forced + `org_isolation` policy keyed on `org_id` (same pattern as other org
  tables). The background worker connects as the **service role** to claim across all orgs;
  inline drain runs within the current org scope (which is sufficient for that org's jobs).
  Note: rows with `org_id IS NULL` are only visible to the service role — fine (system jobs).
  The jobs migration must explicitly `GRANT SELECT/INSERT/UPDATE/DELETE ON jobs TO app_user`
  and `GRANT USAGE,SELECT ON` its sequence — the P1.1 grant only covered tables that existed
  then, so new tables need their own grants (or `ALTER DEFAULT PRIVILEGES`).

### 1.2 Claim (atomic, no double-processing)
```sql
UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
WHERE id IN (
  SELECT id FROM jobs
  WHERE status='pending' AND run_after <= now()
  ORDER BY run_after
  LIMIT $batch
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

### 1.3 Lifecycle
`pending → running` (claim) → `succeeded` on handler success; on handler error:
`attempts < max_attempts` → `pending` with `run_after = now() + backoff(attempts)`; else
`dead` (DLQ) with `last_error`. A job stuck in `running` past a lock timeout (`locked_at <
now() - STUCK_MS`) is reclaimed to `pending` by `reclaimStuck`.

### 1.4 Backoff
`backoff(attempt) = min(BASE_MS * 2^(attempt-1), MAX_MS)` (e.g. BASE 1000ms, MAX 60000ms).
Pure function, unit-tested.

---

## 2. Two drain strategies (one interface)

- **Prod (managed Postgres, `driverKind === 'pg'`):** background worker.
  - `bin/worker.ts` → `npm run worker`: a dedicated process running `startWorker()` (loop of
    `runWorkerOnce` every interval) using the service-role connection.
  - `instrumentation.ts` also starts an in-process `startWorker()` on `pg` (mirrors the old
    scheduler gating). Multiple workers are safe via SKIP LOCKED.
- **Dev (PGlite, `driverKind === 'pglite'`):** **inline**. `createPost` enqueues the
  `publish_post` job and then, on PGlite, calls `runWorkerOnce` within the same
  request/connection. No background timer → no PGlite concurrency abort. `bin/worker.ts`
  refuses to run on PGlite with a clear message (a second process can't open the same
  `.pgdata`).

---

## 3. Publish migration

- `createPost` enqueues a `publish_post` job `{ payload: { postId } }` in the **same
  transaction** as the post + targets insert (durable: if the txn commits, the job exists).
- Handler `publish_post` → `publishPost(db, postId)`: load the post's `pending` targets,
  publish each via the provider (`MockChannelProvider` for now), roll up post status. A single
  target failing is captured on that target (post → `partial`) and does **not** fail the job;
  the job only fails on unexpected errors (so retries don't double-publish succeeded targets —
  `publishPost` only touches `pending` targets).
- `lib/publishing/scheduler.ts` and its `startScheduler` are **removed**; `instrumentation.ts`
  starts the job worker instead (gated to `pg`). `retryTarget` stays for direct UI retries.

---

## 4. Error handling

- Handler throws → `failJob` (retry with backoff, or dead at max). `last_error` recorded.
- `publishPost` isolates per-target failures (no job failure for an expected provider
  rejection); the post rolls up to `partial`/`failed` as today.
- The worker loop wraps each job; one failing job never stops the loop. Errors are logged with
  the job id + type.
- Idempotency: re-running `publish_post` only publishes still-`pending` targets, so a retry
  after a partial success won't re-publish or duplicate.

---

## 5. Testing (TDD)

- `backoff` — exponential growth, cap, attempt=1 base.
- `queue` — enqueue inserts pending; `claimJobs` marks running + increments attempts and a
  second claim returns none for the same row; `completeJob` → succeeded; `failJob` under max →
  pending with future `run_after`; at max → dead; `reclaimStuck` resets a stale running job.
- `worker` — `runWorkerOnce` runs the registered handler and marks succeeded; a throwing
  handler → pending (retry) then dead after max; unknown type → dead with clear error.
- integration — `createPost` enqueues a `publish_post` job; `runWorkerOnce` publishes the
  targets; post status becomes `published`; partial when a target is forced to fail.
- inline — on PGlite, `createPost` drains inline so targets are `published` right after the
  call (simulated by invoking the inline path against the test db).
- All existing 39 tests stay green.

---

## 6. Out of scope

- **Transactional outbox** → P3 (webhooks), when there is an event consumer.
- Non-publish workers (broadcast/sequence/competitor/agent/experiment) → their feature phases.
- Temporal/BullMQ → possible later behind the `lib/jobs` interface.
- Multi-region/sharded worker fleet, priorities, cron-style recurring jobs (add when needed).

---

## 7. Acceptance criteria

- A `publish_post` job is enqueued in the same transaction as the post; if the process dies
  before processing, the job is still `pending` and gets run on next worker pass (durability).
- Failed jobs retry with exponential backoff and dead-letter after `max_attempts`; a `dead`
  job is queryable with its `last_error`.
- Two concurrent claimers never process the same job (SKIP LOCKED) — covered by the claim test.
- **Dev (PGlite):** publishing works again — composing a post results in published targets
  (inline drain), with no background process and no WASM aborts.
- **Prod (managed Postgres):** `npm run worker` drains the queue; the in-process worker also
  runs (gated to `pg`).
- All tests pass (39 existing + new queue/worker/backoff/integration); production build green;
  no feature behavior changed beyond publish now flowing through the durable queue.
