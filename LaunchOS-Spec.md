# LaunchOS — Full Product & Implementation Specification

> Reverse-engineering of Zernio (zernio.com, formerly getlate.dev) + a complete build spec for a superior product, **LaunchOS**.
> Companion file: `launchos_schema.sql` (runnable Postgres DDL — the canonical schema; this doc summarises and references it).
> Audience: a senior engineering team **or an AI coding agent**. Written to minimise assumptions.

---

## Read this first — the strategic reality (don't skip)

Two honest framing points before the spec, because they change how you should build:

**1. Zernio is an infrastructure company, not a UI company.** Its moat is 21 maintained platform integrations, hosted OAuth (so customers don't register dev apps), WhatsApp number provisioning with KYC in 50+ countries, auto-generated SDKs in 8 languages, a 300+ tool MCP server, and SOC 2. That is *years* of unglamorous integration and compliance work. "Build everything Zernio offers" literally means rebuilding all of that.

**2. Therefore the correct architecture for LaunchOS is build-on-top, not rebuild-underneath — at least until scale justifies otherwise.** LaunchOS's differentiation is the **intelligence and autonomy layer** (Campaign Brain, agents, attribution, competitor intel, experiments). None of that requires owning the platform integrations on day one. So:

- **Publishing/messaging/ads substrate:** wrap a unified provider (Zernio itself, Ayrshare, or Unipile) behind a `ChannelProvider` interface in MVP/V1. This buys you 21 integrations + hosted OAuth + WhatsApp KYC for a per-account fee instead of 18 months of work.
- **Swap to native integrations selectively in V2**, starting with the 4–5 platforms that drive most volume (Instagram, X, LinkedIn, TikTok, WhatsApp), where the per-account passthrough margin justifies owning the integration.

The schema, API, and agent layers below are written so this swap is invisible to everything above the provider interface. Where this changes a decision, it's flagged **[BUILD-VS-WRAP]**.

If you ignore this and try to build all 21 native integrations **and** all 12 new AI systems in one go, you will not ship. The MVP plan in §11 reflects the wrap-first path.

---

# PART 0 — ZERNIO REVERSE-ENGINEERING

## 0.1 What Zernio actually is

A **single REST API + MCP server** that lets developers and AI agents publish content, send/receive messages, run ads, and read analytics across **15 channels** (12 social, 3 messaging) with **6 ad networks**, without registering their own platform developer apps. It is explicitly **API-first** (no rich end-user dashboard is the product; the API is the product) and **white-label** (end users never see Zernio branding). Pricing is **per connected account**, not per seat or per post.

Tagline truth: *"Stop maintaining 21 integrations."* The whole value proposition is **integration arbitrage** — they eat the per-platform OAuth-app registration, approval, quota, and breakage pain, and resell it as one clean interface.

## 0.2 Page inventory (sitemap)

**Marketing site (`zernio.com`)**
- `/` home, `/pricing`, `/enterprise`, `/features`, `/about`, `/customers`, `/customers/{heymark,vibiz,...}` case studies, `/careers`, `/press`, `/rebrand`, `/open` (public live stats — posts/accounts this week), `/creators`, `/agents`, `/chat-sdk`, `/n8n-templates`, `/blog`, `/social-media-tips`
- Legal: `/tos`, `/privacy-policy`, `/content-guidelines`, `/legal-disclosure` (Impressum → German entity)
- Per-platform SEO landing pages: `/instagram`, `/x`, `/tiktok`, `/whatsapp`, `/linkedin`, `/facebook`, `/youtube`, `/threads`, `/reddit`, `/pinterest`, `/bluesky`, `/telegram`, `/snapchat`, `/googlebusiness`, `/discord`, and ads variants `/meta-ads`, `/google-ads`, `/linkedin-ads`, `/tiktok-ads`, `/pinterest-ads`, `/x-ads`
- Per-API landing pages: `/social-media-api` (posting), `/social-media-comments`, `/social-media-dms`, `/social-media-analytics`, `/social-media-ads`, `/comment-to-dm`
- Competitor comparison pages: `/alternatives/{buffer,ayrshare,blotato,publer,postiz,unipile,twilio}` + `/compare`
- Auth/app: `/signup`, `/dashboard/*` (API keys, accounts, billing, inbox — thin dashboard)

**Docs (`docs.zernio.com`, Fumadocs)**
- Quickstart, `/sdks`, `/cli`, `/mcp`, `/webhooks`, `/pricing`, `/changelog`, `/refer-and-earn`
- `/platforms/*` per-platform guides, `/api/openapi` (machine spec), `/llms.txt` + `/llms-full.txt` (LLM-readable docs)
- API reference grouped by resource: profiles, accounts, connect, posts, queue, analytics, media, inbox, contacts, broadcasts, sequences, automations, ads, webhooks, invites, api-keys

**Subdomains:** `mcp.zernio.com` (MCP server), `trust.zernio.com` (trust portal), `status.zernio.com` (status), `sst.zernio.com` (server-side GTM). External: `zernio.featurebase.app` (roadmap), `partners.dub.co/zernio` (affiliates).

## 0.3 API capability inventory

Base URL `https://zernio.com/api/v1`. Auth: `Authorization: Bearer sk_<64-hex>` (key stored as SHA-256, shown once). Data model is **Profiles → Accounts → Posts → Targets**, plus a messaging/CRM stack and an ads stack.

| Domain | Capabilities (verbs) |
|---|---|
| **Profiles** | list, get, create, update, delete (brand/project containers) |
| **Connect** | `GET /connect/{platform}?profileId=` → hosted OAuth URL; callback connects account |
| **Accounts** | list, get, health-check |
| **Posts** | create (draft / `scheduledFor` / `publishNow`), list, get, delete, retry; multi-account `platforms[]`; per-target overrides; threads, first-comment, carousels, video |
| **Queue** | recurring time-slot scheduling |
| **Media** | upload (image/video/gif), used by posts |
| **Analytics** | post performance, daily engagement, best-time-to-post |
| **Inbox** | conversations list/get, messages list/send (DMs); comments list / per-post / reply; reviews list / reply (FB, Google Business) |
| **Contacts** | CRM: list/create/get/update/delete, channels, custom fields (set/clear), bulk-create (≤1000) |
| **Broadcasts** | bulk messaging: create/list/get/update/delete, send, schedule, cancel, recipients add/list; WhatsApp templates |
| **Sequences** | drip: create/get/update/delete, steps, activate/pause, enroll/unenroll, enrollments |
| **Automations** | comment-to-DM: keyword trigger → auto-DM + auto comment-reply, logs |
| **WhatsApp** | purchase dedicated number (53 countries, KYC handled), inbox, calls, templates |
| **Ads** | boost post → paid ad; create/manage campaigns on 6 networks |
| **Webhooks** | endpoint settings; events for post status, messages, comments (HMAC, retries) |
| **Invites / API keys** | team invites; key CRUD |

Access surfaces: REST, 8 SDKs (Node/Python/Go/Ruby/Java/PHP/.NET/Rust — clearly **auto-generated from OpenAPI**, version ~0.0.307), a CLI (`@zernio/cli`, JSON-out, browser-login or key), and a **hosted MCP server** (300+ tools auto-generated from the same OpenAPI; OAuth or Bearer). No-code via n8n/Make/Zapier.

## 0.4 User flows

1. **Developer onboarding:** signup (Google OAuth) → create API key → `connect/{platform}` hosted OAuth → first `POST /posts` in <5 min. This 5-minute time-to-first-post is the core activation metric.
2. **Multi-brand agency:** one org → many Profiles → connect clients' accounts under each → schedule/queue per profile → unified inbox to reply → white-label so clients see the agency's brand.
3. **AI-agent operator:** point Claude/Cursor at `mcp.zernio.com/mcp` → "post this everywhere / run a WhatsApp broadcast / show my inbox" in natural language.
4. **WhatsApp product number:** one API call purchases a number; Zernio does KYC + provisioning; inbound calls free, outbound passed through at carrier cost.
5. **Engagement automation:** create comment-to-DM automation on a post → keyword in comments triggers auto-DM + reply.

## 0.5 Likely backend architecture

- **Next.js on Vercel** (confirmed: `_next/image`, `dpl_` deployment hashes, "infrastructure runs on Vercel with global edge distribution" in their FAQ). API is Next route handlers under `/api/v1/*`.
- **MongoDB** as primary store (the `_id` field convention throughout SDK examples; document-shaped per-platform payloads fit Mongo well). External IDs are prefixed (`prof_`, `acc_`, `post_`).
- **A durable job/queue system off the serverless request path** for the things serverless can't do well: scheduled publishing at exact times, retries with backoff, analytics polling, inbox sync, webhook fan-out, broadcast sends, sequence steppers. Almost certainly a queue (QStash/Upstash, SQS, or BullMQ-on-a-worker) + cron, because Vercel functions are short-lived. The retry-then-webhook behaviour ("auto-retry, then fire a webhook with the reason") confirms a real queue with a dead-letter path.
- **Per-platform adapter layer** normalising one internal post/message/ad model to each platform's API quirks. This is the crown jewels.
- **OpenAPI as source of truth** → generates SDKs (Stainless/Speakeasy-style) and the MCP tool list. One spec, many surfaces.
- **Token vault** for OAuth credentials, with refresh handling, kept separate from the public account record.
- **Encrypted secrets, SOC 2 controls, GDPR data-residency** (EU entity present).

## 0.6 Likely database schema (inferred Mongo collections)

`organizations`, `users`, `memberships`, `apiKeys` (hashed), `profiles`, `accounts` (+ embedded or separate `oauthTokens`), `posts` (with embedded `targets[]` per platform + status), `mediaAssets`, `queueSlots`, `analyticsSnapshots`, `conversations`, `messages`, `comments`, `reviews`, `contacts` (+ `channels[]`, `customFields{}`), `broadcasts` (+ `recipients[]`), `sequences` (+ `steps[]`, `enrollments`), `automations` (+ `logs`), `whatsappNumbers`, `adAccounts`, `adCampaigns`, `webhookEndpoints` (+ `deliveries`), `invites`, `usageRecords`. Posts almost certainly embed an array of per-target sub-docs (`{platform, accountId, status, platformPostId, error}`) — that's the natural Mongo shape and matches the API.

## 0.7 Likely third-party integrations

- **Hosting/CDN:** Vercel.
- **Billing:** Stripe (stated). Usage metering → Stripe metered/graduated pricing.
- **WhatsApp:** Meta WhatsApp Cloud API + a BSP/number-provisioning + carrier provider for dedicated numbers and outbound voice; KYC vendor.
- **Affiliates:** Dub (`partners.dub.co/zernio`).
- **Roadmap/feedback:** Featurebase.
- **Compliance:** a trust-portal/SOC-2 automation vendor (Vanta/Delve-class) at `trust.zernio.com`.
- **Status:** Instatus/BetterStack-class at `status.zernio.com`.
- **Analytics/marketing:** server-side GTM (`sst.`), Facebook Pixel.
- **Docs:** Fumadocs. **SDK/MCP generation:** Stainless or Speakeasy. **Registry:** published to the official MCP Registry as `com.zernio/zernio`.
- **Platform APIs themselves** (Meta Graph, X, TikTok, LinkedIn, Google, etc.) as official Marketing/Business Partners.

## 0.8 Monetization strategy

**Pure usage-based, per connected social account, graduated:** 1–2 free, 3–10 @ $6, 11–100 @ $3, 101–2000 @ $1, 2001+ custom. Every feature included at every level (no feature gating). Add-ons billed at cost with zero markup: **X/Twitter API passthrough** (per-request), **WhatsApp numbers** ($2–$20/mo per country) and outbound voice (carrier passthrough). Enterprise = custom. Affiliates via Dub. The genius: pricing scales with the customer's own success (more brands/clients = more accounts), there's nothing to "outgrow," and "everything included" removes the friction of tier-shopping.

## 0.9 Scalability bottlenecks

1. **Serverless + exact-time scheduling.** Millions of posts must fire at precise times; Vercel functions are short and cold-start-prone. The queue/cron tier is the real backbone and the first thing to strain.
2. **Platform rate limits & shared app quotas.** Because Zernio uses its *own* developer apps for many platforms, **all customers share the same app-level quota**. At scale this is the hard ceiling and an availability risk (one noisy tenant, or a platform tightening limits, hits everyone). Needs per-tenant token bucketing and app-pool sharding.
3. **Inbox/analytics polling.** Webhooks don't exist on every platform, so DMs/comments/metrics often require polling thousands of accounts → expensive fan-out and freshness/cost tradeoffs.
4. **MongoDB hot collections.** `posts` and `messages` grow without bound; time-series analytics in a document store gets costly; needs sharding/archival/a columnar sink.
5. **WhatsApp/voice** introduces telecom/regulatory state machines and per-country compliance that don't scale by code alone.
6. **300+ MCP tools** is a huge surface to keep correct as platforms drift.

## 0.10 Competitive weaknesses (where LaunchOS wins)

1. **It's plumbing, not outcomes.** Zernio moves bytes to platforms; it does **not** tell you *what to post, when, to whom, or whether it worked in revenue terms.* The entire strategy/intelligence layer is empty space.
2. **No attribution.** It publishes and reports vanity metrics (likes/reach) but cannot connect a post → click → signup → revenue. Marketers care about the latter.
3. **No autonomy.** MCP exposes tools, but the *agency* (planning, deciding, optimising, learning) is left to the customer to build. There's no resident agent that runs your marketing.
4. **No competitive/market awareness.** Zero competitor tracking, trend detection, or ad-library intelligence.
5. **Developer-only.** "Built for developers and teams with technical resources." That excludes the large non-technical founder/marketer segment — exactly who needs an *OS*, not an API.
6. **Shared-app quota risk** (see 0.9.2) is a structural reliability liability LaunchOS can sidestep early by wrapping multiple providers + adding native apps where it owns the relationship.
7. **No content generation or landing/funnel surface.** It assumes you bring finished content and have somewhere to send traffic.

**LaunchOS thesis:** keep Zernio's clean API-first, MCP-native, per-account, white-label DNA as the *substrate*, and win on the layer above it — an **autonomous marketing operating system** that plans, creates, publishes, optimises, and **attributes to revenue**, usable by both developers (API/MCP) and non-technical operators (app).

---

# PART 1 — LAUNCHOS PRODUCT SPECIFICATION

## 1.1 Positioning

**LaunchOS is the autonomous growth layer for the internet.** One API + one app + one MCP server that doesn't just *publish* across every channel — it *runs* the marketing: generates the content, plans the campaign, launches the product, talks to the customers, watches the competitors, attributes the revenue, and improves itself. Developers consume it as an API/MCP; operators consume it as an app; agents consume it as a fleet.

Three audiences, one product:
- **Builders** — embed unified social/messaging/ads/analytics + AI into their own SaaS (Zernio's audience, matched feature-for-feature).
- **Operators** — solo founders, marketers, agencies who want outcomes, in an app, with agents doing the work.
- **Agents** — autonomous systems (first-party LaunchOS agents and third-party via the Marketplace/MCP) that operate marketing end-to-end under guardrails.

## 1.2 Capability map

**A. Parity with Zernio (the substrate — table stakes):**
Unified Social API · Unified Messaging API (DMs/comments/reviews + WhatsApp numbers) · Unified Analytics API · Hosted OAuth account connection · Multi-platform publishing (schedule/queue/threads/carousels/video) · Ad-network integrations (boost + campaigns, 6+ networks) · Contacts CRM · Broadcasts · Sequences · Comment-to-DM automations · Webhooks · 8-language SDKs · CLI · **MCP server** (auto-generated from OpenAPI) · White-label · Usage-based per-account billing.

**B. New systems (the differentiation):**

1. **AI Campaign Brain** — goal in (e.g. "300 signups for launch in 30 days, $2k budget") → full multi-channel plan out: content calendar, channel mix, budget split, asset briefs, KPIs. Re-plans as results come in.
2. **Autonomous Marketing Agents** — durable, role-based agents (Community Manager, Growth, Ads Optimizer, Researcher, Launch Captain) that wake on schedule/events, use tools, and act under autonomy levels (`suggest` → `approve` → `auto`) with spend/rate/content guardrails and full audit trace.
3. **Competitor Intelligence Engine** — track competitors' organic + paid content (public APIs + ad libraries), detect their viral posts/new ads/posting spikes, surface "steal this angle" briefs.
4. **Revenue Attribution Engine** — identity graph stitching anonymous visitor → contact → customer; multi-touch models (first/last/linear/time-decay/data-driven); answers "which post/ad/DM drove revenue."
5. **Product Launch Assistant** — opinionated launch playbooks (Product Hunt / HN / X / Reddit / email runway), generated task list with owners and timing, pre-written assets, launch-day war room.
6. **Viral Content Generator** — hooks/threads/reel-scripts/carousels/repurposing, scored by a virality model trained on the org's + platform winners, closed-loop (learns from what actually performed).
7. **Landing Page Generator** — block-based, AI-generated pages tied to campaigns, with forms that create contacts + attribution touchpoints, custom domains, A/B-native.
8. **Affiliate Program Manager** — programs, affiliate links, referral tracking via the identity graph, commission rules, Stripe Connect payouts.
9. **Marketing Workflow Builder** — visual trigger→condition→action(+agent) automation graph (n8n-for-marketing), but with agent nodes and LaunchOS-native triggers.
10. **Agent Marketplace** — publish/install agents and workflow templates; rev-share; manifest defines tools, scopes, config, pricing.
11. **Growth Experiment Engine** — hypothesis → variants (post/page/ad/sequence) → traffic split → significance → auto-promote winner; experiment ledger.
12. **Multi-channel Customer Journey Tracking** — unified timeline per contact/identity across every touch (post click, DM, email, page, ad, conversion); stage definitions and funnel analytics.

## 1.3 How the new systems connect (the flywheel)

```
Competitor Intel ─┐                         ┌─> Experiments ──┐
                  ▼                         │                 ▼
  Campaign Brain ──> Viral Gen + Landing ──> Publish/Message ──> Touchpoints
        ▲           (assets)    Pages        (substrate)         │
        │                                                        ▼
        └────────── Revenue Attribution <── Journey Tracking <── Conversions
                          │
                          └─> feeds back goals/winners to Brain & Agents (closed loop)
```

The unifying primitive is the **identity graph + touchpoint/conversion ledger**. Everything publishes touchpoints; everything reads attribution. That's what makes LaunchOS an *OS* and not a bag of features.

## 1.4 Personas & permissions

- **Owner/Admin** — billing, members, connections, white-label, agent autonomy ceilings.
- **Editor** — create/schedule content, run campaigns, configure agents (within ceilings).
- **Analyst** — read analytics/attribution/experiments, no publish.
- **Agent (non-human membership)** — scoped service identity; can only call allowed tools, bounded by policies; every action audit-logged and attributable.

---

# PART 2 — DATABASE SCHEMA

The canonical, runnable schema is **`launchos_schema.sql`** (Postgres 16+). Summary of decisions:

- **Postgres, not Mongo** (deliberate divergence from Zernio). Reasons: attribution and journey analytics are relational and time-series heavy; RLS gives clean multi-tenant isolation; `pgvector` co-locates RAG/embeddings with data; JSONB still handles per-platform payloads. One database, fewer moving parts than Mongo + a separate vector DB + a separate warehouse early on.
- **Multi-tenancy:** every tenant row carries `org_id`; Row-Level Security policies key off `app.current_org`. Service workers use a `BYPASSRLS` role.
- **IDs:** internal `uuid` PKs; external prefixed `public_id` (`post_…`, `acc_…`) for API stability.
- **Money:** integer minor units + `currency`. **Time:** `timestamptz` UTC.
- **Secrets:** OAuth tokens live in `oauth_credentials` as envelope-encrypted `bytea` with `key_version` for rotation — never in the hot `social_accounts` row. API keys stored as SHA-256 only.
- **Domains (table groups):** identity/tenancy/billing · social core · analytics · messaging/CRM · ads · webhooks · AI infra (knowledge + `ai_jobs` ledger + `pgvector`) · then one group per new system (campaigns, agents+marketplace, competitor intel, attribution+journey, viral gen, landing pages+forms, affiliates, workflows, experiments+launches).

Scaling notes baked into the schema: append-only high-volume tables (`audit_log`, `usage_records`, `post_metrics`, `touchpoints`, `conversions`, `experiment_events`, `webhook_deliveries`, `agent_steps`) use `bigint identity` PKs and are **partition-by-month candidates**; move them to a columnar sink (ClickHouse/Timescale) when row counts force it (see §10).

---

# PART 3 — API SPECIFICATION

## 3.1 Conventions

- Base: `https://api.launchos.com/v1`. JSON only. **OpenAPI 3.1 is the single source of truth** → generates SDKs + MCP tools + docs (same trick Zernio uses; non-negotiable for an API-first product).
- **Auth:** `Authorization: Bearer sk_…` (API key, org-scoped) **or** OAuth2 (user/agent identity, for app + MCP). Scopes per resource:`posts:write`, `inbox:read`, `ads:write`, `agents:run`, `attribution:read`, etc.
- **Idempotency:** `Idempotency-Key` header on all POSTs (critical for publish/charge/send).
- **Pagination:** cursor-based (`?cursor=&limit=`), `has_more` + `next_cursor`.
- **Errors:** RFC-9457 problem+json: `{type, title, status, detail, code, request_id}`. Codes are stable strings.
- **Rate limits:** per-org token bucket, headers `X-RateLimit-*`. **Per-platform** internal buckets too (see §10).
- **Webhooks:** HMAC-SHA256 signature header, timestamped, retried with exponential backoff to a DLQ.
- **Versioning:** date-pinned (`LaunchOS-Version: 2026-06-01`) for breaking changes; additive changes unversioned.

## 3.2 Endpoint map (resource → verbs)

**Substrate (Zernio parity):**
```
/profiles                         GET POST            /profiles/{id}            GET PATCH DELETE
/connect/{platform}               GET (hosted OAuth)  /connect/callback         GET
/accounts                         GET                 /accounts/{id}            GET DELETE
/accounts/{id}/health             GET
/media                            POST (multipart / signed-url)
/posts                            GET POST            /posts/{id}               GET PATCH DELETE
/posts/{id}/retry                 POST
/queue                            GET POST            /queue/{id}               DELETE
/analytics/posts                  GET                 /analytics/accounts       GET
/analytics/best-time              GET
/inbox/conversations              GET                 /inbox/conversations/{id} GET
/inbox/conversations/{id}/messages GET POST
/inbox/comments                   GET                 /inbox/comments/{id}/reply POST
/inbox/reviews                    GET                 /inbox/reviews/{id}/reply  POST
/contacts                         GET POST PATCH DELETE  /contacts/bulk         POST
/broadcasts ... /broadcasts/{id}/{send,schedule,cancel,recipients}
/sequences  ... /sequences/{id}/{activate,pause,enroll,enrollments}
/automations ... /automations/{id}/logs
/whatsapp/numbers                 GET POST (purchase) /whatsapp/numbers/{id}    DELETE
/ads/accounts /ads/campaigns /ads/boost  (+ /ads/insights)
/webhooks                         GET POST            /webhooks/{id}            DELETE
/api-keys  /invites  /members
```

**Differentiation (new):**
```
/campaigns                        GET POST            /campaigns/{id}/plan      POST (Brain generates/replans)
/campaigns/{id}/approve|launch    POST
/agents                           GET POST PATCH      /agents/{id}/{run,pause,stop}
/agents/{id}/runs  /runs/{id}/steps  /approvals/{id}/{approve,reject}
/competitors                      GET POST            /competitors/{id}/content  GET
/intel/alerts                     GET
/attribution/touchpoints          POST (ingest)       /attribution/conversions   POST (ingest)
/attribution/report               GET (?model=)       /attribution/identify      POST (stitch)
/journeys  /journeys/{id}/contacts/{cid}/timeline   GET
/content/generate                 POST                /content/variants/{id}/score GET
/landing-pages  /landing-pages/{id}/{publish,versions}
/forms  /forms/{id}/submissions
/affiliates/programs /affiliates /affiliates/{id}/links /referrals /payouts
/workflows /workflows/{id}/{publish,run,runs}
/marketplace/agents /marketplace/agents/{id}/install /marketplace/reviews
/experiments /experiments/{id}/{start,conclude,variants,events}
/launches /launches/{id}/tasks
```

## 3.3 Two example contracts

`POST /posts` (publish/schedule):
```json
{ "profile_id":"prof_…","content":"Launch day!","media_ids":["media_…"],
  "schedule":{"mode":"scheduled","at":"2026-07-01T16:00:00Z","timezone":"Europe/London"},
  "targets":[ {"account_id":"acc_ig","content_override":"Launch day 🚀 #buildinpublic"},
              {"account_id":"acc_li"},
              {"account_id":"acc_x","options":{"thread":["1/…","2/…"]}} ],
  "attribution":{"campaign_id":"cmp_…","utm":{"source":"launchos"}} }
→ 202 {"post":{"id":"post_…","status":"scheduled","targets":[{"account_id":"acc_ig","status":"pending"}]}}
```

`POST /campaigns/{id}/plan` (Campaign Brain):
```json
{ "objective":"launch","goal":{"metric":"signups","target":300},
  "budget_cents":200000,"window":{"start":"2026-07-01","end":"2026-07-31"},
  "channels":["instagram","x","linkedin","email"],"constraints":{"posts_per_week":5} }
→ 200 {"plan":{"calendar":[…], "channel_mix":{…}, "budget_split":{…},
        "asset_briefs":[…], "kpis":[…], "experiments":[…]}}   // persisted to campaigns.plan
```

---

# PART 4 — FRONTEND ARCHITECTURE

- **Stack:** Next.js (App Router) + React + TypeScript + Tailwind + shadcn/ui; TanStack Query for server state; Zustand for local UI state; `react-hook-form` + `zod` for forms. Charts: Recharts/visx. Visual editors (workflow graph, journey, landing builder): React Flow (workflows/journeys) + a block editor (landing pages). Real-time (inbox, agent runs): WebSocket/SSE channel.
- **App structure (route groups):**
  ```
  app/
   (marketing)/                 public site, per-platform & comparison SEO pages
   (auth)/login,signup,oauth
   (app)/
     dashboard/                 home: today's queue, agent activity, KPI tiles
     compose/                   multi-platform composer (the core create surface)
     calendar/                  schedule + queue
     campaigns/[id]             Brain: brief → plan → assets → results
     launches/[id]              Launch Assistant war room
     inbox/                     unified DMs/comments/reviews
     contacts/[id]              CRM + journey timeline
     content-studio/            Viral Generator + variants + scores
     landing/[id]               page builder
     ads/                       boost + campaigns + insights
     analytics/ attribution/    dashboards + multi-touch report
     competitors/               intel feed + alerts
     experiments/[id]           growth experiments
     workflows/[id]             builder
     agents/[id]                agent config + run trace + approvals
     marketplace/               browse/install
     settings/{members,api-keys,connections,billing,white-label,webhooks}
  ```
- **Design system first:** read `frontend-design` skill before building UI. Tokens, type scale, spacing, dark mode, density modes (operators vs analysts). Component library shared across app + white-label theming (CSS variables driven by `organizations.brand_settings`).
- **White-label:** custom domain + `brand_settings` (logo/colors/name) injected at the theme layer; no LaunchOS branding leaks (matches Zernio).
- **Embeddable widgets:** a JS SDK exposing the composer, inbox, and "connect account" flow as embeddable components so *builders* can drop LaunchOS UI into their own apps (a surface Zernio lacks).
- **Accessibility & i18n** from the start (operators are global).

---

# PART 5 — BACKEND ARCHITECTURE

**Shape:** a modular monolith (single deployable API) for MVP/V1, decomposed into a few services only where load demands (publishing engine, sync workers, AI/agent runtime). Don't start microservices.

```
                 ┌────────────── API Gateway / Edge (auth, rate-limit, idempotency) ──────────────┐
                 │                                                                                 │
   App / SDKs / MCP ──> Core API (Next route handlers or Fastify/Nest) ──> Postgres (RLS) + Redis │
                 │                         │                                                       │
                 │                         ├── ChannelProvider interface  [BUILD-VS-WRAP]          │
                 │                         │     ├─ provider:zernio|ayrshare|unipile (V1)           │
                 │                         │     └─ native adapters (V2: ig,x,li,tiktok,wa)         │
                 │                         │                                                        │
                 │   Queue (BullMQ/Temporal) ── Workers:                                            │
                 │      • publish-scheduler (exact-time fire)  • inbox-sync  • analytics-sync       │
                 │      • webhook-dispatch (HMAC, retry, DLQ)  • broadcast-sender                   │
                 │      • sequence-stepper  • competitor-poller  • attribution-resolver             │
                 │      • agent-runtime (durable, see §7)      • experiment-evaluator                │
                 └─────────────────────────────────────────────────────────────────────────────────┘
   Object storage: S3/R2 (media).  Search/vector: pgvector (→ dedicated vector DB if needed).
   Event bus: Postgres LISTEN/NOTIFY or Redis streams (V1) → Kafka/NATS (scale).
```

Key decisions:
- **Durable scheduling, not cron-and-pray.** Use **Temporal** (or BullMQ + a leader-elected scheduler) so exact-time publishing, multi-step sequences, agent runs, and broadcasts survive restarts and retry deterministically. This directly fixes Zernio's #1 bottleneck.
- **ChannelProvider interface** is the single seam between "what to post" and "how each platform wants it." Providers: `publish()`, `fetchMetrics()`, `fetchInbox()`, `sendMessage()`, `connectOAuth()`, `boost()`. Swap wrap→native per platform without touching callers.
- **Per-platform rate governor** (token buckets in Redis, keyed by platform + app-credential-pool + tenant) to avoid the shared-quota cliff. Native apps get their own pool; wrapped providers inherit theirs.
- **Outbox pattern** for webhooks/events (write event in same txn as state change → dispatcher reads outbox) so we never lose or double-fire.
- **Everything tenant-scoped** via RLS; workers assume an org context per job.

---

# PART 6 — AI ARCHITECTURE

**Principle:** one **AI gateway** routes every model call; nothing calls a model SDK directly. This gives cost metering (`ai_jobs` + `usage_records`), caching, fallback, eval, and per-org credit enforcement in one place.

```
Feature code ──> AI Gateway ──> Router (task→model) ──> {Anthropic, OpenAI, Llama, image/video models}
                    │                                      │
                    ├─ prompt registry (versioned templates, prompt_templates table)
                    ├─ RAG: retrieve org knowledge_chunks (pgvector) + brand_voice
                    ├─ structured output (JSON schema / tool-forcing) for plans, variants, scores
                    ├─ guardrails (PII, brand-safety, platform policy) pre/post
                    ├─ cost ledger + budget caps (per org, per feature)
                    └─ eval harness (golden sets per feature; regression gates on prompt changes)
```

- **Model routing by task, not vendor lock:** cheap/fast model for classification, scoring, summarisation; frontier model for planning (Campaign Brain) and agent reasoning; image/video models for creative. Configurable per org (enterprise can pin/bring-keys).
- **RAG context per org:** brand voice, past winning posts, product docs, competitor corpus → every generation is grounded in *this* brand, not generic. This is why LaunchOS output beats a raw LLM and beats Zernio (which has none).
- **Virality model:** start as an LLM-as-judge rubric + simple features (hook strength, length, format fit); evolve to a trained model on `content_variants.predicted_score` vs actual `post_metrics` (closed loop via `content_variants.posted_post_id`).
- **Attribution "data-driven" model:** start with rule-based multi-touch (first/last/linear/time-decay); upgrade to a Markov/Shapley model over `touchpoints`→`conversions` once data volume supports it.
- **Determinism where it matters:** plans/experiments use structured outputs + validation; creative stays sampled.
- **Cost control:** every job has `org_id`, `feature`, token counts, `cost_cents`; budgets enforced before dispatch; agents carry hard `budget_cents` ceilings.

---

# PART 7 — AGENT FRAMEWORK ARCHITECTURE

The agent layer is the headline differentiator, so it gets a real runtime, not a while-loop.

**Model:** an **agent** = (role, goal, tools[], policies[], autonomy_level, schedule, budget). A **run** is a durable workflow (Temporal) with a full **step trace** (`agent_steps`) and optional **human approvals** (`agent_approvals`).

```
Trigger (cron | event | manual)
   ↓
Agent Runtime (durable) ── plan → act-loop:
   • perceive: pull state via read tools (analytics, inbox, intel, attribution)
   • decide: LLM reasoning with goal + policies + RAG
   • act: call write tools (post, reply, boost, adjust budget, launch experiment)
        └─ if autonomy=suggest → emit suggestion, stop
           if autonomy=approve → create agent_approval, WAIT (durable) for human
           if autonomy=auto    → execute, subject to policy checks
   • check guardrails: spend cap, rate cap, content filter, "requires_approval" rules
   • record every thought/tool_call/result to agent_steps (replayable)
   ↓
End: summary, cost, usage; emit events → workflows/attribution can react
```

- **Tools = the LaunchOS API itself**, exposed as a typed tool registry shared with MCP (one definition, used by first-party agents, the marketplace, and external MCP clients). 280+ tools, auto-generated from OpenAPI — same source-of-truth trick, now powering *resident* agents not just external ones.
- **Autonomy ladder** (`suggest` → `approve` → `auto`) is per-agent and capped by org policy; new agents default to `suggest`. This is the trust ramp non-technical operators need.
- **Guardrails as data** (`agent_policies`): spend limits, rate limits, content filters, mandatory-approval action classes (e.g. any ad spend > $X, any DM to >N contacts, anything touching a verified account). Enforced in the runtime, not the prompt.
- **Roles shipped first-party:** Community Manager (inbox triage + replies), Growth (experiment generation), Ads Optimizer (budget reallocation within caps), Researcher (competitor + trend briefs), Launch Captain (drives a `launch` playbook).
- **Observability:** every run is a replayable trace; cost and outcome attributed back to the agent; this is also what makes the **Marketplace** trustworthy (installers see what an agent actually does).
- **Marketplace contract:** a published agent ships a **manifest** (declared tools, required scopes, config schema, pricing model). Install creates a scoped `agent` in the installer's org. Rev-share billed through Stripe Connect. Review + sandbox before `published`.
- **MCP server:** hosted at `mcp.launchos.com/mcp`, OAuth or Bearer, auto-generated from OpenAPI, published to the MCP Registry. External agents (Claude/Cursor/ChatGPT) get the same tools the internal runtime uses.

---

# PART 8 — MONETIZATION MODEL

Keep Zernio's winning core, layer value-metered AI on top, add marketplace rev-share.

1. **Substrate: per connected account, graduated** (match Zernio so switching is painless): free 1–2; then graduated $/account by volume band; everything in the *substrate* included. Passthroughs at cost (X API, WhatsApp numbers/voice).
2. **Intelligence: AI credits** (metered, via `usage_records`→Stripe). Generations, campaign plans, agent runs, attribution recompute, competitor polling consume credits. Plans bundle a monthly credit allowance; overage metered. This is the high-margin layer Zernio doesn't have.
3. **Plans** (bundle accounts + credits + seats + autonomy ceilings): Free, Starter, Growth, Scale, Enterprise. Plans gate *capacity and autonomy*, not features-as-paywalls (preserve the "everything included" ethos that makes Zernio loved).
4. **Marketplace rev-share:** 70/30-style split on paid agents/templates (Stripe Connect).
5. **Affiliate-of-affiliates:** LaunchOS runs its own affiliate program (dogfood the Affiliate Manager) — the product sells itself.
6. **Enterprise:** custom volume, data residency (EU/US), SSO/SCIM, bring-your-own-model-keys, dedicated app credential pools (better rate limits), SLA.

Why it compounds: revenue scales with the customer's number of brands/clients **and** their usage of intelligence **and** the marketplace ecosystem — three growth vectors vs Zernio's one.

---

# PART 9 — SECURITY ARCHITECTURE

- **Tenant isolation:** Postgres RLS on every org-scoped table; app sets `app.current_org` per request/job; workers use least-privilege roles. Defense-in-depth: also filter by `org_id` in queries.
- **Secrets:** OAuth tokens envelope-encrypted (KMS-wrapped data keys) in `oauth_credentials`, `key_version` for rotation; never logged, never returned by API. API keys = SHA-256 only, shown once, prefix stored for display, scoped, revocable, expiring.
- **AuthN/Z:** OAuth2/OIDC for humans (+ optional MFA, SSO/SCIM for enterprise); scoped API keys for machines; agents are first-class scoped identities with their own audit trail. RBAC roles (owner/admin/editor/analyst/agent).
- **Agent safety:** autonomy ceilings, spend/rate/content guardrails enforced in-runtime; mandatory-approval action classes; full replayable trace; kill-switch per agent and org-wide.
- **Webhooks:** HMAC-signed, timestamped (replay window), per-endpoint secret, retried to DLQ.
- **Input/AI safety:** prompt-injection defenses on agent tool use (treat tool/content output as untrusted), content moderation on generated + published content, platform-policy filters to protect customer accounts from bans.
- **Data lifecycle/compliance:** GDPR/CCPA delete + export, data residency (US/EU) per org, retention windows on high-volume tables, PII minimisation in `identities`. Target **SOC 2 Type II** early (it's table stakes vs Zernio) + trust portal + public status page.
- **Network/app:** WAF, rate limiting at edge, idempotency to prevent double-charge/double-post, audit_log append-only, anomaly alerts on key usage and agent spend.
- **Supply chain:** pin SDK/MCP generation, sign releases, scan deps; the 280+ tool surface is reviewed as code.

---

# PART 10 — SCALING PLAN

Address each Zernio bottleneck head-on:

1. **Exact-time publishing → Temporal/durable scheduler** + sharded workers; a partitioned `post_targets` work queue; backpressure per platform. Survives restarts; no missed fires.
2. **Shared-app quota cliff → per-platform rate governor** (Redis token buckets keyed platform×credential-pool×tenant) + **multi-provider + native-app credential pools**; enterprise gets dedicated pools. Wrap-first means provider absorbs early quota; native apps added where volume justifies.
3. **Polling cost (inbox/analytics) →** webhook-first where platforms support it; adaptive polling (busy accounts polled more, idle less); coalesce + cache; move metrics to a time-series/columnar store.
4. **Data growth → partition** append-only tables by month; tier cold data to object storage; **route analytics/attribution/experiment events to ClickHouse or Timescale** once Postgres row counts hurt (keep Postgres as system-of-record, columnar as the read model). `pgvector` → dedicated vector store (e.g. when embeddings ≫ tens of millions).
5. **AI cost → gateway caching, model routing, batch low-priority jobs, per-org budgets**, and pre-computed scores. Agent runs are the cost tail — cap and monitor.
6. **Read scale → CQRS-lite:** materialized dashboards/rollups (`account_metrics_daily`, attribution results) so the UI never scans raw events.
7. **Org/region sharding** as a last resort: tenant routing by `org_id`; EU/US residency already modeled.

Capacity staging: single Postgres + Redis + workers (→100s of orgs) → read replicas + columnar sink + provider pools (→thousands) → sharded data plane + Kafka + dedicated agent fleet (enterprise scale).

---

# PART 11 — MVP PLAN (target ~6–8 weeks, wrap-first)

**Goal:** prove the wedge — *"AI plans + generates + publishes across channels, and tells you what drove signups"* — for solo founders/operators, on a wrapped substrate.

**In scope:**
- Auth, orgs, members, profiles, billing (Stripe, per-account + AI credits), API keys.
- **Substrate via one ChannelProvider** (wrap Zernio/Ayrshare/Unipile) for **5 channels** (X, LinkedIn, Instagram, TikTok, threads/Bluesky as bonus): hosted OAuth connect, multi-platform `POST /posts`, schedule, basic analytics sync. Unified inbox **read** + DM reply for 2 platforms.
- **Viral Content Generator v1** (hooks/threads/repurpose, RAG on brand voice, variant scoring via LLM-judge).
- **AI Campaign Brain v1** (goal→calendar+briefs; manual approve; populates the composer/calendar).
- **Revenue Attribution v1** (JS pixel + `/attribution/identify|conversions` ingest; first/last/linear models; one report). This is the differentiator that must be in the MVP.
- **Multi-channel Customer Journey v1** (contact timeline from touchpoints).
- **OpenAPI + auto-generated Node/Python SDK + hosted MCP server** (so "API-first + MCP" parity exists from day one — cheap because it's generated).
- Composer, Calendar, Campaign, Analytics+Attribution, Inbox, Contacts, Settings screens.

**Explicitly deferred:** native platform apps, WhatsApp numbers, ads, agents-with-autonomy (ship "suggest-only" stub), marketplace, landing pages, workflows, experiments, competitor intel, affiliates, all 15 channels.

**MVP success metric:** time-to-first-attributed-signup < 1 day; activated org generates+publishes a campaign and sees a revenue/ signup touchpoint attributed.

---

# PART 12 — V1 PLAN (next ~3–4 months)

- **Channel breadth → all 15** via providers; **ads (boost + campaigns)** for Meta/Google/X; **WhatsApp numbers** (via provider) + broadcasts + sequences + comment-to-DM automations (full substrate parity with Zernio).
- **Autonomous Agents (real):** runtime + autonomy ladder + guardrails + approvals + traces; ship Community Manager + Ads Optimizer + Researcher first-party.
- **Competitor Intelligence Engine** (organic + ad-library polling, alerts, "steal this" briefs).
- **Landing Page Generator** + forms (closes the attribution loop end-to-end).
- **Growth Experiment Engine** (post/landing/ad A/B with significance + auto-promote).
- **Attribution v2** (time-decay + first data-driven model; identity graph hardening).
- **Workflow Builder v1** (triggers/conditions/actions + agent nodes).
- **8-language SDKs** (generated), CLI, white-label, SOC 2 Type II in progress, trust + status portals.

**V1 = full Zernio parity + 8 of the 12 new systems.**

# PART 13 — V2 PLAN

- **Native platform adapters** for the top 5 channels (own the integration, own the quota, improve margin/reliability) behind the same `ChannelProvider` seam.
- **Product Launch Assistant** (playbooks, war room, launch-day agent).
- **Agent Marketplace** (publish/install, manifest, sandbox/review, Stripe Connect rev-share).
- **Affiliate Program Manager** (programs, links, referral via identity graph, payouts) + dogfood LaunchOS's own program.
- **Attribution v3** (Markov/Shapley data-driven), **virality model trained** on closed-loop data, **multi-model/bring-your-own-keys**, enterprise SSO/SCIM, data residency GA, columnar analytics sink, embeddable widget SDK, marketplace ecosystem flywheel.

---

# PART 14 — SCREEN-BY-SCREEN IMPLEMENTATION PLAN

For each screen: **route · purpose · key components · data (reads/writes) · API calls · states · acceptance criteria.** An agent should be able to implement top-to-bottom. (MVP screens first; V1/V2 screens flagged.)

### 14.1 `/(auth)/signup` & `/login`
- **Purpose:** create org + owner; Google OAuth + email/password.
- **Components:** AuthCard, OAuthButton(Google), EmailPasswordForm (rhf+zod), error toast.
- **Writes:** `users`, `organizations`, `memberships(role=owner)`. **API:** `POST /auth/signup`, `POST /auth/oauth/google`.
- **States:** idle/submitting/error/success→redirect `/dashboard`. Email-verify pending banner.
- **Accept:** new user lands on dashboard with an empty default profile created; verification email sent; no PII in logs.

### 14.2 `/(app)/dashboard`
- **Purpose:** the "today" view — what's queued, what agents did, how growth's tracking.
- **Components:** KPI tiles (followers Δ, reach, attributed signups, attributed revenue), TodayQueue (next posts), AgentActivityFeed (recent runs/approvals), CampaignProgress, ConnectAccountsCTA (if 0 accounts).
- **Reads:** `account_metrics_daily`, `posts(status=scheduled)`, `agent_runs`, `attribution/report` summary, `campaigns`. **API:** `GET /analytics/accounts`, `GET /posts?status=scheduled`, `GET /agents/runs?recent`, `GET /attribution/report?range=30d`.
- **States:** empty (no accounts → onboarding checklist), populated, loading skeletons, error per-tile (tiles fail independently).
- **Accept:** loads < 1s with cached rollups; each tile degrades independently; empty state guides to connect first account.

### 14.3 `/(app)/settings/connections` + `/connect/{platform}`
- **Purpose:** connect/disconnect accounts via hosted OAuth; show health.
- **Components:** PlatformGrid (15 cards w/ capability badges), ProfileSelector, AccountList (status: connected/expired/reauth), ReconnectButton.
- **Flow:** click platform → `GET /connect/{platform}?profile_id=` → redirect to provider hosted OAuth → callback → account appears. **Writes:** `social_accounts`, `oauth_credentials` (encrypted, server-side only).
- **States:** not-connected, connecting (redirect), connected, expired→reauth, error. Billing impact preview ("this is account #3 → $X/mo").
- **Accept:** tokens never reach the client; disconnect sets `deleted_at` + stops billing; health check surfaces reauth needs; per-account cost shown before confirm.

### 14.4 `/(app)/compose`  (core create surface)
- **Purpose:** write once, tailor per platform, schedule/queue/publish/draft.
- **Components:** ProfilePicker, AccountMultiSelect, BaseEditor, PerPlatformTabs (override copy, see live char-count/preview per platform), MediaUploader (drag-drop → `POST /media`), ThreadComposer (X), FirstCommentField, SchedulePicker (now/at/queue/best-time), AttributionFields (campaign, utm), AIAssist button (→ Viral Generator inline).
- **Writes:** `posts`, `post_targets`, `media_assets`. **API:** `POST /media`, `POST /posts`, `GET /analytics/best-time` (suggested slot).
- **States:** draft, validating (per-platform rules: length, media count, video specs), scheduling, scheduled/published/partial/failed (per-target chips), retry on failed target (`POST /posts/{id}/retry`).
- **Accept:** one action posts to N platforms; per-target failures isolated + retryable; previews match platform constraints; idempotency key set; AI assist inserts a chosen variant.

### 14.5 `/(app)/calendar`
- **Purpose:** see/drag scheduled posts; manage queue slots.
- **Components:** MonthWeekToggle, DraggablePostCard, QueueSlotEditor, EmptySlotHints (best-time).
- **Reads/Writes:** `posts`, `post_targets`, `queue_slots`. **API:** `GET /posts?range=`, `PATCH /posts/{id}` (reschedule on drag), `POST /queue`.
- **Accept:** drag updates `scheduled_for` optimistically + persists; queue auto-fills drafts into recurring slots; timezone-correct.

### 14.6 `/(app)/content-studio`  (Viral Content Generator)
- **Purpose:** generate scored content variants; send to composer.
- **Components:** IntentPicker (hook/thread/reel/carousel/repurpose), SourceInput (prompt/URL/existing-post/transcript), BrandVoiceChip (from profile), VariantList (each w/ predicted_score + rationale), "Use in composer", "Run A/B" (→ experiment).
- **Reads/Writes:** `content_generations`, `content_variants`, `ai_jobs`. **API:** `POST /content/generate`, `GET /content/variants/{id}/score`.
- **States:** generating (stream), variants ready, scoring, chosen→composer. Credit cost shown.
- **Accept:** variants grounded in brand voice + org winners (RAG); scores present with rationale; choosing a variant links it back for closed-loop learning (`content_variants.posted_post_id`).

### 14.7 `/(app)/campaigns/[id]`  (AI Campaign Brain)
- **Purpose:** brief → generated plan → assets → live results.
- **Components:** BriefForm (objective, goal metric+target, budget, window, channels, constraints), PlanView (calendar + channel mix + budget split + KPI cards + asset briefs), GenerateButton, ApproveButton, AssetTable (links to posts/landing pages/ads), ResultsPanel (progress vs goal, attribution-fed).
- **Reads/Writes:** `campaigns`, `campaign_assets`, downstream `posts`/`landing_pages`/`ad_campaigns`. **API:** `POST /campaigns`, `POST /campaigns/{id}/plan`, `POST /campaigns/{id}/approve|launch`, `GET /attribution/report?campaign_id=`.
- **States:** planning, plan-generated (editable), approved, running, completed; re-plan on demand.
- **Accept:** plan is concrete + editable; approving materialises real draft assets; results panel pulls attributed outcomes, not vanity metrics.

### 14.8 `/(app)/inbox`
- **Purpose:** unified DMs/comments/reviews; reply; assign; agent-assist.
- **Components:** ConversationList (filter platform/type/status/assignee/unread), Thread, Composer (+ AI suggested reply), AssignMenu, StatusControls, ContactCard (right rail → journey link).
- **Reads/Writes:** `conversations`, `messages`, `contacts`. **API:** `GET /inbox/conversations`, `GET /inbox/conversations/{id}/messages`, `POST .../messages`, `POST /inbox/comments/{id}/reply`, `POST /inbox/reviews/{id}/reply`. Real-time via SSE/WS.
- **States:** loading, open/snoozed/closed, sending, delivered/read/failed; agent-suggested reply (approve/edit/send).
- **Accept:** new inbound appears in real time; reply delivers + reflects status; assigning + closing persists; Community Manager agent can draft replies for approval.

### 14.9 `/(app)/contacts` + `/contacts/[id]` (CRM + Journey)
- **Purpose:** cross-platform contacts; full journey timeline.
- **Components:** ContactTable (search/tags/lifecycle filters, trgm search), ContactDetail (channels, custom fields, lifecycle stage), JourneyTimeline (touchpoints+conversions chronologically across all channels), BulkImport.
- **Reads/Writes:** `contacts`, `contact_channels`, `touchpoints`, `conversions`, `identities`. **API:** `GET/POST/PATCH /contacts`, `POST /contacts/bulk`, `GET /journeys/{id}/contacts/{cid}/timeline`.
- **Accept:** one contact = many platform handles unified; timeline shows post-click→DM→page→signup across channels; identity stitching visible.

### 14.10 `/(app)/analytics` + `/attribution`
- **Purpose:** unified performance + revenue attribution.
- **Components:** DateRange, AccountFilter, MetricCharts (impressions/reach/engagement/follower growth), TopPosts, **AttributionReport** (model selector first/last/linear/time-decay/data-driven; channel→revenue table; path analysis), ExportCSV.
- **Reads:** `post_metrics`, `account_metrics_daily`, `attribution_results`, `conversions`, `touchpoints`. **API:** `GET /analytics/*`, `GET /attribution/report?model=`.
- **Accept:** model switch recomputes credit allocation; revenue ties to specific posts/ads/DMs; numbers reconcile with conversions ingested.

### 14.11 `/(app)/agents/[id]`  (V1)
- **Purpose:** configure an agent; watch runs; approve actions.
- **Components:** AgentConfig (role, goal, allowed_tools, autonomy_level slider suggest→approve→auto, schedule cron, budget cap, policies), RunList, **RunTrace** (step-by-step thoughts/tool-calls/results, replayable), ApprovalQueue (pending proposed actions → approve/reject), KillSwitch.
- **Reads/Writes:** `agents`, `agent_policies`, `agent_runs`, `agent_steps`, `agent_approvals`. **API:** `POST /agents`, `PATCH /agents/{id}`, `POST /agents/{id}/run|pause|stop`, `GET /agents/{id}/runs`, `GET /runs/{id}/steps`, `POST /approvals/{id}/approve|reject`.
- **States:** active/paused/stopped/error; run running/waiting_approval/succeeded/failed; approval pending/decided/expired.
- **Accept:** autonomy ceiling enforced server-side; `auto` blocked by guardrails when a policy trips; every action in the trace; budget cap halts the run; kill-switch immediate.

### 14.12 `/(app)/competitors`  (V1)
- **Purpose:** track competitors; surface intel + "steal this" briefs.
- **Components:** CompetitorList (handles/website), ContentFeed (their posts/ads w/ metrics, ad badge), AlertList (viral_post/new_ad/posting_spike/pricing_change), "Generate counter-angle" (→ content studio).
- **Reads/Writes:** `competitors`, `competitor_content`, `intel_alerts`. **API:** `GET/POST /competitors`, `GET /competitors/{id}/content`, `GET /intel/alerts`.
- **Accept:** new competitor viral post raises an alert; brief generation pulls the actual competitor post as context.

### 14.13 `/(app)/landing/[id]`  (V1)
- **Purpose:** AI-generate + edit block-based landing pages tied to campaigns; forms feed attribution.
- **Components:** BlockEditor (hero/features/cta/form blocks), AIGenerate (from campaign brief), FormBuilder, VersionHistory, Publish (slug/custom domain), VariantToggle (→ experiment).
- **Reads/Writes:** `landing_pages`, `landing_page_versions`, `forms`, `form_submissions`. **API:** `POST /landing-pages`, `POST /landing-pages/{id}/publish`, `GET/POST /forms`.
- **Accept:** published page serves at slug/domain; form submit creates `contact` + `identity` + a `touchpoint` (attribution-wired); A/B variant routes traffic via experiment.

### 14.14 `/(app)/experiments/[id]`  (V1)
- **Purpose:** A/B/n on posts/pages/ads/sequences with significance.
- **Components:** HypothesisForm, VariantSetup (subject + allocation), LiveResults (exposures/conversions/lift + confidence), ConcludeButton (auto-promote winner).
- **Reads/Writes:** `experiments`, `experiment_variants`, `experiment_events`. **API:** `POST /experiments`, `POST /experiments/{id}/start|conclude`, events ingested via pixel/SDK.
- **Accept:** traffic splits per allocation; significance computed; winner promotion updates the underlying asset.

### 14.15 `/(app)/workflows/[id]`  (V1)
- **Purpose:** visual marketing automation (triggers→conditions→actions→agent nodes).
- **Components:** React-Flow canvas, NodePalette (trigger: new contact / comment / conversion / schedule; action: post / send DM / enroll sequence / boost / generate content; condition; **agent** node), RunHistory, Publish/Activate.
- **Reads/Writes:** `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`. **API:** `POST /workflows`, `POST /workflows/{id}/publish`, `GET /workflows/{id}/runs`.
- **Accept:** activating subscribes triggers; a run executes node-by-node with a visible trace; agent nodes invoke the agent runtime.

### 14.16 `/(app)/ads`  (V1)
- **Purpose:** boost posts + manage campaigns across networks; see insights.
- **Components:** AdAccountConnect, BoostDialog (pick post → audience/budget/duration), CampaignTable, InsightsCharts (spend/clicks/conversions/revenue), guardrail note (agent caps).
- **Reads/Writes:** `ad_accounts`, `ad_campaigns`, `ad_insights_daily`. **API:** `POST /ads/boost`, `GET/POST /ads/campaigns`, `GET /ads/insights`.
- **Accept:** boost converts an organic post to a paid ad; insights reconcile with attribution revenue; Ads Optimizer agent can reallocate within caps.

### 14.17 `/(app)/launches/[id]`  (V2 — Product Launch Assistant)
- **Purpose:** orchestrate a launch (PH/HN/X/Reddit/email) with playbook + tasks + war room.
- **Components:** PlaybookPicker, RunwayChecklist (`launch_tasks` w/ owners + timing + linked assets), AssetGenerators (per channel), LaunchDayWarRoom (live timeline, agent-driven posting/replies), PostMortem.
- **Reads/Writes:** `launches`, `launch_tasks`, linked `campaigns`/`posts`. **API:** `POST /launches`, `GET/POST /launches/{id}/tasks`.
- **Accept:** generating a launch produces a dated task list with pre-written assets; war room fires scheduled actions on the day; Launch Captain agent can run it.

### 14.18 `/(app)/marketplace`  (V2 — Agent Marketplace)
- **Purpose:** browse/install agents + templates; publish your own.
- **Components:** AgentGrid (category/rating/price), AgentDetail (manifest: tools, required scopes, config, pricing, reviews, sandboxed trace), InstallButton (scope-consent → creates `agent`), PublisherConsole (submit→review).
- **Reads/Writes:** `marketplace_agents`, `marketplace_installs`, `agents`. **API:** `GET /marketplace/agents`, `POST /marketplace/agents/{id}/install`, publish endpoints.
- **Accept:** install requests explicit scope consent; installed agent is org-scoped + guardrailed; paid installs bill via Stripe Connect rev-share; review gate before publish.

### 14.19 `/(app)/affiliates`  (V2 — Affiliate Program Manager)
- **Purpose:** run affiliate programs; track referrals; pay out.
- **Components:** ProgramSetup (commission type/value, cookie window, threshold), AffiliateTable, LinkGenerator, ReferralLedger (via identity graph), PayoutRunner (Stripe Connect).
- **Reads/Writes:** `affiliate_programs`, `affiliates`, `referrals`, `payouts`. **API:** `/affiliates/*`, `/referrals`, `/payouts`.
- **Accept:** referral attributed through identity graph → commission accrues → payout via Connect when threshold met.

### 14.20 Settings cluster
- `/settings/members` (RBAC invites: `POST /invites`), `/settings/api-keys` (create→show-once→revoke), `/settings/billing` (Stripe portal, per-account preview, AI credit balance/usage), `/settings/white-label` (logo/colors/domain → `brand_settings`), `/settings/webhooks` (endpoint + events + secret + delivery log + test-fire).
- **Accept:** key shown once then hashed; billing preview matches graduated tiers; white-label changes theme app-wide with no LaunchOS leakage; webhook test delivers a signed payload.

---

## Appendix A — Build order checklist (for the coding agent)

1. Scaffold: Postgres + `launchos_schema.sql` + RLS + migrations (Prisma/Drizzle/Atlas) → seed `platforms`.
2. Auth/org/membership/api-keys + RLS context middleware + audit_log.
3. OpenAPI 3.1 spec → generate Node/Python SDK + MCP server skeleton + docs.
4. `ChannelProvider` interface + one wrapped provider (5 channels) + hosted OAuth connect.
5. Media upload → Posts/Targets → durable publish-scheduler (Temporal/BullMQ) → status webhooks (outbox).
6. Analytics sync workers → rollups → dashboard.
7. AI gateway (`ai_jobs` ledger, prompt registry, RAG over `knowledge_chunks`) → Viral Generator → Campaign Brain.
8. Attribution pixel/SDK + ingest + identity stitching + models + report; journey timeline.
9. Inbox (read+reply) + contacts CRM.
10. Billing (Stripe per-account + AI credits/usage_records).
11. App screens per §14 (MVP set), white-label theming, settings.
12. Then V1 systems (agents runtime → competitor intel → landing → experiments → workflows → full channels/ads/WhatsApp), then V2.

## Appendix B — Tech stack summary
Next.js/React/TS/Tailwind/shadcn · Fastify/Nest or Next route handlers · Postgres 16 + pgvector + RLS · Redis · Temporal (or BullMQ) · S3/R2 · OpenAPI-3.1→SDKs+MCP · Stripe (+Connect) · Anthropic/OpenAI via AI gateway · React Flow + block editor · ClickHouse/Timescale (scale) · Vercel/Fly/AWS. SOC 2 + GDPR from V1.
