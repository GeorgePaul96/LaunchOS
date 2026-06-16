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

### Programmatic access (SDK + MCP)

Mint a key, then call the API:

```bash
npm run apikey                 # prints an sk_… key once
curl -H "Authorization: Bearer sk_…" localhost:3000/api/v1/accounts
```

The OpenAPI 3.1 contract is at `GET /api/v1/openapi.json`; the typed client is `lib/sdk`.

**MCP (Claude Desktop / Cursor):** run `npm run dev`, then point your MCP client at:

```json
{ "mcpServers": { "launchos": {
  "command": "npm", "args": ["run", "mcp"],
  "env": { "LAUNCHOS_API_KEY": "sk_…", "LAUNCHOS_BASE_URL": "http://localhost:3000" }
} } }
```

Tools: `list_accounts`, `list_posts`, `create_post`, `attribution_report`, `contact_journey`, `record_touchpoint`, `record_conversion`.

## Test

```bash
npm test
```

## Architecture

UI → `app/api/v1/*` route handlers → `lib/*` services → Drizzle/SQLite.
- `lib/channel/*` — `ChannelProvider` seam (`MockChannelProvider` now; wrap/native later).
- `lib/jobs/*` — durable Postgres-backed job queue (enqueue / claim via SKIP LOCKED / retry / backoff / DLQ).
- `lib/ai/*` — AI gateway: provider seam (Mock dev/test, Anthropic prod via `ANTHROPIC_API_KEY`), task router, `ai_jobs` cost ledger, per-org budget caps.
- `lib/sdk/*` + `mcp/*` — typed API client + stdio MCP server (Claude/Cursor); `/api/v1/openapi.json` is the contract. API-key auth via `Authorization: Bearer sk_…`.
- `lib/publishing/*` — post/target lifecycle; publishing runs as a `publish_post` job.
- `lib/attribution/*` — identity stitching, ingest, first/last/linear models, channel report.
- `lib/journey/*` — per-contact timeline.

The database is **Postgres**, accessed via Drizzle: PGlite (`@electric-sql/pglite`, WASM) in
dev/test and node-postgres (`pg`) in production, selected by `DATABASE_URL`. The schema
(`db/schema.ts`) is a subset of `launchos_schema.sql` keeping logical types (native
uuid/timestamptz/jsonb fidelity is a deferred follow-up). Multi-tenant isolation is real
Postgres RLS (enable + force + per-table `org_isolation` policy), with `org_id` query filters
kept as defense-in-depth.

Set `ANTHROPIC_API_KEY` to use real Claude calls (model `claude-opus-4-8`); without it the AI
gateway runs on a deterministic mock. Per-org monthly AI spend is capped via
`AI_BUDGET_CENTS_DEFAULT` (env) or `organizations.feature_flags.ai_budget_cents`.

## What this slice deliberately omits

AI gateway / Viral Generator / Campaign Brain, real platform OAuth, Stripe billing, inbox/
messaging, ads, agents, Temporal, pgvector/RAG, SDK/MCP generation, white-label theming,
time-decay & data-driven attribution, browser pixel. Each has a named seam to slot into later.
