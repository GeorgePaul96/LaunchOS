# OpenAPI → SDK + MCP — Design

**Date:** 2026-06-16
**Status:** Approved (pending written-spec review)
**Phase:** P1.4 (production foundation — fourth sub-project)
**Source:** `docs/IMPLEMENTATION-ROADMAP.md` §4.5, `LaunchOS-Spec.md` §3 (API conventions, API keys)

---

## 0. Context & decisions

Programmatic + agent access to LaunchOS. The `/v1` API is cookie-only today; this sub-project
adds API-key auth, an OpenAPI 3.1 contract, a hand-written typed SDK, and a stdio MCP server so
the owner can drive LaunchOS from scripts and from Claude/Cursor. No new product features — it
exposes the existing `/v1` surface.

Decisions locked during brainstorming:
- **SDK:** hand-written thin typed client in `lib/sdk/` (one method per endpoint), no codegen
  step. The OpenAPI spec is the human-facing contract.
- **MCP reach:** the MCP server is a stdio process that calls the running Next API over HTTP
  with an API key (via the SDK). Only the Next process touches `.pgdata`, so this sidesteps the
  PGlite single-connection limit and matches the spec's "MCP wraps the public API" intent.
- **No cloud generators** (Stainless/Speakeasy) — everything runs locally.
- **API-key auth is a prerequisite** and is built here.
- **MCP exposes a curated tool set** (the actionable endpoints), not every route.

**Tech:** `@modelcontextprotocol/sdk` 1.29; Node `crypto` for key hashing; Vitest.

---

## 1. API-key auth (prerequisite)

### 1.1 Minting — `POST /api/v1/api-keys`
Session-authenticated. Body: `{ name, scopes? }`. Generates `sk_` + 32 random bytes (hex);
stores **SHA-256(secret)** in `api_keys.key_hash`, the first 8 chars in `key_prefix`, and
`scopes` (default `[]`). Returns the full secret **once**: `{ id, key, key_prefix }`. The
`api_keys` table already exists (P1.1 schema).

### 1.2 Authenticating — `lib/auth.ts` + `lib/request.ts`
- `hashApiKey(secret)` → `sha256` hex (in `lib/auth.ts`, alongside password hashing).
- `requireContext()` resolves an org context from **either**:
  1. `Authorization: Bearer sk_…` → `hashApiKey` → look up `api_keys` where `key_hash` matches
     and `revoked_at IS NULL` and (`expires_at IS NULL` or `> now()`) → `{ orgId, userId: created_by }`;
     best-effort update `last_used_at`.
  2. the session cookie (existing path).
- API-key lookups use the **service-role** db (the key itself proves the org; we then run the
  request's DB work via `withOrg(orgId)` exactly as the cookie path does).
- Failures → `ApiError(401, "unauthorized", …)` (never disclose whether a key exists).

### 1.3 Bootstrap CLI — `bin/apikey.ts` (`npm run apikey`)
Service-role script: mints a key for the demo org (or the first org) and prints it once.
Solves the chicken-and-egg of needing a key to call the API before any session exists.

---

## 2. OpenAPI 3.1 spec

- Hand-authored in `lib/openapi/spec.ts` as a typed object (the contract), served at
  `GET /api/v1/openapi.json`.
- Documents: `bearerAuth` security scheme; paths for accounts, posts (+ `/posts/{id}/retry`),
  attribution (`/identify`, `/touchpoints`, `/conversions`, `/report`), `/journeys/contacts/{cid}/timeline`,
  `/api-keys`; request/response schemas; the RFC-9457 problem+json error shape.
- **Drift guard (test):** the spec parses as OpenAPI 3.1, and the set of documented paths equals
  the set of `app/api/v1/**/route.ts` handlers (excluding `/auth/*` and `/openapi.json` itself),
  so new endpoints can't silently go undocumented.

---

## 3. Hand-written SDK (`lib/sdk/`)

- `lib/sdk/client.ts`: `LaunchOSClient({ baseUrl, apiKey, fetch? })` (injectable `fetch` for
  tests). A private request helper sets `Authorization: Bearer <apiKey>` + `content-type`, parses
  JSON, and throws `LaunchOSApiError(status, code, detail)` (from `lib/sdk/errors.ts`) on non-2xx.
- Methods (one per endpoint), typed args/returns:
  `accounts.list()`, `posts.create(input)`, `posts.list()`, `posts.retry(publicId)`,
  `attribution.identify(input)`, `attribution.touchpoint(input)`, `attribution.conversion(input)`,
  `attribution.report(model)`, `journeys.timeline(contactId)`, `apiKeys.create(input)`.
- Types live in `lib/sdk/types.ts`. No build step; importable directly.

---

## 4. MCP server (`mcp/server.ts`, stdio)

- Built on `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`).
- Configured by env: `LAUNCHOS_BASE_URL` (default `http://localhost:3000`) and
  `LAUNCHOS_API_KEY`. Instantiates `LaunchOSClient` and registers tools that call it.
