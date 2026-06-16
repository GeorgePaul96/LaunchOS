# OpenAPI + SDK + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add programmatic + agent access to LaunchOS — API-key auth, an OpenAPI 3.1 spec, a hand-written typed SDK, and a stdio MCP server.

**Architecture:** API-key auth (Bearer `sk_…`, SHA-256 stored) accepted by `requireContext` alongside the session cookie; a hand-authored OpenAPI doc served at `/v1/openapi.json` with a drift-guard test; a thin `lib/sdk/` client; an MCP server (`mcp/*`) that calls the running API via the SDK using a key (avoiding PGlite's single-connection limit). Builds on P1.1–P1.3.

**Tech Stack:** `@modelcontextprotocol/sdk` 1.29 + `zod`, Node `crypto`, drizzle-orm/pg-core, Vitest, Next 16. SDK is hand-written (no codegen).

**Reference:** `docs/superpowers/specs/2026-06-16-openapi-sdk-mcp-design.md`.

**Conventions:** run from repo root. Commit after each task. Tests use the base test DB (service role) + injected stubs. `api_keys` keeps the existing text-timestamp convention.

---

## File Structure

```
db/schema.ts             + created_by/last_used_at/expires_at/revoked_at on api_keys
db/migrations/            + 0006_*.sql (generated columns)
lib/auth.ts              + hashApiKey() + generateApiKey()
lib/apikey.ts            resolveApiKeyOrg(db, secret)
lib/request.ts           requireContext accepts Bearer sk_ key OR session cookie
app/api/v1/api-keys/route.ts        POST mint key
app/api/v1/openapi.json/route.ts    GET the spec
lib/openapi/spec.ts      hand-authored OpenAPI 3.1 document
lib/openapi/paths.ts     routeApiPaths() — filesystem walk for the drift guard
lib/sdk/errors.ts        LaunchOSApiError
lib/sdk/types.ts         request/response types
lib/sdk/client.ts        LaunchOSClient
mcp/tools.ts             tool defs (name, description, zod schema, run)
mcp/server.ts            buildServer(client) + toMcpResult()
mcp/main.ts              stdio entry (env-configured)
bin/apikey.ts            `npm run apikey` bootstrap
package.json             + @modelcontextprotocol/sdk, zod; + apikey, mcp scripts
test/apikey.test.ts, openapi.test.ts, sdk.test.ts, mcp.test.ts   NEW
```

---

## Task 1: `api_keys` lifecycle columns + migration

**Files:** Modify `db/schema.ts`; Create `db/migrations/0006_*.sql`

- [ ] **Step 1: Add columns to `apiKeys` in `db/schema.ts`**

Replace the `apiKeys` table definition with:
```ts
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  createdBy: text("created_by").references(() => users.id),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: creates `db/migrations/0006_*.sql` with `ALTER TABLE "api_keys" ADD COLUMN …` for the four new columns.

- [ ] **Step 3: Verify it applies + reseed + run existing suite**

Run (Git Bash):
```
node --input-type=module -e "import {PGlite} from '@electric-sql/pglite';import {drizzle} from 'drizzle-orm/pglite';import {migrate} from 'drizzle-orm/pglite/migrator';const db=drizzle(new PGlite(),{});await migrate(db,{migrationsFolder:'db/migrations'});const c=await db.execute(\"select count(*)::int n from information_schema.columns where table_name='api_keys' and column_name in ('created_by','last_used_at','expires_at','revoked_at')\");console.log('new cols', c.rows[0].n);"
rm -rf .pgdata && npm run setup && npx vitest run 2>&1 | tail -4
```
Expected: `new cols 4`; setup completes; 73 tests pass.

- [ ] **Step 4: Commit**

```bash
git add db/schema.ts db/migrations
git commit -m "feat(api-keys): add created_by/last_used_at/expires_at/revoked_at columns"
```

---

## Task 2: API-key hashing + resolution

**Files:** Modify `lib/auth.ts`; Create `lib/apikey.ts`, `test/apikey.test.ts`

- [ ] **Step 1: Write the failing test**

`test/apikey.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { hashApiKey, generateApiKey } from "@/lib/auth";
import { resolveApiKeyOrg } from "@/lib/apikey";
import { uuid } from "@/lib/ids";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

async function insertKey(orgId: string, opts: { revoked?: boolean; expired?: boolean } = {}) {
  const { secret, hash, prefix } = generateApiKey();
  await db.insert(schema.apiKeys).values({
    id: uuid(), orgId, name: "test", keyHash: hash, keyPrefix: prefix,
    revokedAt: opts.revoked ? new Date().toISOString() : null,
    expiresAt: opts.expired ? new Date(Date.now() - 1000).toISOString() : null,
  });
  return secret;
}

describe("api keys", () => {
  it("hashApiKey is a stable sha256 hex", () => {
    expect(hashApiKey("sk_abc")).toBe(hashApiKey("sk_abc"));
    expect(hashApiKey("sk_abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateApiKey returns an sk_ secret, prefix, and matching hash", () => {
    const { secret, hash, prefix } = generateApiKey();
    expect(secret.startsWith("sk_")).toBe(true);
    expect(prefix).toBe(secret.slice(0, 8));
    expect(hash).toBe(hashApiKey(secret));
    expect(generateApiKey().secret).not.toBe(secret);
  });

  it("resolves a valid key to its org", async () => {
    const { orgId } = await seedOrg(db);
    const secret = await insertKey(orgId);
    expect(await resolveApiKeyOrg(db as any, secret)).toMatchObject({ orgId });
  });

  it("rejects revoked, expired, and garbage keys", async () => {
    const { orgId } = await seedOrg(db);
    const revoked = await insertKey(orgId, { revoked: true });
    const expired = await insertKey(orgId, { expired: true });
    expect(await resolveApiKeyOrg(db as any, revoked)).toBeNull();
    expect(await resolveApiKeyOrg(db as any, expired)).toBeNull();
    expect(await resolveApiKeyOrg(db as any, "sk_nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- apikey`
Expected: FAIL — cannot resolve `@/lib/apikey` / `generateApiKey`.

- [ ] **Step 3: Add hashing helpers to `lib/auth.ts`**

Add to the top imports of `lib/auth.ts` (it already imports from `node:crypto`):
```ts
import { scrypt, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
```
Append at the end of `lib/auth.ts`:
```ts
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateApiKey(): { secret: string; hash: string; prefix: string } {
  const secret = "sk_" + randomBytes(32).toString("hex");
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 8) };
}
```

- [ ] **Step 4: Implement `lib/apikey.ts`**

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { hashApiKey } from "@/lib/auth";

export interface ApiKeyContext {
  orgId: string;
  userId: string;
}

// Resolve a Bearer secret to its org via the service-role db (keys are pre-org-context).
export async function resolveApiKeyOrg(db: DB, secret: string): Promise<ApiKeyContext | null> {
  if (!secret.startsWith("sk_")) return null;
  const hash = hashApiKey(secret);
  const [row] = await db.select().from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.keyHash, hash), isNull(schema.apiKeys.revokedAt)));
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
  // best-effort touch of last_used_at
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, row.id));
  return { orgId: row.orgId, userId: row.createdBy ?? "" };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- apikey`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts lib/apikey.ts test/apikey.test.ts
git commit -m "feat(api-keys): hashing + generation + org resolution"
```

---

## Task 3: Bearer auth in requireContext + mint route + bootstrap CLI

**Files:** Modify `lib/request.ts`, `package.json`; Create `app/api/v1/api-keys/route.ts`, `bin/apikey.ts`

- [ ] **Step 1: Update `lib/request.ts` to accept a Bearer API key**

Replace `lib/request.ts` with:
```ts
import { cookies, headers } from "next/headers";
import { db, withOrg as withOrgScoped, type DB } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth";
import { resolveApiKeyOrg } from "@/lib/apikey";

export interface RequestContext {
  orgId: string;
  userId: string;
  withOrg: <T>(fn: (db: DB) => Promise<T>) => Promise<T>;
}

function contextFor(orgId: string, userId: string): RequestContext {
  return { orgId, userId, withOrg: (fn) => withOrgScoped(orgId, fn) };
}

export async function requireContext(): Promise<RequestContext> {
  // 1. API key (Authorization: Bearer sk_...)
  const h = await headers();
  const auth = h.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const ctx = await resolveApiKeyOrg(db, auth.slice(7).trim());
    if (!ctx) throw new ApiError(401, "unauthorized", "Invalid API key");
    return contextFor(ctx.orgId, ctx.userId);
  }
  // 2. Session cookie
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) throw new ApiError(401, "unauthorized", "No session");
  const payload = verifySession(token, sessionSecret());
  if (!payload) throw new ApiError(401, "unauthorized", "Invalid session");
  return contextFor(payload.orgId, payload.userId);
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
```
Note: `db` and `withOrg` are now imported from `@/db/client` (both are exported there).

- [ ] **Step 2: Create `app/api/v1/api-keys/route.ts`**

```ts
import { requireContext, ok } from "@/lib/request";
import { toProblemResponse, ApiError } from "@/lib/errors";
import { schema } from "@/db/client";
import { generateApiKey } from "@/lib/auth";
import { uuid } from "@/lib/ids";

export async function POST(req: Request) {
  try {
    const ctx = await requireContext();
    const body = await req.json();
    if (!body.name || typeof body.name !== "string") {
      throw new ApiError(400, "invalid_request", "name is required");
    }
    const { secret, hash, prefix } = generateApiKey();
    const id = uuid();
    await ctx.withOrg((db) =>
      db.insert(schema.apiKeys).values({
        id, orgId: ctx.orgId, name: body.name, keyHash: hash, keyPrefix: prefix,
        scopes: JSON.stringify(Array.isArray(body.scopes) ? body.scopes : []),
        createdBy: ctx.userId || null,
      }),
    );
    return ok({ id, key: secret, key_prefix: prefix }, 201);
  } catch (e) { return toProblemResponse(e); }
}
```

- [ ] **Step 3: Create `bin/apikey.ts`**

```ts
import { db, schema } from "../db/client";
import { generateApiKey } from "../lib/auth";
import { uuid } from "../lib/ids";

const [org] = await db.select().from(schema.organizations).limit(1);
if (!org) {
  console.error("No organization found. Run `npm run db:seed` first.");
  process.exit(1);
}
const { secret, hash, prefix } = generateApiKey();
await db.insert(schema.apiKeys).values({
  id: uuid(), orgId: org.id, name: "cli", keyHash: hash, keyPrefix: prefix, createdBy: null,
});
console.log(`API key for org ${org.slug} (save it now — shown once):`);
console.log(secret);
process.exit(0);
```
Note: top-level `await` works because the project is `"type": "module"` and this is run via `tsx`.

- [ ] **Step 4: Add scripts to `package.json`**

In `scripts`, add after `"worker"`:
```json
    "apikey": "tsx bin/apikey.ts",
```

- [ ] **Step 5: Type-check + full suite + CLI smoke**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -4 && npm run apikey`
Expected: tsc exit 0; 77 tests pass (73 + 4 apikey); the CLI prints an `sk_…` key.

- [ ] **Step 6: Commit**

```bash
git add lib/request.ts app/api/v1/api-keys package.json bin/apikey.ts
git commit -m "feat(api-keys): Bearer auth in requireContext + mint route + bootstrap CLI"
```

---

## Task 4: OpenAPI spec + endpoint + drift guard

**Files:** Create `lib/openapi/spec.ts`, `lib/openapi/paths.ts`, `app/api/v1/openapi.json/route.ts`, `test/openapi.test.ts`

- [ ] **Step 1: Create `lib/openapi/spec.ts`**

```ts
// Hand-authored OpenAPI 3.1 contract for the /v1 API. Source of truth for SDK consumers.
const problem = {
  type: "object",
  properties: {
    type: { type: "string" }, title: { type: "string" }, status: { type: "integer" },
    detail: { type: "string" }, code: { type: "string" }, request_id: { type: "string" },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: { title: "LaunchOS API", version: "0.1.0", description: "Compose, publish, and attribute." },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "sk_*" } },
    schemas: { Problem: problem },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/accounts": { get: { summary: "List connected accounts", responses: resp("Accounts") } },
    "/posts": {
      get: { summary: "List posts", responses: resp("Posts") },
      post: { summary: "Create + queue a post", requestBody: jsonBody({
        profileId: { type: "string" }, content: { type: "string" },
        accountIds: { type: "array", items: { type: "string" } },
      }, ["profileId", "accountIds"]), responses: resp("Post", 202) },
    },
    "/posts/{id}/retry": { post: { summary: "Retry failed targets", parameters: [pathParam("id")], responses: resp("Retry") } },
    "/attribution/identify": { post: { summary: "Identify / stitch", requestBody: jsonBody({ anonymousId: { type: "string" }, contactId: { type: "string" } }, ["anonymousId"]), responses: resp("Identity") } },
    "/attribution/touchpoints": { post: { summary: "Record a touchpoint", requestBody: jsonBody({ identityId: { type: "string" }, channel: { type: "string" } }, ["identityId", "channel"]), responses: resp("Touchpoint", 201) } },
    "/attribution/conversions": { post: { summary: "Record a conversion", requestBody: jsonBody({ identityId: { type: "string" }, eventName: { type: "string" }, valueCents: { type: "integer" } }, ["identityId", "eventName"]), responses: resp("Conversion", 201) } },
    "/attribution/report": { get: { summary: "Attribution report", parameters: [queryParam("model")], responses: resp("Report") } },
    "/journeys/contacts/{cid}/timeline": { get: { summary: "Contact journey", parameters: [pathParam("cid")], responses: resp("Timeline") } },
    "/api-keys": { post: { summary: "Mint an API key", requestBody: jsonBody({ name: { type: "string" }, scopes: { type: "array", items: { type: "string" } } }, ["name"]), responses: resp("ApiKey", 201) } },
  },
} as const;

function jsonBody(props: Record<string, unknown>, required: string[]) {
  return { required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } };
}
function resp(_name: string, ok = 200) {
  return {
    [String(ok)]: { description: "Success", content: { "application/json": { schema: { type: "object" } } } },
    "4XX": { description: "Error", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
  };
}
function pathParam(name: string) {
  return { name, in: "path", required: true, schema: { type: "string" } };
}
function queryParam(name: string) {
  return { name, in: "query", required: false, schema: { type: "string" } };
}
```

- [ ] **Step 2: Create `lib/openapi/paths.ts` (filesystem walk for the drift guard)**

```ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Returns the set of /v1 API paths implemented as route.ts handlers, with [x] -> {x}.
// Excludes /auth/* and /openapi.json (auth is intentionally undocumented; the spec serves itself).
export function routeApiPaths(root = "app/api/v1"): string[] {
  const out: string[] = [];
  function walk(dir: string, segs: string[]) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, [...segs, entry.replace(/^\[(.+)\]$/, "{$1}")]);
      } else if (entry === "route.ts") {
        out.push("/" + segs.join("/"));
      }
    }
  }
  walk(root, []);
  return out.filter((p) => !p.startsWith("/auth") && p !== "/openapi.json").sort();
}
```

- [ ] **Step 3: Create `app/api/v1/openapi.json/route.ts`**

```ts
import { openapiSpec } from "@/lib/openapi/spec";

