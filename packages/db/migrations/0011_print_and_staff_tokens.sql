-- S2-06 — printing and the signed staff token: what a branch may change about
-- a printout, the record of every attempt to push bytes at a machine, the
-- credential a box verifies with no network, and the per-unit device facts the
-- hardware research says cannot be inferred from a model name.
--
-- Expand only. Three new tables, one nullable column, and one CHECK widened —
-- nothing is renamed, retyped or dropped — so the release now deployed runs
-- unchanged against this database and a rollback onto it is uneventful.
--
-- The one statement worth reading twice is the `box_command_kind_check` pair at
-- the top and bottom. It is a DROP and an ADD rather than an ALTER because
-- Postgres has no ALTER for a check's expression, and it is SAFE because the
-- new list is a superset of the old one: every value the currently deployed
-- release writes still passes, and the two statements are inside the one
-- transaction this migration runs in, so no concurrent insert ever sees the
-- table unconstrained. Widening a CHECK in a single statement is exactly what
-- S2-01b replaced the pg enums for.
--
-- `core.device.settings` is added nullable with no default, which Postgres
-- records as metadata rather than by rewriting the table — `core.device` is
-- small, but the habit is what keeps a migration on a busy afternoon boring.
--
-- Nothing here is unique over existing data — `print_template_branch_type_unique`
-- builds over an empty table — so no index in this migration can refuse to
-- build on a live database.
--
-- Two placements are decisions rather than conveniences, and the reasoning is
-- on the tables in `packages/db/src/schema/print.ts`: the TEMPLATE is branch
-- configuration read only by the till, so it sits in `pos` beside the catalogue
-- it prints; the JOB is the record of one attempt to reach a device, with a
-- queue, a retry and a retention window, so it sits in `edge`. What a reprint
-- MEANS — who reprinted a receipt and why — is an audit row, which is never
-- swept, and that is what keeps the swept table from being the system of record
-- for anything.

