CREATE TABLE "employee_role_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"role_id" varchar NOT NULL,
	"role_name" text NOT NULL,
	"unavailable_date" varchar(10) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar
);
--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "assigned_employee_id" varchar;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "assigned_role_id" varchar;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "weekly_days" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "preferred_due_time" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "is_recurring_definition" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_role_availability" ADD CONSTRAINT "employee_role_availability_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_role_availability" ADD CONSTRAINT "employee_role_availability_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_role_availability" ADD CONSTRAINT "employee_role_availability_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "era_tenant_idx" ON "employee_role_availability" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "era_employee_idx" ON "employee_role_availability" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "era_date_idx" ON "employee_role_availability" USING btree ("unavailable_date");--> statement-breakpoint
CREATE INDEX "era_employee_role_date_idx" ON "employee_role_availability" USING btree ("employee_id","role_id","unavailable_date");--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_recurring_def" ON "tasks" USING btree ("is_recurring_definition");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_task_id");