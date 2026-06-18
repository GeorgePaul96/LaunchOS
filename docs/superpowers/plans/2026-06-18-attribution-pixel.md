# Attribution Pixel + Journey Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an embeddable `pixel.js` + a public, CORS-enabled, write-key-authed `POST /api/v1/collect` endpoint that records pageview touchpoints and conversions from untrusted browsers and stitches anonymous visitors to contacts by email — closing the attribution loop end-to-end.

**Architecture:** One publishable `pk_…` write key per org on `organizations`. A single batched public endpoint `/api/v1/collect` resolves the org from the write key (base/service-role db), then runs inside `withOrg(orgId, …)` to identify the visitor (find-or-create by `anonymousId`) and dispatch `page`/`track`/`identify`. `identify` finds-or-creates a contact by email and links the identity, so the existing `contactTimeline` fan-in merges cross-device journeys with no timeline/report changes.

**Tech Stack:** Next.js 16 App Router (route handlers), TypeScript, Drizzle ORM (pg-core) on PGlite (dev/test) / node-postgres (prod), Vitest. No new dependencies.

## Global Constraints

- **Public ingest is the ONLY unauthenticated path.** `/api/v1/collect` does NOT use `requireContext()`; its credential is the `writeKey` in the request body. All existing authenticated `/api/v1/attribution/*` routes stay untouched.
- **Write key is publishable and NOT hashed** (unlike `sk_` API keys which are SHA-256). Format: `"pk_" + randomBytes(24).toString("hex")`. It authorizes only `/collect` (write-only); it can never read data.
- **`organizations.write_key`** is declared `text NOT NULL DEFAULT ''` with **NO** `.unique()` in the Drizzle schema. Uniqueness is added by a `CREATE UNIQUE INDEX` in the follow-up migration *after* the backfill — declaring unique on the column would collide on the shared `''` default when the column is added to existing rows. All org-creation paths (signup, seed, test `seedOrg`) must set a real key so `''` never recurs.
- **Multi-tenancy = Postgres RLS.** Org-scoped work runs inside `withOrg(orgId, fn)`; keep `org_id` filters in every query (defense-in-depth). `resolveWriteKeyOrg` runs on the base/service-role `db` (pre-org-context), exactly like the existing `resolveApiKeyOrg`.
- **Every new `/v1` route MUST be in `lib/openapi/spec.ts`** or `test/openapi.test.ts` drift guard fails. `/collect` is documented with `security: []` (public). `/pixel.js` is NOT under `app/api/v1`, so it is not an OpenAPI path.
- **Route handlers cannot be unit-tested against the test DB** (they import the app's `@/db/client` `db`, which is a different instance from the shared test PGlite). Therefore all DB logic lives in services tested directly with the test db; the route stays thin. Non-DB route pieces (CORS helper, OPTIONS, body parsing) ARE unit-tested.
- **Errors** are `ApiError(status, code, detail, headers?)` from `lib/errors.ts`; convert with `toProblemResponse()`. CORS headers must be added to every `/collect` response, including errors.
- **TDD**: failing test first. Tests share one PGlite instance and TRUNCATE between tests (`test/helpers.ts`). Run `npm test`.
- **Windows / PowerShell**: chain with `;` not `&&` (Bash tool also available). PGlite = one process per `.pgdata`.
- **Commits**: co-author trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Work on branch `feat/attribution-pixel` (already created).
- All existing tests must stay green throughout. After UI/route work, also run `npm run build` (route syntax errors are invisible to `npm test`).

---

### Task 1: Write-key infrastructure (schema + key generator + migration + creation paths)

**Files:**
- Modify: `lib/auth.ts` (add `generateWriteKey`)
- Modify: `db/schema.ts` (add `organizations.write_key`)
- Create: `db/migrations/00XX_*.sql` (generated) + `db/migrations/00YY_write_key_backfill.sql` (custom)
- Modify: `test/helpers.ts` (`seedOrg` sets a write key)
- Modify: `db/seed.ts` (seed org gets a write key)
- Modify: `app/api/v1/auth/signup/route.ts` (new org gets a write key)
- Test: `test/write-key.test.ts`

**Interfaces:**
- Produces: `generateWriteKey(): string` (returns `"pk_" + 48 hex chars`); `schema.organizations.writeKey` (column `write_key`); `seedOrg` continues to return `{ orgId, profileId }` but now every seeded org has a distinct `write_key`.

- [ ] **Step 1: Write the failing test**

Create `test/write-key.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { generateWriteKey } from "@/lib/auth";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("write key", () => {
  it("generateWriteKey returns a pk_ key", () => {
    const k = generateWriteKey();
    expect(k.startsWith("pk_")).toBe(true);
    expect(k.length).toBeGreaterThan(20);
    expect(generateWriteKey()).not.toBe(k); // unique each call
  });

  it("seedOrg gives every org a distinct non-empty write key (unique index holds)", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const rows = await db.select().from(schema.organizations);
    const keys = rows.map((r) => r.writeKey);
    expect(keys.every((k) => k.startsWith("pk_"))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // all distinct
    const [orgA] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, a.orgId));
    expect(orgA.writeKey).not.toBe("");
    expect(b.orgId).not.toBe(a.orgId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- write-key`
Expected: FAIL — `generateWriteKey` not exported / `writeKey` column missing.

- [ ] **Step 3: Add the key generator**

In `lib/auth.ts`, after `generateApiKey` (it already imports `randomBytes`):

```ts
export function generateWriteKey(): string {
  return "pk_" + randomBytes(24).toString("hex");
}
```

- [ ] **Step 4: Add the schema column**

In `db/schema.ts`, in the `organizations` table, add after `featureFlags` (do NOT add `.unique()`):

```ts
  featureFlags: text("feature_flags").notNull().default("{}"),
  writeKey: text("write_key").notNull().default(""),
  createdAt: text("created_at").notNull().$defaultFn(now),
```

- [ ] **Step 5: Generate the column migration**

Run: `npm run db:generate`
Expected: a new `db/migrations/00XX_*.sql` adding `write_key text NOT NULL DEFAULT ''` to `organizations` (no unique). Note its number `XX`.

- [ ] **Step 6: Hand-write the backfill + unique-index migration**

Run: `npx drizzle-kit generate --custom --name write_key_backfill`
Replace the generated empty file (`db/migrations/00YY_write_key_backfill.sql`) with:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE write_key = '' LOOP
    UPDATE organizations SET write_key = 'pk_' || replace(gen_random_uuid()::text, '-', '') WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX organizations_write_key_unique ON organizations (write_key);
```

- [ ] **Step 7: Make `seedOrg` set a write key**

In `test/helpers.ts`, import the generator and set the column. Add to the imports at the top:

```ts
import { generateWriteKey } from "@/lib/auth";
```

In `seedOrg`, change the organizations insert to include `writeKey`:

```ts
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Acme", slug: "acme-" + orgId.slice(0, 8),
    writeKey: generateWriteKey(),
  });
