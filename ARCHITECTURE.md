# ARCHITECTURE.md — LaunchOS

How the system fits together. For the file/dir index see [PROJECT_MAP.md](PROJECT_MAP.md);
for data see [DATABASE.md](DATABASE.md); for endpoints see [API_MAP.md](API_MAP.md).

## Request flow
```
Browser UI (app/(app)/*, app/(auth)/*)
        │  fetch (same-origin, cookie auth)
        ▼
Next middleware.ts  ── stamps x-request-id
        ▼
Route handler  app/api/v1/**/route.ts
   requireContext()         → { orgId, userId, withOrg }   (cookie OR Bearer sk_…)
   ctx.withOrg(db => …)     → RLS-scoped transaction (SET app.current_org, role app_user)
        ▼
Service layer  lib/<domain>/service.ts   (publishing, viral, attribution, journey, …)
        ▼
Drizzle ORM  db/client.ts → PGlite (dev/test) | node-postgres (prod)   [selected by DATABASE_URL]
        ▼
Postgres (RLS enforced)
```
Thrown `ApiError` → `toProblemResponse()` → RFC-9457 `application/problem+json`.

## Core seams (the extension points)
- **AI gateway** — `lib/ai/gateway.ts run()` is the *single* path to any model. Router (`lib/ai/router.ts`) maps task→model/effort; `lib/ai/pricing.ts` + the `ai_jobs` table form a cost ledger; `lib/ai/budget.ts` enforces per-org caps. Providers behind `lib/ai/provider.ts`: `MockAIProvider` (deterministic, offline) and `AnthropicProvider` (`claude-opus-4-8`). Structured output via `jsonSchema`.
- **Channel provider** — `lib/channel/*` defines a `ChannelProvider` interface; `MockChannelProvider` today, real wrapped/native adapters later. Publishing never talks to a platform directly.
- **Durable jobs** — `lib/jobs/*` over the `jobs` table: enqueue → claim (`FOR UPDATE SKIP LOCKED`, claimed on `statement_timestamp()`) → run → retry w/ exponential backoff → DLQ. Worker process (`bin/worker.ts`) on managed Postgres; **inline drain** in-request on PGlite.
- **Programmatic surface** — `lib/sdk/client.ts` (hand-written typed client) + `mcp/*` (stdio MCP server) both ride the same `/api/v1` HTTP contract published at `/api/v1/openapi.json` (`lib/openapi/spec.ts`), guarded against drift by `test/openapi.test.ts`.

## Cross-cutting concerns
| Concern | Where | Note |
|---|---|---|
| AuthN | `lib/auth.ts`, `lib/request.ts` | scrypt passwords; signed expiring session cookie (`Secure` in prod); API keys SHA-256. |
| Multi-tenancy | `db/client.ts` (`withOrg`/`scopeToOrg`/`withServiceRole`) | Postgres RLS, `app_user` role, `org_isolation_*` policies. |
| Errors | `lib/errors.ts` | `ApiError` → problem+json. |
| Logging | `lib/log.ts`, `middleware.ts` | JSON lines, secret redaction, `x-request-id`. |
| Audit | `lib/audit.ts` | `recordAudit()` → `audit_log`, never throws. |
| Rate limiting | `lib/ratelimit.ts` | in-memory fixed-window; auth routes → 429 + Retry-After. |

## Driver / environment model
One schema, two drivers. `db/client.ts` picks PGlite when `DATABASE_URL` is unset (local dev/test;
WASM in-process Postgres, **single connection per `.pgdata`**) and node-postgres otherwise. Same
migrations, same RLS, same code. This — plus "no Docker / no C++ toolchain / no Redis" on the dev
box — explains the inline job drain, the single-fork Vitest harness, and MCP-over-stdio.

## Build/runtime entry points
`instrumentation.ts` (Next startup hook), `middleware.ts` (request-id), `bin/worker.ts` (job
worker), `bin/apikey.ts` (mint key), `mcp/main.ts` (MCP server). Scripts in `package.json`.

## Deliberately deferred (named seams exist)
Real platform OAuth + native channel adapters, Stripe billing, inbox/messaging, ads, agents,
pgvector/RAG over past winners, closed-loop AI scoring, time-decay/data-driven attribution,
browser attribution pixel, white-label theming. Roadmap: [docs/IMPLEMENTATION-ROADMAP.md](docs/IMPLEMENTATION-ROADMAP.md).
