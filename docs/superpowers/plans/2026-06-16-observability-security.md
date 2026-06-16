# Observability & Security Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close P1 with the security hardening from the audit plus a baseline of structured logging, request IDs, an `audit_log` trail, and an in-memory rate limiter.

**Architecture:** Harden `lib/auth.ts` (prod secret guard, `Secure`/`Max-Age` cookies, session `exp`); RLS-isolate `organizations` and revoke `app_user` on `users` via migration; add `lib/log.ts` (JSON logger + secret redaction) and a request-id `middleware.ts`; add an `audit_log` table + `recordAudit` helper wired into mutating routes; add an in-memory `lib/ratelimit.ts` applied to auth routes. Builds on P1.1–P1.4.

**Tech Stack:** Next 16 middleware, drizzle-orm/pg-core, Node `crypto`, Vitest. No new deps.

**Reference:** `docs/superpowers/specs/2026-06-16-observability-security-design.md`.

**Conventions:** run from repo root. Commit after each task. Tests use the base test DB (service role) + pure helpers. New tables use native `jsonb`/`timestamptz`.

---

## File Structure

```
lib/auth.ts             + sessionSecret prod guard; sessionCookie/clearedCookie; exp in sign/verify
lib/errors.ts           ApiError gains optional headers; toProblemResponse applies them
lib/log.ts              redact() + log.{info,warn,error}
lib/ratelimit.ts        rateLimit() + assertRateLimit() + __resetRateLimits()
lib/audit.ts            recordAudit()
middleware.ts           x-request-id stamping
db/schema.ts            + audit_log table
db/migrations/           + 0007 org-RLS/users-revoke (custom) + 0008 audit_log (generated) + 0009 audit_log RLS (custom)
app/api/v1/auth/login/route.ts, signup/route.ts, logout/route.ts   use cookie helper + rate limit + audit
app/api/v1/posts/route.ts, api-keys/route.ts                       recordAudit on create
lib/ai/gateway.ts, lib/jobs/worker.ts, instrumentation.ts          console.* -> log.*
test/log.test.ts, ratelimit.test.ts, audit.test.ts, auth.test.ts(+) NEW/extended
test/helpers.ts          + "audit_log" in ALL_TABLES
```

---

## Task 1: Session hardening (secret guard + cookies + expiry)

**Files:** Modify `lib/auth.ts`, `test/auth.test.ts`, `app/api/v1/auth/{login,signup,logout}/route.ts`

- [ ] **Step 1: Extend `test/auth.test.ts`**

Add `sessionSecret` to the import and append these tests inside the `describe("auth", …)` block:
```ts
  it("signSession stamps an exp and verifySession rejects expired tokens", () => {
    const fresh = signSession({ userId: "u1", orgId: "o1" }, "secret", 3600);
    expect(verifySession(fresh, "secret")).toMatchObject({ userId: "u1", orgId: "o1" });
    const expired = signSession({ userId: "u1", orgId: "o1" }, "secret", -1);
    expect(verifySession(expired, "secret")).toBeNull();
  });

  it("sessionSecret throws in production without SESSION_SECRET, falls back otherwise", async () => {
    const { sessionSecret } = await import("@/lib/auth");
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.SESSION_SECRET;
    try {
      delete process.env.SESSION_SECRET;
      (process.env as Record<string, string>).NODE_ENV = "production";
      expect(() => sessionSecret()).toThrow();
      (process.env as Record<string, string>).NODE_ENV = "development";
      expect(sessionSecret()).toBe("dev-only-secret-change-me");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = origEnv ?? "test";
      if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret;
    }
  });
```
Add to the top import:
```ts
import { hashPassword, verifyPassword, signSession, verifySession, sessionSecret } from "@/lib/auth";
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- auth`
Expected: FAIL — the expiry and prod-guard behaviors don't exist yet.

- [ ] **Step 3: Update `lib/auth.ts`**