export function GET() {
  return new Response(JSON.stringify(openapiSpec), { headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 4: Write the drift-guard test**

`test/openapi.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { openapiSpec } from "@/lib/openapi/spec";
import { routeApiPaths } from "@/lib/openapi/paths";

describe("openapi spec", () => {
  it("is a valid OpenAPI 3.1 document", () => {
    expect(openapiSpec.openapi).toBe("3.1.0");
    expect(openapiSpec.info.title).toBeTruthy();
    expect(Object.keys(openapiSpec.paths).length).toBeGreaterThan(0);
    expect(openapiSpec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("documents every /v1 route (drift guard)", () => {
    const documented = Object.keys(openapiSpec.paths).sort();
    const implemented = routeApiPaths();
    expect(documented).toEqual(implemented);
  });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- openapi`
Expected: PASS (2 tests). If the drift guard fails, the printed diff shows which path is documented-but-missing or implemented-but-undocumented — reconcile `spec.ts` with the actual routes.

- [ ] **Step 6: Commit**

```bash
git add lib/openapi app/api/v1/openapi.json test/openapi.test.ts
git commit -m "feat(openapi): 3.1 spec + /v1/openapi.json + route drift guard"
```

---

## Task 5: Hand-written SDK

**Files:** Create `lib/sdk/errors.ts`, `lib/sdk/types.ts`, `lib/sdk/client.ts`, `test/sdk.test.ts`

- [ ] **Step 1: Create `lib/sdk/errors.ts`**

```ts
export class LaunchOSApiError extends Error {
  constructor(public status: number, public code: string, public detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LaunchOSApiError";
  }
}
```

- [ ] **Step 2: Create `lib/sdk/types.ts`**

```ts
export interface CreatePostInput {
  profileId: string;
  content?: string;
  accountIds: string[];
  scheduledFor?: string | null;
  campaignId?: string | null;
}
export interface IdentifyInput { anonymousId: string; contactId?: string; externalUserId?: string }
export interface TouchpointInput { identityId: string; channel: string; platform?: string; sourceType?: string; sourceId?: string; campaignId?: string }
export interface ConversionInput { identityId: string; eventName: string; valueCents?: number; currency?: string }
export interface CreateApiKeyInput { name: string; scopes?: string[] }
export type AttributionModel = "first_touch" | "last_touch" | "linear";

export interface ClientOptions {
  baseUrl?: string;            // origin, e.g. http://localhost:3000
  apiKey: string;
  fetch?: typeof fetch;        // injectable for tests
}
```

- [ ] **Step 3: Write the failing test**

`test/sdk.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { LaunchOSClient } from "@/lib/sdk/client";
import { LaunchOSApiError } from "@/lib/sdk/errors";

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("LaunchOSClient", () => {
  it("sends the Bearer header and parses JSON", async () => {
    const { fn, calls } = stubFetch(200, { data: [{ id: "acc_1" }] });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    const res = await client.accounts.list();
    expect(res).toEqual({ data: [{ id: "acc_1" }] });
    expect(calls[0].url).toBe("http://x/api/v1/accounts");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk_test");
  });

  it("POSTs a body for create", async () => {
    const { fn, calls } = stubFetch(202, { post: { id: "post_1", status: "scheduled" } });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.posts.create({ profileId: "p", content: "hi", accountIds: ["a"] });
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ profileId: "p", accountIds: ["a"] });
  });

  it("builds the report query string", async () => {
    const { fn, calls } = stubFetch(200, { model: "linear", channels: [] });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.attribution.report("linear");
    expect(calls[0].url).toBe("http://x/api/v1/attribution/report?model=linear");
  });

  it("throws LaunchOSApiError on non-2xx problem+json", async () => {
    const { fn } = stubFetch(401, { code: "unauthorized", detail: "Invalid API key" });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_bad", fetch: fn });
    await expect(client.accounts.list()).rejects.toBeInstanceOf(LaunchOSApiError);
    await expect(client.accounts.list()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test -- sdk`
Expected: FAIL — cannot resolve `@/lib/sdk/client`.

- [ ] **Step 5: Implement `lib/sdk/client.ts`**

```ts
import { LaunchOSApiError } from "./errors";
import type {
  ClientOptions, CreatePostInput, IdentifyInput, TouchpointInput, ConversionInput,
  CreateApiKeyInput, AttributionModel,
} from "./types";

export class LaunchOSClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new LaunchOSApiError(res.status, json.code ?? "error", json.detail ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  accounts = {
    list: () => this.req<{ data: unknown[] }>("GET", "/accounts"),
  };

  posts = {
    list: () => this.req<{ data: unknown[] }>("GET", "/posts"),
    create: (input: CreatePostInput) => this.req<{ post: { id: string; status: string } }>("POST", "/posts", input),
    retry: (publicId: string) => this.req<{ retried: number }>("POST", `/posts/${encodeURIComponent(publicId)}/retry`),
  };

  attribution = {
    identify: (input: IdentifyInput) => this.req<{ identity_id: string }>("POST", "/attribution/identify", input),
    touchpoint: (input: TouchpointInput) => this.req<{ touchpoint_id: number }>("POST", "/attribution/touchpoints", input),
    conversion: (input: ConversionInput) => this.req<{ conversion_id: number }>("POST", "/attribution/conversions", input),
    report: (model: AttributionModel) => this.req<unknown>("GET", `/attribution/report?model=${encodeURIComponent(model)}`),
  };

  journeys = {
    timeline: (contactId: string) => this.req<{ data: unknown[] }>("GET", `/journeys/contacts/${encodeURIComponent(contactId)}/timeline`),
  };

  apiKeys = {
    create: (input: CreateApiKeyInput) => this.req<{ id: string; key: string; key_prefix: string }>("POST", "/api-keys", input),
  };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -- sdk`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/sdk test/sdk.test.ts
git commit -m "feat(sdk): hand-written typed LaunchOSClient"
```

---

## Task 6: MCP server

**Files:** Modify `package.json`; Create `mcp/tools.ts`, `mcp/server.ts`, `mcp/main.ts`, `test/mcp.test.ts`

- [ ] **Step 1: Add dependencies**

In `package.json` `dependencies`, add:
```json
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0",
```
Run: `npm install`
Expected: both installed (zod 3.x is the version the MCP SDK expects).

- [ ] **Step 2: Create `mcp/tools.ts`**

```ts
import { z } from "zod";
import type { LaunchOSClient } from "@/lib/sdk/client";
import type { AttributionModel } from "@/lib/sdk/types";

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  run: (client: LaunchOSClient, args: Record<string, unknown>) => Promise<unknown>;
}

export const tools: ToolDef[] = [
  { name: "list_accounts", description: "List connected social accounts.", schema: {},
    run: (c) => c.accounts.list() },
  { name: "list_posts", description: "List posts and their target statuses.", schema: {},
    run: (c) => c.posts.list() },
  { name: "create_post", description: "Create and queue a post to one or more accounts.",
    schema: { profileId: z.string(), content: z.string(), accountIds: z.array(z.string()) },
    run: (c, a) => c.posts.create({ profileId: a.profileId as string, content: a.content as string, accountIds: a.accountIds as string[] }) },
  { name: "attribution_report", description: "Channel revenue attribution for a model (first_touch | last_touch | linear).",
    schema: { model: z.enum(["first_touch", "last_touch", "linear"]) },
    run: (c, a) => c.attribution.report(a.model as AttributionModel) },
  { name: "contact_journey", description: "Chronological touchpoint+conversion timeline for a contact id.",
    schema: { contactId: z.string() },
    run: (c, a) => c.journeys.timeline(a.contactId as string) },
  { name: "record_touchpoint", description: "Record a marketing touchpoint against an identity.",
    schema: { identityId: z.string(), channel: z.string(), platform: z.string().optional(), sourceId: z.string().optional() },
    run: (c, a) => c.attribution.touchpoint({ identityId: a.identityId as string, channel: a.channel as string, platform: a.platform as string | undefined, sourceId: a.sourceId as string | undefined }) },
  { name: "record_conversion", description: "Record a conversion/revenue event against an identity.",
    schema: { identityId: z.string(), eventName: z.string(), valueCents: z.number().optional() },
    run: (c, a) => c.attribution.conversion({ identityId: a.identityId as string, eventName: a.eventName as string, valueCents: a.valueCents as number | undefined }) },
];
```

- [ ] **Step 3: Create `mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LaunchOSClient } from "@/lib/sdk/client";
import { LaunchOSApiError } from "@/lib/sdk/errors";
import { tools } from "./tools";

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// Wrap an SDK call into an MCP tool result; surface problem+json detail on error.
export async function toMcpResult(work: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    const out = await work();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    const detail = e instanceof LaunchOSApiError ? e.detail : e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: detail }], isError: true };
  }
}

