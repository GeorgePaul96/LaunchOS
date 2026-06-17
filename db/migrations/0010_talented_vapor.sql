CREATE TABLE "content_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"org_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"intent" text NOT NULL,
	"prompt" text NOT NULL,
	"source_ref" text,
	"ai_job_id" bigint,
	"created_at" text NOT NULL,
	CONSTRAINT "content_generations_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "content_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"org_id" text NOT NULL,
	"body" text NOT NULL,
	"predicted_score" integer DEFAULT 0 NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"chosen" boolean DEFAULT false NOT NULL,
	"posted_post_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "content_variants_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "content_generations" ADD CONSTRAINT "content_generations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_generations" ADD CONSTRAINT "content_generations_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_generations" ADD CONSTRAINT "content_generations_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_generation_id_content_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."content_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_posted_post_id_posts_id_fk" FOREIGN KEY ("posted_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;