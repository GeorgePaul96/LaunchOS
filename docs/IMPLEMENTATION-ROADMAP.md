# LaunchOS — Full Implementation Roadmap

> **Purpose:** the master reference for building all of LaunchOS, from the current state to
> the complete product. Derived from `LaunchOS-Spec.md` (product spec) and
> `launchos_schema.sql` (canonical Postgres schema). Read those two first; this document is
> the execution plan that sequences every feature into shippable phases with concrete scope,
> data, APIs, screens, workers, dependencies, and acceptance criteria.
>
> **Status legend:** ✅ done · 🟡 partial · ⬜ not started.
> **Last updated:** 2026-06-13.

---

## 0. How to read this document

Each system below is specified as an implementable unit:
- **Scope** — what it does and where it stops.
- **Data** — the canonical tables it owns (all already defined in `launchos_schema.sql`).
- **API** — the `/v1` endpoints it adds (from spec §3.2).
- **Workers** — durable/background jobs it needs.
- **Screens** — the app routes (from spec §14).
- **Depends on** — systems that must exist first.
- **Acceptance** — the bar for "done."

Phases (§2) bundle these systems into releases. The dependency graph (§3) is the source of
truth for ordering; the phases are the recommended path through it.

The guiding architectural rule from the spec never changes: **the identity graph +
touchpoint/conversion ledger is the unifying primitive. Everything publishes touchpoints;
everything reads attribution.** Build outward from that core.

---

## 1. Current state (what already exists)

### 1.1 ✅ Core Flywheel Slice (shipped)
The first runnable vertical slice is complete, tested, and committed
(`docs/superpowers/plans/2026-06-13-core-flywheel-slice.md`):

- **Stack:** Next.js 16 (App Router) modular monolith; SQLite via libsql (Postgres-shaped);
  Drizzle ORM; Vitest. `org_id` filtering substitutes for Postgres RLS.
- **Built:** auth (email/password + signed-cookie sessions), org/profile/membership model,
  `ChannelProvider` interface + `MockChannelProvider`, post/target lifecycle + in-process
  scheduler, identity stitching, touchpoint/conversion ingest, first/last/linear attribution
  models + channel revenue report, contact journey timeline, RFC-9457 errors,
  Idempotency-Key, seeded demo org, and 6 screens (dashboard, compose, calendar, analytics,
  contact, connections).
- **Verified:** 36 unit/integration tests pass, production build green, end-to-end flywheel
  confirmed over HTTP.

### 1.2 Gap to the full product
Everything else in the spec. The slice proves the wedge; the rest is substrate parity with
Zernio plus the 11 remaining differentiating systems, plus the production-grade foundation
(real Postgres+RLS, durable runtime, AI gateway, billing, SDK/MCP, security/compliance).

---

## 2. Phase plan (the recommended path)

| Phase | Theme | Outcome | Systems |
|------|-------|---------|---------|
| **P0** ✅ | Wedge | Flywheel slice runs locally | §1.1 |
| **P1** ✅ | Production foundation | The slice, but production-grade & multi-tenant-safe | ✅ Postgres+RLS; ✅ durable jobs; ✅ AI gateway; ✅ OpenAPI/SDK/MCP; ✅ observability/security (logging, request-id, audit, rate-limit; metrics/governor deferred). Billing deferred (low value for personal use). |
| **P2** 🔄 | MVP completion | Spec §11 fully met | ✅ Viral Generator; ⬜ real wrapped provider (5 channels), Campaign Brain, inbox read+reply, attribution pixel |
| **P3** ⬜ | Substrate parity | Full Zernio parity | All 15 channels, ads, WhatsApp numbers, broadcasts, sequences, comment-to-DM automations, webhooks |
| **P4** ⬜ | Intelligence & autonomy | 8 of 12 new systems | Agent runtime, Competitor Intel, Landing Pages, Experiments, Workflow Builder, Attribution v2 |
| **P5** ⬜ | Ecosystem & native | Remaining systems + margin/scale | Native platform adapters (top 5), Launch Assistant, Agent Marketplace, Affiliate Manager, Attribution v3, columnar analytics, enterprise (SSO/SCIM, residency), SOC 2 Type II |

Maps to the spec's MVP (P1+P2) → V1 (P3+P4) → V2 (P5). Rough order-of-magnitude effort for a
small senior team: P1 ~4–6 wks, P2 ~4–6 wks, P3 ~10–14 wks, P4 ~12–16 wks, P5 ~16–24 wks.

