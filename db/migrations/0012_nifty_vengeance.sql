CREATE TABLE "campaign_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"org_id" text NOT NULL,
	"account_id" text,
	"platform" text NOT NULL,
	"day_offset" integer DEFAULT 0 NOT NULL,
	"draft_body" text DEFAULT '' NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"expected_outcome" text DEFAULT '' NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"post_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "campaign_assets_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "ai_job_id" bigint;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "account_ids" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;