-- SCRUM-805 (a party's kitchen and bar slips at a set time; birthday plan
-- section 5, the owner's decision 3) - expand-only: one new table, one new
-- nullable column, and one check widened by a word. Nothing existing is
-- rewritten or dropped, and a release that does not know them never reads them.
--
--   pos.party_slip_print                    new table
--       one row per slip per printing of a party's slips (kitchen, bar),
--       keyed by the OTO App's party, its day, the station and the run; a
--       reprint is the next run. Empty until a party's slip time passes.
--   core.branch.party_slips_station_id      uuid, null, FK core.station
--       the station whose kitchen and bar printers receive the slips. Null on
--       every branch until the park names one; the slips are then recorded
--       "no printer". PostgreSQL adds a nullable column without rewriting the
--       table. ON DELETE SET NULL: a deleted station leaves no printer named.
--   edge.print_job.print_job_subject_check  dropped and added again with
--       'party_slip' beside the nine words it held, as 0058 widened it for
--       'end_of_day'. Every existing row still satisfies it.
CREATE TABLE "pos"."party_slip_print" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"party_date" date NOT NULL,
	"station" text NOT NULL,
	"run" integer NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"print_job_id" uuid,
	"document" jsonb,
	"printed_at" timestamp with time zone,
	"requested_by_account_id" uuid,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_slip_print_station_check" CHECK ("pos"."party_slip_print"."station" in ('kitchen','bar')),
	CONSTRAINT "party_slip_print_status_check" CHECK ("pos"."party_slip_print"."status" in ('printed','no_printer','nothing_to_print')),
	CONSTRAINT "party_slip_print_trigger_check" CHECK ("pos"."party_slip_print"."trigger" in ('schedule','reprint')),
	CONSTRAINT "party_slip_print_run_check" CHECK ("pos"."party_slip_print"."run" > 0),
	CONSTRAINT "party_slip_print_printed_check" CHECK (("pos"."party_slip_print"."status" = 'printed') = ("pos"."party_slip_print"."print_job_id" is not null and "pos"."party_slip_print"."printed_at" is not null)),
	CONSTRAINT "party_slip_print_document_check" CHECK (("pos"."party_slip_print"."status" = 'nothing_to_print') = ("pos"."party_slip_print"."document" is null))
);
--> statement-breakpoint
ALTER TABLE "edge"."print_job" DROP CONSTRAINT "print_job_subject_check";--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "party_slips_station_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."party_slip_print" ADD CONSTRAINT "party_slip_print_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_slip_print" ADD CONSTRAINT "party_slip_print_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_slip_print" ADD CONSTRAINT "party_slip_print_requested_by_account_id_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_slip_print_run_unique" ON "pos"."party_slip_print" USING btree ("event_id","party_date","station","run");--> statement-breakpoint
CREATE INDEX "party_slip_print_operator_idx" ON "pos"."party_slip_print" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_slip_print_branch_date_idx" ON "pos"."party_slip_print" USING btree ("branch_id","party_date");--> statement-breakpoint
CREATE INDEX "party_slip_print_job_idx" ON "pos"."party_slip_print" USING btree ("print_job_id");--> statement-breakpoint
CREATE INDEX "party_slip_print_requested_by_idx" ON "pos"."party_slip_print" USING btree ("requested_by_account_id");--> statement-breakpoint
ALTER TABLE "core"."branch" ADD CONSTRAINT "branch_party_slips_station_id_station_id_fk" FOREIGN KEY ("party_slips_station_id") REFERENCES "core"."station"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_party_slips_station_idx" ON "core"."branch" USING btree ("party_slips_station_id");--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_subject_check" CHECK ("edge"."print_job"."subject_type" is null or "edge"."print_job"."subject_type" in ('sale','sale_line','band','voucher','booking','visit','station','wallet','end_of_day','party_slip'));