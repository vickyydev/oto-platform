-- SCRUM-769: the platform is told when a login goes to pay only, as it is told
-- when a login is switched off (0031). The 03:00 batch now keeps a leaver's
-- login on and limits it to My pay (0040) instead of switching it off, so the
-- 0031 trigger no longer fires for a leaver and the platform account — the
-- launcher, the till, the other apps — would keep every role it holds. A
-- 'restrict' event asks the platform to keep the account on, with its road to
-- the OTO App (the only way to My pay while the app's own sign-in is off), and
-- to end its sessions and withdraw every other role.
--
-- Expand-only: a column with a default every existing event takes
-- ('deactivate', what each of them is), a check on its two values, a trigger of
-- its own on access_mode, and 0031's function given the kind it supersedes.
ALTER TABLE "login_lifecycle_events" ADD COLUMN "kind" text DEFAULT 'deactivate' NOT NULL;--> statement-breakpoint
ALTER TABLE "login_lifecycle_events" ADD CONSTRAINT "login_lifecycle_events_kind_check" CHECK ("login_lifecycle_events"."kind" IN ('deactivate', 'restrict'));--> statement-breakpoint

-- 0031's switch, unchanged but for one word: a login switched back on withdraws
-- a switch-off still waiting for the platform, and no longer a restriction —
-- a login in pay only switched back on by an administrator is still in pay
-- only, so its restriction still stands.
CREATE OR REPLACE FUNCTION otoapp.queue_login_lifecycle_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active IS FALSE AND NEW.is_active IS TRUE THEN
    UPDATE otoapp.login_lifecycle_events
       SET state = 'superseded', settled_at = now(), last_error_code = NULL
     WHERE user_id = NEW.id AND kind = 'deactivate' AND state = 'pending';
  ELSIF OLD.is_active IS TRUE AND NEW.is_active IS FALSE
        AND NEW.platform_user_id IS NOT NULL THEN
    INSERT INTO otoapp.login_lifecycle_events (id, user_id, platform_account_id)
    VALUES (gen_random_uuid(), NEW.id, NEW.platform_user_id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- The restriction travels with the access_mode write that makes it, whichever
-- app-owned writer made it (the 03:00 batch, Offboard with a last day already
-- past), and is withdrawn while still waiting when the login reaches the whole
-- app again (Onboard Again's start, a last working day moved later).
CREATE FUNCTION otoapp.queue_login_restriction_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.access_mode = 'pay_only' AND NEW.access_mode = 'full' THEN
    UPDATE otoapp.login_lifecycle_events
       SET state = 'superseded', settled_at = now(), last_error_code = NULL
     WHERE user_id = NEW.id AND kind = 'restrict' AND state = 'pending';
  ELSIF OLD.access_mode = 'full' AND NEW.access_mode = 'pay_only'
        AND NEW.platform_user_id IS NOT NULL THEN
    INSERT INTO otoapp.login_lifecycle_events (id, user_id, platform_account_id, kind)
    VALUES (gen_random_uuid(), NEW.id, NEW.platform_user_id, 'restrict');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER users_login_restriction_event
AFTER UPDATE OF access_mode ON otoapp.users
FOR EACH ROW WHEN (OLD.access_mode IS DISTINCT FROM NEW.access_mode)
EXECUTE FUNCTION otoapp.queue_login_restriction_event();
