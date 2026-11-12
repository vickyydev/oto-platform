-- SCRUM-861 (a void slip and an updated-items slip reach the kitchen and the
-- bar) - expand-only: one new table and one check widened by a word. Nothing
-- existing is rewritten or dropped, and a release that does not know them
-- never reads them.
--
--   pos.prep_slip_print                     new table
--       one row per VOID or UPDATED slip sent to a station: by a sale's
--       refund (the sale and the refund named) or by a party's plan changing
--       after its slips printed (the OTO App's party, its day, the run and
--       the fingerprint of the slip the station now holds). Carries the slip
--       as it was composed, the print job that put it on paper and what
--       became of it, as pos.party_slip_print does. Empty until a refund
--       cancels an order a station already has, or a printed party's plan
--       changes.
--   edge.print_job.print_job_subject_check  dropped and added again with
--       'prep_slip' beside the ten words it held, as 0109 widened it for
--       'party_slip'. Every existing row still satisfies it.
--
-- TO REVERSE (nothing else depends on the table): drop pos.prep_slip_print,
-- then re-add print_job_subject_check with the list of 0109_party_slips
-- (ending in 'party_slip'). Rows of edge.print_job with subject_type
-- 'prep_slip' would fail that check: delete them first (they name slips of
-- the dropped table and nothing else).
CREATE TABLE "pos"."prep_slip_print" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"source" text NOT NULL,
	"sale_id" uuid,
	"refund_id" uuid,
	"event_id" uuid,
	"party_date" date,
	"run" integer,
	"plan_fingerprint" text,
	"station" text NOT NULL,
	"variant" text NOT NULL,
	"status" text NOT NULL,
	"print_job_id" uuid,
	"document" jsonb NOT NULL,
	"printed_at" timestamp with time zone,
	"requested_by_account_id" uuid,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prep_slip_print_source_check" CHECK ("pos"."prep_slip_print"."source" in ('refund','party')),
	CONSTRAINT "prep_slip_print_station_check" CHECK ("pos"."prep_slip_print"."station" in ('kitchen','bar')),
	CONSTRAINT "prep_slip_print_variant_check" CHECK ("pos"."prep_slip_print"."variant" in ('void','updated')),
	CONSTRAINT "prep_slip_print_status_check" CHECK ("pos"."prep_slip_print"."status" in ('printed','no_printer')),
	CONSTRAINT "prep_slip_print_run_check" CHECK ("pos"."prep_slip_print"."run" is null or "pos"."prep_slip_print"."run" > 0),
	CONSTRAINT "prep_slip_print_refund_check" CHECK (("pos"."prep_slip_print"."source" = 'refund') = ("pos"."prep_slip_print"."refund_id" is not null and "pos"."prep_slip_print"."sale_id" is not null)),
	CONSTRAINT "prep_slip_print_party_check" CHECK (("pos"."prep_slip_print"."source" = 'party') = ("pos"."prep_slip_print"."event_id" is not null and "pos"."prep_slip_print"."party_date" is not null and "pos"."prep_slip_print"."run" is not null and "pos"."prep_slip_print"."plan_fingerprint" is not null)),
	CONSTRAINT "prep_slip_print_printed_check" CHECK (("pos"."prep_slip_print"."status" = 'printed') = ("pos"."prep_slip_print"."print_job_id" is not null and "pos"."prep_slip_print"."printed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "edge"."print_job" DROP CONSTRAINT "print_job_subject_check";--> statement-breakpoint
ALTER TABLE "pos"."prep_slip_print" ADD CONSTRAINT "prep_slip_print_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prep_slip_print" ADD CONSTRAINT "prep_slip_print_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prep_slip_print" ADD CONSTRAINT "prep_slip_print_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prep_slip_print" ADD CONSTRAINT "prep_slip_print_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "pos"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."prep_slip_print" ADD CONSTRAINT "prep_slip_print_requested_by_account_id_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prep_slip_print_refund_unique" ON "pos"."prep_slip_print" USING btree ("refund_id","station","variant") WHERE refund_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "prep_slip_print_party_unique" ON "pos"."prep_slip_print" USING btree ("event_id","party_date","station","variant","run") WHERE event_id is not null;--> statement-breakpoint
CREATE INDEX "prep_slip_print_operator_idx" ON "pos"."prep_slip_print" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "prep_slip_print_branch_idx" ON "pos"."prep_slip_print" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "prep_slip_print_sale_idx" ON "pos"."prep_slip_print" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "prep_slip_print_refund_idx" ON "pos"."prep_slip_print" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "prep_slip_print_party_idx" ON "pos"."prep_slip_print" USING btree ("event_id","party_date");--> statement-breakpoint
CREATE INDEX "prep_slip_print_job_idx" ON "pos"."prep_slip_print" USING btree ("print_job_id");--> statement-breakpoint
CREATE INDEX "prep_slip_print_requested_by_idx" ON "pos"."prep_slip_print" USING btree ("requested_by_account_id");--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_subject_check" CHECK ("edge"."print_job"."subject_type" is null or "edge"."print_job"."subject_type" in ('sale','sale_line','band','voucher','booking','visit','station','wallet','end_of_day','party_slip','prep_slip'));