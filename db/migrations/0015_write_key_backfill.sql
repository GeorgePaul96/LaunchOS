DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE write_key = '' LOOP
    UPDATE organizations SET write_key = 'pk_' || replace(gen_random_uuid()::text, '-', '') WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX organizations_write_key_unique ON organizations (write_key);
