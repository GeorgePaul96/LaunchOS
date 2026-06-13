-- =============================================================================
-- LaunchOS — Canonical Database Schema (PostgreSQL 16+)
-- =============================================================================
-- Conventions:
--   * Every tenant-scoped row carries org_id. Row-Level Security keys off it.
--   * Primary keys are UUID v7-ish (time-ordered) generated app-side or via
--     gen_random_uuid(). External (API-facing) IDs are prefixed text (see id_prefix()).
--   * timestamptz everywhere, stored UTC. created_at/updated_at on every table.
--   * Soft delete via deleted_at where history matters; hard delete otherwise.
--   * Money stored as integer minor units (cents) + currency char(3). Never float.
--   * Enums implemented as text + CHECK for forward-compat (cheap to extend,
--     no ALTER TYPE locking pain). Lookup-heavy ones use real enums.
--   * JSONB for platform-specific payloads that we don't query relationally.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive email columns
CREATE EXTENSION IF NOT EXISTS "vector";       -- pgvector for embeddings/RAG
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- fuzzy search on contacts/content
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Helper: prefixed public IDs (org_, post_, acc_...) generated app-side normally;
-- this is a fallback for SQL-created rows.
CREATE OR REPLACE FUNCTION id_prefix(p text)
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT p || '_' || replace(gen_random_uuid()::text, '-', '');
$$;

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- =============================================================================
-- 1. IDENTITY, TENANCY, BILLING
-- =============================================================================

CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('org'),
  name            text NOT NULL,
  slug            text UNIQUE NOT NULL,
  plan            text NOT NULL DEFAULT 'free'
                  CHECK (plan IN ('free','starter','growth','scale','enterprise')),
  -- Stripe mirror
  stripe_customer_id      text,
  stripe_subscription_id  text,
  billing_email   text,
  -- White-label
  is_white_label  boolean NOT NULL DEFAULT false,
  brand_settings  jsonb NOT NULL DEFAULT '{}',   -- logo, colors, custom domain
  feature_flags   jsonb NOT NULL DEFAULT '{}',
  data_residency  text NOT NULL DEFAULT 'us' CHECK (data_residency IN ('us','eu')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('user'),
  email           citext UNIQUE NOT NULL,
  email_verified_at timestamptz,
  name            text,
  avatar_url      text,
  password_hash   text,                 -- null when SSO-only
  mfa_secret      text,                 -- encrypted at rest (app-level)
  mfa_enabled     boolean NOT NULL DEFAULT false,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member'
                  CHECK (role IN ('owner','admin','editor','analyst','member','agent')),
  -- 'agent' = a non-human service identity (autonomous agent acting in-org)
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','invited')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role            text NOT NULL DEFAULT 'member',
  token_hash      text NOT NULL,         -- sha256 of invite token
  invited_by      uuid REFERENCES users(id),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- API keys: store ONLY sha256 hash. Prefix sk_ + 64 hex. Show once.
CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id),
  name            text NOT NULL,
  key_hash        text UNIQUE NOT NULL,   -- sha256(secret)
  key_prefix      text NOT NULL,          -- first 8 chars shown in UI for ID
  scopes          text[] NOT NULL DEFAULT '{}',
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON api_keys (org_id) WHERE revoked_at IS NULL;

-- Append-only audit log (security + compliance). Partition by month at scale.
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','api_key','agent','system')),
  actor_id        text,
  action          text NOT NULL,          -- e.g. 'post.publish','account.connect'
  target_type     text,
  target_id       text,
  ip              inet,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (org_id, created_at DESC);

-- Usage metering (drives per-connected-account billing + AI credit billing)
CREATE TABLE usage_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric          text NOT NULL,          -- 'connected_account','ai_credit','wa_message','ad_spend_passthrough'
  quantity        numeric NOT NULL,
  unit_cost_cents numeric,
  ref_type        text,
  ref_id          text,
  period          date NOT NULL,          -- billing month bucket
  reported_to_stripe boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_records (org_id, period, metric);

