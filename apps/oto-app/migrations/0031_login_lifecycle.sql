CREATE TABLE "login_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"platform_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"settled_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	CONSTRAINT "login_lifecycle_events_state_check" CHECK ("login_lifecycle_events"."state" IN ('pending', 'delivered', 'superseded')),
	CONSTRAINT "login_lifecycle_events_attempt_count_check" CHECK ("login_lifecycle_events"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_login_lifecycle_pending" ON "login_lifecycle_events" USING btree ("state","created_at","id");
--> statement-breakpoint

-- The users write and its notification commit or roll back together, whichever
-- app-owned writer changed the active flag. Existing inactive users are not
-- backfilled. Snapshot IDs deliberately have no FK or cascading delete.
CREATE FUNCTION otoapp.queue_login_lifecycle_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active IS FALSE AND NEW.is_active IS TRUE THEN
    UPDATE otoapp.login_lifecycle_events
       SET state = 'superseded', settled_at = now(), last_error_code = NULL
     WHERE user_id = NEW.id AND state = 'pending';
  ELSIF OLD.is_active IS TRUE AND NEW.is_active IS FALSE
        AND NEW.platform_user_id IS NOT NULL THEN
    INSERT INTO otoapp.login_lifecycle_events (id, user_id, platform_account_id)
    VALUES (gen_random_uuid(), NEW.id, NEW.platform_user_id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Grant the identity seam only this queue, atomically with trigger installation.
-- App-only installations without core.account have no platform recipient.
DO $login_lifecycle_access$
DECLARE
  platform_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO platform_owner
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'core' AND c.relname = 'account' AND c.relkind IN ('r', 'p');
  IF platform_owner IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE otoapp.login_lifecycle_events TO %I',
      platform_owner
    );
  END IF;
END;
$login_lifecycle_access$;
--> statement-breakpoint

CREATE TRIGGER users_login_lifecycle_event
AFTER UPDATE OF is_active ON otoapp.users
FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
EXECUTE FUNCTION otoapp.queue_login_lifecycle_event();