---

## 3. Dependency graph (what unblocks what)

```
P0 flywheel ✅
   └─> P1 Postgres+RLS ──> P1 durable jobs ──> (everything durable: broadcasts, sequences,
        │                                        agents, experiments, competitor polling)
        ├─> P1 AI gateway ──> Viral Gen, Campaign Brain, Agents, Competitor briefs, Landing gen
        ├─> P1 billing ─────> usage metering for accounts + AI credits + marketplace/affiliates
        └─> P1 OpenAPI ─────> SDKs + MCP server + typed agent tool registry

   identity graph + touchpoints (✅ exists) ──> Attribution v2/v3, Journeys, Experiments,
                                                 Affiliate referral tracking, Landing forms

   ChannelProvider (✅ interface) ──> wrapped provider (P2) ──> native adapters (P5)

   Agent runtime (P4) ──> Marketplace (P5), Workflow agent-nodes (P4), Launch Captain (P5)
```

**Hard rule:** do P1 before scaling features. Building 11 systems on SQLite-without-RLS,
cron-and-pray jobs, and direct model calls would create rework debt the spec explicitly warns
against.

---

## 4. P1 — Production foundation (cross-cutting)

### 4.1 ✅ Postgres + RLS migration
- **Scope:** move from SQLite/libsql to Postgres 16; apply `launchos_schema.sql` verbatim
  (it is already the canonical schema); enable Row-Level Security on every org-scoped table
  with policies keyed on `app.current_org`; service workers use a `BYPASSRLS` role. Keep the
  `org_id` query filters as defense-in-depth.
- **Data:** the full `launchos_schema.sql` (60+ tables, `pgvector`, `citext`, `pg_trgm`).
- **Migration tooling:** Drizzle/Atlas migrations; port `db/schema.ts` types to `pg-core`
  (per the divergence header in that file). Re-point the libsql client to `node-postgres`.
- **Acceptance:** RLS proven — a request with org A's context cannot read org B rows even
  with a crafted query; all existing tests pass against Postgres; `attribution_results.credit`
  moves back to `numeric` fractions.

### 4.2 ✅ Durable job/workflow runtime (Postgres-backed queue)
- **Scope:** replace the in-process poller with **Temporal** (or BullMQ + leader-elected
  scheduler). Workflows: publish-scheduler (exact-time), inbox-sync, analytics-sync,
  webhook-dispatch (HMAC + retry + DLQ), broadcast-sender, sequence-stepper, competitor-poller,
  attribution-resolver, agent-runtime, experiment-evaluator. Outbox pattern for events.
- **Data:** uses existing tables; add a transactional `outbox` table.
- **Acceptance:** exact-time publishing survives a restart; retries are deterministic; no
  double-fire (idempotent) and no lost events (outbox).

### 4.3 ✅ AI gateway
- **Scope:** single chokepoint for every model call (spec §6). Model routing by task,
  prompt registry (`prompt_templates`), RAG over `knowledge_chunks` (pgvector) + `brand_voice`,
  structured outputs, pre/post guardrails (PII, brand-safety, platform-policy), cost ledger
  (`ai_jobs` + `usage_records`), per-org budget caps, eval harness with golden sets.
- **Data:** `ai_jobs`, `prompt_templates`, `knowledge_documents`, `knowledge_chunks`.
- **API:** internal library; no public endpoint (features call it).
- **Acceptance:** no feature imports a model SDK directly; every call writes an `ai_jobs` row
  with token counts + `cost_cents`; budget cap blocks dispatch when exceeded; prompt changes
  gated by eval regression.

### 4.4 ⬜ Billing (Stripe)
- **Scope:** per-connected-account graduated pricing + AI-credit metering (spec §8). Stripe
  customer/subscription mirror on `organizations`; usage metering via `usage_records` →
  Stripe; plan gating of capacity/autonomy (not features). Connect scaffolding for later
  marketplace/affiliate payouts.
- **Data:** `usage_records`, `organizations.stripe_*`.
- **API:** `/settings/billing` portal hooks; Stripe webhooks.
- **Acceptance:** connecting account #3 shows the correct graduated price; AI usage accrues
  credits; overage metered; billing preview matches tiers.

### 4.5 ✅ OpenAPI 3.1 → SDK + MCP (TS; Python/others later)
- **Scope:** author OpenAPI 3.1 as the single source of truth for the `/v1` surface; generate
  Node + Python SDKs (Stainless/Speakeasy-style); generate the hosted **MCP server**
  (`mcp.launchos.com/mcp`, OAuth or Bearer); the same definitions produce the typed tool
  registry the agent runtime consumes.
