# Observability & Security Baseline — Design

**Date:** 2026-06-16
**Status:** Approved (pending written-spec review)
**Phase:** P1.6 (production foundation — final sub-project; closes P1)
**Source:** `docs/IMPLEMENTATION-ROADMAP.md` §4.6, `LaunchOS-Spec.md` §9, the security audit (this session)

---

## 0. Context & decisions

Closes the production-foundation phase: the security-hardening items from the audit plus the
baseline observability (structured logging, request IDs, audit trail) and a rate limiter.

Decisions locked during brainstorming:
- **Scope:** security hardening + structured logging + `audit_log` + an in-memory rate limiter.
- **Deferred:** OpenTelemetry metrics/traces + collector; the per-platform outbound token-bucket
  governor (no real provider to govern yet); Postgres/Redis-backed distributed rate limiting;
  envelope-encrypted `oauth_credentials` (no OAuth until the P2 channel provider).
- **Rate-limiter backend:** in-memory fixed-window (no Redis; the Next HTTP process is single,
  so per-process windows are adequate) behind a small function interface for a later swap.

---

## 1. Security hardening

### 1.1 Session-secret guard (`lib/auth.ts`)
`sessionSecret()` throws when `process.env.NODE_ENV === "production"` and `SESSION_SECRET` is
unset; outside production it falls back to the dev default. Removes the public-default-secret
session-forgery risk.

### 1.2 Cookie + session hardening (`lib/auth.ts` + auth routes)
- A `sessionCookie(token)` / `clearedCookie()` helper centralizes the `Set-Cookie` string:
  always `HttpOnly; Path=/; SameSite=Lax`; add `Secure` when in production; `Max-Age=604800`
  (7d) on set, `Max-Age=0` on clear. `login`/`signup`/`logout` use the helper.
- `SessionPayload` gains `exp` (epoch seconds). `signSession(payload, secret, ttlSeconds = 604800)`
  stamps `exp = now + ttl`. `verifySession` returns `null` when `exp` is present and `< now`.
  (Adding `exp` is a superset — existing `toMatchObject({userId, orgId})` tests still pass.)

### 1.3 RLS gap fixes (migration)
- Enable + force RLS on `organizations` with policy
  `USING (id = current_setting('app.current_org', true))` (and matching `WITH CHECK`). The only
  app_user read of `organizations` is its own row by id (budget lookup), which the policy allows.
- `REVOKE ALL ON users FROM app_user`. Auth (signup/login) runs on the service-role connection,
  so no app-scoped query needs `users`; this guarantees `password_hash` is unreachable under an
  org scope. (organizations and users have no `org_isolation` policy added beyond the above.)

---

## 2. Structured logging + request IDs

### 2.1 `lib/log.ts`
- `redact(value)` (pure): deep-clones and replaces values of sensitive keys (case-insensitive
  match on `authorization`, `password`, `passwordhash`, `token`, `secret`, `key`, `apikey`,
  `set-cookie`, `cookie`) with `"[redacted]"`; everything else passes through. Guards against
  cycles and non-objects.
- `log.info(msg, fields?)` / `log.warn(...)` / `log.error(...)`: emit one JSON line
  `{ ts, level, msg, ...redact(fields) }` to stdout (stderr for `error`). Never throws.

### 2.2 Request IDs (`middleware.ts`)
A Next middleware sets `x-request-id` (`crypto.randomUUID()` if absent) on the request and
echoes it on the response. Log call sites include the id when available. Existing ad-hoc
`console.warn`/`console.log` (AI gateway, scheduler/worker) are switched to `log.*`.

---

## 3. `audit_log` (new table)

Add `audit_log` to `db/schema.ts` (native types, matching canonical):
- `id` bigserial PK, `org_id` text, `actor_type` text (`user | api_key | system`),
  `actor_id` text, `action` text, `target_type` text, `target_id` text, `metadata` jsonb
  default `{}`, `created_at` timestamptz default now().
- Index on `(org_id, created_at)`. RLS enabled + forced + `org_isolation` on `org_id`;
  `app_user` granted SELECT/INSERT + sequence usage (append-only in practice).
- `recordAudit(db, { orgId, actorType, actorId?, action, targetType?, targetId?, metadata? })`
  helper inserts one row.
- Wired into mutating actions at the route layer: `post.create`, `api_key.create`,
  `auth.login`, `auth.signup`. (Routes call it; the helper itself is unit-tested.)

---

## 4. Rate limiting (`lib/ratelimit.ts`)

- In-memory fixed-window: a module `Map<string, { count, resetAt }>`.
  `rateLimit(key, limit, windowMs): { allowed, remaining, resetAt }` increments the window
  bucket and reports.
- `assertRateLimit(key, limit, windowMs)` throws `ApiError(429, "rate_limited", …)` carrying a
  `retryAfterSeconds` (the helper sets a `Retry-After` header when converted to a response).
- Applied to `auth/login` and `auth/signup`, keyed by client IP (`x-forwarded-for` first hop, or
  `"local"`), e.g. 10 attempts / 60s. Closes the brute-force + enumeration finding.

---

## 5. Error handling

- 429 → problem+json with a `Retry-After` header; signup stays generic (no user enumeration).
- `verifySession` returns `null` (not throw) on expired/invalid → existing 401 path.
- `redact`/`log` are fail-safe (never throw; unknown shapes pass through with sensitive keys
  stripped).
- `recordAudit` failures are swallowed + logged (auditing must never break the request).

---

## 6. Testing (TDD)

- `log` — `redact` strips sensitive keys at top level and nested, leaves others, handles
  non-objects and cycles.
- `ratelimit` — allows `limit` hits then blocks the next; a new window re-allows; distinct keys
  are independent; `assertRateLimit` throws 429 past the limit.
- `auth` — `signSession` stamps `exp`; `verifySession` rejects an expired token and accepts a
  fresh one; `sessionSecret()` throws in production without the env var and falls back otherwise.
- `audit` — `recordAudit` writes one row with the given fields scoped to the org.
- All 87 existing tests stay green.

---

## 7. Out of scope (deferred, named seams)

OpenTelemetry metrics/traces + collector; per-platform outbound token-bucket governor;
distributed (Postgres/Redis) rate limiting; envelope-encrypted `oauth_credentials` (P2 channel
provider); API-key **scope enforcement** (scopes stored, still not checked).

---

## 8. Acceptance criteria

- In production, a missing `SESSION_SECRET` aborts startup/usage rather than silently using the
  public default; session cookies are `Secure` in prod and carry `Max-Age`; an expired session
  token is rejected.
- `app_user` cannot read `users` (revoked), and `organizations` is RLS-isolated to the current
  org; existing RLS tests + all features still pass.
- Logs are single-line JSON with request IDs and no secrets (verified by the redactor test and a
  manual dev-log scan).
- Mutating actions (post create, key mint, login/signup) write an `audit_log` row.
- Repeated `auth/login` attempts past the limit return 429 with `Retry-After`.
- All tests pass (87 existing + new log/ratelimit/auth/audit); build green. **P1 complete.**
