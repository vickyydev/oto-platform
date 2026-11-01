-- SCRUM-699 (nannies and their shifts from the OTO App rota, with a Console
-- fallback) - expand-only: nullable columns or columns with a constant
-- default, which PostgreSQL 11+ adds without rewriting the table; one new
-- table; new indexes and checks. A release that does not know the columns
-- never reads them, and the till's roster read (nannyRosterOf) is unchanged.
--
--   pos.nanny.source               text, not null
--       where the nanny came from: 'seed' (the demo roster), 'app_schedule'
--       (the OTO App's rota) or 'manual' (added by hand on the Console).
--       Every existing row is 'seed' - the demo seed was the only writer of
--       this table until now - so the column is added with DEFAULT 'seed'
--       and the default is then changed to 'manual' for rows written later.
--   pos.nanny.app_employee_id      text, null
--       the OTO App's employees.id (varchar there, so text; no FK), set
--       exactly on 'app_schedule' rows; unique per branch among live rows.
--   pos.nanny_shift.source         text, not null
--       the same three words, added the same way: every existing shift is
--       'seed', later rows default to 'manual'. A sync writes and removes
--       only 'app_schedule' shifts.
--   pos.nanny_shift.business_date  date, null
--       the trading day an app or manual shift was written for; required on
--       'app_schedule' rows, null on seed rows and on rows written directly.
--   pos.nanny_shift.app_assignment_id  text, null
--       otoapp.schedule_assignments.id, set exactly on 'app_schedule' rows.
--   pos.nanny_shift.synced_at      timestamptz, null
--       when a sync last wrote the row.
--   pos.nanny_shift.added_by_account_id  uuid, null (FK core.account)
--       who added a manual shift.
--   pos.supervision_policy.nanny_match_text  text, not null, default 'Nanny'
--       the text that makes somebody on the rota a nanny at this park (the
--       Thai word is matched as well, in code); at most 100 characters.
--   pos.nanny_sync                 new table, one row per branch and trading day
--       when the rota was last read, the app's state and whom the sync could
--       not make a nanny; it is also what tells the morning job the branch is
--       done for the day.
--
-- TO REVERSE: DROP TABLE "pos"."nanny_sync"; drop the checks
-- nanny_source_check, nanny_app_employee_check, nanny_shift_source_check,
-- nanny_shift_app_check and supervision_policy_nanny_match_text_check; drop
-- the indexes nanny_branch_app_employee_unique,
-- nanny_shift_app_assignment_unique, nanny_shift_branch_date_idx and
-- nanny_shift_added_by_idx (the FK nanny_shift_added_by_account_id_account_id_fk
-- goes with its column); then drop the columns nanny.source,
-- nanny.app_employee_id, nanny_shift.source, nanny_shift.business_date,
-- nanny_shift.app_assignment_id, nanny_shift.synced_at,
-- nanny_shift.added_by_account_id and supervision_policy.nanny_match_text.
-- App-sourced and manual nannies and shifts stay readable by the till, which
-- reads names and shift spans only; where each came from is lost.
CREATE TABLE "pos"."nanny_sync" (
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"app_state" text NOT NULL,
	"unmatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nanny_sync_branch_id_business_date_pk" PRIMARY KEY("branch_id","business_date"),
	CONSTRAINT "nanny_sync_app_state_check" CHECK ("pos"."nanny_sync"."app_state" in ('ok','app_not_installed','no_app_branch','ambiguous_app_branch'))
);
--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD COLUMN "source" text DEFAULT 'seed' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."nanny" ALTER COLUMN "source" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD COLUMN "app_employee_id" text;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD COLUMN "source" text DEFAULT 'seed' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ALTER COLUMN "source" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD COLUMN "app_assignment_id" text;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD COLUMN "added_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."supervision_policy" ADD COLUMN "nanny_match_text" text DEFAULT 'Nanny' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."nanny_sync" ADD CONSTRAINT "nanny_sync_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny_sync" ADD CONSTRAINT "nanny_sync_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny_sync" ADD CONSTRAINT "nanny_sync_synced_by_account_id_account_id_fk" FOREIGN KEY ("synced_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nanny_sync_operator_idx" ON "pos"."nanny_sync" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "nanny_sync_synced_by_idx" ON "pos"."nanny_sync" USING btree ("synced_by_account_id");--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD CONSTRAINT "nanny_shift_added_by_account_id_account_id_fk" FOREIGN KEY ("added_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nanny_branch_app_employee_unique" ON "pos"."nanny" USING btree ("branch_id","app_employee_id") WHERE app_employee_id is not null and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "nanny_shift_app_assignment_unique" ON "pos"."nanny_shift" USING btree ("branch_id","app_assignment_id","nanny_id") WHERE app_assignment_id is not null;--> statement-breakpoint
CREATE INDEX "nanny_shift_branch_date_idx" ON "pos"."nanny_shift" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "nanny_shift_added_by_idx" ON "pos"."nanny_shift" USING btree ("added_by_account_id");--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD CONSTRAINT "nanny_source_check" CHECK ("pos"."nanny"."source" in ('seed','app_schedule','manual'));--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD CONSTRAINT "nanny_app_employee_check" CHECK (("pos"."nanny"."source" = 'app_schedule') = ("pos"."nanny"."app_employee_id" is not null));--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD CONSTRAINT "nanny_shift_source_check" CHECK ("pos"."nanny_shift"."source" in ('seed','app_schedule','manual'));--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD CONSTRAINT "nanny_shift_app_check" CHECK (("pos"."nanny_shift"."source" = 'app_schedule') = ("pos"."nanny_shift"."app_assignment_id" is not null) and ("pos"."nanny_shift"."source" <> 'app_schedule' or "pos"."nanny_shift"."business_date" is not null));--> statement-breakpoint
ALTER TABLE "pos"."supervision_policy" ADD CONSTRAINT "supervision_policy_nanny_match_text_check" CHECK (char_length("pos"."supervision_policy"."nanny_match_text") <= 100);