Replace `SessionPayload`, `signSession`, `verifySession`, and `sessionSecret`, and add the cookie helpers:
```ts
export interface SessionPayload { userId: string; orgId: string; exp?: number }

export function signSession(payload: SessionPayload, secret: string, ttlSeconds = 604800): string {
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "launchos_session";

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  return "dev-only-secret-change-me";
}

const SESSION_TTL_SECONDS = 604800; // 7 days

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax;${secure} Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax;${secure} Max-Age=0`;
}
```
(Delete the old `SESSION_COOKIE`/`sessionSecret` lines being replaced.)

- [ ] **Step 4: Use the cookie helpers in the auth routes**

In `app/api/v1/auth/login/route.ts` and `signup/route.ts`, replace the inline `res.headers.append("set-cookie", …)` with:
```ts
res.headers.append("set-cookie", sessionCookie(token));
```
and add `sessionCookie` to the `@/lib/auth` import. In `logout/route.ts`, replace the inline cookie with:
```ts
import { clearedCookie } from "@/lib/auth";
// ...
res.headers.append("set-cookie", clearedCookie());
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- auth && npx tsc --noEmit`
Expected: auth tests pass (5); tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts test/auth.test.ts app/api/v1/auth
git commit -m "feat(security): prod session-secret guard + Secure/Max-Age cookies + session expiry"
```

---

## Task 2: RLS gap fixes (organizations + users)

**Files:** Create `db/migrations/0007_org_rls_users_revoke.sql`

- [ ] **Step 1: Create the custom migration**

Run: `npx drizzle-kit generate --custom --name org_rls_users_revoke`
Expected: creates an empty `db/migrations/0007_org_rls_users_revoke.sql`.

- [ ] **Step 2: Fill `db/migrations/0007_org_rls_users_revoke.sql`**

```sql
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_organizations ON organizations
  USING (id = current_setting('app.current_org', true))
  WITH CHECK (id = current_setting('app.current_org', true));
--> statement-breakpoint
REVOKE ALL ON users FROM app_user;
```
Rationale: auth (signup/login) and seeding use the service-role connection (bypasses RLS), so revoking `app_user` on `users` and isolating `organizations` doesn't break them; the only `app_user` read of `organizations` is its own row (budget lookup), which the policy allows.

- [ ] **Step 3: Verify it applies + RLS still proven + suite green**

Run (Git Bash):
```
node --input-type=module -e "import {PGlite} from '@electric-sql/pglite';import {drizzle} from 'drizzle-orm/pglite';import {migrate} from 'drizzle-orm/pglite/migrator';const db=drizzle(new PGlite(),{});await migrate(db,{migrationsFolder:'db/migrations'});const p=await db.execute(\"select count(*)::int n from pg_policies where policyname like 'org_isolation_%'\");console.log('policies',p.rows[0].n);"
rm -rf .pgdata && npm run setup && npx vitest run 2>&1 | tail -4
```
Expected: `policies 19` (18 + organizations); setup completes; 87 tests pass (incl. the existing RLS isolation test, which is unaffected because it seeds via the service role).

- [ ] **Step 4: Commit**

```bash
git add db/migrations
git commit -m "feat(security): RLS-isolate organizations + revoke app_user on users"
```

---

## Task 3: Structured logging + redaction

**Files:** Create `lib/log.ts`, `test/log.test.ts`

- [ ] **Step 1: Write the failing test**

`test/log.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { redact } from "@/lib/log";

describe("redact", () => {
  it("masks sensitive keys at the top level", () => {
    const out = redact({ user: "jo", password: "hunter2", apiKey: "sk_x" }) as Record<string, unknown>;
    expect(out.user).toBe("jo");
    expect(out.password).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
  });
  it("masks sensitive keys nested in objects and arrays", () => {
    const out = redact({ a: { authorization: "Bearer sk_x", ok: 1 }, list: [{ token: "t" }] }) as any;
    expect(out.a.authorization).toBe("[redacted]");
    expect(out.a.ok).toBe(1);
    expect(out.list[0].token).toBe("[redacted]");
  });
  it("is case-insensitive on key names", () => {
    const out = redact({ Authorization: "x", Set_Cookie: "y", "set-cookie": "z" }) as Record<string, unknown>;
    expect(out.Authorization).toBe("[redacted]");
    expect(out["set-cookie"]).toBe("[redacted]");
  });
  it("passes through non-objects and tolerates cycles", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => redact(cyc)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- log`