- **Acceptance:** `POST /posts` etc. callable from the generated Node SDK and from an MCP
  client (Claude/Cursor); docs render from the spec; one definition powers REST + SDK + MCP.

### 4.6 ✅ Observability & security baseline (logging/request-id/audit/rate-limit; metrics+governor deferred)
- **Scope:** structured logging (no PII/secrets), request IDs end-to-end, metrics/traces,
  audit_log writes on every mutating action, edge rate limiting + per-platform token-bucket
  governor (Redis), envelope-encrypted `oauth_credentials` with `key_version` rotation, API
  keys as SHA-256 only.
- **Acceptance:** tokens never logged or returned; audit trail complete; rate limits enforced
  with `X-RateLimit-*` headers.

---

## 5. P2 — MVP completion (spec §11)

### 5.1 ⬜ Real wrapped ChannelProvider (5 channels)
- **Scope:** implement a `ChannelProvider` against a unified provider (Zernio/Ayrshare/Unipile)
  behind the existing interface, for X, LinkedIn, Instagram, TikTok, + Threads/Bluesky bonus.
  Hosted OAuth connect flow; real publish; basic analytics sync; inbox read + DM reply for 2
  platforms.
- **Data:** `social_accounts`, `oauth_credentials`, `post_targets`, `post_metrics`,
  `account_metrics_daily`, `conversations`, `messages`.
- **API:** `/connect/{platform}`, `/connect/callback`, `/accounts`, `/accounts/{id}/health`,
  `/analytics/*`, `/inbox/*`.
- **Workers:** publish-scheduler (real), analytics-sync, inbox-sync.
- **Screens:** `/settings/connections` (real OAuth), `/inbox` (read+reply).
- **Depends on:** P1 (durable jobs, rate governor, token vault).
- **Acceptance:** 5-min time-to-first-post; per-target failures isolated + retryable; tokens
  server-side only; metrics populate the dashboard.

### 5.2 ✅ Viral Content Generator v1
- **Scope:** generate scored content variants (hooks/threads/reels/carousels/repurpose),
  grounded in brand voice, with per-variant predicted score + rationale via the AI gateway;
  "use in composer." (RAG over org winners + closed-loop training deferred — see spec §8.)
- **Data:** `content_generations`, `content_variants` (linked to the `ai_jobs` cost ledger);
  `content_variants.posted_post_id` reserved for the closed loop (P4).
- **API:** `POST /content/generate`, `GET /content/generations`,
  `POST /content/variants/{id}/choose` — also in the OpenAPI spec, the SDK (`content.*`), and a
  `generate_content` MCP tool.
- **Screens:** `/content-studio`; chosen variant prefills `/compose?content=`.
- **Depends on:** AI gateway.
- **Status:** done 2026-06-17. Spec: `docs/superpowers/specs/2026-06-17-viral-content-generator-design.md`;
  plan: `docs/superpowers/plans/2026-06-17-viral-content-generator.md`. 117 tests green.

### 5.3 ⬜ AI Campaign Brain v1
- **Scope:** goal → plan (calendar + channel mix + budget split + asset briefs + KPIs);
  manual approve materializes draft assets into composer/calendar; re-plan on demand.
- **Data:** `campaigns`, `campaign_assets`.
- **API:** `POST /campaigns`, `POST /campaigns/{id}/plan|approve|launch`,
  `GET /attribution/report?campaign_id=`.
- **Screens:** `/campaigns/[id]`.
- **Depends on:** AI gateway, Viral Gen, attribution (✅).
- **Acceptance:** plan is concrete + editable; approving creates real draft posts; results
  panel reads attributed outcomes, not vanity metrics.

### 5.4 ⬜ Attribution pixel + journey hardening
- **Scope:** embeddable `pixel.js` + public ingest for `/attribution/identify|touchpoints|
  conversions`; wire form/landing submissions to touchpoints; harden identity stitching.
- **Data:** `identities`, `touchpoints`, `conversions` (✅ models exist).
- **Acceptance:** a browser click on a published post records a touchpoint; a conversion ties
  back through the identity graph; report reconciles.

**P1 + P2 = spec MVP success metric met:** time-to-first-attributed-signup < 1 day.

---

## 6. P3 — Substrate parity (full Zernio parity)

