# PROJECT_MAP.md — LaunchOS

Directory/file index so Claude can jump straight to the right file. 163 tracked files (~1.9 MB);
largest source file is `db/schema.ts` at 298 lines — nothing needs splitting.

## Top level
```
app/                 Next.js App Router: UI pages + /api/v1 route handlers
lib/                 business logic (services + cross-cutting seams)   ← most edits land here
db/                  schema, drizzle migrations, client/driver selection, seed
mcp/                 stdio MCP server (Claude/Cursor) over the SDK
bin/                 CLI scripts (worker, apikey)
test/               Vitest suites + shared PGlite harness (helpers.ts)
docs/                roadmap + superpowers specs/plans (design history)
CLAUDE.md ARCHITECTURE.md PROJECT_MAP.md DATABASE.md API_MAP.md DEVELOPER_GUIDE.md   doc layer
LaunchOS-Spec.md launchos_schema.sql   large canonical references (read on demand)
*.config.ts / instrumentation.ts / middleware.ts   framework config + startup/request hooks
```

## `app/`
- `app/(app)/` — authenticated UI: `dashboard`, `compose`, `content-studio`, `calendar`, `analytics`, `contacts/[id]`, `settings/connections` (each a `page.tsx`); shared `layout.tsx` holds the nav.
- `app/(auth)/` — `login`, `signup`.
- `app/api/v1/**/route.ts` — the HTTP API (full list in [API_MAP.md](API_MAP.md)).

## `lib/` (by module — what / where)
| Module | Responsibility |
|---|---|
| `ai/` | AI gateway `run()`, provider seam (`mock`, `anthropic`), `router`, `pricing`, `budget` |
| `viral/` | Viral Content Generator: `prompt.ts` (builder), `service.ts` (generate/list/choose) |
| `publishing/` | post + post_target lifecycle; enqueues `publish_post` jobs |
| `channel/` | `ChannelProvider` interface + `MockChannelProvider` |
| `jobs/` | durable queue: enqueue, claim (SKIP LOCKED), worker, backoff, DLQ |
| `attribution/` | identity stitching, ingest, first/last/linear models, channel report |
| `journey/` | per-contact touchpoint+conversion timeline |
| `sdk/` | hand-written typed API client (`client.ts`, `types.ts`, `errors.ts`) |
| `openapi/` | `spec.ts` (hand-authored 3.1 contract) + `paths.ts` (drift-guard discovery) |
| `auth.ts` `request.ts` | password/session/api-key crypto; `requireContext()` |
| `errors.ts` | `ApiError` + problem+json |
| `log.ts` `audit.ts` `ratelimit.ts` | logging (redaction), audit trail, rate limiting |
| `ids.ts` | `uuid()`, `publicId(prefix)` |
| `org-context.ts` `page-data.ts` | server-side org context + page data loaders |

## `db/`
- `schema.ts` — all Drizzle tables (the active schema). See [DATABASE.md](DATABASE.md).
- `client.ts` — driver selection + `withOrg` / `scopeToOrg` / `withServiceRole`.
- `migrations/` — drizzle SQL migrations (`0000…0011`); `migrations/meta/**` is generated JSON (in `.claudeignore`).
- `migrate.ts`, `seed.ts` — apply migrations / seed demo org.

## `mcp/` and `bin/`
- `mcp/tools.ts` (tool definitions) · `mcp/server.ts` (builds the MCP server) · `mcp/main.ts` (entry).
- `bin/worker.ts` (drain jobs on managed Postgres) · `bin/apikey.ts` (mint an `sk_…` key).

## `test/`
- `helpers.ts` — shared single PGlite instance, `makeTestDb()`, `seedOrg`, `seedAccount`, `scopeToOrg`, `ALL_TABLES` (add new tables here).
- One `*.test.ts` per concern (ai-*, publishing, queue, rls, sdk, mcp, content-api, viral-*, …).
- `vitest.config.ts` — single-fork, `isolate:false` (PGlite WASM constraint).
