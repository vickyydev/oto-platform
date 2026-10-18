-- Flexible leave types (SCRUM-560, the October Replit port R3; upstream
-- 0024_flexible_leave_types, REGENERATED from shared/schema.ts and adapted).
--
-- The DDL is drizzle-kit's, made re-runnable (IF NOT EXISTS, guarded keys):
-- a production restore may arrive with these tables already made by the
-- park's own schema push, and the restore rehearsal replays every migration
-- after 0000 onto it.
--
-- The seed and the opening snapshot are two functions, so the migration and
-- the app's lazy per-park-group start (server/leave-types.ts) run ONE copy of
-- the rules. Both are fenced to one park group (tenant): upstream's seed read
-- any park group's company-wide leave policy and every park group's settings
-- through MAX(); here a park group reads its own settings row for a key, else
-- the default park group's (the settings rule since 0006, Q28), its own
-- company-wide leave policy, else the default park group's (the slot rule of
-- getActiveLeavePolicy, Q49), and its own sick-leave policy only (round 5).
-- Both are idempotent: a type or an opening already there is left alone.
CREATE TABLE IF NOT EXISTS "employee_leave_balance_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"snapshot_at" timestamp NOT NULL,
	"opening_balance" real NOT NULL,
	"worked_days_at_snapshot" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_leave_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"annual_days" real,
	"accrual_start_date" date,
	"waiting_months" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "employee_leave_overrides_annual_days_check" CHECK ("employee_leave_overrides"."annual_days" IS NULL OR "employee_leave_overrides"."annual_days" >= 0),
	CONSTRAINT "employee_leave_overrides_waiting_months_check" CHECK ("employee_leave_overrides"."waiting_months" IS NULL OR "employee_leave_overrides"."waiting_months" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"accrual_method" text DEFAULT 'YEARLY' NOT NULL,
	"annual_days" real DEFAULT 0 NOT NULL,
	"waiting_months" integer DEFAULT 0 NOT NULL,
	"prorate_by_start_date" boolean DEFAULT false NOT NULL,
	"days_worked_required" integer DEFAULT 0 NOT NULL,
	"days_off_earned" real DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "leave_types_accrual_method_check" CHECK ("leave_types"."accrual_method" IN ('YEARLY', 'WORKDAYS', 'NONE')),
	CONSTRAINT "leave_types_annual_days_check" CHECK ("leave_types"."annual_days" >= 0),
	CONSTRAINT "leave_types_waiting_months_check" CHECK ("leave_types"."waiting_months" >= 0),
	CONSTRAINT "leave_types_days_worked_required_check" CHECK ("leave_types"."days_worked_required" >= 0),
	CONSTRAINT "leave_types_days_off_earned_check" CHECK ("leave_types"."days_off_earned" >= 0)
);
--> statement-breakpoint
-- The foreign keys, each added only where the table has none to that parent
-- yet (a table the park's own push made carries its own, differently named).
DO $$
DECLARE
	fk record;
BEGIN
	FOR fk IN SELECT * FROM (VALUES
		('employee_leave_balance_openings', 'tenants', 'ALTER TABLE "employee_leave_balance_openings" ADD CONSTRAINT "employee_leave_balance_openings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action'),
		('employee_leave_balance_openings', 'employees', 'ALTER TABLE "employee_leave_balance_openings" ADD CONSTRAINT "employee_leave_balance_openings_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action'),
		('employee_leave_balance_openings', 'leave_types', 'ALTER TABLE "employee_leave_balance_openings" ADD CONSTRAINT "employee_leave_balance_openings_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE cascade ON UPDATE no action'),
		('employee_leave_overrides', 'tenants', 'ALTER TABLE "employee_leave_overrides" ADD CONSTRAINT "employee_leave_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action'),
		('employee_leave_overrides', 'employees', 'ALTER TABLE "employee_leave_overrides" ADD CONSTRAINT "employee_leave_overrides_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action'),
		('employee_leave_overrides', 'leave_types', 'ALTER TABLE "employee_leave_overrides" ADD CONSTRAINT "employee_leave_overrides_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE cascade ON UPDATE no action'),
		('leave_types', 'tenants', 'ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action')
	) AS wanted(child, parent, ddl) LOOP
		IF NOT EXISTS (
			SELECT 1 FROM pg_constraint c
			WHERE c.contype = 'f' AND c.conrelid = fk.child::regclass AND c.confrelid = fk.parent::regclass
		) THEN
			EXECUTE fk.ddl;
		END IF;
	END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_leave_balance_openings_employee_type_unique" ON "employee_leave_balance_openings" USING btree ("employee_id","leave_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_leave_balance_openings_tenant" ON "employee_leave_balance_openings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_leave_balance_openings_leave_type" ON "employee_leave_balance_openings" USING btree ("leave_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_leave_overrides_employee_type_unique" ON "employee_leave_overrides" USING btree ("employee_id","leave_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_leave_overrides_tenant" ON "employee_leave_overrides" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_leave_overrides_leave_type" ON "employee_leave_overrides" USING btree ("leave_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leave_types_tenant_code_unique" ON "leave_types" USING btree ("tenant_id",upper("code"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leave_types_tenant_active" ON "leave_types" USING btree ("tenant_id","is_active");--> statement-breakpoint
-- The default park group, as the app finds it (getDefaultParkGroupId): the
-- slug-`default` one, else the only one there is, else none.
CREATE OR REPLACE FUNCTION leave_default_park_group() RETURNS uuid LANGUAGE sql STABLE AS $$
	SELECT COALESCE(
		(SELECT id FROM tenants WHERE slug = 'default' LIMIT 1),
		(SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END FROM tenants)
	)
$$;
--> statement-breakpoint
-- A leave setting as the app read it before this migration: the park group's
-- own row for the key, else the default park group's (Q28); the value read
-- with parseInt, as every balance read did; the fallback where there is none.
CREATE OR REPLACE FUNCTION leave_legacy_setting(p_tenant uuid, p_key text, p_fallback integer) RETURNS integer LANGUAGE sql STABLE AS $$
	SELECT COALESCE(
		(SELECT NULLIF(substring(s.value FROM '^\s*(-?[0-9]+)'), '')::integer
		   FROM settings s
		  WHERE s.key = p_key AND (s.tenant_id = p_tenant OR s.tenant_id = leave_default_park_group())
		  ORDER BY (s.tenant_id = p_tenant) DESC
		  LIMIT 1),
		p_fallback
	)
$$;
--> statement-breakpoint
-- The park group's leave policy owner, as storage's documentOwnedBy reads a
-- row with no park group (its branch's, else the default park group's).
CREATE OR REPLACE FUNCTION leave_policy_park_group(p_tenant uuid, p_branch varchar) RETURNS uuid LANGUAGE sql STABLE AS $$
	SELECT COALESCE(
		p_tenant,
		(SELECT b.tenant_id FROM branches b WHERE b.id = p_branch),
		leave_default_park_group()
	)
$$;
--> statement-breakpoint
-- The seven built-in leave types for one park group, each only where the park
-- group has no type of that code yet. Values come from what the park group
-- read before: annual and business days from its settings, Days Off from its
-- company-wide leave policy slot, sick days from its own company-wide sick
-- leave policy. Returns how many types it made.
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
		(tenant_id, code, name, accrual_method, annual_days, waiting_months,
		 prorate_by_start_date, days_worked_required, days_off_earned)
	VALUES
		(p_tenant, 'ANNUAL', 'Annual Leave', 'YEARLY',
		 GREATEST(0, leave_legacy_setting(p_tenant, 'annual_leave_total_days', 8))::real,
		 GREATEST(0, leave_legacy_setting(p_tenant, 'annual_leave_waiting_months', 6)), false, 0, 0),
		(p_tenant, 'BUSINESS', 'Business Days', 'YEARLY',
		 GREATEST(0, leave_legacy_setting(p_tenant, 'business_days_total', 3))::real, 0, false, 0, 0),
		(p_tenant, 'SICK', 'Sick Leave', 'YEARLY',
		 COALESCE(v_sick_days, 30), 0, COALESCE(v_sick_prorate, true), 0, 0),
		(p_tenant, 'CHANGE_DAY_OFF', 'Days Off', 'WORKDAYS', 0, 0, false,
		 GREATEST(1, COALESCE(v_required, 5)), COALESCE(v_earned, 2)),
		(p_tenant, 'UNPAID', 'Unpaid Leave', 'NONE', 0, 0, false, 0, 0),
		(p_tenant, 'TRAINING', 'Training', 'NONE', 0, 0, false, 0, 0),
		(p_tenant, 'OTHER', 'Other', 'NONE', 0, 0, false, 0, 0)
	ON CONFLICT (tenant_id, upper(code)) DO NOTHING;
	GET DIAGNOSTICS v_made = ROW_COUNT;
	RETURN v_made;
END $$;
--> statement-breakpoint
-- Freeze each pre-existing employee's balance as one opening amount per
-- accruing built-in type (balances freeze-then-recalc, owner 2026-10-19).
-- "Pre-existing" is an employee of the park group made before its leave
-- catalogue was: a later hire gets no opening and accrues by the type's rules
-- from the start. The amounts are what the app showed before this migration:
--   Days Off  floor(days worked / required) * earned - days off taken, the
--             policy the newest effective of the branch's own and the
--             company-wide slot (getActiveLeavePolicy), `|| 5` / `|| 2`;
--   Annual    floor(months this year / 12 * total) once the waiting months
--             are served, less this year's days taken at the employee's
--             branch; Business the same without the wait;
--   Sick      the year's entitlement, prorated from a start this year, less
--             this year's sick days, never below zero.
-- An opening already there is never changed. Returns how many it made.
CREATE OR REPLACE FUNCTION snapshot_leave_balance_openings(p_tenant uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	v_default uuid := leave_default_park_group();
	v_slot uuid;
	v_made integer;
BEGIN
	v_slot := CASE WHEN EXISTS (
		SELECT 1 FROM leave_policies lp
		 WHERE lp.is_active AND lp.branch_id IS NULL
		   AND leave_policy_park_group(lp.tenant_id, lp.branch_id) = p_tenant
	) THEN p_tenant ELSE COALESCE(v_default, p_tenant) END;

	WITH clock AS (
		SELECT now()::timestamp AS snapshot_at,
		       current_date AS today,
		       extract(year FROM current_date)::integer AS cy,
		       extract(month FROM current_date)::integer AS cm,
		       make_date(extract(year FROM current_date)::integer, 1, 1) AS year_start
	), catalogue AS (
		SELECT MIN(lt.created_at) AS made_at
		  FROM leave_types lt
		 WHERE lt.tenant_id = p_tenant
		   AND upper(lt.code) IN ('ANNUAL', 'BUSINESS', 'SICK', 'CHANGE_DAY_OFF', 'UNPAID', 'TRAINING', 'OTHER')
	), rules AS (
		SELECT leave_legacy_setting(p_tenant, 'annual_leave_total_days', 8) AS annual_total,
		       leave_legacy_setting(p_tenant, 'annual_leave_waiting_months', 6) AS annual_wait,
		       leave_legacy_setting(p_tenant, 'business_days_total', 3) AS business_total
	), staff AS (
		SELECT e.id AS employee_id, e.branch_id,
		       e.start_date::date AS start_date,
		       c.snapshot_at, c.cy,
		       GREATEST(0, LEAST(12,
		         (c.cy - extract(year FROM GREATEST(COALESCE(e.start_date::date, c.today), c.year_start))::integer) * 12
		         + c.cm - extract(month FROM GREATEST(COALESCE(e.start_date::date, c.today), c.year_start))::integer
		       )) AS months_this_year,
		       GREATEST(0,
		         (c.cy - extract(year FROM COALESCE(e.start_date::date, c.today))::integer) * 12
		         + c.cm - extract(month FROM COALESCE(e.start_date::date, c.today))::integer
		       ) AS months_employed,
		       COALESCE(NULLIF(dayoff.days_worked_required, 0), 5) AS days_required,
		       COALESCE(NULLIF(dayoff.days_off_earned, 0), 2)::real AS days_earned,
		       COALESCE(NULLIF(sick.annual_sick_leave_days, 0), 30) AS sick_days,
		       COALESCE(sick.pro_rate_by_start_date, true) AS sick_prorate,
		       COALESCE(worked.n, 0) AS worked_days,
		       COALESCE(used.annual, 0) AS annual_used,
		       COALESCE(used.business, 0) AS business_used,
		       COALESCE(used.sick, 0) AS sick_used,
		       COALESCE(used.day_off, 0) AS day_off_used
		  FROM employees e
		 CROSS JOIN clock c
		 CROSS JOIN catalogue cat
		  LEFT JOIN LATERAL (
			SELECT lp.days_worked_required, lp.days_off_earned
			  FROM leave_policies lp
			 WHERE lp.is_active AND (
			       (leave_policy_park_group(lp.tenant_id, lp.branch_id) = p_tenant
			        AND CASE WHEN e.branch_id IS NULL THEN lp.branch_id IS NOT NULL ELSE lp.branch_id = e.branch_id END)
			    OR (lp.branch_id IS NULL AND leave_policy_park_group(lp.tenant_id, lp.branch_id) = v_slot))
			 ORDER BY lp.effective_from DESC, lp.created_at DESC
			 LIMIT 1
		  ) dayoff ON true
		  LEFT JOIN LATERAL (
			SELECT slp.annual_sick_leave_days, slp.pro_rate_by_start_date
			  FROM sick_leave_policies slp
			 WHERE slp.tenant_id = p_tenant AND slp.is_active
			   AND (slp.branch_id = e.branch_id OR slp.branch_id IS NULL)
			 ORDER BY (slp.branch_id IS NOT NULL) DESC, slp.updated_at DESC, slp.created_at DESC
			 LIMIT 1
		  ) sick ON true
		  LEFT JOIN LATERAL (
			SELECT COUNT(DISTINCT sa.shift_date)::integer AS n
			  FROM schedule_assignments sa
			 WHERE sa.employee_id = e.id
		  ) worked ON true
		  LEFT JOIN LATERAL (
			SELECT
			  COALESCE(SUM(GREATEST(1, (eto.end_date::date - eto.start_date::date) + 1))
			    FILTER (WHERE eto.type = 'ANNUAL' AND extract(year FROM eto.start_date)::integer = c.cy
			            AND (e.branch_id IS NULL OR eto.branch_id = e.branch_id)), 0)::real AS annual,
			  COALESCE(SUM(GREATEST(1, (eto.end_date::date - eto.start_date::date) + 1))
			    FILTER (WHERE eto.type = 'BUSINESS' AND extract(year FROM eto.start_date)::integer = c.cy
			            AND (e.branch_id IS NULL OR eto.branch_id = e.branch_id)), 0)::real AS business,
			  (COUNT(*) FILTER (WHERE eto.type = 'SICK' AND extract(year FROM eto.start_date)::integer = c.cy))::real AS sick,
			  (COUNT(*) FILTER (WHERE eto.type = 'CHANGE_DAY_OFF'))::real AS day_off
			  FROM employee_time_off eto
			 WHERE eto.employee_id = e.id
		  ) used ON true
		 WHERE e.tenant_id = p_tenant
		   AND cat.made_at IS NOT NULL
		   AND e.created_at < cat.made_at
		   AND EXISTS (
			SELECT 1 FROM leave_types lt
			 WHERE lt.tenant_id = p_tenant
			   AND upper(lt.code) IN ('ANNUAL', 'BUSINESS', 'SICK', 'CHANGE_DAY_OFF')
			   AND NOT EXISTS (
				SELECT 1 FROM employee_leave_balance_openings o
				 WHERE o.employee_id = e.id AND o.leave_type_id = lt.id))
	), balances AS (
		SELECT s.employee_id, s.snapshot_at, s.worked_days,
		  GREATEST(0,
		    CASE WHEN s.sick_prorate AND s.start_date IS NOT NULL AND extract(year FROM s.start_date)::integer = s.cy
		           THEN round(((12 - extract(month FROM s.start_date)::integer + 1)::numeric / 12) * s.sick_days)::real
		         WHEN s.sick_prorate AND s.start_date IS NOT NULL AND extract(year FROM s.start_date)::integer > s.cy
		           THEN 0
		         ELSE s.sick_days::real
		    END - s.sick_used
		  ) AS sick_balance,
		  CASE WHEN s.months_employed >= r.annual_wait
		         THEN floor((s.months_this_year::real / 12) * r.annual_total) - s.annual_used
		       ELSE -s.annual_used
		  END AS annual_balance,
		  floor((s.months_this_year::real / 12) * r.business_total) - s.business_used AS business_balance,
		  floor(s.worked_days::real / s.days_required) * s.days_earned - s.day_off_used AS day_off_balance
		  FROM staff s CROSS JOIN rules r
	)
	INSERT INTO employee_leave_balance_openings
		(tenant_id, employee_id, leave_type_id, snapshot_at, opening_balance, worked_days_at_snapshot)
	SELECT p_tenant, b.employee_id, lt.id, b.snapshot_at,
	       CASE upper(lt.code)
	         WHEN 'ANNUAL' THEN b.annual_balance
	         WHEN 'BUSINESS' THEN b.business_balance
	         WHEN 'SICK' THEN b.sick_balance
	         WHEN 'CHANGE_DAY_OFF' THEN b.day_off_balance
	       END::real,
	       CASE WHEN upper(lt.code) = 'CHANGE_DAY_OFF' THEN b.worked_days ELSE 0 END
	  FROM balances b
	  JOIN leave_types lt ON lt.tenant_id = p_tenant
	   AND upper(lt.code) IN ('ANNUAL', 'BUSINESS', 'SICK', 'CHANGE_DAY_OFF')
	ON CONFLICT (employee_id, leave_type_id) DO NOTHING;
	GET DIAGNOSTICS v_made = ROW_COUNT;
	RETURN v_made;
END $$;
--> statement-breakpoint
-- Every park group's catalogue, then every park group's openings.
SELECT seed_tenant_leave_types(t.id) FROM tenants t;
--> statement-breakpoint
SELECT snapshot_leave_balance_openings(t.id) FROM tenants t;
