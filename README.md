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
> Run a single `npm run dev`. The in-process publish **scheduler runs only against managed
> Postgres** (`DATABASE_URL=postgres://…`), not PGlite — so on PGlite, scheduled posts are not
> auto-published in dev (the publish path is covered by the test suite). Everything else works
> on PGlite.

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
