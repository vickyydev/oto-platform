-- SCRUM-1075: readings of employees' incentive clauses in payroll's own
-- incentive terms. The AI proposes a reading of a clause that is new or
-- changed; a person approves it, corrects it or marks it not an incentive.
-- Nothing pays until approval, which writes ordinary dated rules and
-- assignments into payroll_incentive_rules, payroll_incentive_rule_versions
-- and payroll_incentive_assignments and names them in `rules`. The clause is
-- kept as read with its hash, so an edited clause on the HR profile is seen
-- and the approved reading keeps paying until a person decides a new one.
--
-- Expand-only: one new table, read and written by the new payroll clause
-- routes and read by the month's preview; no existing row is read or written.
-- A reading is a payroll record, so an employee who has one is not deleted
-- (ON DELETE RESTRICT, as payroll_incentive_assignments).
--
-- Re-runnable, like 0056 (the restore rehearsal replays migrations onto a
-- restored database): the table, its keys and its checks are made in one
-- CREATE TABLE IF NOT EXISTS, and each index only where it is missing.
CREATE TABLE IF NOT EXISTS "payroll_incentive_clause_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"clause_text" text NOT NULL,
	"clause_hash" text NOT NULL,
	"reading" jsonb NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"decided_reason" text,
	"decided_by_user_id" varchar,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"reason" text NOT NULL,
	"actor_user_id" varchar,
	"actor_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_incentive_clause_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_incentive_clause_readings_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_incentive_clause_readings_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_incentive_clause_readings_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "payroll_incentive_clause_readings_source_check" CHECK ("payroll_incentive_clause_readings"."source" IN ('ai', 'person')),
	CONSTRAINT "payroll_incentive_clause_readings_status_check" CHECK ("payroll_incentive_clause_readings"."status" IN ('pending', 'approved', 'not-incentive', 'replaced'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_incentive_clause_readings_tenant_id_id_unique" ON "payroll_incentive_clause_readings" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_incentive_clause_readings_employee" ON "payroll_incentive_clause_readings" USING btree ("tenant_id","employee_id","created_at");
