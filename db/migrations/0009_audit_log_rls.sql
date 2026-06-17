GRANT SELECT, INSERT ON audit_log TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_user;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_audit_log ON audit_log
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at);
