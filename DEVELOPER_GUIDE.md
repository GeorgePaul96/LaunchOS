# DEVELOPER_GUIDE.md — LaunchOS

AI-first workflows. The principle: **read the hub + the entry file(s) for your task, change those,
verify, stop.** Don't scan the tree. Entry points per task are in [CLAUDE.md](CLAUDE.md); deeper
maps in [ARCHITECTURE.md](ARCHITECTURE.md) / [PROJECT_MAP.md](PROJECT_MAP.md) /
[DATABASE.md](DATABASE.md) / [API_MAP.md](API_MAP.md).

## Setup & commands
```bash
npm install
npm run setup        # migrate (creates .pgdata) + seed demo org
npm run dev          # http://localhost:3000   (login: demo@launchos.com / demo1234)
npm test             # Vitest (shared PGlite)
npm run build        # production build (no DB needed)
```
Programmatic: `npm run apikey` → `curl -H "Authorization: Bearer sk_…" localhost:3000/api/v1/accounts`.
MCP server: `npm run mcp` (see README for the client config). **Don't** run `dev` and `worker` at
once on PGlite (single connection).

## Workflows

### Bug fixing
1. Reproduce with a **failing test** (find the matching `test/*.test.ts`; `helpers.ts` for fixtures).
2. Trace: route (`app/api/v1/.../route.ts`) → service (`lib/<domain>/service.ts`). Most logic is in services.
3. Fix the service, keep the test green, run the focused file (`npm test -- test/<file>`), then `npm test`.
Files to open: the one test + the one service. Usually 2–3 files total.

### Feature development
1. Brainstorm → spec → plan in `docs/superpowers/` (existing pattern), then TDD.
2. **New API endpoint:** add `app/api/v1/<x>/route.ts` (copy the pattern in [API_MAP.md](API_MAP.md)) → add the path to `lib/openapi/spec.ts` → add SDK method (`lib/sdk/client.ts`) + MCP tool (`mcp/tools.ts`) if exposing it → test.
3. **New AI feature:** call `lib/ai/gateway.ts run()` only; put logic in a `lib/<feature>/` module with a pure prompt builder + a service. Worked example: `lib/viral/*`.
4. **New table:** follow the 5-step migration workflow in [DATABASE.md](DATABASE.md) (schema → generate → custom RLS migration → `ALL_TABLES` → migrate).

### Attribution pixel
Embed the pixel in any page you want to track:
```html
<script async src="/pixel.js" data-write-key="pk_…"></script>
```
Get the write key from **`/settings/connections`** (shown alongside your connected accounts).

Once loaded the pixel auto-fires a `page` event (captures UTM params + referrer) and exposes:
- `launchos.track(event, valueCents?)` — record a named conversion (e.g. `"signup"`, `"purchase"`).
- `launchos.identify(email)` — stitch the anonymous visitor to a known contact.

Events POST to `POST /api/v1/collect` (the one unauthenticated `/v1` endpoint; see `API_MAP.md`).

### Refactoring
- Keep public interfaces stable; refactor behind the service boundary. Tests are the safety net — they must stay green with no edits to assertions (changing assertions = behavior change, get approval).
- Don't restructure directories: the layout is intentional and small.

### Security audits
Checklist (and where): every org-scoped query filters by `org_id` and runs in `withOrg`
(`db/client.ts`); RLS policy + `app_user` grant exist for each org table (`db/migrations/*_rls.sql`,
verified by `test/rls.test.ts`); secrets never logged (`lib/log.ts` redaction); `SESSION_SECRET`
required in prod (`lib/auth.ts`); API keys stored SHA-256 (`lib/auth.ts`); auth routes rate-limited
(`lib/ratelimit.ts`). The built-in `/security-review` skill reviews the current diff.

### Architecture reviews
Start from [ARCHITECTURE.md](ARCHITECTURE.md) (seams) and [docs/IMPLEMENTATION-ROADMAP.md](docs/IMPLEMENTATION-ROADMAP.md)
(phase status). Judge changes against the seams: does new code call the AI gateway / channel
provider / job queue rather than bypass them? Is multi-tenancy preserved?

## Keeping Claude cheap (token hygiene)
- Trust the doc layer; open large references (`LaunchOS-Spec.md`, `launchos_schema.sql`, `docs/superpowers/**`) only when a task needs that detail.
- Never open `.claudeignore`d paths (`node_modules`, `.next`, `.pgdata`, `db/migrations/meta/**`, `package-lock.json`).
- Prefer `Grep`/`Glob` with a `glob`/`type` filter over reading whole directories.
- When you add a route, table, or env var, update the matching map file so the next session stays scan-free.

## Conventions
TypeScript throughout; services take `(db, orgId, input)`; throw `ApiError`, never bare strings;
TDD with Vitest; commit/push only when asked, branching off `main`; co-author trailer
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
