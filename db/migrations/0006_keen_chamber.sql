ALTER TABLE "api_keys" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;