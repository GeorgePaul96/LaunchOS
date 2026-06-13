CREATE TABLE `account_metrics_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`day` text NOT NULL,
	`followers` integer,
	`impressions` integer,
	`reach` integer,
	`engagement` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `attribution_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`conversion_id` integer NOT NULL,
	`model` text NOT NULL,
	`touchpoint_id` integer,
	`credit` integer NOT NULL,
	`credited_value_cents` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversion_id`) REFERENCES `conversions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`touchpoint_id`) REFERENCES `touchpoints`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`org_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`name` text NOT NULL,
	`objective` text NOT NULL,
	`goal_metric` text,
	`goal_target` integer,
	`budget_cents` integer,
	`status` text DEFAULT 'planning' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `contact_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`account_id` text,
	`platform` text NOT NULL,
	`platform_identifier` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform`) REFERENCES `platforms`(`key`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`org_id` text NOT NULL,
	`profile_id` text,
	`name` text,
	`email` text,
	`phone` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`identity_id` text,
	`lifecycle_stage` text DEFAULT 'lead' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `conversions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`identity_id` text,
	`event_name` text NOT NULL,
	`value_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`occurred_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`anonymous_id` text,
	`contact_id` text,
	`external_user_id` text,
	`traits` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `journeys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`profile_id` text,
	`name` text NOT NULL,
	`stages` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`brand_settings` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `platforms` (
	`key` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`category` text NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
CREATE TABLE `post_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`content_override` text,
	`options` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`platform_post_id` text,
	`permalink` text,
	`error_code` text,
	`error_detail` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform`) REFERENCES `platforms`(`key`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`org_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`created_by` text,
	`content` text,
	`media_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_for` text,
	`publish_now` integer DEFAULT false NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`origin_ref` text,
	`campaign_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`brand_voice` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`org_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`platform` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`username` text,
	`display_name` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`connected_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform`) REFERENCES `platforms`(`key`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `touchpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`identity_id` text,
	`channel` text NOT NULL,
	`platform` text,
	`source_type` text,
	`source_id` text,
	`campaign_id` text,
	`utm` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`password_hash` text,
	`created_at` text NOT NULL
);
