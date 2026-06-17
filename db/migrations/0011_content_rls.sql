GRANT SELECT, INSERT, UPDATE, DELETE ON content_generations TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON content_variants TO app_user;
--> statement-breakpoint
ALTER TABLE content_generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE content_generations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_content_generations ON content_generations
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
ALTER TABLE content_variants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE content_variants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_content_variants ON content_variants
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX content_generations_org_created_idx ON content_generations (org_id, created_at);
--> statement-breakpoint
CREATE INDEX content_variants_generation_idx ON content_variants (generation_id);
