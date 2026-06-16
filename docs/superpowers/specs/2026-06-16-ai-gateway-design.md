# AI Gateway — Design

**Date:** 2026-06-16
**Status:** Approved (pending written-spec review)
**Phase:** P1.3 (production foundation — third sub-project)
**Source:** `docs/IMPLEMENTATION-ROADMAP.md` §4.3, `LaunchOS-Spec.md` §6, claude-api skill (model IDs/SDK)

---

## 0. Context & decisions

The spec (§6) mandates one **AI gateway** that routes every model call — nothing calls a model
SDK directly. This gives cost metering, budget caps, routing, and (later) caching/RAG/guardrails
in one place. No feature consumes it yet (Viral Generator and Campaign Brain are P2); this
sub-project builds the seam, the cost ledger, and budget enforcement so those features can plug in.

Decisions locked during brainstorming:
- **Scope:** gateway foundation — `AIProvider` interface + task→model router + `ai_jobs` cost
  ledger + per-org budget caps + structured-JSON output. **Deferred** (no consumer yet): RAG
  over `knowledge_chunks`/pgvector, the versioned prompt registry (`prompt_templates`), and
  content guardrails.
- **Providers:** a deterministic **MockAIProvider** for dev/test (no network) and a real
  **AnthropicProvider** (`@anthropic-ai/sdk`) for prod. Selected by `ANTHROPIC_API_KEY`
  presence — same env-driven split as the DB driver and ChannelProvider.
- **Budget source:** a per-org monthly cap in cents, defaulting from `AI_BUDGET_CENTS_DEFAULT`
  (env) with a per-org override in `organizations.feature_flags.ai_budget_cents` (column
  already exists). No new budget schema.
- **Model defaults (from the claude-api skill):** `claude-opus-4-8` for planning/generation,
  `claude-haiku-4-5` for classification. Adaptive thinking (`thinking: {type:"adaptive"}`) on
  planning tasks; effort via `output_config.effort`. Pricing: opus-4-8 $5/$25, haiku-4-5
  $1/$5, sonnet-4-6 $3/$15 per MTok.

---

## 1. Architecture

```
lib/ai/
  provider.ts     AIProvider interface + CompletionRequest / AIResult types
  mock.ts         MockAIProvider — deterministic, no network (dev/test default)
  anthropic.ts    AnthropicProvider — wraps @anthropic-ai/sdk (prod)
  router.ts       route(task) -> { model, effort, thinking? }
  pricing.ts      PRICING table + costCents(model, usage)
  budget.ts       orgBudgetCents(db, orgId) + assertWithinBudget(db, orgId, addCents)
  gateway.ts      run(db, input) -> AIRunResult  (the only public entrypoint)
```

### 1.1 `AIProvider` (the swap seam)
```ts
interface CompletionRequest {
  model: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  effort?: "low" | "medium" | "high" | "max";
  thinking?: boolean;            // adaptive thinking on/off
  jsonSchema?: Record<string, unknown>; // structured output (Anthropic output_config.format)
  maxTokens?: number;
}
interface AIResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}
interface AIProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<AIResult>;
}
```
- **MockAIProvider:** returns deterministic text derived from the request (e.g. a hash of the
  prompt) and a deterministic token count; when `jsonSchema` is set, returns a minimal valid
  JSON object string for that schema. No network. Default in dev/test.
- **AnthropicProvider:** `new Anthropic()` (reads `ANTHROPIC_API_KEY`); calls
  `client.messages.create({ model, max_tokens, system, messages, thinking?, output_config? })`;
  maps the text block(s) → `text` and `response.usage` → `usage`. Streaming is out of scope.

### 1.2 Provider selection
`process.env.ANTHROPIC_API_KEY` present → `AnthropicProvider`; otherwise `MockAIProvider` with a
one-time `console.warn`. Tests inject `MockAIProvider` explicitly. The gateway accepts an
optional provider arg for testability; defaults to the env-selected one.

### 1.3 Router
`route(task)` maps a task string to model + knobs:
| task | model | effort | thinking |
|---|---|---|---|
| `plan` | `claude-opus-4-8` | high | adaptive on |
| `generate` | `claude-opus-4-8` | medium | off |
| `classify` | `claude-haiku-4-5` | (n/a) | off |
| (unknown) | `claude-opus-4-8` | medium | off |
Per-org model overrides are a later concern; the map is a module constant for now.

### 1.4 Pricing
`PRICING: Record<model, { inputCentsPerMTok; outputCentsPerMTok }>` seeded from the claude-api
table. `costCents(model, usage)` = ceil((inTok·inRate + outTok·outRate) / 1_000_000), minimum
**1 cent** so every successful call is metered. Unknown model → throw (router only emits known
models; this guards drift).

---

## 2. The `ai_jobs` ledger (new table)

