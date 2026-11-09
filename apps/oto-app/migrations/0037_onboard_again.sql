-- Onboard Again (SCRUM-794): a new employment planned on a profile whose
-- contract ends (or has ended), so the profile keeps its login, face enrolment
-- and history. One planned employment per profile at a time; the night batch
-- starts it on its start date and marks the offboarding it follows as
-- re-onboarded. Expand-only: a new table and one nullable column.
CREATE TABLE "employee_engagements" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"start_date" date NOT NULL,
	"department_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"position_title" text,
	"employment_basis" text,
	"contract_instance_id" varchar,
	"offboarding_id" varchar,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp,
	"cancelled_at" timestamp,
	CONSTRAINT "employee_engagements_status_check" CHECK ("employee_engagements"."status" IN ('planned', 'active', 'ended', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "employee_offboarding" ADD COLUMN "reonboarded_at" timestamp;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_contract_instance_id_contract_instances_id_fk" FOREIGN KEY ("contract_instance_id") REFERENCES "contract_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_offboarding_id_employee_offboarding_id_fk" FOREIGN KEY ("offboarding_id") REFERENCES "employee_offboarding"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_engagements" ADD CONSTRAINT "employee_engagements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_employee_engagements_employee" ON "employee_engagements" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_employee_engagements_due" ON "employee_engagements" USING btree ("status","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_engagements_one_planned" ON "employee_engagements" USING btree ("employee_id") WHERE "employee_engagements"."status" = 'planned';