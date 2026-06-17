# CLAUDE.md — LaunchOS

Auto-loaded each session. This is the **hub**: read it first, then open only the entry
file(s) for your task (see the table below). The goal is to act without scanning the tree.

## What this is
LaunchOS is a venture-scale social-media-management SaaS + AI differentiator systems. Current
state is a production-grade vertical slice plus the first AI feature, built in phases
(P0 wedge → P1 production foundation → P2 MVP). **The owner uses it personally right now — not
shipping multi-tenant SaaS yet; billing is deferred.** Status: see [docs/IMPLEMENTATION-ROADMAP.md](docs/IMPLEMENTATION-ROADMAP.md).

## Stack (one line)
Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind · Drizzle ORM (pg-core) · Postgres via
**PGlite** (WASM, dev/test) or **node-postgres** (prod), selected by `DATABASE_URL` · Vitest.

## The 10 things to know before editing
1. **Every model call goes through `lib/ai/gateway.ts` `run()`** — never call a provider directly. It routes task→model, records the `ai_jobs` cost ledger, and enforces per-org budgets. Mock provider offline; real Claude (`claude-opus-4-8`) when `ANTHROPIC_API_KEY` is set.
2. **Multi-tenancy is real Postgres RLS.** Org-scoped work runs inside `withOrg(orgId, fn)` (sets `app.current_org` under the non-privileged `app_user` role). `withServiceRole`/base `db` bypasses RLS. Keep `org_id` filters in queries too (defense-in-depth). See [DATABASE.md](DATABASE.md).
3. **API routes** live in `app/api/v1/**/route.ts`, resolve the caller with `requireContext()` (session cookie OR `Authorization: Bearer sk_…`), do work in `ctx.withOrg(...)`, return via `ok()`, and convert thrown `ApiError` with `toProblemResponse()` (RFC-9457 problem+json). Pattern reference: `app/api/v1/posts/route.ts`.
4. **Every new `/v1` route MUST be added to `lib/openapi/spec.ts`** or the drift-guard test (`test/openapi.test.ts`) fails.
5. **Durable work = the `jobs` table** (`lib/jobs/*`), claimed via `FOR UPDATE SKIP LOCKED`. On PGlite (single-connection) jobs drain **inline** in the request; on managed Postgres a separate `npm run worker` drains them.
6. **New feature table** = add to `db/schema.ts` → `npm run db:generate` → hand-write an RLS migration (`drizzle-kit generate --custom`) with `app_user` GRANT + `org_isolation_*` policy → add the table to `test/helpers.ts` `ALL_TABLES`. Worked example: migrations `0010`/`0011`.
7. **TDD is the norm** here (Vitest). Tests share ONE PGlite instance and TRUNCATE between tests (`test/helpers.ts`). Run `npm test`.
8. **Errors** are `ApiError(status, code, detail, headers?)` from `lib/errors.ts`; never throw bare strings in routes/services.
9. **Secrets/logging:** `lib/log.ts` redacts; `SESSION_SECRET` is required in production (app refuses to boot without it); API keys are stored SHA-256 only.
10. **Environment constraints:** Windows, no Docker, no C++ toolchain, no Redis. That's why PGlite (not better-sqlite3), in-process jobs, and MCP-over-stdio. PGlite allows **one process per `.pgdata`** — don't run `npm run dev` and the worker simultaneously on PGlite.

## Where to look (entry-point-per-task)
| Task | Open these first |
|---|---|
| Add/modify an API endpoint | `app/api/v1/posts/route.ts` (pattern) · [API_MAP.md](API_MAP.md) · `lib/request.ts` · `lib/openapi/spec.ts` |
| Add a DB table / migration | [DATABASE.md](DATABASE.md) · `db/schema.ts` · migrations `0010`/`0011` · `test/helpers.ts` |
| Add an AI feature | `lib/ai/gateway.ts` · `lib/viral/*` (worked example) · `lib/ai/router.ts` |
| Publishing / channels | `lib/publishing/service.ts` · `lib/channel/*` · `lib/jobs/*` |
| Attribution / journeys | `lib/attribution/*` · `lib/journey/*` |
| SDK / MCP surface | `lib/sdk/client.ts` · `mcp/tools.ts` |
| Understand the whole system | [ARCHITECTURE.md](ARCHITECTURE.md) · [PROJECT_MAP.md](PROJECT_MAP.md) |
| How to do common workflows | [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) |

## Commands
`npm run dev` · `npm test` · `npm run build` · `npm run setup` (migrate+seed) · `npm run db:generate` · `npm run db:migrate` · `npm run worker` · `npm run apikey` · `npm run mcp`. Login: **demo@launchos.com / demo1234**.

## Read-on-demand only (large; don't open speculatively)
`LaunchOS-Spec.md` (61 KB product vision), `launchos_schema.sql` (55 KB canonical schema — but
`db/schema.ts` is the **active** schema), `docs/superpowers/specs|plans/**` (design history).
`db/migrations/meta/**`, `package-lock.json`, `node_modules`, `.next`, `.pgdata` are in `.claudeignore` — do not read them.

## House rules
- Commit/push only when asked; branch off `main` first. Co-author trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Don't change application behavior as part of "cleanup" without approval.
- Keep docs in sync: if you add a route, table, or env var, update the matching map file.
