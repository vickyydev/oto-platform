-- SCRUM-473 (plan D4-D6, docs/progress/plans/booth/TEMPLATES_AND_DUTY_PLAN.md) —
-- the day's booth staff, synced from the OTO App's scheduling and merged into
-- one label on every voucher.
--
-- booth.booth_duty_assignment is the dated roster: one row per person per booth
-- per trading day, with where it came from (app_schedule, app_duty_block,
-- manual, self_assigned). account_id is nullable because a casual worker has no
-- account and never signs in, yet is named on the slip. The unique index is
-- over the account when there is one, else the app's casual worker id (two
-- different casuals who share a nickname are two rows), else the lower-cased
-- name (a name typed by hand), so a person with a shift AND a duty block is on
-- the roster once. casual_worker_id is text, not uuid: the app's ids are
-- varchar, and an id that is not a uuid must not fail a booth's whole sync.
--
-- booth.booth_duty_sync remembers the last sync of each booth for each day: the
-- morning job reads it to sync once at the branch's open, and the Console reads
-- the names the sync could not follow to an account from it.
--
-- booth.booth_settings gains the per-booth match rule. THE DEFAULTS ARE THE
-- RECOMMENDED RULE ('Sale Booth' for the shift group, department or role;
-- 'booth' inside a duty block's name), so every existing booth matches the
-- park's real rows without anybody touching it. Neither column is published to
-- the box, so no bundle hash moves.
--
-- New tables, and columns with constant defaults: no table rewrite on
-- PostgreSQL 11+, safe on a live database. Forward only.
CREATE TABLE "booth"."booth_duty_assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"account_id" uuid,
	"display_name" text NOT NULL,
	"casual_worker_id" text,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone,
	"added_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booth_duty_assignment_source_check" CHECK ("booth"."booth_duty_assignment"."source" in ('app_schedule','app_duty_block','manual','self_assigned')),
	CONSTRAINT "booth_duty_assignment_display_name_check" CHECK (char_length(btrim("booth"."booth_duty_assignment"."display_name")) between 1 and 100),
	CONSTRAINT "booth_duty_assignment_casual_check" CHECK ("booth"."booth_duty_assignment"."account_id" is null or "booth"."booth_duty_assignment"."casual_worker_id" is null)
);
--> statement-breakpoint
CREATE TABLE "booth"."booth_duty_sync" (
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"app_state" text NOT NULL,
	"unmatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booth_duty_sync_station_id_business_date_pk" PRIMARY KEY("station_id","business_date"),
	CONSTRAINT "booth_duty_sync_app_state_check" CHECK ("booth"."booth_duty_sync"."app_state" in ('ok','app_not_installed','no_app_branch','ambiguous_app_branch'))
);
--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "duty_group_text" text DEFAULT 'Sale Booth' NOT NULL;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "duty_match_text" text DEFAULT 'booth' NOT NULL;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_assignment" ADD CONSTRAINT "booth_duty_assignment_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_assignment" ADD CONSTRAINT "booth_duty_assignment_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_assignment" ADD CONSTRAINT "booth_duty_assignment_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_assignment" ADD CONSTRAINT "booth_duty_assignment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_assignment" ADD CONSTRAINT "booth_duty_assignment_added_by_account_id_account_id_fk" FOREIGN KEY ("added_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_sync" ADD CONSTRAINT "booth_duty_sync_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_sync" ADD CONSTRAINT "booth_duty_sync_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_sync" ADD CONSTRAINT "booth_duty_sync_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_duty_sync" ADD CONSTRAINT "booth_duty_sync_synced_by_account_id_account_id_fk" FOREIGN KEY ("synced_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booth_duty_assignment_person_unique" ON "booth"."booth_duty_assignment" USING btree ("station_id","business_date",coalesce("account_id"::text, "casual_worker_id", lower("display_name")));--> statement-breakpoint
CREATE INDEX "booth_duty_assignment_station_date_idx" ON "booth"."booth_duty_assignment" USING btree ("station_id","business_date");--> statement-breakpoint
CREATE INDEX "booth_duty_assignment_operator_idx" ON "booth"."booth_duty_assignment" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booth_duty_assignment_branch_idx" ON "booth"."booth_duty_assignment" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "booth_duty_assignment_account_idx" ON "booth"."booth_duty_assignment" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "booth_duty_assignment_added_by_idx" ON "booth"."booth_duty_assignment" USING btree ("added_by_account_id");--> statement-breakpoint
CREATE INDEX "booth_duty_sync_operator_idx" ON "booth"."booth_duty_sync" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booth_duty_sync_branch_idx" ON "booth"."booth_duty_sync" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "booth_duty_sync_synced_by_idx" ON "booth"."booth_duty_sync" USING btree ("synced_by_account_id");--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_duty_group_text_check" CHECK (char_length("booth"."booth_settings"."duty_group_text") <= 100);--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_duty_match_text_check" CHECK (char_length("booth"."booth_settings"."duty_match_text") <= 100);