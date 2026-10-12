ALTER TYPE "notification_type" ADD VALUE 'timekeeping_ping';--> statement-breakpoint
CREATE TABLE "presence_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"employee_id" varchar NOT NULL,
	"branch_id" varchar NOT NULL,
	"shift_row_id" varchar NOT NULL,
	"shift_date" date NOT NULL,
	"created_by" varchar NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"failure_message" text,
	"notification_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "presence_delivery_status" CHECK ("presence_notification_deliveries"."status" IN ('Pending', 'Delivered', 'Failed')),
	CONSTRAINT "presence_delivery_result" CHECK (("presence_notification_deliveries"."status" = 'Delivered') = ("presence_notification_deliveries"."notification_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "presence_notification_deliveries" ADD CONSTRAINT "presence_notification_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_notification_deliveries" ADD CONSTRAINT "presence_notification_deliveries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_notification_deliveries" ADD CONSTRAINT "presence_notification_deliveries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_notification_deliveries" ADD CONSTRAINT "presence_notification_deliveries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_notification_deliveries" ADD CONSTRAINT "presence_notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_presence_delivery_request" ON "presence_notification_deliveries" USING btree ("tenant_id","request_key");--> statement-breakpoint
CREATE INDEX "idx_presence_delivery_live" ON "presence_notification_deliveries" USING btree ("tenant_id","employee_id","shift_date");