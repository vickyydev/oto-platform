CREATE TABLE "location_branch_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "contract_instances" ADD COLUMN "employee_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "thai_name" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "nickname" text NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employment_basis" text DEFAULT 'FULL_TIME' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "daily_rate" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "updated_by" varchar;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD COLUMN "photo_evidence_urls" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD COLUMN "reference_media_urls" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "reference_media_urls" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "requires_photo_evidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "assigned_department_id" varchar;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD COLUMN "completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD COLUMN "completed_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assigned_role_id" varchar;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assigned_department_id" varchar;--> statement-breakpoint
ALTER TABLE "location_branch_access" ADD CONSTRAINT "location_branch_access_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_branch_access" ADD CONSTRAINT "location_branch_access_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_location_branch_location" ON "location_branch_access" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_location_branch_branch" ON "location_branch_access" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_locations_tenant" ON "locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_locations_parent" ON "locations" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_assigned_department_id_departments_id_fk" FOREIGN KEY ("assigned_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_event_tasks" ADD CONSTRAINT "studio_event_tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_role_id_roles_id_fk" FOREIGN KEY ("assigned_role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_department_id_departments_id_fk" FOREIGN KEY ("assigned_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_location" ON "checklist_templates" USING btree ("location_id");