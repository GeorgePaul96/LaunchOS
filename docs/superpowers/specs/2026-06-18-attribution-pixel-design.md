# Attribution Pixel + Journey Hardening — Design

**Date:** 2026-06-18
**Phase:** P2 (MVP completion) — §5.4, third sub-project after the Viral Generator and Campaign Brain
**Status:** Approved

## 1. Purpose & Scope

Ship an embeddable `pixel.js` that any external website embeds with a one-line snippet, plus a
public, CORS-enabled, write-key-authed ingest endpoint that records touchpoints and conversions
from untrusted browsers. This closes the attribution loop end-to-end: a click on a published post
→ a pageview on the site → a signup reconciles in the existing channel revenue report and contact
journey. It is the change that meets the spec MVP metric: time-to-first-attributed-signup.

### In scope

- **Auto pageview touchpoints.** `pixel.js` generates/stores an anonymous id, captures `utm_*`
  params + referrer on load, and POSTs a pageview touchpoint automatically.
- **JS API.** `window.launchos.track(event, valueCents?, metadata?)` records conversions;
  `window.launchos.identify(emailOrObject, traits?)` links the anonymous visitor to a known contact.
- **Identity stitching hardening.** `identify` finds-or-creates a contact by email and links the
  visitor's identity to it, so multiple devices (multiple anonymous ids) collapse to one contact
  and prior anonymous touchpoints are credited to that contact.
- **Form-submit auto-capture.** `pixel.js` auto-binds host-page `<form>` submits → a touchpoint /
  conversion (host-page forms only; the landing-page + hosted form builder is the P4 system).

### Architecture (one paragraph)

One publishable write key (`pk_…`) per org, stored on `organizations`. One batched public endpoint
`POST /api/v1/collect` handles `type: page | track | identify`. The browser knows only its
`anonymousId`; the server resolves/creates the identity and (on identify) the contact. The existing
authenticated `/api/v1/attribution/*` routes are untouched and remain for server-to-server use.

### Out of scope (deferred)

- Landing pages / hosted form builder (P4 — §7.3).
- Server-side bot filtering beyond rate limiting.
- Consent / GDPR banners and cookie management UI.
- Multiple sites / keys per org with origin allowlists (P5 enterprise).
- Attribution model changes (time-decay / data-driven is P4 — §7.6).

## 2. Data Model

No new tables. Reuse `identities`, `touchpoints`, `conversions`, `contacts`. One new column + a
backfill.

### Change to `organizations`
- Add `write_key` — `text NOT NULL DEFAULT ''`. Holds a publishable `pk_…` key, safe to expose in
  client JS. **Not hashed** (unlike `sk_` API keys, which are stored SHA-256) — it is publishable by
  design, like a Segment write key or Stripe publishable key. It authorizes only the write-only
  `/collect` endpoint; it can never read data or call authenticated routes.
- **Uniqueness is enforced by an index added *after* backfill, not by the column declaration.** The
  Drizzle schema column is declared **without** `.unique()`. Reason: adding a `NOT NULL DEFAULT ''`
  column to a table with multiple existing orgs sets every row to `''` at once; a unique constraint
  declared on the column would fail immediately on the second row. So the generated migration adds
  the plain column, the follow-up migration backfills distinct keys, and only then creates
  `CREATE UNIQUE INDEX organizations_write_key_unique`. All org-creation paths (signup, seed) set a
  real key, so `''` never recurs after backfill and the index holds.

### Reused tables (no change)
- `identities` — resolved/created by `(orgId, anonymousId)` via the existing `identify()` /
  `resolveIdentity()`.
- `touchpoints` — `channel`, `platform`, `sourceType`, `sourceId`, `utm`, `campaignId`. The
  campaign id comes from a `los_campaign` (or `utm_campaign`) param and is stored on the touchpoint
  only when it matches a real `campaigns.id` in the org; otherwise it is preserved in the `utm` JSON.
- `conversions` — `eventName`, `valueCents`.
- `contacts` — find-or-create by `(orgId, normalized email)`; link via `identities.contactId` (and
  set `contacts.identityId` to the first identity). The existing `contactTimeline` already fans in
  all identities by `contactId`, so cross-device merge works with no timeline change.

## 3. Public Ingest — `POST /api/v1/collect`

A dedicated public endpoint — **no `requireContext()`**; the credential is the write key in the body.

