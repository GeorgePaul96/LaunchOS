// Postgres schema (drizzle-orm/pg-core), logical types preserved from the SQLite slice so
// service code + tests are unchanged. Native-type fidelity (uuid/timestamptz/jsonb/numeric)
// is deferred — see docs/superpowers/specs/2026-06-15-postgres-rls-migration-design.md §2.
// Driver: PGlite (dev/test) / node-postgres (prod). Canonical source: launchos_schema.sql.
import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";

const now = () => new Date().toISOString();

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  brandSettings: text("brand_settings").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("owner"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  brandVoice: text("brand_voice").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const platforms = pgTable("platforms", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),
  capabilities: text("capabilities").notNull().default("[]"),
  isActive: boolean("is_active").notNull().default(true),
});

export const socialAccounts = pgTable("social_accounts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  platform: text("platform").notNull().references(() => platforms.key),
  platformUserId: text("platform_user_id").notNull(),
  username: text("username"),
  displayName: text("display_name"),
  status: text("status").notNull().default("connected"),
  metadata: text("metadata").notNull().default("{}"),
  connectedAt: text("connected_at").notNull().$defaultFn(now),
});

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  goalMetric: text("goal_metric"),
  goalTarget: integer("goal_target"),
  budgetCents: integer("budget_cents"),
  status: text("status").notNull().default("planning"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").notNull().references(() => profiles.id),
  createdBy: text("created_by").references(() => users.id),
  content: text("content"),
  mediaIds: text("media_ids").notNull().default("[]"),
  status: text("status").notNull().default("draft"),
  scheduledFor: text("scheduled_for"),
  publishNow: boolean("publish_now").notNull().default(false),
  origin: text("origin").notNull().default("manual"),
  originRef: text("origin_ref"),
  campaignId: text("campaign_id").references(() => campaigns.id),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const postTargets = pgTable("post_targets", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull().references(() => posts.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  accountId: text("account_id").notNull().references(() => socialAccounts.id),
  platform: text("platform").notNull().references(() => platforms.key),
  contentOverride: text("content_override"),
  options: text("options").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  platformPostId: text("platform_post_id"),
  permalink: text("permalink"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  attempts: integer("attempts").notNull().default(0),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const accountMetricsDaily = pgTable("account_metrics_daily", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  accountId: text("account_id").notNull().references(() => socialAccounts.id),
  day: text("day").notNull(),
  followers: integer("followers"),
  impressions: integer("impressions"),
  reach: integer("reach"),
  engagement: integer("engagement"),
});

export const contacts = pgTable("contacts", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").references(() => profiles.id),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  tags: text("tags").notNull().default("[]"),
  identityId: text("identity_id"),
  lifecycleStage: text("lifecycle_stage").notNull().default("lead"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const contactChannels = pgTable("contact_channels", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  accountId: text("account_id").references(() => socialAccounts.id),
  platform: text("platform").notNull().references(() => platforms.key),
  platformIdentifier: text("platform_identifier").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const identities = pgTable("identities", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  anonymousId: text("anonymous_id"),
  contactId: text("contact_id").references(() => contacts.id),
  externalUserId: text("external_user_id"),
  traits: text("traits").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const touchpoints = pgTable("touchpoints", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  identityId: text("identity_id").references(() => identities.id),
  channel: text("channel").notNull(),
  platform: text("platform"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  campaignId: text("campaign_id").references(() => campaigns.id),
  utm: text("utm").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull().$defaultFn(now),
});

export const conversions = pgTable("conversions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  identityId: text("identity_id").references(() => identities.id),
  eventName: text("event_name").notNull(),
  valueCents: integer("value_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  occurredAt: text("occurred_at").notNull().$defaultFn(now),
  metadata: text("metadata").notNull().default("{}"),
});

export const attributionResults = pgTable("attribution_results", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  conversionId: integer("conversion_id").notNull().references(() => conversions.id),
  model: text("model").notNull(),
  touchpointId: integer("touchpoint_id").references(() => touchpoints.id),
  credit: integer("credit").notNull(), // basis points 0..10000 (numeric fidelity deferred)
  creditedValueCents: integer("credited_value_cents").notNull().default(0),
});

export const journeys = pgTable("journeys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  profileId: text("profile_id").references(() => profiles.id),
  name: text("name").notNull(),
  stages: text("stages").notNull().default("[]"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  orgId: text("org_id").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