```

- [ ] **Step 8: Make seed + signup set a write key**

In `db/seed.ts`, add the import and set `writeKey` on the org insert:

```ts
import { hashPassword, generateWriteKey } from "../lib/auth";
```
```ts
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Demo Co", slug: "demo-co",
    writeKey: generateWriteKey(),
  });
```

In `app/api/v1/auth/signup/route.ts`, add `generateWriteKey` to the `@/lib/auth` import and set it on the org insert:

```ts
import { hashPassword, signSession, sessionSecret, sessionCookie, generateWriteKey } from "@/lib/auth";
```
```ts
    await db.insert(schema.organizations).values({ id: orgId, publicId: publicId("org"), name: name ? `${name}'s Org` : "My Org", slug: "org-" + orgId.slice(0, 8), writeKey: generateWriteKey() });
```

- [ ] **Step 9: Find and fix any other org inserts in tests**

Run: `npx rg -l "insert\(schema.organizations\)" test` (or use the Grep tool).
For every match other than `test/helpers.ts`, add `writeKey: generateWriteKey()` to the insert (importing `generateWriteKey` from `@/lib/auth` in that file). This prevents the new unique index from colliding on `''`.

- [ ] **Step 10: Run the focused test, then the full suite**

Run: `npm test -- write-key`  → PASS.
Run: `npm test`  → all green (the new migrations apply during shared-DB setup; the unique index must not collide).

- [ ] **Step 11: Commit**

```bash
git add lib/auth.ts db/schema.ts db/migrations test/helpers.ts db/seed.ts app/api/v1/auth/signup/route.ts test/write-key.test.ts
git commit -m "feat(attribution): organizations.write_key + generateWriteKey + backfill migration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `resolveWriteKeyOrg`

**Files:**
- Modify: `lib/apikey.ts` (add `resolveWriteKeyOrg`)
- Test: `test/write-key.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `schema.organizations.writeKey` (Task 1).
- Produces: `resolveWriteKeyOrg(db, writeKey: string): Promise<string | null>` — returns `orgId` for a valid `pk_` key, else null.

- [ ] **Step 1: Write the failing test**

Append to `test/write-key.test.ts`:

```ts
import { resolveWriteKeyOrg } from "@/lib/apikey";

