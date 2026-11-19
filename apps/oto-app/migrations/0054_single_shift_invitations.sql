-- SCRUM-1038: a former employee invited to one shift, on the same profile and
-- without rehiring. The shift itself is an ordinary schedule assignment; this
-- table holds its invitation: who, which shift on which day at which branch,
-- and how the shift is paid — on the person's last contract (the default) or
-- switched to a casual day rate the manager types, in whole baht a day.
--
-- Expand-only: one new table, read by the new single-shift routes and by the
-- kiosk's ended-employment check; no existing row is read or written. An
-- employee deleted takes their invitations with them (as their shifts go); a
-- shift removed empties `assignment_id`, which closes the kiosk again.
--
-- Re-runnable, like 0053 (the restore rehearsal replays migrations onto a
-- restored database): the table, its keys and its check are made in one
-- CREATE TABLE IF NOT EXISTS, and each index only where it is missing.
CREATE TABLE IF NOT EXISTS "single_shift_invitations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"assignment_id" varchar,
	"shift_row_id" varchar,
	"shift_date" date NOT NULL,
	"pay_basis" text DEFAULT 'old_contract' NOT NULL,
	"casual_day_rate" integer,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "single_shift_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_assignment_id_schedule_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "schedule_assignments"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_shift_row_id_schedule_shift_rows_id_fk" FOREIGN KEY ("shift_row_id") REFERENCES "schedule_shift_rows"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "single_shift_invitations_pay_check" CHECK (("single_shift_invitations"."pay_basis" = 'old_contract' AND "single_shift_invitations"."casual_day_rate" IS NULL) OR ("single_shift_invitations"."pay_basis" = 'casual_day_rate' AND "single_shift_invitations"."casual_day_rate" > 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_single_shift_invitations_tenant_date" ON "single_shift_invitations" USING btree ("tenant_id","shift_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_single_shift_invitations_employee_date" ON "single_shift_invitations" USING btree ("employee_id","shift_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "single_shift_invitations_assignment_unique" ON "single_shift_invitations" USING btree ("assignment_id");
