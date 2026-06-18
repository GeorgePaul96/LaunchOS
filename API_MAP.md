# API_MAP.md — LaunchOS

All endpoints live in `app/api/v1/**/route.ts`. Source of truth for consumers is the OpenAPI 3.1
doc at `GET /api/v1/openapi.json` (hand-authored in `lib/openapi/spec.ts`). **Adding a route without
adding it to `lib/openapi/spec.ts` breaks `test/openapi.test.ts` (drift guard).**

## Auth
Two ways to authenticate, both resolved by `requireContext()` (`lib/request.ts`):
- **Session cookie** — browser UI, set by `/v1/auth/*`.
- **`Authorization: Bearer sk_…`** — programmatic (SDK/MCP/curl). Mint with `npm run apikey`.

Responses: success via `ok(body, status)`; errors via thrown `ApiError` → `toProblemResponse()` →
`application/problem+json` (RFC-9457: `type/title/status/detail/code/request_id`).

## Endpoints
| Method | Path | Handler dir | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | `auth/signup` | create org+user, set session |
| POST | `/api/v1/auth/login` | `auth/login` | start session (rate-limited) |
| POST | `/api/v1/auth/logout` | `auth/logout` | clear session |
| GET | `/api/v1/accounts` | `accounts` | list connected social accounts |
| GET/POST | `/api/v1/posts` | `posts` | list / create+queue a post (202) |
| POST | `/api/v1/posts/{id}/retry` | `posts/[id]/retry` | retry failed targets |
| POST | `/api/v1/content/generate` | `content/generate` | generate scored variants (201) |
| GET | `/api/v1/content/generations` | `content/generations` | list generations + variants |
| POST | `/api/v1/content/variants/{id}/choose` | `content/variants/[id]/choose` | mark a variant chosen |
| GET/POST | `/api/v1/campaigns` | `campaigns` | list / create a campaign (201) |
| GET | `/api/v1/campaigns/{id}` | `campaigns/[id]` | get campaign + assets |
| POST | `/api/v1/campaigns/{id}/plan` | `campaigns/[id]/plan` | generate (or re-generate) the AI plan |
| POST | `/api/v1/campaigns/{id}/approve` | `campaigns/[id]/approve` | approve plan → materialize draft posts |
| GET | `/api/v1/campaigns/{id}/results` | `campaigns/[id]/results` | campaign-scoped attribution results |
| POST | `/api/v1/attribution/identify` | `attribution/identify` | identify / stitch identity |
| POST | `/api/v1/attribution/touchpoints` | `attribution/touchpoints` | record a touchpoint (201) |
| POST | `/api/v1/attribution/conversions` | `attribution/conversions` | record a conversion (201) |
| GET | `/api/v1/attribution/report` | `attribution/report` | channel attribution (model=first/last/linear) |
| GET | `/api/v1/journeys/contacts/{cid}/timeline` | `journeys/contacts/[cid]/timeline` | contact journey |
| POST | `/api/v1/api-keys` | `api-keys` | mint an API key (201) |
| GET | `/api/v1/openapi.json` | `openapi.json` | the OpenAPI contract (undocumented in itself) |

`/auth/*` and `/openapi.json` are intentionally excluded from the drift guard (`lib/openapi/paths.ts`).

## Route handler pattern (copy this)
```ts
export async function POST(req: Request) {
  try {
    const ctx = await requireContext();                 // cookie OR Bearer
    const body = await req.json();
    if (!body.x) throw new ApiError(400, "invalid_request", "x required");
    const out = await ctx.withOrg(async (db) => {        // RLS-scoped tx
      const r = await someService(db, ctx.orgId, body);
      await recordAudit(db, { orgId: ctx.orgId, actorType: "user", actorId: ctx.userId || undefined, action: "x.create", targetType: "x", targetId: r.publicId });
      return r;
    });
    return ok(out, 201);
  } catch (e) { return toProblemResponse(e); }
}
```
Dynamic params (Next 16): `({ params }: { params: Promise<{ id: string }> })` then `const { id } = await params;`.

## Mirrors of the HTTP API
- **SDK:** `lib/sdk/client.ts` — `accounts`, `posts`, `attribution`, `journeys`, `apiKeys`, `content` resources.
- **MCP tools** (`mcp/tools.ts`): `list_accounts`, `list_posts`, `create_post`, `attribution_report`, `contact_journey`, `record_touchpoint`, `record_conversion`, `generate_content`.
Keep route ↔ OpenAPI ↔ SDK ↔ MCP in sync when adding endpoints.
