GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_assets TO app_user;
--> statement-breakpoint
ALTER TABLE campaign_assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation_campaign_assets ON campaign_assets
  USING (org_id = current_setting('app.current_org', true))
  WITH CHECK (org_id = current_setting('app.current_org', true));
--> statement-breakpoint
CREATE INDEX campaign_assets_campaign_idx ON campaign_assets (campaign_id);
--> statement-breakpoint
CREATE INDEX campaign_assets_org_idx ON campaign_assets (org_id);
