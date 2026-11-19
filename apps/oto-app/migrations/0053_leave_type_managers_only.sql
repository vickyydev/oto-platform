-- SCRUM-1037: the leave types as the owner set them on 19 November 2026.
-- Staff see Annual Leave and Days Off; Sick Leave, Business Days and Unpaid
-- Leave are for managers only (staff do not see them; a manager records them
-- for a person); Training and Other are switched off.
--
-- Expand-only: one column with a default every existing type takes (false:
-- seen by everyone, as every type was), so the deployed release reads the
-- table as before. No time-off row, opening balance, override or payroll
-- figure is read or written here: a type is never deleted, a switched-off
-- type keeps every record made on it, and balances count records by code.
--
-- Re-runnable, like 0018 (the restore rehearsal replays migrations onto a
-- restored database): the column only where it is missing, the seed function
-- replaced in place, and each update only where a row is not yet as set.
ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "managers_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- A new park group's seven built-in types: 0018's seed with every value read
-- as before, and the owner's set from the start (Sick Leave, Business Days
-- and Unpaid Leave for managers only; Training and Other switched off). The
-- lazy start (server/leave-types.ts) calls this same function.
CREATE OR REPLACE FUNCTION seed_tenant_leave_types(p_tenant uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	v_default uuid := leave_default_park_group();
	v_slot uuid;
	v_required integer;
	v_earned real;
	v_sick_days real;
	v_sick_prorate boolean;
	v_made integer;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN
		RETURN 0;
	END IF;

	-- Days Off: the park group's own active company-wide policy, else the
	-- default park group's; the newest effective; `|| 5` and `|| 2` as read.
	v_slot := CASE WHEN EXISTS (
		SELECT 1 FROM leave_policies lp
		 WHERE lp.is_active AND lp.branch_id IS NULL
		   AND leave_policy_park_group(lp.tenant_id, lp.branch_id) = p_tenant
	) THEN p_tenant ELSE COALESCE(v_default, p_tenant) END;
	SELECT NULLIF(lp.days_worked_required, 0), NULLIF(lp.days_off_earned, 0)::real
	  INTO v_required, v_earned
	  FROM leave_policies lp
	 WHERE lp.is_active AND lp.branch_id IS NULL
	   AND leave_policy_park_group(lp.tenant_id, lp.branch_id) = v_slot
	 ORDER BY lp.effective_from DESC, lp.created_at DESC
	 LIMIT 1;

	-- Sick Leave: the park group's own company-wide policy only (round 5).
	SELECT NULLIF(slp.annual_sick_leave_days, 0)::real, slp.pro_rate_by_start_date
	  INTO v_sick_days, v_sick_prorate
	  FROM sick_leave_policies slp
	 WHERE slp.tenant_id = p_tenant AND slp.branch_id IS NULL AND slp.is_active
	 ORDER BY slp.updated_at DESC, slp.created_at DESC
	 LIMIT 1;

	INSERT INTO leave_types
		(tenant_id, code, name, is_active, managers_only, accrual_method, annual_days, waiting_months,
		 prorate_by_start_date, days_worked_required, days_off_earned)
	VALUES
		(p_tenant, 'ANNUAL', 'Annual Leave', true, false, 'YEARLY',
		 GREATEST(0, leave_legacy_setting(p_tenant, 'annual_leave_total_days', 8))::real,
		 GREATEST(0, leave_legacy_setting(p_tenant, 'annual_leave_waiting_months', 6)), false, 0, 0),
		(p_tenant, 'BUSINESS', 'Business Days', true, true, 'YEARLY',
		 GREATEST(0, leave_legacy_setting(p_tenant, 'business_days_total', 3))::real, 0, false, 0, 0),
		(p_tenant, 'SICK', 'Sick Leave', true, true, 'YEARLY',
		 COALESCE(v_sick_days, 30), 0, COALESCE(v_sick_prorate, true), 0, 0),
		(p_tenant, 'CHANGE_DAY_OFF', 'Days Off', true, false, 'WORKDAYS', 0, 0, false,
		 GREATEST(1, COALESCE(v_required, 5)), COALESCE(v_earned, 2)),
		(p_tenant, 'UNPAID', 'Unpaid Leave', true, true, 'NONE', 0, 0, false, 0, 0),
		(p_tenant, 'TRAINING', 'Training', false, false, 'NONE', 0, 0, false, 0, 0),
		(p_tenant, 'OTHER', 'Other', false, false, 'NONE', 0, 0, false, 0, 0)
	ON CONFLICT (tenant_id, upper(code)) DO NOTHING;
	GET DIAGNOSTICS v_made = ROW_COUNT;
	RETURN v_made;
END $$;
--> statement-breakpoint
-- Every existing park group: its built-in Sick Leave, Business Days and
-- Unpaid Leave for managers only. The setting is new, so no manager has set
-- it yet; a type a park made itself (any other code) stays seen by everyone.
UPDATE leave_types SET managers_only = true, updated_at = now()
 WHERE upper(code) IN ('SICK', 'BUSINESS', 'UNPAID') AND NOT managers_only;
--> statement-breakpoint
-- Every existing park group: its built-in Training and Other switched off
-- where each is still as built (on, its built name, no accrual). One a manager
-- renamed or gave an accrual is left as the manager made it; one already off
-- stays off.
UPDATE leave_types SET is_active = false, updated_at = now()
 WHERE is_active
   AND accrual_method = 'NONE'
   AND ((upper(code) = 'TRAINING' AND lower(btrim(name)) = 'training')
     OR (upper(code) = 'OTHER' AND lower(btrim(name)) = 'other'));
