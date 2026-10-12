CREATE TABLE "employee_action_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"actor_id" varchar NOT NULL,
	"action" text NOT NULL,
	"payload_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_action_receipts" ADD CONSTRAINT "employee_action_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_action_receipts" ADD CONSTRAINT "employee_action_receipts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION employee_changes_preserve_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'contract_generated' - 'contract_instance_id') IS DISTINCT FROM
     (to_jsonb(OLD) - 'contract_generated' - 'contract_instance_id') THEN
    RAISE EXCEPTION 'Employee change history is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER employee_changes_preserve_history BEFORE UPDATE ON employee_changes
FOR EACH ROW EXECUTE FUNCTION employee_changes_preserve_history();