export function buildServer(client: LaunchOSClient): McpServer {
  const server = new McpServer({ name: "launchos", version: "0.1.0" });
  for (const t of tools) {
    server.tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) =>
      toMcpResult(() => t.run(client, args)),
    );
  }
  return server;
}
```

- [ ] **Step 4: Create `mcp/main.ts` (stdio entry)**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LaunchOSClient } from "@/lib/sdk/client";
import { buildServer } from "./server";

const apiKey = process.env.LAUNCHOS_API_KEY;
if (!apiKey) {
  console.error("LAUNCHOS_API_KEY is required. Mint one with `npm run apikey`.");
  process.exit(1);
}
const client = new LaunchOSClient({ baseUrl: process.env.LAUNCHOS_BASE_URL ?? "http://localhost:3000", apiKey });
const server = buildServer(client);
await server.connect(new StdioServerTransport());
console.error("[mcp] launchos server running on stdio");
```

- [ ] **Step 5: Add the `mcp` script to `package.json`**

In `scripts`, add after `"apikey"`:
```json
    "mcp": "tsx mcp/main.ts",
```

- [ ] **Step 6: Write the test**

`test/mcp.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tools } from "@/mcp/tools";
import { toMcpResult, buildServer } from "@/mcp/server";
import { LaunchOSApiError } from "@/lib/sdk/errors";
import { LaunchOSClient } from "@/lib/sdk/client";

describe("mcp", () => {
  it("registers the curated tool set", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "attribution_report", "contact_journey", "create_post", "list_accounts",
      "list_posts", "record_conversion", "record_touchpoint",
    ]);
  });

  it("routes a tool call through the client", async () => {
    const stub = { accounts: { list: async () => ({ data: [{ id: "acc_1" }] }) } } as unknown as LaunchOSClient;
    const listAccounts = tools.find((t) => t.name === "list_accounts")!;
    const out = await listAccounts.run(stub, {});
    expect(out).toEqual({ data: [{ id: "acc_1" }] });
  });

  it("toMcpResult surfaces errors with isError", async () => {
    const ok = await toMcpResult(async () => ({ a: 1 }));
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("\"a\": 1");

    const err = await toMcpResult(async () => { throw new LaunchOSApiError(401, "unauthorized", "Invalid API key"); });
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toBe("Invalid API key");
  });

  it("buildServer constructs without a transport", () => {
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test" });
    expect(buildServer(client)).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npm test -- mcp`
