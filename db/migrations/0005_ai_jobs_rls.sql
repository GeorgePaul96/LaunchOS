GRANT SELECT, INSERT, UPDATE, DELETE ON ai_jobs TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE ai_jobs_id_seq TO app_user;
--> statement-breakpoint
ALTER TABLE ai_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_ai_jobs ON ai_jobs
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX ai_jobs_org_created_idx ON ai_jobs (org_id, created_at);
