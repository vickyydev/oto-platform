ALTER TABLE "login_lifecycle_events" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "login_lifecycle_events" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
CREATE INDEX "idx_login_lifecycle_due" ON "login_lifecycle_events" USING btree ("state","next_attempt_at","id");
--> statement-breakpoint

-- SCRUM-778/810. Snapshot the same unambiguous park group used for managed
-- users: access rows and the operator anchor, or a one-tenant installation.
-- No FK: this diagnostic identity must survive the login's deletion.
CREATE FUNCTION otoapp.login_lifecycle_tenant(p_user_id varchar) RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  candidates uuid[];
BEGIN
  SELECT array_agg(DISTINCT tenant_id) INTO candidates FROM (
    SELECT a.tenant_id FROM otoapp.user_branch_access a WHERE a.user_id = p_user_id
    UNION
    SELECT o.tenant_id FROM otoapp.users u JOIN otoapp.operators o ON o.id = u.operator_id
     WHERE u.id = p_user_id
  ) anchors WHERE tenant_id IS NOT NULL;
  IF coalesce(cardinality(candidates), 0) > 0 THEN
    IF cardinality(candidates) = 1 THEN RETURN candidates[1]; END IF;
    RETURN NULL;
  END IF;
  SELECT array_agg(id) INTO candidates FROM (SELECT id FROM otoapp.tenants LIMIT 2) known;
  IF cardinality(candidates) = 1 THEN RETURN candidates[1]; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION otoapp.stamp_login_lifecycle_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.tenant_id := otoapp.login_lifecycle_tenant(NEW.user_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER login_lifecycle_tenant_stamp
BEFORE INSERT ON otoapp.login_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION otoapp.stamp_login_lifecycle_tenant();
--> statement-breakpoint

UPDATE otoapp.login_lifecycle_events
   SET tenant_id = otoapp.login_lifecycle_tenant(user_id);
--> statement-breakpoint

-- A deleted login cannot act on the platform again. Keep its immutable
-- receipt, but remove it from pending in the SAME transaction as deletion.
CREATE FUNCTION otoapp.settle_deleted_login_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE otoapp.login_lifecycle_events
     SET state = 'superseded', settled_at = now(), next_attempt_at = NULL,
         last_error_code = 'LOGIN_DELETED'
   WHERE user_id = OLD.id AND state = 'pending';
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_settle_deleted_login_lifecycle
AFTER DELETE ON otoapp.users
FOR EACH ROW EXECUTE FUNCTION otoapp.settle_deleted_login_lifecycle();
--> statement-breakpoint

-- Repair already orphaned receipts, including the two recorded in SCRUM-810.
UPDATE otoapp.login_lifecycle_events e
   SET state = 'superseded', settled_at = now(), next_attempt_at = NULL,
       last_error_code = 'LOGIN_DELETED'
 WHERE state = 'pending' AND NOT EXISTS (SELECT 1 FROM otoapp.users u WHERE u.id = e.user_id);
--> statement-breakpoint

-- Existing attempt counts are historical facts, not reset for another run.
-- Six total attempts is the transport's ceiling; NULL due time parks the row.
UPDATE otoapp.login_lifecycle_events
   SET next_attempt_at = NULL,
       last_error_code = CASE WHEN last_error_code LIKE 'RETRY_LIMIT:%' THEN last_error_code
         ELSE 'RETRY_LIMIT:' || coalesce(last_error_code, 'UNKNOWN') END
 WHERE state = 'pending' AND attempt_count >= 6;
--> statement-breakpoint
UPDATE otoapp.login_lifecycle_events SET next_attempt_at = NULL WHERE state <> 'pending';