describe("resolveWriteKeyOrg", () => {
  it("resolves a valid pk_ key to its org and isolates across orgs", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const [orgA] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, a.orgId));
    const [orgB] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, b.orgId));
    expect(await resolveWriteKeyOrg(db as any, orgA.writeKey)).toBe(a.orgId);
    expect(await resolveWriteKeyOrg(db as any, orgB.writeKey)).toBe(b.orgId);
  });

  it("returns null for missing / empty / sk_-prefixed / unknown keys", async () => {
    await seedOrg(db);
    expect(await resolveWriteKeyOrg(db as any, "")).toBeNull();
    expect(await resolveWriteKeyOrg(db as any, "sk_deadbeef")).toBeNull();
    expect(await resolveWriteKeyOrg(db as any, "pk_does_not_exist")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- write-key`
Expected: FAIL — `resolveWriteKeyOrg` not exported.

- [ ] **Step 3: Implement**

In `lib/apikey.ts` (it already imports `eq`, `schema`, `DB`), add:

```ts
// Resolve a publishable write key (pk_...) to its org via the service-role db.
// Unlike sk_ keys, write keys are stored in plaintext (publishable by design).
export async function resolveWriteKeyOrg(db: DB, writeKey: string): Promise<string | null> {
  if (!writeKey || !writeKey.startsWith("pk_")) return null;
  const [row] = await db.select().from(schema.organizations).where(eq(schema.organizations.writeKey, writeKey));
  return row?.id ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- write-key`  → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/apikey.ts test/write-key.test.ts
git commit -m "feat(attribution): resolveWriteKeyOrg (plaintext pk_ lookup)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `stitchContact` (identity → contact)

**Files:**
- Modify: `lib/attribution/identity.ts` (add `stitchContact` + `StitchInput`)
- Test: `test/identity.test.ts` (add cases) — or `test/stitch.test.ts` if the file is unrelated; check first and prefer the existing `test/identity.test.ts`.

**Interfaces:**
- Consumes: `schema.contacts`, `schema.identities`, `uuid`, `publicId`.
- Produces: `stitchContact(db, orgId, { identityId, email?, contactId?, traits? }): Promise<string | null>` — links the identity to a found/created contact (by email or contactId), merges traits into the identity, sets `contacts.identityId` if null; returns the contactId (null when neither email nor contactId given).

- [ ] **Step 1: Write the failing test**

Add to `test/identity.test.ts` (mirror its existing imports — it uses `makeTestDb`, `seedOrg`; add `import * as schema from "@/db/schema"; import { eq, and } from "drizzle-orm"; import { identify, stitchContact } from "@/lib/attribution/identity"; import { contactTimeline } from "@/lib/journey/timeline";` as needed, deduping against what the file already imports):

```ts
describe("stitchContact", () => {
  it("creates a contact by email and links the identity both ways", async () => {
    const { orgId } = await seedOrg(db);
    const idA = await identify(db as any, orgId, { anonymousId: "anon-1" });
    const contactId = await stitchContact(db as any, orgId, { identityId: idA, email: "Jo@Example.com ", traits: { name: "Jo" } });
    expect(contactId).toBeTruthy();
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, idA));
    expect(identity.contactId).toBe(contactId);
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId!));
    expect(contact.email).toBe("jo@example.com"); // normalized
    expect(contact.identityId).toBe(idA);
  });

  it("merges two devices (same email) into one contact and one merged timeline", async () => {
    const { orgId } = await seedOrg(db);
    const id1 = await identify(db as any, orgId, { anonymousId: "dev-1" });
    const id2 = await identify(db as any, orgId, { anonymousId: "dev-2" });
    const c1 = await stitchContact(db as any, orgId, { identityId: id1, email: "x@y.com" });
    const c2 = await stitchContact(db as any, orgId, { identityId: id2, email: "x@y.com" });
    expect(c2).toBe(c1); // same contact reused
    // both identities now point to the same contact → timeline fans both in
    await db.insert(schema.touchpoints).values({ orgId, identityId: id1, channel: "web", occurredAt: "2026-01-01T00:00:00.000Z" });
    await db.insert(schema.touchpoints).values({ orgId, identityId: id2, channel: "email", occurredAt: "2026-01-02T00:00:00.000Z" });
    const tl = await contactTimeline(db as any, orgId, c1!);
    expect(tl.map((e) => e.channel)).toEqual(["web", "email"]);
  });

  it("ignores a contactId from another org and is a no-op without email/contactId", async () => {
    const a = await seedOrg(db);
    const b = await seedOrg(db);
    const idA = await identify(db as any, a.orgId, { anonymousId: "anon-a" });
    // create a contact in org B
    const idB = await identify(db as any, b.orgId, { anonymousId: "anon-b" });
    const cB = await stitchContact(db as any, b.orgId, { identityId: idB, email: "b@b.com" });
    // org A identify referencing org B's contactId → ignored (treated as no match → no-op since no email)
    const res = await stitchContact(db as any, a.orgId, { identityId: idA, contactId: cB! });
    expect(res).toBeNull();
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, idA));
    expect(identity.contactId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- identity`
Expected: FAIL — `stitchContact` not exported.

- [ ] **Step 3: Implement**

In `lib/attribution/identity.ts`, extend the imports to include `asc`, `publicId`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { uuid, publicId } from "@/lib/ids";
```

Add at the end of the file:

```ts
export interface StitchInput {
  identityId: string;
  email?: string | null;
  contactId?: string | null;
  traits?: Record<string, unknown>;
}

// Link an identity to a contact (found/created by email or contactId), merge traits,
// and set contacts.identityId if it was null. Returns the contactId (null = no-op).
export async function stitchContact(db: DB, orgId: string, input: StitchInput): Promise<string | null> {
  let contactId: string | null = null;

  if (input.contactId) {
    const [c] = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, input.contactId), eq(schema.contacts.orgId, orgId)));
    if (c) contactId = c.id;
  }

  if (!contactId && input.email) {
    const email = input.email.trim().toLowerCase();
    const matches = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.email, email)))
      .orderBy(asc(schema.contacts.createdAt));
    if (matches.length) {
      contactId = matches[0].id;
    } else {
      contactId = uuid();
      await db.insert(schema.contacts).values({
        id: contactId, publicId: publicId("contact"), orgId,
        name: (input.traits?.name as string | undefined) ?? null,
        email, lifecycleStage: "lead",
      });
    }
  }

  if (!contactId) return null;

  const [identity] = await db.select().from(schema.identities)
    .where(and(eq(schema.identities.id, input.identityId), eq(schema.identities.orgId, orgId)));
  const patch: Record<string, unknown> = { contactId };
  if (input.traits && Object.keys(input.traits).length) {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(identity?.traits || "{}"); } catch { existing = {}; }
    patch.traits = JSON.stringify({ ...existing, ...input.traits });
  }
  await db.update(schema.identities).set(patch)
    .where(and(eq(schema.identities.id, input.identityId), eq(schema.identities.orgId, orgId)));

  const [contact] = await db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)));
  if (contact && !contact.identityId) {
    await db.update(schema.contacts).set({ identityId: input.identityId })
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)));
  }
  return contactId;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- identity`  → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/attribution/identity.ts test/identity.test.ts
git commit -m "feat(attribution): stitchContact (find-or-create contact by email, link identity)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `collectEvent` service + `parseCollectBody`

**Files:**
- Create: `lib/attribution/collect.ts`
- Test: `test/collect.test.ts`

**Interfaces:**
- Consumes: `identify`, `stitchContact` (Task 3) from `./identity`; `recordTouchpoint`, `recordConversion` from `./ingest`; `schema.campaigns`.
- Produces:
  - `CollectPayload` (interface, fields below) and `CollectType`.
  - `collectEvent(db, orgId, payload: CollectPayload): Promise<{ identityId: string }>` — assumes an **org-scoped** db; identifies the visitor by `anonymousId`, then dispatches `page`/`track`/`identify`.
  - `parseCollectBody(raw: string): CollectPayload` — tolerant JSON parse (returns `{}` on failure), used by the route for both JSON and `text/plain` sendBeacon bodies.

- [ ] **Step 1: Write the failing test**

Create `test/collect.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb, seedOrg, type TestDB } from "./helpers";
import * as schema from "@/db/schema";
import { uuid, publicId } from "@/lib/ids";
import { collectEvent, parseCollectBody } from "@/lib/attribution/collect";

let db: TestDB;
beforeEach(async () => { db = await makeTestDb(); });

describe("parseCollectBody", () => {
  it("parses JSON and returns {} on garbage", () => {
    expect(parseCollectBody('{"type":"page","anonymousId":"a"}')).toMatchObject({ type: "page", anonymousId: "a" });
    expect(parseCollectBody("not json")).toEqual({});
  });
});

describe("collectEvent", () => {
  it("page records a web touchpoint with utm + matched campaign", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const campId = uuid();
    await db.insert(schema.campaigns).values({ id: campId, publicId: publicId("camp"), orgId, profileId, name: "C", objective: "o", status: "planning" });
    const { identityId } = await collectEvent(db as any, orgId, {
      type: "page", anonymousId: "a1", url: "https://site/x", referrer: "https://google.com",
      utm: { utm_source: "x" }, campaignId: campId,
    });
    const tps = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId));
    expect(tps).toHaveLength(1);
    expect(tps[0].channel).toBe("web");
    expect(tps[0].campaignId).toBe(campId);
    expect(JSON.parse(tps[0].utm)).toMatchObject({ utm_source: "x", referrer: "https://google.com" });
  });

  it("page with an unknown campaignId stores null campaign", async () => {
    const { orgId } = await seedOrg(db);
    const { identityId } = await collectEvent(db as any, orgId, { type: "page", anonymousId: "a2", campaignId: "ghost" });
    const [tp] = await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId));
    expect(tp.campaignId).toBeNull();
  });

  it("track records a conversion with valueCents", async () => {
    const { orgId } = await seedOrg(db);
    const { identityId } = await collectEvent(db as any, orgId, { type: "track", anonymousId: "a3", event: "signup", valueCents: 5000 });
    const [c] = await db.select().from(schema.conversions).where(eq(schema.conversions.identityId, identityId));
    expect(c.eventName).toBe("signup");
    expect(c.valueCents).toBe(5000);
  });

  it("identify stitches a contact and records no event", async () => {
    const { orgId } = await seedOrg(db);
    const { identityId } = await collectEvent(db as any, orgId, { type: "identify", anonymousId: "a4", email: "z@z.com" });
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, identityId));
    expect(identity.contactId).toBeTruthy();
    expect(await db.select().from(schema.touchpoints).where(eq(schema.touchpoints.identityId, identityId))).toHaveLength(0);
    expect(await db.select().from(schema.conversions).where(eq(schema.conversions.identityId, identityId))).toHaveLength(0);
  });

  it("reuses one identity across calls with the same anonymousId", async () => {
    const { orgId } = await seedOrg(db);
    const r1 = await collectEvent(db as any, orgId, { type: "page", anonymousId: "same" });
    const r2 = await collectEvent(db as any, orgId, { type: "track", anonymousId: "same", event: "x" });
    expect(r2.identityId).toBe(r1.identityId);
  });

  it("400s on missing anonymousId, unknown type, and track without event", async () => {
    const { orgId } = await seedOrg(db);
    await expect(collectEvent(db as any, orgId, { type: "page" })).rejects.toMatchObject({ status: 400 });
    await expect(collectEvent(db as any, orgId, { type: "nope", anonymousId: "a" } as any)).rejects.toMatchObject({ status: 400 });
    await expect(collectEvent(db as any, orgId, { type: "track", anonymousId: "a" })).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- collect`
Expected: FAIL — module `@/lib/attribution/collect` not found.

- [ ] **Step 3: Implement**

Create `lib/attribution/collect.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import { identify, stitchContact } from "./identity";
import { recordTouchpoint, recordConversion } from "./ingest";

export type CollectType = "page" | "track" | "identify";

export interface CollectPayload {
  writeKey?: string;
  anonymousId?: string;
  type?: string;
  // page
  url?: string;
  referrer?: string;
  utm?: Record<string, unknown>;
  campaignId?: string;
  // track
  event?: string;
  valueCents?: number;
  metadata?: Record<string, unknown>;
  // identify
  email?: string;
  contactId?: string;
  traits?: Record<string, unknown>;
}

// Tolerant body parse: JSON for both application/json and text/plain (sendBeacon) bodies.
export function parseCollectBody(raw: string): CollectPayload {
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === "object") ? (v as CollectPayload) : {};
  } catch {
    return {};
  }
}

async function resolveCampaignId(db: DB, orgId: string, campaignId?: string): Promise<string | null> {
  if (!campaignId) return null;
  const [c] = await db.select().from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)));
  return c?.id ?? null;
}

// Assumes an org-scoped db. Identifies the visitor by anonymousId then dispatches the event.
export async function collectEvent(db: DB, orgId: string, payload: CollectPayload): Promise<{ identityId: string }> {
  if (!payload.anonymousId) throw new ApiError(400, "invalid_request", "anonymousId required");
  const type = payload.type;
  if (type !== "page" && type !== "track" && type !== "identify") {
    throw new ApiError(400, "invalid_request", "type must be page, track, or identify");
  }

  const identityId = await identify(db, orgId, { anonymousId: payload.anonymousId });

  if (type === "page") {
    const campaignId = await resolveCampaignId(db, orgId, payload.campaignId);
    const utm = { ...(payload.utm ?? {}), ...(payload.referrer ? { referrer: payload.referrer } : {}) };
    await recordTouchpoint(db, orgId, {
      identityId, channel: "web", platform: null, sourceType: "pixel",
      sourceId: payload.url ?? null, campaignId, utm,
    });
  } else if (type === "track") {
    if (!payload.event) throw new ApiError(400, "invalid_request", "event required for track");
    await recordConversion(db, orgId, {
      identityId, eventName: payload.event, valueCents: payload.valueCents, metadata: payload.metadata,
    });
  } else {
    await stitchContact(db, orgId, { identityId, email: payload.email, contactId: payload.contactId, traits: payload.traits });
  }

  return { identityId };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- collect`  → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/attribution/collect.ts test/collect.test.ts
git commit -m "feat(attribution): collectEvent service (page/track/identify) + parseCollectBody

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Public `POST /api/v1/collect` route (+ CORS, rate limit, OpenAPI)

**Files:**
- Create: `app/api/v1/collect/route.ts`
- Modify: `lib/openapi/spec.ts` (document `/collect`)
- Test: `test/collect-route.test.ts`

**Interfaces:**
- Consumes: `db`, `withOrg` from `@/db/client`; `resolveWriteKeyOrg` (Task 2); `collectEvent`, `parseCollectBody` (Task 4); `assertRateLimit`, `__resetRateLimits` from `@/lib/ratelimit`; `toProblemResponse`, `ApiError`.
- Produces: route handlers `POST` and `OPTIONS`; exported `CORS_HEADERS` and `withCors(res)` for testing.

- [ ] **Step 1: Write the failing test**

Create `test/collect-route.test.ts` (these exercise the non-DB parts — OPTIONS + the CORS helper — which need no app db):

```ts
import { describe, it, expect } from "vitest";
import { OPTIONS, withCors, CORS_HEADERS } from "@/app/api/v1/collect/route";

describe("collect route CORS", () => {
  it("OPTIONS returns 204 with permissive CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("withCors stamps CORS headers onto any response", () => {
    const res = withCors(new Response("x", { status: 500 }));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toBe("content-type");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- collect-route`
Expected: FAIL — module `@/app/api/v1/collect/route` not found.

- [ ] **Step 3: Implement the route**

Create `app/api/v1/collect/route.ts`:

```ts
import { db, withOrg } from "@/db/client";
import { ApiError, toProblemResponse } from "@/lib/errors";
import { assertRateLimit } from "@/lib/ratelimit";
import { resolveWriteKeyOrg } from "@/lib/apikey";
import { collectEvent, parseCollectBody } from "@/lib/attribution/collect";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS(): Promise<Response> {
  return withCors(new Response(null, { status: 204 }));
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local").trim();
    const raw = await req.text();
    const payload = parseCollectBody(raw);
    const writeKey = payload.writeKey ?? "";
    // Throttle per write key + IP before doing any DB work.
    assertRateLimit(`collect:${writeKey}:${ip}`, 120, 60_000);
    const orgId = await resolveWriteKeyOrg(db, writeKey);
    if (!orgId) throw new ApiError(401, "invalid_write_key", "Unknown or missing write key");
    const result = await withOrg(orgId, (sdb) => collectEvent(sdb, orgId, payload));
    return withCors(new Response(JSON.stringify({ ok: true, identityId: result.identityId }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  } catch (e) {
    return withCors(toProblemResponse(e));
  }
}
```

- [ ] **Step 4: Document `/collect` in the OpenAPI spec**

In `lib/openapi/spec.ts`, add to the `paths` object (after `/campaigns/...`). `security: []` marks it public:

```ts
    "/collect": {
      post: {
        summary: "Public pixel ingest (page/track/identify) — auth via body writeKey, not bearer",
        security: [],
        requestBody: jsonBody({ writeKey: { type: "string" }, anonymousId: { type: "string" }, type: { type: "string" } }, ["writeKey", "anonymousId", "type"]),
        responses: resp(),
      },
      options: { summary: "CORS preflight", security: [], responses: resp() },
    },
```

- [ ] **Step 5: Run the tests + drift guard**

Run: `npm test -- collect-route`  → PASS.
Run: `npm test -- openapi`  → PASS (drift guard: `/collect` now documented).
Run: `npm test`  → all green.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/collect/route.ts lib/openapi/spec.ts test/collect-route.test.ts
git commit -m "feat(attribution): public POST /v1/collect (CORS + write-key + rate limit) + OpenAPI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `pixel.js` served script

**Files:**
- Create: `app/pixel.js/route.ts`
- Test: `test/pixel-js.test.ts`

**Interfaces:**
- Produces: `GET` handler returning the pixel client as `text/javascript`; exported `PIXEL_SCRIPT` string for assertions.

- [ ] **Step 1: Write the failing test**

Create `test/pixel-js.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GET, PIXEL_SCRIPT } from "@/app/pixel.js/route";

describe("pixel.js", () => {
  it("serves JavaScript with the expected client surface", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("/api/v1/collect");
    expect(body).toContain("data-write-key");
    expect(body).toContain("navigator.sendBeacon");
    expect(body).toContain("track");
    expect(body).toContain("identify");
    expect(body).toContain("form_submit");
  });

  it("PIXEL_SCRIPT is the served body", async () => {
    const res = await GET();
    expect(await res.text()).toBe(PIXEL_SCRIPT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pixel-js`
Expected: FAIL — module `@/app/pixel.js/route` not found.

- [ ] **Step 3: Implement**

Create `app/pixel.js/route.ts`:

```ts
export const PIXEL_SCRIPT = `(function () {
  var scriptEl = document.currentScript || (function () { var s = document.getElementsByTagName("script"); return s[s.length - 1]; })();
  var writeKey = scriptEl && scriptEl.getAttribute("data-write-key");
  var origin = "";
  try { origin = new URL(scriptEl.src).origin; } catch (e) { origin = ""; }
  var endpoint = origin + "/api/v1/collect";
  if (!writeKey) return;

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16);
    });
  }
  function aid() {
    try {
      var k = "_los_aid", v = localStorage.getItem(k);
      if (!v) { v = uuid(); localStorage.setItem(k, v); }
      return v;
    } catch (e) {
      var m = document.cookie.match(/(?:^|; )_los_aid=([^;]+)/);
      if (m) return m[1];
      var nv = uuid(); document.cookie = "_los_aid=" + nv + "; path=/; max-age=31536000"; return nv;
    }
  }
  function send(body) {
    body.writeKey = writeKey; body.anonymousId = aid();
    var json = JSON.stringify(body);
    try { if (navigator.sendBeacon) { navigator.sendBeacon(endpoint, json); return; } } catch (e) {}
    try { fetch(endpoint, { method: "POST", body: json, keepalive: true, headers: { "content-type": "text/plain" } }); } catch (e) {}
  }
  function utmFrom(search) {
    var utm = {}, q = new URLSearchParams(search);
    q.forEach(function (val, key) { if (key.indexOf("utm_") === 0) utm[key] = val; });
    return utm;
  }
  function page() {
    var q = new URLSearchParams(location.search);
    send({ type: "page", url: location.href, referrer: document.referrer || "", utm: utmFrom(location.search), campaignId: q.get("los_campaign") || q.get("utm_campaign") || undefined });
  }
  function track(event, valueCents, metadata) { send({ type: "track", event: event, valueCents: valueCents, metadata: metadata || {} }); }
  function identify(arg, traits) {
    var body = { type: "identify", traits: traits || {} };
    if (typeof arg === "string") body.email = arg;
    else if (arg) { body.email = arg.email; body.contactId = arg.contactId; if (arg.traits) body.traits = arg.traits; }
    send(body);
  }
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM" || f.hasAttribute("data-los-ignore")) return;
    track("form_submit", undefined, { id: f.id || "", name: f.getAttribute("name") || "", action: f.getAttribute("action") || "" });
    var email = f.querySelector("input[type=email]");
    if (email && email.value) identify(email.value);
  }, true);

  var existing = window.launchos && window.launchos.q;
  window.launchos = { track: track, identify: identify, page: page };
  if (existing && existing.length) { existing.forEach(function (a) { var m = a.shift(); if (window.launchos[m]) window.launchos[m].apply(null, a); }); }
  page();
})();`;

export async function GET(): Promise<Response> {
  return new Response(PIXEL_SCRIPT, {
    status: 200,
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- pixel-js`  → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/pixel.js/route.ts test/pixel-js.test.ts
git commit -m "feat(attribution): pixel.js client served at /pixel.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Settings UI — write key + embed snippet

