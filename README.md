# LaunchOS — Core Flywheel Slice

The first runnable vertical slice: compose → publish (mock) → touchpoint → attribution → dashboard.
See `docs/superpowers/specs/2026-06-13-core-flywheel-slice-design.md` for scope and rationale,
and `LaunchOS-Spec.md` / `launchos_schema.sql` for the full product vision and canonical schema.

## Run it

```bash
npm install
npm run setup     # runs migrations (creates .pgdata via PGlite) + seeds a demo org
npm run dev       # http://localhost:3000
```

Log in at `/login` with **demo@launchos.com / demo1234**.

Database: **PGlite** (in-process Postgres, WASM) for local dev/test — no install needed. Set
`DATABASE_URL=postgres://…` to point at managed Postgres in production (same migrations, same
code). Tenant isolation is enforced by Postgres **Row-Level Security** (`withOrg` sets
`app.current_org` under a non-privileged role); workers use the service-role connection.

> **PGlite dev note:** PGlite is single-connection and allows only one process per data dir.
> Run a single `npm run dev`. The background job worker runs only against managed Postgres; on
> PGlite, jobs drain **inline** in the POST /posts request, so publishing works in dev too.

### Background worker

Publishing runs through a durable job queue (the `jobs` table). On **managed Postgres**, run a
worker to drain it (the Next server also runs an in-process worker):

```bash
npm run worker     # requires DATABASE_URL=postgres://…
```

On **PGlite dev**, there is no separate worker (single-connection); the POST /posts route
drains the just-enqueued `publish_post` job inline, so publishing works in dev.

## Test

```bash
npm test
```

## Architecture

UI → `app/api/v1/*` route handlers → `lib/*` services → Drizzle/SQLite.
- `lib/channel/*` — `ChannelProvider` seam (`MockChannelProvider` now; wrap/native later).
- `lib/jobs/*` — durable Postgres-backed job queue (enqueue / claim via SKIP LOCKED / retry / backoff / DLQ).
- `lib/publishing/*` — post/target lifecycle; publishing runs as a `publish_post` job.
- `lib/attribution/*` — identity stitching, ingest, first/last/linear models, channel report.
- `lib/journey/*` — per-contact timeline.

The database is **Postgres**, accessed via Drizzle: PGlite (`@electric-sql/pglite`, WASM) in
dev/test and node-postgres (`pg`) in production, selected by `DATABASE_URL`. The schema
(`db/schema.ts`) is a subset of `launchos_schema.sql` keeping logical types (native
uuid/timestamptz/jsonb fidelity is a deferred follow-up). Multi-tenant isolation is real
Postgres RLS (enable + force + per-table `org_isolation` policy), with `org_id` query filters
kept as defense-in-depth.

## What this slice deliberately omits

AI gateway / Viral Generator / Campaign Brain, real platform OAuth, Stripe billing, inbox/
messaging, ads, agents, Temporal, pgvector/RAG, SDK/MCP generation, white-label theming,
time-decay & data-driven attribution, browser pixel. Each has a named seam to slot into later.