### Request
JSON (also accepts `text/plain` bodies, since `navigator.sendBeacon` sends `text/plain`):
```
{ writeKey: "pk_…", anonymousId: "…", type: "page" | "track" | "identify",
  // page:     url?, referrer?, utm?: {}, campaignId?
  // track:    event: string, valueCents?, metadata?: {}
  // identify: email?, contactId?, traits?: {} }
```

### Response
`{ ok: true, identityId }` (200), or RFC-9457 problem+json on error.

### Service — `lib/attribution/collect.ts`
`collect(db, writeKey, payload)`:
1. **Resolve org** via `resolveWriteKeyOrg(db, writeKey)` (new — see §3.1). 401 `invalid_write_key`
   if no match. Returns `orgId`. (Called on the base/service-role `db`, pre-org-context, exactly as
   `resolveApiKeyOrg` is.)
2. The route then runs steps 3–5 inside `withOrg(orgId, …)` so RLS + `org_id` filters apply.
3. **Identify** the visitor: find-or-create the identity by `anonymousId` (reuse `identify()`).
4. **Dispatch by `type`:**
   - `page` → `recordTouchpoint({ channel: "web", sourceType: "pixel", sourceId: url, platform:
     null, utm, campaignId })` (campaignId resolved as in §2).
   - `track` → `recordConversion({ eventName: event, valueCents })`.
   - `identify` → `stitchContact(...)` (§5) only; records no touchpoint/conversion.
5. Validation: missing `anonymousId` or `type` → `ApiError(400, "invalid_request", …)`; `track`
   without `event` → 400; unknown `type` → 400.

Returns `{ identityId }`.

### 3.1 Write-key resolution
`resolveWriteKeyOrg(db, writeKey): Promise<string | null>` (in `lib/apikey.ts`, beside
`resolveApiKeyOrg`):
- Returns null if `writeKey` is empty or does not start with `pk_`.
- Plaintext lookup of `organizations.write_key`; returns the `orgId` or null.