Expected: FAIL — cannot resolve `@/lib/log`.

- [ ] **Step 3: Implement `lib/log.ts`**

```ts
const SENSITIVE = /^(authorization|password|passwordhash|password_hash|token|secret|key|apikey|api_key|set[-_]?cookie|cookie)$/i;

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, seen);
  }
  return out;
}

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as Fields) : {}) });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- log`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/log.ts test/log.test.ts
git commit -m "feat(observability): structured JSON logger + secret redaction"
```

---

## Task 4: Request-id middleware + switch console.* to log

**Files:** Create `middleware.ts`; Modify `lib/ai/gateway.ts`, `lib/jobs/worker.ts`, `instrumentation.ts`

- [ ] **Step 1: Create `middleware.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  let id = requestHeaders.get("x-request-id");
  if (!id) {
    id = crypto.randomUUID();
    requestHeaders.set("x-request-id", id);
  }
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-request-id", id);
  return res;
}

export const config = { matcher: "/api/:path*" };
```

- [ ] **Step 2: Switch ad-hoc console logging to the structured logger**

In `lib/ai/gateway.ts`, replace:
```ts
    console.warn("[ai] ANTHROPIC_API_KEY not set — using MockAIProvider");
```
with:
```ts
    log.warn("ai_provider_fallback", { reason: "ANTHROPIC_API_KEY not set; using MockAIProvider" });
```
and add `import { log } from "@/lib/log";` to the top.

In `lib/jobs/worker.ts`, replace `console.error("[worker]", err)` with `log.error("worker_job_failed", { error: String(err) })` and `console.log("[worker] started")` with `log.info("worker_started")`; add `import { log } from "@/lib/log";`.

In `instrumentation.ts`, replace the two `console.log(...)` calls with `log.info("scheduler_started")` and `log.info("worker_inline_mode")` respectively; add the import via dynamic import inside `register()`:
```ts
    const { log } = await import("@/lib/log");
```
(use `log.info(...)` after that import; keep the existing structure).

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -4`
Expected: tsc exit 0; 91 tests pass (87 + 4 log).

- [ ] **Step 4: Commit**

```bash
git add middleware.ts lib/ai/gateway.ts lib/jobs/worker.ts instrumentation.ts
git commit -m "feat(observability): request-id middleware + structured logs at call sites"
```

---

## Task 5: audit_log table + recordAudit + wiring

**Files:** Modify `db/schema.ts`, `test/helpers.ts`; Create `db/migrations/0008_*.sql` (generated), `db/migrations/0009_audit_log_rls.sql`, `lib/audit.ts`, `test/audit.test.ts`; Modify `app/api/v1/posts/route.ts`, `app/api/v1/api-keys/route.ts`, `app/api/v1/auth/{login,signup}/route.ts`

- [ ] **Step 1: Add `auditLog` to `db/schema.ts`**

