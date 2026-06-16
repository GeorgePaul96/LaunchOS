-- New table needs its own grants (the P1.1 grant only covered tables existing then).
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE jobs_id_seq TO app_user;
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_jobs ON jobs
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX jobs_status_run_after_idx ON jobs (status, run_after);
