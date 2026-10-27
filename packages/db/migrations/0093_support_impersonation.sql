CREATE TABLE "core"."impersonation_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"actor_session_id" uuid NOT NULL,
	"subject_account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"target_app" text NOT NULL,
	"mode" text NOT NULL,
	"reason" text,
	"reference" text,
	"approval_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "impersonation_session_target_app_check" CHECK ("core"."impersonation_session"."target_app" in ('pos', 'oto_app', 'radar', 'inbox')),
	CONSTRAINT "impersonation_session_mode_check" CHECK ("core"."impersonation_session"."mode" in ('read_only', 'write_allowed')),
	CONSTRAINT "impersonation_session_not_self_check" CHECK ("core"."impersonation_session"."actor_account_id" <> "core"."impersonation_session"."subject_account_id"),
	CONSTRAINT "impersonation_session_window_check" CHECK ("core"."impersonation_session"."expires_at" > "core"."impersonation_session"."started_at"),
	CONSTRAINT "impersonation_session_write_reason_check" CHECK ("core"."impersonation_session"."mode" = 'read_only' or (
    length(btrim(coalesce("core"."impersonation_session"."reason", ''))) > 0 and length(btrim(coalesce("core"."impersonation_session"."reference", ''))) > 0)),
	CONSTRAINT "impersonation_session_end_check" CHECK (("core"."impersonation_session"."ended_at" is null and "core"."impersonation_session"."end_reason" is null) or (
    "core"."impersonation_session"."ended_at" is not null and "core"."impersonation_session"."ended_at" >= "core"."impersonation_session"."started_at"
    and "core"."impersonation_session"."end_reason" in ('ended', 'actor_signed_out', 'subject_signed_out')))
);
--> statement-breakpoint
ALTER TABLE "core"."suite_control_approval" DROP CONSTRAINT "suite_control_approval_action_check";--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "on_behalf_of" uuid;--> statement-breakpoint
ALTER TABLE "core"."impersonation_session" ADD CONSTRAINT "impersonation_session_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."impersonation_session" ADD CONSTRAINT "impersonation_session_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."impersonation_session" ADD CONSTRAINT "impersonation_session_actor_session_id_session_id_fk" FOREIGN KEY ("actor_session_id") REFERENCES "core"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."impersonation_session" ADD CONSTRAINT "impersonation_session_subject_account_id_account_id_fk" FOREIGN KEY ("subject_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."impersonation_session" ADD CONSTRAINT "impersonation_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "core"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."impersonation_session" ADD CONSTRAINT "impersonation_session_approval_id_suite_control_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "core"."suite_control_approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "impersonation_session_operator_idx" ON "core"."impersonation_session" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "impersonation_session_actor_idx" ON "core"."impersonation_session" USING btree ("actor_account_id","started_at");--> statement-breakpoint
CREATE INDEX "impersonation_session_actor_session_idx" ON "core"."impersonation_session" USING btree ("actor_session_id");--> statement-breakpoint
CREATE INDEX "impersonation_session_subject_idx" ON "core"."impersonation_session" USING btree ("subject_account_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_session_session_unique" ON "core"."impersonation_session" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_session_approval_unique" ON "core"."impersonation_session" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "audit_on_behalf_of_idx" ON "core"."audit_log" USING btree ("on_behalf_of");--> statement-breakpoint
ALTER TABLE "core"."suite_control_approval" ADD CONSTRAINT "suite_control_approval_action_check" CHECK ("core"."suite_control_approval"."action" in ('kill_switch.set', 'impersonation.write'));