### 6.1 ⬜ All 15 channels (via providers)
- **Scope:** extend the wrapped provider to all 12 social + 3 messaging channels; per-platform
  capability badges; per-target option handling (threads, first-comment, carousels, boards,
  subreddits, stories).
- **Data:** `platforms` (seed all), `post_targets.options`.
- **Acceptance:** each channel publishes with its platform-specific options; capability matrix
  drives the composer UI.

### 6.2 ⬜ Ads (boost + campaigns)
- **Scope:** connect ad accounts; boost an organic post → paid ad; create/manage campaigns on
  Meta/Google/X first; insights sync; reconcile ad revenue into attribution.
- **Data:** `ad_accounts`, `ad_campaigns`, `ad_insights_daily`.
- **API:** `/ads/accounts`, `/ads/campaigns`, `/ads/boost`, `/ads/insights`.
- **Screens:** `/ads`.
- **Workers:** ad-insights-sync.
- **Acceptance:** boost converts an organic post to an ad; insights reconcile with attribution
  revenue.

### 6.3 ⬜ WhatsApp numbers + messaging stack
- **Scope:** purchase dedicated numbers (provider/BSP + KYC state machine); WhatsApp templates;
  inbound/outbound messaging.
- **Data:** `whatsapp_numbers`, `conversations`, `messages`.
- **API:** `/whatsapp/numbers` (GET/POST/DELETE).
- **Acceptance:** one API call provisions a number through KYC states to `active`; templated
  sends work.

### 6.4 ⬜ Broadcasts, Sequences, Comment-to-DM automations
- **Scope:** bulk messaging with recipients + scheduling; drip sequences with steps +
  enrollments + stepper; keyword-triggered comment→auto-DM + auto-reply with logs.
- **Data:** `broadcasts`, `broadcast_recipients`, `sequences`, `sequence_steps`,
  `sequence_enrollments`, `automations`, `automation_logs`.
- **API:** `/broadcasts/*`, `/sequences/*`, `/automations/*`.
- **Workers:** broadcast-sender, sequence-stepper, automation-trigger.
- **Acceptance:** a broadcast sends to ≤1000 recipients with per-recipient status; a sequence
  advances on schedule; a keyword comment fires the DM + reply and logs it.

### 6.5 ⬜ Webhooks
- **Scope:** customer-facing webhook endpoints; HMAC-signed, timestamped, retried to DLQ;
  events for post status, messages, comments; test-fire + delivery log.
- **Data:** `webhook_endpoints`, `webhook_deliveries`.
- **API:** `/webhooks` (GET/POST/DELETE).
- **Workers:** webhook-dispatch (via outbox).
- **Acceptance:** a state change delivers a signed payload; failures retry then DLQ; test-fire
  works from settings.

### 6.6 ⬜ CLI + 8-language SDKs + white-label
- **Scope:** `@launchos/cli`; generate the remaining 6 SDKs from OpenAPI; white-label
  (custom domain + `brand_settings` theme injection, no LaunchOS branding leak).
- **Acceptance:** CLI logs in and posts; white-label changes theme app-wide.

---

## 7. P4 — Intelligence & autonomy (8 of 12 new systems)

### 7.1 ⬜ Autonomous Agent runtime
- **Scope:** durable agents = (role, goal, tools[], policies[], autonomy_level, schedule,
  budget). Run = durable workflow with full step trace + optional human approvals. Autonomy
  ladder suggest→approve→auto capped by org policy; guardrails-as-data (spend/rate/content/
  mandatory-approval); kill-switch. Ship Community Manager, Ads Optimizer, Researcher
  first-party. Tools = the LaunchOS API via the typed registry (shared with MCP).
- **Data:** `agents`, `agent_policies`, `agent_runs`, `agent_steps`, `agent_approvals`.
- **API:** `/agents`, `/agents/{id}/{run,pause,stop}`, `/agents/{id}/runs`, `/runs/{id}/steps`,
  `/approvals/{id}/{approve,reject}`.
- **Screens:** `/agents/[id]` (config, run trace, approval queue, kill-switch).
- **Depends on:** durable runtime, AI gateway, OpenAPI tool registry.
- **Acceptance:** autonomy ceiling enforced server-side; `auto` blocked when a policy trips;
  every action in the replayable trace; budget cap halts the run; kill-switch immediate.