Expected: PASS (4 tests). The `@` alias maps to the repo root, so `@/mcp/tools` resolves to `mcp/tools.ts`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json mcp test/mcp.test.ts
git commit -m "feat(mcp): stdio MCP server exposing 7 curated LaunchOS tools"
```

---

## Task 7: Verify end-to-end + docs

**Files:** Modify `README.md`, `docs/IMPLEMENTATION-ROADMAP.md`

- [ ] **Step 1: Fresh setup + full suite + build**

Run (Git Bash): `rm -rf .pgdata && npm run setup && npx tsc --noEmit && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -4`
Expected: setup ok; tsc exit 0; all tests pass (73 + apikey 4 + openapi 2 + sdk 4 + mcp 4 = 87); build exits 0.

- [ ] **Step 2: HTTP smoke — mint a key, call the API with it, fetch the spec**

Run: `npm run dev` (background), then:
```
KEY=$(npm run apikey 2>/dev/null | grep '^sk_')
echo "key: ${KEY:0:12}..."
curl -s localhost:3000/api/v1/openapi.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('openapi',j.openapi,'paths',Object.keys(j.paths).length)})"
curl -s -H "Authorization: Bearer $KEY" localhost:3000/api/v1/accounts | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('accounts',(j.data||[]).length)})"
curl -s -o /dev/null -w "no-key %{http_code}\n" localhost:3000/api/v1/accounts
```
Expected: a key prints; `openapi 3.1.0 paths 9`; `accounts 3`; `no-key 401`. Stop the server afterward (`taskkill //F //T //PID $(netstat -ano | grep -E ":3000\b" | grep LISTENING | head -1 | awk '{print $NF}')`; `rm -f dev.log`).

