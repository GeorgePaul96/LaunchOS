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

The database is SQLite via **libsql** (`@libsql/client`) — a prebuilt driver chosen so the
project builds with no native C++ toolchain. The schema (`db/schema.ts`) is a Postgres-shaped
subset of `launchos_schema.sql`; `org_id` filtering substitutes for Postgres RLS. To target
Postgres later, port `db/schema.ts` back per its header notes.

## What this slice deliberately omits

AI gateway / Viral Generator / Campaign Brain, real platform OAuth, Stripe billing, inbox/
messaging, ads, agents, Temporal, pgvector/RAG, SDK/MCP generation, white-label theming,
time-decay & data-driven attribution, browser pixel. Each has a named seam to slot into later.