Append:
```ts
// Append-only audit trail of mutating actions.
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: text("org_id"),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add `"audit_log"` to `ALL_TABLES` in `test/helpers.ts`**

```ts
const ALL_TABLES = [
  "audit_log", "ai_jobs", "jobs", "attribution_results", "conversions", "touchpoints", "identities", "contact_channels",
  "contacts", "account_metrics_daily", "post_targets", "posts", "campaigns",
  "social_accounts", "profiles", "api_keys", "memberships", "journeys",
  "idempotency_keys", "platforms", "users", "organizations",
].join(", ");
```

- [ ] **Step 3: Generate the table migration + custom RLS migration**

Run: `npm run db:generate`
Expected: `db/migrations/0008_*.sql` with `CREATE TABLE "audit_log"`.
Run: `npx drizzle-kit generate --custom --name audit_log_rls`
Expected: empty `db/migrations/0009_audit_log_rls.sql`.

- [ ] **Step 4: Fill `db/migrations/0009_audit_log_rls.sql`**

```sql
GRANT SELECT, INSERT ON audit_log TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_user;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_audit_log ON audit_log
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at);
```

- [ ] **Step 5: Write the failing test**

`test/audit.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { recordAudit } from "@/lib/audit";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("recordAudit", () => {
  it("writes one audit row scoped to the org", async () => {
    const { orgId } = await seedOrg(db);
    await recordAudit(db as any, {
      orgId, actorType: "user", actorId: "u1", action: "post.create",
      targetType: "post", targetId: "post_1", metadata: { n: 2 },
    });
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("post.create");
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].targetId).toBe("post_1");
    expect(rows[0].metadata).toEqual({ n: 2 });
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- audit`
Expected: FAIL — cannot resolve `@/lib/audit`.

- [ ] **Step 7: Implement `lib/audit.ts`**

```ts
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { log } from "@/lib/log";

export interface AuditInput {
  orgId: string;
  actorType: "user" | "api_key" | "system";
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

// Append-only audit write. Never throws — auditing must not break the request.
export async function recordAudit(db: DB, input: AuditInput): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (e) {
    log.error("audit_write_failed", { action: input.action, error: String(e) });
  }
}
```

- [ ] **Step 8: Wire `recordAudit` into mutating routes**

In `app/api/v1/posts/route.ts` POST, inside the `ctx.withOrg(async (db) => { … })` block, after creating the post (before returning `out`), add:
```ts
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "post.create", targetType: "post", targetId: post.publicId });
```
and add `import { recordAudit } from "@/lib/audit";`.

In `app/api/v1/api-keys/route.ts`, inside the `ctx.withOrg(...)` insert block (or right after), add:
```ts
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "api_key.create", targetType: "api_key", targetId: id });
```
(move the `recordAudit` call inside the `withOrg` callback so it shares the org scope) and import it.

In `app/api/v1/auth/login/route.ts`, after a successful credential check (before returning), add:
```ts
await recordAudit(db, { orgId: membership.orgId, actorType: "user", actorId: user.id, action: "auth.login" });
```
and import `recordAudit` + ensure `db` (base) is imported (it already is). In `app/api/v1/auth/signup/route.ts`, after creating the org/user, add:
```ts
await recordAudit(db, { orgId, actorType: "user", actorId: userId, action: "auth.signup" });
```

- [ ] **Step 9: Run to verify + type-check + full suite**

Run: `npm test -- audit && npx tsc --noEmit && npm test 2>&1 | tail -4`
Expected: audit test passes (1); tsc exit 0; 92 tests pass (91 + 1 audit).

- [ ] **Step 10: Commit**

```bash
git add db/schema.ts db/migrations test/helpers.ts lib/audit.ts test/audit.test.ts app/api/v1/posts app/api/v1/api-keys app/api/v1/auth
git commit -m "feat(observability): audit_log table + recordAudit wired into mutating routes"
```

---

## Task 6: Rate limiting on auth routes

**Files:** Modify `lib/errors.ts`; Create `lib/ratelimit.ts`, `test/ratelimit.test.ts`; Modify `app/api/v1/auth/{login,signup}/route.ts`

- [ ] **Step 1: Add optional headers to `ApiError` + `toProblemResponse`**

In `lib/errors.ts`, change the `ApiError` constructor and `toProblemResponse`:
```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
    public headers?: Record<string, string>,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}