Add `ai_jobs` to `db/schema.ts` (native `jsonb`/`timestamptz`, like the P1.2 `jobs` table):
- `id` bigserial PK
- `org_id` text NOT NULL
- `feature` text NOT NULL (e.g. `viral_gen`, `campaign_brain`; the caller passes it)
- `task` text NOT NULL (router input)
- `model` text NOT NULL
- `status` text NOT NULL — `succeeded | failed`
- `input_tokens` int NOT NULL default 0
- `output_tokens` int NOT NULL default 0
- `cost_cents` int NOT NULL default 0
- `latency_ms` int
- `error` text
- `created_at` timestamptz NOT NULL default now()
- Index on `(org_id, created_at)` for budget sums.
- RLS: enable + force + `org_isolation` policy on `org_id`; grant `app_user`
  SELECT/INSERT/UPDATE/DELETE + sequence usage (new table needs its own grant, per P1.2).

Every `gateway.run()` writes exactly one row (succeeded or failed).

---

## 3. Budget enforcement

- `orgBudgetCents(db, orgId)`: read `organizations.feature_flags` (JSON text); if it has a
  numeric `ai_budget_cents`, use it; else `Number(process.env.AI_BUDGET_CENTS_DEFAULT)` (default
  e.g. 100_000 = $1,000/mo if unset).
- `assertWithinBudget(db, orgId, addCents)`: sum `ai_jobs.cost_cents` for the org in the current
  calendar month; if `spent + addCents > cap`, throw `ApiError(402, "budget_exceeded", …)`.
- The gateway checks budget **before** dispatch using a small fixed estimate (since real cost is
  only known after the call). The estimate is conservative; exact cost is recorded post-call.
  (A tighter pre-estimate via token counting is a later refinement.)

---

## 4. Data flow — `gateway.run()`

```
run(db, { orgId, feature, task, system?, messages, jsonSchema?, provider? }) :
  1. { model, effort, thinking } = route(task)
  2. assertWithinBudget(db, orgId, ESTIMATE_CENTS)        // throws 402 if over
  3. t0 = now
  4. try:
       result = provider.complete({ model, system, messages, effort, thinking, jsonSchema })
       cost = costCents(model, result.usage)
       insert ai_jobs(succeeded, tokens, cost, latency = now - t0)
       return { text: result.text, json?: parsed, usage, costCents: cost, model }
     catch e:
       insert ai_jobs(failed, error = msg, latency = now - t0, cost 0)
       rethrow as ApiError(502, "ai_provider_error", …)  // budget_exceeded passes through
```
When `jsonSchema` is set, `json` is `JSON.parse(text)` (Mock returns valid JSON; Anthropic
constrained by `output_config.format`).

---

## 5. Error handling

- **Over budget:** `ApiError(402, "budget_exceeded", …)` thrown before any provider call; a
  `failed` ai_jobs row (cost 0) is recorded for audit.
- **Provider error:** caught; `failed` row with `error`; rethrown as
  `ApiError(502, "ai_provider_error", …)`. The Anthropic SDK already retries 429/5xx internally.
- **No `ANTHROPIC_API_KEY` in prod:** not a crash — provider selection falls back to Mock with a
  logged warning. Real key enables real calls.
- All errors are the existing RFC-9457 problem+json shape at the API layer (when a route later
  calls the gateway).

---

## 6. Testing (TDD)

- `pricing` — cost math per model; ceil rounding; 1¢ minimum; unknown model throws.
- `router` — each task → expected model/effort/thinking; unknown task → default.
- `mock` — deterministic text for a given request; `jsonSchema` → valid parseable JSON.
- `budget` — under cap passes; at/over cap throws 402; per-org `feature_flags.ai_budget_cents`
  overrides the env default; sum scoped to current month + org.
- `gateway` — happy path writes one `succeeded` ai_jobs row with tokens + cost > 0 and returns
  text; over-budget writes `failed` + throws 402; provider error writes `failed` + throws 502;
  structured request returns parsed `json`. All against MockAIProvider + the in-memory test DB.
- All 54 existing tests remain green.

---

## 7. Out of scope (deferred, with named seams)

- **RAG** (`knowledge_documents`/`knowledge_chunks`, pgvector embeddings, retrieval) — added with
  the first feature that grounds generation (Viral Generator, P2).
- **Prompt registry** (`prompt_templates`, versioned templates + eval harness) — P2.
- **Guardrails** (PII, brand-safety, platform-policy pre/post filters) — P2/security pass.
- **Streaming**, response **caching**, additional providers (OpenAI/Llama/image) — later behind
  `AIProvider`.
- The P2 features that actually call `gateway.run()`.

---

## 8. Acceptance criteria

- No feature imports a model SDK directly; the only path to a model is `lib/ai/gateway.run()`.
- Every `run()` writes exactly one `ai_jobs` row (succeeded or failed) with org_id, feature,
  task, model, token counts, `cost_cents`, and latency.
- Budget cap is enforced before dispatch; exceeding it throws and is recorded; a per-org
  `feature_flags.ai_budget_cents` override beats the env default.
- Dev/test run fully offline on `MockAIProvider`; setting `ANTHROPIC_API_KEY` switches to real
  Anthropic calls with no code change (model `claude-opus-4-8`, adaptive thinking on planning).
- `ai_jobs` is org-isolated by RLS (cross-org rows invisible) and granted to `app_user`.
- All tests pass (54 existing + new pricing/router/mock/budget/gateway); build green; no secrets
  logged.
