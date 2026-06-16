-- Non-privileged application role: RLS policies apply to it (unlike the superuser/owner).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
--> statement-breakpoint
-- Enable + FORCE RLS and add an org-isolation policy on every org-scoped table.
-- org_id stays text, so compare directly to the GUC (no ::uuid cast).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'memberships','api_keys','profiles','social_accounts','campaigns','posts',
    'post_targets','account_metrics_daily','contacts','contact_channels','identities',
    'touchpoints','conversions','attribution_results','journeys','idempotency_keys'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY org_isolation_%1$s ON %1$I
        USING (org_id = current_setting('app.current_org', true))
        WITH CHECK (org_id = current_setting('app.current_org', true))
    $f$, t);
  END LOOP;
END $$;
