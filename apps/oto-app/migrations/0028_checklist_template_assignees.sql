-- A checklist template can name several employees (SCRUM-658). The template's
-- own assigned_employee_id stays, written as the first of them, so a reader
-- that knows only that column still finds a named person; readers take the
-- union. Existing single-assignee templates are copied in at the end so the
-- table is the whole record from here on.
CREATE TABLE "checklist_template_assignees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_template_assignees" ADD CONSTRAINT "checklist_template_assignees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_assignees" ADD CONSTRAINT "checklist_template_assignees_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_assignees" ADD CONSTRAINT "checklist_template_assignees_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_template_assignees_template_employee_unique" ON "checklist_template_assignees" USING btree ("template_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_assignees_employee" ON "checklist_template_assignees" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_assignees_tenant" ON "checklist_template_assignees" USING btree ("tenant_id");--> statement-breakpoint
INSERT INTO "checklist_template_assignees" ("tenant_id", "template_id", "employee_id")
SELECT "tenant_id", "id", "assigned_employee_id" FROM "checklist_templates"
WHERE "assigned_employee_id" IS NOT NULL
ON CONFLICT DO NOTHING;