### 7.2 ⬜ Competitor Intelligence Engine
- **Scope:** track competitors' organic + paid content (public APIs + ad libraries); detect
  viral posts / new ads / posting spikes / pricing changes; "steal this angle" briefs.
- **Data:** `competitors`, `competitor_content` (+ embedding), `intel_alerts`.
- **API:** `/competitors`, `/competitors/{id}/content`, `/intel/alerts`.
- **Screens:** `/competitors`.
- **Workers:** competitor-poller.
- **Acceptance:** a competitor viral post raises an alert; brief generation uses the actual
  competitor post as RAG context.

### 7.3 ⬜ Landing Page Generator + forms
- **Scope:** block-based AI-generated pages tied to campaigns; form builder; published pages
  serve at slug/custom domain; form submit creates contact + identity + touchpoint
  (attribution-wired); A/B-native via experiments.
- **Data:** `landing_pages`, `landing_page_versions`, `forms`, `form_submissions`.
- **API:** `/landing-pages`, `/landing-pages/{id}/{publish,versions}`, `/forms`,
  `/forms/{id}/submissions`.
- **Screens:** `/landing/[id]` (block editor).
- **Acceptance:** published page serves; form submit wires a touchpoint; A/B routes traffic.

### 7.4 ⬜ Growth Experiment Engine
- **Scope:** hypothesis → variants (post/page/ad/sequence) → traffic split → significance →
  auto-promote winner; experiment ledger.
- **Data:** `experiments`, `experiment_variants`, `experiment_events`.
- **API:** `/experiments`, `/experiments/{id}/{start,conclude,variants,events}`.
- **Screens:** `/experiments/[id]`.
- **Workers:** experiment-evaluator.
- **Acceptance:** traffic splits per allocation; significance computed; winner promotion updates
  the underlying asset.

### 7.5 ⬜ Marketing Workflow Builder
- **Scope:** visual trigger→condition→action(+agent) graph; LaunchOS-native triggers; runs
  execute node-by-node with a visible trace; agent nodes invoke the agent runtime.
- **Data:** `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`.
- **API:** `/workflows`, `/workflows/{id}/{publish,run,runs}`.
- **Screens:** `/workflows/[id]` (React Flow canvas).
- **Acceptance:** activating subscribes triggers; a run executes with a trace; agent nodes work.

### 7.6 ⬜ Attribution v2 + Journeys UI
- **Scope:** add time-decay + first data-driven (Markov/Shapley-lite) models; harden identity
  graph; journey stage definitions + funnel analytics.
- **Data:** `attribution_results` (new models), `journeys`.
- **API:** `/attribution/report?model=time_decay|data_driven`, `/journeys`.
- **Acceptance:** model switch recomputes credit; data-driven model validated against held-out
  conversions.

**V1 = full substrate parity (P3) + 8 new systems (P4).**

---

## 8. P5 — Ecosystem, native integrations, enterprise scale (V2)

### 8.1 ⬜ Native platform adapters (top 5)
- **Scope:** own native integrations for Instagram, X, LinkedIn, TikTok, WhatsApp behind the
  same `ChannelProvider` seam; dedicated app-credential pools; improves margin + reliability +
  rate-limit headroom. Swap is invisible above the interface.
- **Acceptance:** top-5 traffic served by native adapters; per-tenant rate governor uses
  dedicated pools; no caller code changes.

### 8.2 ⬜ Product Launch Assistant
- **Scope:** opinionated launch playbooks (PH/HN/X/Reddit/email); dated task list with owners;
  pre-written assets; launch-day war room; Launch Captain agent drives it.
- **Data:** `launches`, `launch_tasks`.
- **API:** `/launches`, `/launches/{id}/tasks`.
- **Screens:** `/launches/[id]`.
- **Acceptance:** generating a launch produces a dated task list with assets; war room fires
  scheduled actions; Launch Captain can run it.

### 8.3 ⬜ Agent Marketplace
- **Scope:** publish/install agents + workflow templates; manifest (tools, scopes, config,
  pricing); install creates a scoped agent with consent; rev-share via Stripe Connect; review
  + sandbox before publish.
- **Data:** `marketplace_agents`, `marketplace_installs`, `agents`.
- **API:** `/marketplace/agents`, `/marketplace/agents/{id}/install`, `/marketplace/reviews`.
- **Screens:** `/marketplace`.
- **Depends on:** agent runtime, billing/Connect.
- **Acceptance:** install requests explicit scope consent; paid installs bill rev-share;
  review gate before publish.