CREATE TABLE "core"."staff_token" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_token_expiry_check" CHECK ("core"."staff_token"."expires_at" > "core"."staff_token"."issued_at"),
	CONSTRAINT "staff_token_revocation_check" CHECK ("core"."staff_token"."revoked_at" is not null
          or ("core"."staff_token"."revoked_reason" is null and "core"."staff_token"."revoked_by_account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "edge"."print_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"station_id" uuid,
	"device_id" uuid,
	"role" text,
	"kind" text NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"copies" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"reprint_of" uuid,
	"reprint_reason" text,
	"requested_by_account_id" uuid,
	"action_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_job_status_check" CHECK ("edge"."print_job"."status" in ('queued','printed','failed','skipped')),
	CONSTRAINT "print_job_kind_check" CHECK ("edge"."print_job"."kind" in ('receipt','kitchen_ticket','bar_ticket','kids_wristband','adult_wristband','credit_voucher','item_voucher','booth_voucher','test_page')),
	CONSTRAINT "print_job_role_check" CHECK ("edge"."print_job"."role" is null or "edge"."print_job"."role" in ('receipt','kids_band','adult_band','kitchen','bar','scanner','card_terminal','qr_terminal','gate','cash_drawer')),
	CONSTRAINT "print_job_subject_check" CHECK ("edge"."print_job"."subject_type" is null or "edge"."print_job"."subject_type" in ('sale','sale_line','band','voucher','booking','visit','station')),
	CONSTRAINT "print_job_copies_check" CHECK ("edge"."print_job"."copies" > 0),
	CONSTRAINT "print_job_attempts_check" CHECK ("edge"."print_job"."attempts" >= 0),
	CONSTRAINT "print_job_template_version_check" CHECK ("edge"."print_job"."template_version" is null or "edge"."print_job"."template_version" > 0),
	CONSTRAINT "print_job_printed_device_check" CHECK ("edge"."print_job"."status" <> 'printed' or "edge"."print_job"."device_id" is not null),
	CONSTRAINT "print_job_finished_check" CHECK (("edge"."print_job"."status" = 'queued') = ("edge"."print_job"."finished_at" is null)),
	CONSTRAINT "print_job_reprint_self_check" CHECK ("edge"."print_job"."reprint_of" is null or "edge"."print_job"."reprint_of" <> "edge"."print_job"."id")
);
--> statement-breakpoint
CREATE TABLE "pos"."print_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"show_logo" boolean DEFAULT true NOT NULL,
	"header_text" text,
	"footer_text" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "print_template_type_check" CHECK ("pos"."print_template"."type" in ('receipt','kids_wristband','adult_wristband','kitchen_ticket','bar_ticket','credit_voucher')),
	CONSTRAINT "print_template_version_check" CHECK ("pos"."print_template"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "edge"."box_command" DROP CONSTRAINT "box_command_kind_check";--> statement-breakpoint
ALTER TABLE "core"."device" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "core"."session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."staff_token" ADD CONSTRAINT "staff_token_revoked_by_account_id_account_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_template_id_print_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "pos"."print_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_requested_by_account_id_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."print_template" ADD CONSTRAINT "print_template_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."print_template" ADD CONSTRAINT "print_template_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_token_deny_idx" ON "core"."staff_token" USING btree ("expires_at") WHERE revoked_at is not null;--> statement-breakpoint
CREATE INDEX "staff_token_box_issued_idx" ON "core"."staff_token" USING btree ("box_id","issued_at");--> statement-breakpoint
CREATE INDEX "staff_token_account_issued_idx" ON "core"."staff_token" USING btree ("account_id","issued_at");--> statement-breakpoint
CREATE INDEX "staff_token_session_idx" ON "core"."staff_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "staff_token_station_idx" ON "core"."staff_token" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "staff_token_operator_idx" ON "core"."staff_token" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "staff_token_branch_idx" ON "core"."staff_token" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "staff_token_revoked_by_idx" ON "core"."staff_token" USING btree ("revoked_by_account_id");--> statement-breakpoint
CREATE INDEX "print_job_box_queued_idx" ON "edge"."print_job" USING btree ("box_id","queued_at");--> statement-breakpoint
CREATE INDEX "print_job_pending_idx" ON "edge"."print_job" USING btree ("box_id","queued_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "print_job_device_queued_idx" ON "edge"."print_job" USING btree ("device_id","queued_at");--> statement-breakpoint
CREATE INDEX "print_job_station_queued_idx" ON "edge"."print_job" USING btree ("station_id","queued_at");--> statement-breakpoint
CREATE INDEX "print_job_branch_queued_idx" ON "edge"."print_job" USING btree ("branch_id","queued_at");--> statement-breakpoint
CREATE INDEX "print_job_subject_idx" ON "edge"."print_job" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "print_job_reprint_idx" ON "edge"."print_job" USING btree ("reprint_of") WHERE reprint_of is not null;--> statement-breakpoint
CREATE INDEX "print_job_action_idx" ON "edge"."print_job" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "print_job_queued_idx" ON "edge"."print_job" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "print_job_operator_idx" ON "edge"."print_job" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "print_job_template_idx" ON "edge"."print_job" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "print_job_requested_by_idx" ON "edge"."print_job" USING btree ("requested_by_account_id");--> statement-breakpoint
CREATE INDEX "print_template_operator_idx" ON "pos"."print_template" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "print_template_branch_idx" ON "pos"."print_template" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_template_branch_type_unique" ON "pos"."print_template" USING btree ("branch_id","type") WHERE archived_at is null;--> statement-breakpoint
ALTER TABLE "edge"."box_command" ADD CONSTRAINT "box_command_kind_check" CHECK ("edge"."box_command"."kind" in ('test_print','config_apply','clear_cache','collect_logs','restart','go_offline','go_online','reset_store','simulate'));