```
and in `toProblemResponse`, build the headers:
```ts
export function toProblemResponse(err: unknown): Response {
  const e =
    err instanceof ApiError
      ? err
      : new ApiError(500, "internal_error", "An unexpected error occurred");
  const body = problem({ status: e.status, code: e.code, detail: e.detail });
  return new Response(JSON.stringify(body), {
    status: e.status,
    headers: { "content-type": "application/problem+json", ...(e.headers ?? {}) },
  });
}
```

- [ ] **Step 2: Write the failing test**

`test/ratelimit.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, assertRateLimit, __resetRateLimits } from "@/lib/ratelimit";
import { ApiError } from "@/lib/errors";

beforeEach(() => __resetRateLimits());

describe("rate limit", () => {
  it("allows up to the limit then blocks", () => {
    const t = 1000;
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(true);
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(true);
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(true);
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(false);
  });
  it("resets after the window", () => {
    expect(rateLimit("k", 1, 1000, 1000).allowed).toBe(true);
    expect(rateLimit("k", 1, 1000, 1000).allowed).toBe(false);
    expect(rateLimit("k", 1, 1000, 2000).allowed).toBe(true); // new window
  });
  it("keys are independent", () => {
    expect(rateLimit("a", 1, 1000, 1000).allowed).toBe(true);
    expect(rateLimit("b", 1, 1000, 1000).allowed).toBe(true);
  });
  it("assertRateLimit throws a 429 ApiError past the limit", () => {
    assertRateLimit("z", 1, 60000);
    let err: unknown;
    try { assertRateLimit("z", 1, 60000); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).headers?.["Retry-After"]).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- ratelimit`
Expected: FAIL — cannot resolve `@/lib/ratelimit`.

- [ ] **Step 4: Implement `lib/ratelimit.ts`**

```ts
import { ApiError } from "@/lib/errors";

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export interface RateResult { allowed: boolean; remaining: number; resetAt: number }

// In-memory fixed-window limiter. `now` is injectable for testing.
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}

export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  const r = rateLimit(key, limit, windowMs);
  if (!r.allowed) {
    const retryAfter = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", `Too many requests; retry in ${retryAfter}s`, {
      "Retry-After": String(retryAfter),
    });
  }
}

// Test helper.
export function __resetRateLimits(): void {
  buckets.clear();
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- ratelimit`
Expected: PASS (4 tests).

- [ ] **Step 6: Apply the limiter to the auth routes**

In `app/api/v1/auth/login/route.ts` and `signup/route.ts`, at the start of the `try` block (before reading the body), add:
```ts
    const h = await headers();
    const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? "local").trim();
    assertRateLimit(`auth:${ip}`, 10, 60_000);
```
Add imports at the top of each file:
```ts
import { headers } from "next/headers";
import { assertRateLimit } from "@/lib/ratelimit";
```

- [ ] **Step 7: Type-check + full suite**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -4`
Expected: tsc exit 0; 96 tests pass (92 + 4 ratelimit). The existing `errors` tests still pass (the new `headers` param is optional).

- [ ] **Step 8: Commit**

```bash
git add lib/errors.ts lib/ratelimit.ts test/ratelimit.test.ts app/api/v1/auth
git commit -m "feat(security): in-memory rate limiter on auth routes (429 + Retry-After)"
```

---

## Task 7: Verify end-to-end + docs (P1 complete)

**Files:** Modify `README.md`, `docs/IMPLEMENTATION-ROADMAP.md`

- [ ] **Step 1: Fresh setup + full suite + build**

Run (Git Bash): `rm -rf .pgdata && npm run setup && npx tsc --noEmit && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -4`
Expected: setup ok; tsc exit 0; all tests pass (96); build exits 0. Confirm migrations include 0007–0009 and `policies` count is 20 (organizations + audit_log added):
```
node --input-type=module -e "import {PGlite} from '@electric-sql/pglite';import {drizzle} from 'drizzle-orm/pglite';import {migrate} from 'drizzle-orm/pglite/migrator';const db=drizzle(new PGlite(),{});await migrate(db,{migrationsFolder:'db/migrations'});const p=await db.execute(\"select count(*)::int n from pg_policies where policyname like 'org_isolation_%'\");console.log('policies',p.rows[0].n);"
```
Expected: `policies 20`.