### 8.4 ⬜ Affiliate Program Manager
- **Scope:** programs, affiliate links, referral tracking via the identity graph, commission
  rules, Stripe Connect payouts; dogfood LaunchOS's own program.
- **Data:** `affiliate_programs`, `affiliates`, `referrals`, `payouts`.
- **API:** `/affiliates/*`, `/referrals`, `/payouts`.
- **Screens:** `/affiliates`.
- **Acceptance:** referral attributed through identity graph → commission accrues → payout via
  Connect at threshold.

### 8.5 ⬜ Attribution v3 + trained virality model
- **Scope:** full Markov/Shapley data-driven attribution; virality model trained on
  `content_variants.predicted_score` vs actual `post_metrics` (closed loop); bring-your-own
  model keys.
- **Acceptance:** trained model beats LLM-judge baseline on held-out engagement.

### 8.6 ⬜ Enterprise + scale-out
- **Scope:** SSO/SCIM, MFA, data residency (US/EU) GA, dedicated credential pools, SLA;
  columnar analytics sink (ClickHouse/Timescale) for `post_metrics`/`touchpoints`/`conversions`/
  `experiment_events`; partition append-only tables by month; CQRS-lite materialized rollups;
  pgvector → dedicated vector store if embeddings ≫ tens of millions; SOC 2 Type II + trust +
  status portals; embeddable widget SDK.
- **Acceptance:** scaling bottlenecks from spec §10 each addressed; SOC 2 Type II achieved;
  enterprise tenants on dedicated pools + residency.

---

## 9. Cross-cutting concerns (apply in every phase)

- **Multi-tenancy:** `org_id` on every tenant row + RLS (from P1); workers carry org context.
- **Security (spec §9):** envelope-encrypted tokens, SHA-256 API keys, scoped OAuth2, agent
  identities with audit trails, prompt-injection defenses on agent tool use, content
  moderation + platform-policy filters, GDPR/CCPA export+delete, retention windows.
- **Testing:** TDD for service logic (the pattern from P0); contract tests against OpenAPI;
  golden-set evals for AI features with regression gates; load tests for the job runtime.
- **AI cost control:** gateway caching, model routing, batched low-priority jobs, per-org
  budgets, pre-computed scores; agents carry hard `budget_cents` ceilings.
- **DevOps:** migrations gated in CI; OpenAPI diff checks; SDK/MCP regeneration pinned and
  signed; dependency scanning; the 280+ tool surface reviewed as code.

---

## 10. Migration notes: SQLite slice → Postgres production

The slice was built Postgres-shaped on purpose. To productionize (P1.1):
1. Stand up Postgres 16; run `launchos_schema.sql` (already canonical — no rewrite).
2. Port `db/schema.ts` from `sqlite-core` to `pg-core` per its header divergence table
   (uuid/timestamptz/jsonb/text[]/bigint identity/numeric all become native again).
3. Swap the libsql client for `node-postgres`; set `app.current_org` per request/job; enable
   RLS policies; keep `org_id` filters as defense-in-depth.
4. Revert `attribution_results.credit` from basis-points integer to `numeric` fractions.
5. Re-run the test suite against Postgres (tests are driver-agnostic at the service layer).

---

## 11. Risk register

| Risk | Phase | Mitigation |
|------|-------|-----------|
| Shared-app platform quota cliff | P2–P3 | Per-tenant token-bucket governor + multi-provider + native pools (P5) |
| Exact-time scheduling at scale | P1 | Temporal/durable runtime from the start |
| AI cost runaway | P1–P4 | Gateway budgets, routing, caching, agent ceilings |
| Agent acting unsafely | P4 | Guardrails-as-data, autonomy ladder, mandatory-approval classes, kill-switch, replayable trace |
| Data growth on Postgres | P5 | Partition append-only tables; columnar sink; CQRS rollups |
| Provider lock-in | P3→P5 | `ChannelProvider` seam; swap wrap→native invisibly |
| Compliance gap vs Zernio | P5 | SOC 2 Type II + trust/status portals early in V2 |

---

## 12. Definition of done (whole product)

Full Zernio substrate parity **plus** all 12 differentiating systems live, on Postgres+RLS
with a durable runtime, AI gateway, billing, OpenAPI-generated SDKs + MCP, native adapters for
the top 5 channels, agent marketplace + affiliate program operating, attribution v3, and SOC 2
Type II — i.e. spec Parts 11→13 fully delivered, with the identity-graph/touchpoint core
unchanged throughout.
