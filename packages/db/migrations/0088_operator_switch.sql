ALTER TABLE "core"."session" ADD COLUMN "operator_override" uuid;--> statement-breakpoint
ALTER TABLE "core"."session" ADD CONSTRAINT "session_operator_override_operator_id_fk" FOREIGN KEY ("operator_override") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;