- [ ] **Step 2: HTTP smoke — rate limit + audit + request id**

Run: `npm run dev` (background), then:
```
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3000/api/v1/auth/login -H "content-type: application/json" -d '{"email":"x@x.com","password":"bad"}'; done; echo
curl -s -D - -o /dev/null localhost:3000/api/v1/openapi.json | grep -i x-request-id
curl -s -c cj.txt -X POST localhost:3000/api/v1/auth/login -H "content-type: application/json" -d '{"email":"demo@launchos.com","password":"demo1234"}' -o /dev/null -w "demo-login %{http_code}\n"
```
Expected: the 12 bad logins show several `401` then `429` once the per-IP limit (10/min) trips; the openapi response carries an `x-request-id` header; the seeded demo login succeeds (`200`) — note it shares the IP bucket, so run this check after a fresh server start or wait for the window. Stop the server: `taskkill //F //T //PID $(netstat -ano | grep -E ":3000\b" | grep LISTENING | head -1 | awk '{print $NF}')`; `rm -f cj.txt dev.log`.

- [ ] **Step 3: Update README**

Add an architecture bullet after the `lib/sdk/*` line:
```
- `lib/log.ts` + `middleware.ts` — structured JSON logs (secret-redacted) + per-request `x-request-id`; `lib/audit.ts` writes the `audit_log` trail; `lib/ratelimit.ts` rate-limits auth.
```
Add a security note after the RLS paragraph:
```
Security: set `SESSION_SECRET` in production (the app refuses to start without it); session
cookies are `Secure` + time-limited; `organizations` is RLS-isolated and `app_user` cannot read
`users`. Auth routes are rate-limited (in-memory). API keys are SHA-256 only.
```

- [ ] **Step 4: Mark P1 complete in the roadmap**

In `docs/IMPLEMENTATION-ROADMAP.md`: change `### 4.6 ⬜ Observability & security baseline` to `### 4.6 ✅ Observability & security baseline (logging/request-id/audit/rate-limit; metrics+governor deferred)`; change the **P1** row marker in the §2 table from 🟡 to ✅ and list all six items done (note metrics/traces + platform governor deferred within 4.6).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/IMPLEMENTATION-ROADMAP.md
git commit -m "docs: observability/security notes + P1 complete"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** session-secret prod guard + Secure/Max-Age cookies + `exp` (Task 1) ✓;
  organizations RLS + `app_user` users revoke (Task 2) ✓; structured logger + redaction (Task 3)
  ✓; request-id middleware + console→log (Task 4) ✓; `audit_log` table + `recordAudit` + route
  wiring (Task 5) ✓; in-memory rate limiter + 429/Retry-After on auth (Task 6) ✓; deferred
  metrics/governor/oauth-encryption not built ✓; all 87 prior tests stay green (Tasks 1–7) ✓.
- **No placeholders:** every step has complete code; route edits show exact insertions; the HTTP
  smoke is concrete.
- **Type consistency:** `signSession(payload, secret, ttl?)` / `verifySession` / `sessionCookie`
  / `clearedCookie` used consistently in auth.ts + routes; `ApiError(status,code,detail,headers?)`
  is backward-compatible (headers optional) and consumed by `assertRateLimit` + `toProblemResponse`;
  `recordAudit(db, AuditInput)` matches its call sites; `rateLimit(key,limit,windowMs,now?)` /
  `assertRateLimit` signatures match the tests and routes; `redact`/`log` shapes consistent.
- **Migration order:** 0007 (org RLS + users revoke, custom) → 0008 (audit_log table, generated)
  → 0009 (audit_log RLS, custom); final `org_isolation_*` policy count = 20.
```