- **Curated tools** (Zod input schemas):
  `list_accounts`, `list_posts`, `create_post`, `attribution_report`, `contact_journey`,
  `record_touchpoint`, `record_conversion`. (Auth/key-minting excluded — bootstrap concerns.)
- Each tool returns the SDK result as JSON text content; on `LaunchOSApiError` returns
  `{ isError: true, content: [{ type: "text", text: <detail> }] }`.
- Run via `npm run mcp`. README documents the Claude Desktop / Cursor config block.

---

## 5. Error handling

- API-key auth failure → 401 problem+json; no existence disclosure.
- SDK maps non-2xx problem+json → typed `LaunchOSApiError`; network failure → a wrapped error.
- MCP tool errors surface the problem+json `detail` only (no secrets, no stack traces).
- The minted API key secret is returned exactly once and never stored in plaintext or logged.

---

## 6. Testing (TDD)

- **api-key auth** (`lib/auth` + request path): `hashApiKey` is stable sha256; a valid key
  resolves to its org; revoked/expired/garbage keys are rejected; a key for org A cannot read
  org B's data (RLS still applies via `withOrg`).
- **openapi**: `spec.ts` is valid OpenAPI 3.1 (required fields, version, paths); path-coverage
  drift guard matches the route handlers.
- **sdk**: each method builds the correct method/URL/headers/body and parses the response, using
  an injected stub `fetch`; non-2xx → `LaunchOSApiError` with the right code; the Bearer header
  is set.
- **mcp**: the server registers exactly the curated tool set; one tool call routes through a
  stubbed `LaunchOSClient` and returns its result; an SDK error → `isError: true`.
- All 73 existing tests stay green.

---

## 7. Out of scope

- Python and other-language SDKs (the OpenAPI spec enables them later).
- Hosted/remote MCP with OAuth; publishing the SDK to npm.
- API-key **scopes enforcement** (scopes are stored but not yet checked) and per-key
  **rate limiting** — both land with the observability/security sub-project.
- The deferred RAG/guardrails from the AI gateway.

---

## 8. Acceptance criteria

- `npm run apikey` prints a usable `sk_…` key; that key authenticates `/v1` requests via
  `Authorization: Bearer` and is scoped to its org (cross-org access denied).
- API keys are stored as SHA-256 only; the plaintext secret appears once at creation and is
  never logged or persisted.
- `GET /api/v1/openapi.json` returns a valid OpenAPI 3.1 document covering the `/v1` surface; the
  drift-guard test passes.
- The hand-written SDK can, against the running server, list accounts, create + list posts,
  ingest a touchpoint/conversion, and fetch an attribution report.
- The MCP server starts over stdio, lists the 7 curated tools, and a tool call succeeds against
  the running API with a configured key (documented Claude/Cursor config).
- All tests pass (73 existing + new auth/openapi/sdk/mcp); build green.