**Files:**
- Modify: `app/(app)/settings/connections/page.tsx`

**Interfaces:**
- Consumes: `schema.organizations.writeKey` (Task 1); reads the org row inside `ctx.withOrg`.
- Produces: a "Tracking pixel" section showing the org's `pk_` key and the copy-paste snippet. Server component; verified by `npm run build`.

- [ ] **Step 1: Add the org read + snippet section**

Edit `app/(app)/settings/connections/page.tsx`. Add `org` to the `withOrg` load and render a section. Replace the data-load and the returned JSX as follows (keeping the existing accounts/contacts sections):

```tsx
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const ctx = await getOrgContextOrRedirect();
  const { accounts, contacts, org } = await ctx.withOrg(async (db) => ({
    accounts: await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, ctx.orgId)),
    contacts: await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, ctx.orgId)).limit(20),
    org: (await db.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)))[0],
  }));
  const snippet = `<script async src="/pixel.js" data-write-key="${org?.writeKey ?? ""}"></script>`;
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Connections</h1>

      <section className="mb-8 rounded-lg border bg-white p-4">
        <h2 className="mb-1 text-lg font-semibold">Tracking pixel</h2>
        <p className="mb-2 text-sm text-neutral-500">Embed this on your site to attribute visits and conversions. Then call <code>launchos.track("signup")</code> or <code>launchos.identify(email)</code>.</p>
        <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">{snippet}</pre>
        <p className="mt-2 text-xs text-neutral-400">Write key: <code>{org?.writeKey}</code> (publishable — safe to expose).</p>
      </section>

      <div className="mb-8 grid grid-cols-3 gap-4">
        {accounts.map((a) => (
          <div key={a.id} className="rounded-lg border bg-white p-4">
            <div className="font-medium">{a.platform}</div>
            <div className="text-sm text-neutral-500">{a.username}</div>
            <div className="mt-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs">{a.status}</div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 text-lg font-semibold">Contacts</h2>
      <ul className="text-sm">
        {contacts.map((c) => (
          <li key={c.id}><a className="underline" href={`/contacts/${c.id}`}>{c.name} · {c.email}</a></li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Verify build + suite**

Run: `npm run build`  → succeeds (no type errors).
Run: `npm test`  → all green.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/settings/connections/page.tsx"
git commit -m "feat(attribution): show pixel write key + embed snippet on Connections

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end attribution-loop test

**Files:**
- Test: `test/collect.test.ts` (add an end-to-end describe block)

**Interfaces:**
- Consumes: `collectEvent` (Task 4), `resolveWriteKeyOrg` (Task 2), `buildReport` from `@/lib/attribution/report`, `campaignResults` from `@/lib/campaign/service`, `contactTimeline` from `@/lib/journey/timeline`.

- [ ] **Step 1: Write the end-to-end test**

Append to `test/collect.test.ts` (extend its imports with: `import { resolveWriteKeyOrg } from "@/lib/apikey"; import { buildReport } from "@/lib/attribution/report"; import { campaignResults } from "@/lib/campaign/service"; import { contactTimeline } from "@/lib/journey/timeline";`):

```ts
describe("attribution loop end-to-end", () => {
  it("write key → page(campaign) → identify → track → report + campaign results + timeline", async () => {
    const { orgId, profileId } = await seedOrg(db);
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));

    // The pixel resolves the org purely from the write key.
    const resolved = await resolveWriteKeyOrg(db as any, org.writeKey);
    expect(resolved).toBe(orgId);

    const campId = uuid();
    await db.insert(schema.campaigns).values({ id: campId, publicId: publicId("camp"), orgId, profileId, name: "Launch", objective: "signups", status: "active" });

    await collectEvent(db as any, orgId, { type: "page", anonymousId: "v1", url: "https://site/lp", campaignId: campId, utm: { utm_source: "twitter" } });
    await collectEvent(db as any, orgId, { type: "identify", anonymousId: "v1", email: "buyer@example.com" });
    await collectEvent(db as any, orgId, { type: "track", anonymousId: "v1", event: "signup", valueCents: 5000 });

    // Channel report credits the web channel.
    const report = await buildReport(db as any, orgId, "linear");
    expect(report.channels.map((c) => c.channel)).toContain("web");

    // Campaign-scoped results reflect the conversion through the campaign touchpoint.
    const camp = await campaignResults(db as any, orgId, campId, "linear");
    expect(camp.totalConversions).toBeGreaterThan(0);
    expect(camp.channels.map((c) => c.channel)).toContain("web");

    // Contact timeline shows the pageview then the signup, in order.
    const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.anonymousId, "v1"));
    const tl = await contactTimeline(db as any, orgId, identity.contactId!);
    expect(tl.map((e) => e.kind)).toEqual(["touchpoint", "conversion"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm test -- collect`  → PASS (the loop is wired through already-built pieces).
Expected note: if it fails, do NOT weaken the assertions — diagnose which leg of the loop broke and fix the underlying task's code.

- [ ] **Step 3: Commit**

```bash
git add test/collect.test.ts
git commit -m "test(attribution): end-to-end pixel loop (report + campaign results + timeline)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Docs sync

**Files:**
- Modify: `docs/IMPLEMENTATION-ROADMAP.md` (mark §5.4 done + P2 row)
- Modify: `API_MAP.md` (add `/collect`)
- Modify: `DEVELOPER_GUIDE.md` (short "embed the pixel" note)

**Interfaces:** docs only; no test.

- [ ] **Step 1: Update the roadmap**

In `docs/IMPLEMENTATION-ROADMAP.md`:
- In the P2 row of the phase table (~line 64), move `attribution pixel` from the not-started (⬜) list into the done (✅) items, matching how Campaign Brain / Viral Generator are shown.
- In §5.4, change the heading marker `⬜` → `✅` and add a `**Status:** done 2026-06-18. Spec: \`docs/superpowers/specs/2026-06-18-attribution-pixel-design.md\`; plan: \`docs/superpowers/plans/2026-06-18-attribution-pixel.md\`.` line, mirroring §5.2/§5.3 format.

- [ ] **Step 2: Update API_MAP.md**

Read `API_MAP.md`; add a row for `POST /api/v1/collect` (public pixel ingest; auth via body write key) in the same format the file uses for other routes. Note it is the one unauthenticated `/v1` endpoint.

- [ ] **Step 3: Add a short pixel note to DEVELOPER_GUIDE.md**

Read `DEVELOPER_GUIDE.md`; add a brief subsection near any attribution/analytics content: how to embed `<script async src="/pixel.js" data-write-key="pk_…">`, that the key is on `/settings/connections`, and the `launchos.track` / `launchos.identify` API. Keep it to ~8 lines. If no natural section exists, add a top-level "Attribution pixel" subsection.

- [ ] **Step 4: Final verification**

Run: `npm test`  → all green.
Run: `npm run build`  → succeeds.

- [ ] **Step 5: Commit**

```bash
git add docs/IMPLEMENTATION-ROADMAP.md API_MAP.md DEVELOPER_GUIDE.md
git commit -m "docs(attribution): mark P2.4 pixel done; map /collect; pixel embed guide

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Write key on `organizations` (unhashed, unique-via-index-after-backfill) → Task 1.
- `resolveWriteKeyOrg` → Task 2.
- Identity stitching hardening (find-or-create contact by email, link, cross-device merge) → Task 3.
- `collect` service: page→web touchpoint (utm/referrer/campaign match), track→conversion, identify→stitch; validation → Task 4.
- Public `POST /api/v1/collect`: CORS, rate limit, write-key auth, sendBeacon/text body, problem+json, OpenAPI → Task 5.
- `pixel.js`: anon id, auto pageview + utm/referrer, `track`/`identify`, form auto-capture, pre-init queue → Task 6.
- Settings UI snippet + key → Task 7.
- End-to-end loop (report + campaign results + timeline) → Task 8.
- Docs → Task 9.
- Migration (backfill + unique index, gen_random_uuid) → Task 1 Steps 5–6.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". `00XX`/`00YY` are explicitly "use the number db:generate assigns"; `pk_…` in docs/snippets is literal illustrative key text. Every code step has complete code.

**3. Type consistency:** `generateWriteKey(): string`, `resolveWriteKeyOrg(db, writeKey): Promise<string|null>`, `stitchContact(db, orgId, StitchInput): Promise<string|null>`, `collectEvent(db, orgId, CollectPayload): Promise<{identityId}>`, `parseCollectBody(raw): CollectPayload`, `withCors`/`CORS_HEADERS`/`OPTIONS`/`POST`, `PIXEL_SCRIPT`/`GET` — names are used identically across tasks and tests. Channel string is `"web"` everywhere. Anonymous-id key `_los_aid` and campaign param `los_campaign`/`utm_campaign` consistent between pixel (Task 6) and service (Task 4). The route reads `req.headers` (not `next/headers`) so its non-DB parts are unit-testable per the Global Constraints note.

One cross-task note resolved inline: the route (Task 5) is intentionally thin and its DB path (resolve → withOrg → collectEvent) is exercised by Task 4's service tests + Task 8's end-to-end test rather than a route-against-DB test, because route handlers import the app `db` (not the test PGlite). OPTIONS, `withCors`, and `parseCollectBody` are unit-tested directly.