### Route — `app/api/v1/collect/route.ts`
- `OPTIONS` returns a CORS preflight response; `POST` does the work. Both set
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`,
  `Access-Control-Allow-Headers: content-type`. Open CORS is correct: pixels run on arbitrary
  origins, and the write key is the only credential — write-only by construction.
- **Rate limit** via the existing `assertRateLimit`, keyed on `writeKey + client IP`
  (120 requests / 60 s) → 429 with `Retry-After`. Client IP from `x-forwarded-for` (first hop) or a
  fallback constant.
- Reads the body tolerantly: `await req.json()` with a `.catch` that falls back to parsing
  `await req.text()` as JSON (for `sendBeacon` `text/plain`), then `{}` on failure → 400 via
  validation.
- Errors via `toProblemResponse`; success via `ok()`. **CORS headers are added to every response**,
  including errors (a helper wraps the Response).
- Documented in `lib/openapi/spec.ts` so the drift guard (`test/openapi.test.ts`) stays green, with
  a note that it authenticates via a body write key, not bearer auth.

## 4. `pixel.js` — served script + client behavior

### Served by a route handler
`app/pixel.js/route.ts` — `GET` returns the script with `Content-Type: text/javascript` and
cache-friendly headers. A route (not a static `public/` file) so the body is unit-testable and the
ingest origin could later be templated; for v1 it returns a static script body.

### Embed snippet (shown in `/settings/connections` with the org's key)
```html
<script async src="https://APP_ORIGIN/pixel.js" data-write-key="pk_…"></script>
```

### Client behavior (vanilla, dependency-free IIFE, ~120 lines)
- Reads `data-write-key` from its own `<script>` tag; derives the ingest origin from the script
  `src`.
- **Anonymous id:** read/generate a UUID in `localStorage` under `_los_aid`, with a cookie
  fallback; reused across visits.
- **Auto pageview:** on load, parse `location.search` for `utm_*` params (+ `los_campaign`) and read
  `document.referrer`, then send `{ type: "page", url, referrer, utm, campaignId }` via
  `navigator.sendBeacon` (fallback `fetch(url, { method: "POST", keepalive: true })`).
- **`window.launchos.track(event, valueCents?, metadata?)`** → `{ type: "track", … }`.
- **`window.launchos.identify(emailOrObject, traits?)`** → `{ type: "identify", … }`; accepts a bare
  email string or `{ email, contactId, traits }`. Records that it identified so it is not re-sent
  needlessly within a session.
- **Form auto-capture:** one delegated `submit` listener on `document`. On any `<form>` submit, send
  `{ type: "track", event: "form_submit", metadata: { id, name, action } }`. If the form has an
  `input[type=email]`, also `identify` with that email. A form with `data-los-ignore` is skipped.
- All network calls swallow errors (never break the host page). A `window.launchos.q` array buffers
  calls made before the script finishes initializing, drained on init.

Clear interface: embed the snippet → pageviews flow automatically; call `track` / `identify` for
conversions and known users.

## 5. Identity Stitching Hardening

Today `identify()` only patches `identities.contactId` when a `contactId` is passed in — but the
pixel sends an **email**. Add contact resolution.

### `lib/attribution/identity.ts` — `stitchContact`
`stitchContact(db, orgId, { identityId, email?, contactId?, traits? }): Promise<string | null>`:
1. If `contactId` is given and belongs to the org, use it. Else if `email` is given, find a contact
   by `(orgId, normalized email)`; if none exists, **create** one (`lifecycleStage: "lead"`, `name`
   from `traits.name` if present). Normalize email = `trim().toLowerCase()`.
2. Link both directions: set `identities.contactId = contact.id`; if `contacts.identityId` is null,
   set it to this identity (first-touch identity).
3. Merge `traits` into the identity's `traits` JSON (shallow).
4. Return the `contactId` (or null when neither email nor contactId was provided — a no-op stitch).

### Why this completes the loop
Two devices (two `anonymousId`s → two identities) that both `identify` with the same email receive
the same `contactId`. `contactTimeline` already fans in all identities by `contactId`, so the
journey and the channel report credit the unified person — no change to timeline or report code.

### Edge cases
- identify with neither email nor contactId → returns the identity, no stitch.
- email matching multiple contacts → pick the oldest (deterministic `order by created_at`).
- contactId from another org → ignored (org filter + RLS).

## 6. Testing (TDD)

- **`lib/attribution/collect`** (PGlite): `page` records a `web` touchpoint with utm/referrer and a
  matched `campaignId`; `track` records a conversion with `valueCents`; `identify` stitches a contact
  and records no touchpoint/conversion; unknown `type` → 400; missing `anonymousId` → 400; reusing an
  `anonymousId` across calls resolves to a single identity.
- **`resolveWriteKeyOrg`**: valid `pk_` → orgId; unknown / empty / `sk_`-prefixed → null; cross-org
  isolation (org A's key never resolves org B).
- **`stitchContact`**: find-or-create by email; two identities + same email → same `contactId` and
  `contactTimeline` merges both; contactId from another org ignored; neither email nor contactId →
  no-op; multi-match picks the oldest contact.
- **`/api/v1/collect` route**: `OPTIONS` returns CORS headers; `POST` page/track/identify happy paths
  return `{ ok, identityId }` with `Access-Control-Allow-Origin: *`; rate limit → 429 with
  `Retry-After` (using `__resetRateLimits` and an injectable window); 401 on bad/missing key;
  problem+json on 400. Drift guard stays green with `/collect` documented.
- **`pixel.js` route**: `GET` returns `text/javascript` and a non-empty body containing the
  `track` / `identify` / `collect` symbols and the `data-write-key` read (string assertions on the
  served text — no DOM execution).
- **End-to-end (PGlite)**: write key → `page` (with `los_campaign` matching a real campaign) →
  `identify(email)` → `track("signup", 5000)`; then `buildReport` credits the `web` channel and the
  campaign-scoped `campaignResults` reflects the conversion, and `contactTimeline` shows
  pageview → signup in order.
- The full existing suite stays green.

## 7. Migration

`db:generate` adds the plain `organizations.write_key` column (`NOT NULL DEFAULT ''`, **no** unique
constraint — see §2). A hand-written follow-up migration then, in order:
1. Backfills every existing org (including the seeded demo org) that still has `write_key = ''` with
   a generated `pk_` key.
2. Creates `CREATE UNIQUE INDEX organizations_write_key_unique ON organizations (write_key)` — safe
   only because step 1 has already given every row a distinct value.

The backfill must generate one key per existing row (a value SQL alone cannot produce per-row
portably), so it uses a `DO` block that loops over orgs with an empty key and sets
`write_key = 'pk_' || replace(gen_random_uuid()::text, '-', '')`. PGlite and Postgres 16 both
provide `gen_random_uuid()`.

`organizations` already has its RLS policy, and the new column needs no extra grant. The seed
(`npm run setup`) and the signup path set a `write_key` for newly created orgs (so `''` never recurs
after migration). No new table → no `test/helpers.ts` `ALL_TABLES` change.