-- =============================================================================
-- 2. SOCIAL CORE  (Zernio parity: profiles → accounts → posts → targets)
-- =============================================================================

-- "Profiles" = brand/project workspaces grouping accounts (Zernio's term).
CREATE TABLE profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('prof'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  timezone        text NOT NULL DEFAULT 'UTC',
  brand_voice     jsonb NOT NULL DEFAULT '{}',  -- tone, banned words, examples (fuels AI)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX ON profiles (org_id) WHERE deleted_at IS NULL;

-- Supported channel catalog (seed data; not tenant-scoped).
CREATE TABLE platforms (
  key             text PRIMARY KEY,       -- 'instagram','twitter','whatsapp',...
  display_name    text NOT NULL,
  category        text NOT NULL CHECK (category IN ('social','messaging','ads')),
  capabilities    text[] NOT NULL DEFAULT '{}', -- post,video,carousel,dm,comment,review,ads,story
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE social_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('acc'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform        text NOT NULL REFERENCES platforms(key),
  platform_user_id text NOT NULL,         -- id on the platform
  username        text,
  display_name    text,
  avatar_url      text,
  status          text NOT NULL DEFAULT 'connected'
                  CHECK (status IN ('connected','expired','revoked','error','reauth_required')),
  scopes          text[] NOT NULL DEFAULT '{}',
  metadata        jsonb NOT NULL DEFAULT '{}',  -- platform-specific (page id, ig business id...)
  health_checked_at timestamptz,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (profile_id, platform, platform_user_id)
);
CREATE INDEX ON social_accounts (org_id) WHERE deleted_at IS NULL;
CREATE INDEX ON social_accounts (profile_id, platform);

-- OAuth tokens kept in a SEPARATE table so the hot account table never leaks
-- secrets and so encryption/rotation is isolated. Ciphertext only (KMS/libsodium).
CREATE TABLE oauth_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL UNIQUE REFERENCES social_accounts(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  access_token_enc bytea NOT NULL,        -- envelope-encrypted
  refresh_token_enc bytea,
  token_type      text,
  expires_at      timestamptz,
  key_version     int NOT NULL DEFAULT 1, -- for key rotation
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('media'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('image','video','gif','document')),
  storage_key     text NOT NULL,          -- S3/R2 object key
  cdn_url         text,
  mime_type       text,
  bytes           bigint,
  width           int,
  height          int,
  duration_ms     int,
  alt_text        text,
  source          text DEFAULT 'upload' CHECK (source IN ('upload','generated','imported')),
  ai_generation_id uuid,                  -- FK set later (content_generations)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media_assets (org_id, created_at DESC);

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('post'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id),
  content         text,                   -- base copy; per-target overrides below
  media_ids       uuid[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','publishing','published','partial','failed','deleted')),
  scheduled_for   timestamptz,
  timezone        text DEFAULT 'UTC',
  publish_now     boolean NOT NULL DEFAULT false,
  -- provenance: which system created it
  origin          text DEFAULT 'manual'
                  CHECK (origin IN ('manual','api','agent','campaign','workflow','viral_gen')),
  origin_ref      text,                   -- campaign_id, agent_run_id, workflow_run_id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX ON posts (org_id, status, scheduled_for);
CREATE INDEX ON posts (profile_id, created_at DESC);

-- One row per (post, account). The publishing engine works off this table.
CREATE TABLE post_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform        text NOT NULL REFERENCES platforms(key),
  content_override text,                  -- platform-tailored copy
  options         jsonb NOT NULL DEFAULT '{}', -- first_comment, thread, board id, subreddit...
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','publishing','published','failed','skipped')),
  platform_post_id text,                  -- id returned by platform
  permalink       text,
  error_code      text,
  error_detail    text,
  attempts        int NOT NULL DEFAULT 0,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON post_targets (status, post_id);
CREATE INDEX ON post_targets (account_id, published_at DESC);

-- Recurring auto-schedule slots ("queue").
CREATE TABLE queue_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES social_accounts(id) ON DELETE CASCADE,
  day_of_week     int NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  time_of_day     time NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 3. ANALYTICS  (unified metrics across platforms)
-- =============================================================================

-- Per-post performance (synced + normalized). Append snapshots over time.
CREATE TABLE post_metrics (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  post_target_id  uuid NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  impressions     bigint DEFAULT 0,
  reach           bigint DEFAULT 0,
  likes           bigint DEFAULT 0,
  comments        bigint DEFAULT 0,
  shares          bigint DEFAULT 0,
  saves           bigint DEFAULT 0,
  clicks          bigint DEFAULT 0,
  video_views     bigint DEFAULT 0,
  raw             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON post_metrics (post_target_id, captured_at DESC);

-- Account-level daily rollup (followers, totals) — drives dashboards cheaply.
CREATE TABLE account_metrics_daily (
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  day             date NOT NULL,
  followers       bigint,
  following        bigint,
  impressions     bigint,
  reach           bigint,
  engagement      bigint,
  profile_views   bigint,
  raw             jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, day)
);

-- =============================================================================
-- 4. UNIFIED MESSAGING / INBOX  (DMs, comments, reviews) + CRM
-- =============================================================================

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('contact'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  name            text,
  email           citext,
  phone           text,
  tags            text[] NOT NULL DEFAULT '{}',
  custom_fields   jsonb NOT NULL DEFAULT '{}',
  -- identity-graph link (revenue attribution joins on this)
  identity_id     uuid,
  lifecycle_stage text DEFAULT 'lead'
                  CHECK (lifecycle_stage IN ('lead','mql','sql','customer','churned')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON contacts (org_id);
CREATE INDEX ON contacts USING gin (name gin_trgm_ops);

-- A contact can be reachable on multiple platforms (one identity, many handles).
CREATE TABLE contact_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES social_accounts(id) ON DELETE SET NULL,
  platform        text NOT NULL REFERENCES platforms(key),
  platform_identifier text NOT NULL,      -- the user's id/handle on that platform
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_identifier, account_id)
);

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('conv'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform        text NOT NULL REFERENCES platforms(key),
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  channel_type    text NOT NULL DEFAULT 'dm' CHECK (channel_type IN ('dm','comment','review')),
  platform_thread_id text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','closed')),
  assignee_id     uuid REFERENCES users(id),
  last_message_at timestamptz,
  unread          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (org_id, status, last_message_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender          text,                   -- 'contact','user','agent','automation'
  body            text,
  attachments     jsonb NOT NULL DEFAULT '[]',
  platform_message_id text,
  delivery_status text DEFAULT 'sent' CHECK (delivery_status IN ('queued','sent','delivered','read','failed')),
  sent_by_user_id uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at);

-- WhatsApp dedicated numbers (provisioned per org).
CREATE TABLE whatsapp_numbers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  phone_number    text UNIQUE NOT NULL,
  country_code    text NOT NULL,
  provider        text NOT NULL DEFAULT 'meta',  -- meta BSP / carrier provider
  provider_ref    text,
  status          text NOT NULL DEFAULT 'provisioning'
                  CHECK (status IN ('provisioning','kyc_pending','active','suspended','released')),
  monthly_cost_cents int,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Bulk messaging.
CREATE TABLE broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('bcast'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform        text NOT NULL REFERENCES platforms(key),
  name            text NOT NULL,
  message         jsonb NOT NULL,         -- text or template payload
  template_name   text,                   -- for WhatsApp templates
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at    timestamptz,
  stats           jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcast_recipients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id    uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','read','failed','skipped')),
  error_detail    text,
  sent_at         timestamptz
);
CREATE INDEX ON broadcast_recipients (broadcast_id, status);

-- Drip sequences.
CREATE TABLE sequences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('seq'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES social_accounts(id) ON DELETE SET NULL,
  platform        text REFERENCES platforms(key),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id     uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order      int NOT NULL,
  delay_minutes   int NOT NULL DEFAULT 0,
  message         jsonb NOT NULL,
  UNIQUE (sequence_id, step_order)
);

CREATE TABLE sequence_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id     uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','completed','unenrolled','failed')),
  current_step    int NOT NULL DEFAULT 0,
  next_run_at     timestamptz,
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id)
);
CREATE INDEX ON sequence_enrollments (status, next_run_at);

-- Comment-to-DM automations.
CREATE TABLE automations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('auto'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform_post_id text,
  name            text NOT NULL,
  keywords        text[] NOT NULL DEFAULT '{}',  -- empty = trigger on all comments
  dm_message      jsonb NOT NULL,
  comment_reply   text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger_comment text,
  triggered_by    text,                   -- platform user id
  status          text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 5. ADS  (boost + campaign management across networks)
-- =============================================================================

CREATE TABLE ad_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('adacc'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  network         text NOT NULL,          -- meta_ads,google_ads,linkedin_ads,...
  platform_account_id text NOT NULL,
  name            text,
  currency        char(3),
  status          text NOT NULL DEFAULT 'connected',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('adcmp'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ad_account_id   uuid NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  network         text NOT NULL,
  objective       text,
  daily_budget_cents int,
  lifetime_budget_cents int,
  status          text NOT NULL DEFAULT 'draft',
  platform_campaign_id text,
  -- link back to a launch/campaign brain plan
  campaign_id     uuid,
  source_post_id  uuid REFERENCES posts(id) ON DELETE SET NULL,  -- boosted post
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_insights_daily (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ad_campaign_id  uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day             date NOT NULL,
  spend_cents     bigint DEFAULT 0,
  impressions     bigint DEFAULT 0,
  clicks          bigint DEFAULT 0,
  conversions     bigint DEFAULT 0,
  revenue_cents   bigint DEFAULT 0,
  raw             jsonb NOT NULL DEFAULT '{}',
  UNIQUE (ad_campaign_id, day)
);

-- =============================================================================
-- 6. WEBHOOKS  (outbound events to customers' systems)
-- =============================================================================

CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url             text NOT NULL,
  secret          text NOT NULL,          -- HMAC signing secret
  events          text[] NOT NULL DEFAULT '{}', -- 'post.published','post.failed','message.received'...
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed')),
  attempts        int NOT NULL DEFAULT 0,
  response_code   int,
  next_retry_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhook_deliveries (status, next_retry_at);

-- =============================================================================
-- 7. AI INFRASTRUCTURE  (shared by every AI feature)
-- =============================================================================

-- Knowledge base per org (brand docs, past winners, product info) for RAG.
CREATE TABLE knowledge_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  source_type     text NOT NULL,          -- 'upload','url','post','competitor','transcript'
  title           text,
  content         text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index     int NOT NULL,
  content         text NOT NULL,
  embedding       vector(1536),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Generic async AI job ledger (every model call routed through here for cost/audit).
CREATE TABLE ai_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature         text NOT NULL,          -- 'viral_gen','campaign_brain','competitor','landing','agent'
  ref_type        text,
  ref_id          text,
  model           text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  input           jsonb,
  output          jsonb,
  prompt_tokens   int,
  completion_tokens int,
  cost_cents      numeric,
  latency_ms      int,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX ON ai_jobs (org_id, feature, created_at DESC);

CREATE TABLE prompt_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL,          -- 'viral.hook.v3'
  version         int NOT NULL DEFAULT 1,
  body            text NOT NULL,
  variables       jsonb NOT NULL DEFAULT '[]',
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (key, version)
);

-- =============================================================================
-- 8. NEW SYSTEM: AI CAMPAIGN BRAIN  (goal -> plan -> assets -> schedule)
-- =============================================================================

CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('cmp'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  objective       text NOT NULL,          -- 'launch','awareness','leads','sales','retention'
  goal_metric     text,                   -- 'signups','revenue','followers'
  goal_target     numeric,
  budget_cents    bigint,
  start_date      date,
  end_date        date,
  brief           jsonb NOT NULL DEFAULT '{}',  -- audience, offer, channels, constraints
  plan            jsonb,                  -- generated calendar + channel mix
  status          text NOT NULL DEFAULT 'planning'
                  CHECK (status IN ('planning','approved','running','paused','completed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_type      text NOT NULL,          -- 'post','email','ad','landing_page'
  ref_id          uuid,                   -- points to posts/landing_pages/etc
  channel         text,
  scheduled_for   timestamptz,
  status          text NOT NULL DEFAULT 'planned',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 9. NEW SYSTEM: AUTONOMOUS MARKETING AGENTS  +  AGENT MARKETPLACE
-- =============================================================================

-- An installed/configured agent instance running inside an org.
CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('agent'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  marketplace_agent_id uuid,              -- null if custom/native
  name            text NOT NULL,
  role            text NOT NULL,          -- 'community_manager','growth','ads_optimizer','researcher'
  goal            text,
  config          jsonb NOT NULL DEFAULT '{}',
  -- autonomy & guardrails
  autonomy_level  text NOT NULL DEFAULT 'suggest'
                  CHECK (autonomy_level IN ('suggest','approve','auto')),
  allowed_tools   text[] NOT NULL DEFAULT '{}',
  budget_cents    bigint,                 -- hard spend ceiling per period
  schedule_cron   text,                   -- when it wakes up
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','stopped','error')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_type       text NOT NULL,          -- 'spend_limit','rate_limit','content_filter','requires_approval'
  config          jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('run'),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trigger         text NOT NULL,          -- 'schedule','event','manual'
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','waiting_approval','succeeded','failed','cancelled')),
  summary         text,
  tokens_used     int,
  cost_cents      numeric,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX ON agent_runs (agent_id, started_at DESC);

-- Full reasoning/tool trace for observability + replay.
CREATE TABLE agent_steps (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_index      int NOT NULL,
  step_type       text NOT NULL,          -- 'thought','tool_call','tool_result','message','approval_request'
  tool_name       text,
  input           jsonb,
  output          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Human-in-the-loop approvals when autonomy_level='approve'.
CREATE TABLE agent_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_summary  text NOT NULL,
  proposed_action jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Marketplace catalog (published, installable agents).
CREATE TABLE marketplace_agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('mpagent'),
  publisher_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  slug            text UNIQUE NOT NULL,
  name            text NOT NULL,
  description     text,
  category        text,
  manifest        jsonb NOT NULL,         -- tools, required scopes, config schema, pricing
  pricing_model   text DEFAULT 'free' CHECK (pricing_model IN ('free','flat','usage','rev_share')),
  price_cents     int,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','in_review','published','suspended')),
  install_count   int NOT NULL DEFAULT 0,
  rating          numeric,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace_installs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_agent_id uuid NOT NULL REFERENCES marketplace_agents(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_agent_id, org_id)
);

-- =============================================================================
-- 10. NEW SYSTEM: COMPETITOR INTELLIGENCE ENGINE
-- =============================================================================

CREATE TABLE competitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  handles         jsonb NOT NULL DEFAULT '{}',  -- {platform: handle}
  website         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Observed competitor content (public data, polled).
CREATE TABLE competitor_content (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competitor_id   uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  platform        text NOT NULL,
  platform_post_id text,
  posted_at       timestamptz,
  content         text,
  media           jsonb NOT NULL DEFAULT '[]',
  metrics         jsonb NOT NULL DEFAULT '{}',  -- likes, comments, est. reach
  is_ad           boolean DEFAULT false,        -- from public ad libraries
  embedding       vector(1536),
  captured_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON competitor_content (competitor_id, posted_at DESC);

CREATE TABLE intel_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competitor_id   uuid REFERENCES competitors(id) ON DELETE CASCADE,
  alert_type      text NOT NULL,          -- 'viral_post','new_ad','pricing_change','posting_spike'
  summary         text,
  payload         jsonb NOT NULL DEFAULT '{}',
  seen            boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 11. NEW SYSTEM: REVENUE ATTRIBUTION  +  CUSTOMER JOURNEY
-- =============================================================================

-- Identity graph: stitches anonymous visitors -> contacts -> customers.
CREATE TABLE identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  anonymous_id    text,                   -- first-party cookie/device id
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  external_user_id text,                  -- customer's own user id (via API)
  traits          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON identities (org_id, anonymous_id);

-- Every marketing touch (post click, ad click, dm, email open, page view).
CREATE TABLE touchpoints (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_id     uuid REFERENCES identities(id) ON DELETE SET NULL,
  channel         text NOT NULL,          -- 'organic_social','paid_social','dm','email','landing'
  platform        text,
  source_type     text,                   -- 'post','ad_campaign','broadcast','sequence','landing_page'
  source_id       text,
  campaign_id     uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  utm             jsonb NOT NULL DEFAULT '{}',
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON touchpoints (org_id, identity_id, occurred_at);
CREATE INDEX ON touchpoints (campaign_id);

-- Conversions/revenue events (sent in via API/webhook/Stripe).
CREATE TABLE conversions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_id     uuid REFERENCES identities(id) ON DELETE SET NULL,
  event_name      text NOT NULL,          -- 'signup','trial','purchase','subscription'
  value_cents     bigint DEFAULT 0,
  currency        char(3) DEFAULT 'USD',
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON conversions (org_id, occurred_at);

-- Computed attribution results per conversion (multiple models stored).
CREATE TABLE attribution_results (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversion_id   bigint NOT NULL REFERENCES conversions(id) ON DELETE CASCADE,
  model           text NOT NULL,          -- 'first_touch','last_touch','linear','time_decay','data_driven'
  touchpoint_id   bigint REFERENCES touchpoints(id) ON DELETE SET NULL,
  credit          numeric NOT NULL,       -- 0..1 fraction
  credited_value_cents bigint
);
CREATE INDEX ON attribution_results (org_id, model);

-- Customer journey definitions (stages a contact moves through).
CREATE TABLE journeys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  stages          jsonb NOT NULL DEFAULT '[]', -- ordered stage definitions
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 12. NEW SYSTEM: VIRAL CONTENT GENERATOR
-- =============================================================================

CREATE TABLE content_generations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('gen'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  prompt          text,
  intent          text,                   -- 'hook','thread','reel_script','carousel','repurpose'
  source_ref      jsonb,                  -- e.g. {type:'url'|'post'|'transcript', id}
  ai_job_id       uuid REFERENCES ai_jobs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_variants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id   uuid NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform        text,
  body            text NOT NULL,
  predicted_score numeric,                -- virality/engagement model score 0..100
  rationale       text,
  chosen          boolean NOT NULL DEFAULT false,
  posted_post_id  uuid REFERENCES posts(id) ON DELETE SET NULL,  -- for closed-loop learning
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 13. NEW SYSTEM: LANDING PAGE GENERATOR  (+ forms)
-- =============================================================================

CREATE TABLE landing_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('lp'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  campaign_id     uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  slug            text NOT NULL,
  custom_domain   text,
  title           text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_version_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE landing_page_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version         int NOT NULL,
  schema          jsonb NOT NULL,         -- block-based page definition
  is_variant      boolean DEFAULT false,  -- for A/B (links to experiments)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landing_page_id, version)
);

CREATE TABLE forms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  landing_page_id uuid REFERENCES landing_pages(id) ON DELETE CASCADE,
  fields          jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_submissions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  identity_id     uuid REFERENCES identities(id) ON DELETE SET NULL,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 14. NEW SYSTEM: AFFILIATE PROGRAM MANAGER
-- =============================================================================

CREATE TABLE affiliate_programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  commission_type text NOT NULL CHECK (commission_type IN ('percent','flat')),
  commission_value numeric NOT NULL,
  cookie_window_days int NOT NULL DEFAULT 30,
  payout_threshold_cents int DEFAULT 5000,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('aff'),
  program_id      uuid NOT NULL REFERENCES affiliate_programs(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  name            text,
  ref_code        text UNIQUE NOT NULL,
  payout_method   jsonb,                  -- stripe connect acct / paypal
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  affiliate_id    uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  identity_id     uuid REFERENCES identities(id) ON DELETE SET NULL,
  conversion_id   bigint REFERENCES conversions(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','paid')),
  commission_cents bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  affiliate_id    uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','paid','failed')),
  stripe_transfer_id text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 15. NEW SYSTEM: MARKETING WORKFLOW BUILDER
-- =============================================================================

CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('wf'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  active_version_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version         int NOT NULL,
  graph           jsonb NOT NULL,         -- nodes (trigger/action/condition/agent) + edges
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE workflow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trigger_event   jsonb,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed','waiting')),
  context         jsonb NOT NULL DEFAULT '{}',
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX ON workflow_runs (workflow_id, started_at DESC);

CREATE TABLE workflow_run_steps (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         text NOT NULL,
  status          text NOT NULL,
  input           jsonb,
  output          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 16. NEW SYSTEM: GROWTH EXPERIMENT ENGINE  (+ PRODUCT LAUNCH ASSISTANT)
-- =============================================================================

CREATE TABLE experiments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('exp'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  hypothesis      text NOT NULL,
  subject_type    text NOT NULL,          -- 'post','landing_page','ad','sequence'
  metric          text NOT NULL,          -- primary success metric
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','running','concluded','archived')),
  winner_variant_id uuid,
  confidence      numeric,
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_variants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label           text NOT NULL,          -- 'control','A','B'
  ref_id          uuid,                   -- the post/page/ad being tested
  allocation      numeric NOT NULL DEFAULT 0.5,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES experiment_variants(id) ON DELETE CASCADE,
  identity_id     uuid REFERENCES identities(id) ON DELETE SET NULL,
  event_type      text NOT NULL,          -- 'exposure','conversion'
  value           numeric,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON experiment_events (experiment_id, variant_id, event_type);

-- Product launches (orchestrates campaign + tasks + assets across the runway).
CREATE TABLE launches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text UNIQUE NOT NULL DEFAULT id_prefix('launch'),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  campaign_id     uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  name            text NOT NULL,
  product_summary text,
  launch_date     date,
  channels        text[] NOT NULL DEFAULT '{}',  -- 'producthunt','hn','x','email','reddit'
  status          text NOT NULL DEFAULT 'planning'
                  CHECK (status IN ('planning','runway','live','post','done')),
  playbook        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE launch_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_id       uuid NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  phase           text,                   -- 'pre','launch_day','post'
  due_at          timestamptz,
  assignee_id     uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','skipped')),
  ref_type        text,                   -- links to a post/asset/agent
  ref_id          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 17. ROW-LEVEL SECURITY  (illustrative; enable per table, set app.current_org)
-- =============================================================================
-- Every connection sets: SET app.current_org = '<org uuid>';
-- Policies restrict rows to that org. Service role bypasses via BYPASSRLS.

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation_posts ON posts
  USING (org_id = current_setting('app.current_org', true)::uuid);
-- ...repeat ENABLE + POLICY for every org-scoped table in production migrations.

-- =============================================================================
-- 18. updated_at triggers (attach to mutable tables)
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'organizations','users','memberships','profiles','social_accounts',
    'oauth_credentials','posts','post_targets','contacts','conversations',
    'campaigns','agents','landing_pages','workflows'
  ]) LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', t);
  END LOOP;
END $$;

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================