- [ ] **Step 3: Update README**

Add an architecture bullet after the `lib/ai/*` line:
```
- `lib/sdk/*` + `mcp/*` — typed API client + stdio MCP server (Claude/Cursor); `/api/v1/openapi.json` is the contract. API-key auth via `Authorization: Bearer sk_…`.
```
Add a "Programmatic access" subsection after the Background worker section:
````markdown
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
Tools: list_accounts, list_posts, create_post, attribution_report, contact_journey, record_touchpoint, record_conversion.
````

- [ ] **Step 4: Mark P1.5 in the roadmap**

In `docs/IMPLEMENTATION-ROADMAP.md`, change `### 4.5 ⬜ OpenAPI 3.1 → SDKs + MCP + typed tool registry` to `### 4.5 ✅ OpenAPI 3.1 → SDK + MCP (TS; Python/others later)`, and update the P1 row in the §2 table to add `✅ OpenAPI/SDK/MCP` (leaving billing + observability ⬜).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/IMPLEMENTATION-ROADMAP.md
git commit -m "docs: programmatic access (SDK + MCP) notes + roadmap status (P1.4 done)"
```

---

## Self-review notes (addressed in this plan)

- **Spec coverage:** API-key minting + SHA-256 storage (Tasks 1–3) ✓; Bearer-or-cookie auth in
  `requireContext` (Task 3) ✓; bootstrap CLI (Task 3) ✓; OpenAPI 3.1 served + drift guard
  (Task 4) ✓; hand-written typed SDK + typed error (Task 5) ✓; stdio MCP with the curated
  7-tool set over the SDK (Task 6) ✓; no-existence-disclosure 401, error mapping (Tasks 3,5,6)
  ✓; offline tests via stubs (Tasks 2,5,6) ✓; all 73 existing tests stay green (Tasks 3,7) ✓.
- **No placeholders:** every step has complete code. The MCP HTTP smoke and Claude/Cursor config
  are concrete.
- **Type consistency:** `LaunchOSApiError(status,code,detail)` used identically in SDK + MCP;
  `LaunchOSClient` method names match the SDK test, MCP tools, and the smoke; `resolveApiKeyOrg`
  returns `{orgId,userId}` consumed by `requireContext`; `ToolDef {name,description,schema,run}`
  consistent across tools/server/test; OpenAPI path strings equal `routeApiPaths()` output
  (9 paths: accounts, posts, posts/{id}/retry, 4 attribution, journeys timeline, api-keys).
- **Schema note:** `api_keys` gains `created_by/last_used_at/expires_at/revoked_at` (canonical
  columns the P1 subset omitted) — Task 1.
```
