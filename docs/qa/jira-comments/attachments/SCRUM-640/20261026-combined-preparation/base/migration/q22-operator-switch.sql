ALTER TABLE "core"."session" ADD COLUMN "operator_override" uuid;--> statement-breakpoint
ALTER TABLE "core"."session" ADD CONSTRAINT "session_operator_override_operator_id_fk" FOREIGN KEY ("operator_override") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "home_operator_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "effective_operator_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_home_operator_id_operator_id_fk" FOREIGN KEY ("home_operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD CONSTRAINT "audit_log_effective_operator_id_operator_id_fk" FOREIGN KEY ("effective_operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;
