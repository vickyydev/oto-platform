-- S2-15a round 2 (plan docs/progress/plans/cash/PLAN.md §4, §7 round 2;
-- SCRUM-215) — the provisional close, stranded occupancy and the End of Day
-- receipt. Add-only:
--   - pos.occupancy_resolution: a manual resolution of a band still counted
--     inside, or a child still checked in, at close (left without scanning,
--     band lost, gate fault), with who recorded it and when. Append-only, by
--     trigger, under the demo reset's purge flag (oto.cash_ledger_purge). The
--     gate's journal and the check-in are not touched.
--   - pos.end_of_day: the manager override (who, why, the rows as they stood)
--     and the receipt's number and closing counter, nullable, written at the
--     one insert a close makes.
--   - pos.receipt_series.kind and edge.print_job.subject_type each widen by
--     one word, 'end_of_day': the receipt is numbered on the closing counter's
--     own series and printed as a job about the closed day.
--
-- Undo (before anything is written to them): DROP TABLE
-- "pos"."occupancy_resolution"; DROP FUNCTION
-- "pos"."occupancy_resolution_append_only"(); ALTER TABLE "pos"."end_of_day"
-- DROP COLUMN "override_by_account_id", DROP COLUMN "override_reason", DROP
-- COLUMN "override_stranded", DROP COLUMN "receipt_number", DROP COLUMN
-- "receipt_station_id"; restore the two CHECKs without 'end_of_day'.

CREATE TABLE "pos"."occupancy_resolution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"band_id" uuid,
	"checkin_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"resolved_by_account_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	"action_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occupancy_resolution_kind_check" CHECK ("pos"."occupancy_resolution"."kind" in ('band','checkin')),
	CONSTRAINT "occupancy_resolution_subject_check" CHECK (("pos"."occupancy_resolution"."kind" = 'band' and "pos"."occupancy_resolution"."band_id" is not null and "pos"."occupancy_resolution"."checkin_id" is null)
          or ("pos"."occupancy_resolution"."kind" = 'checkin' and "pos"."occupancy_resolution"."checkin_id" is not null and "pos"."occupancy_resolution"."band_id" is null)),
	CONSTRAINT "occupancy_resolution_reason_check" CHECK ("pos"."occupancy_resolution"."reason" in ('left_without_scanning','band_lost','gate_fault')),
	CONSTRAINT "occupancy_resolution_action_check" CHECK (length("pos"."occupancy_resolution"."action_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "edge"."print_job" DROP CONSTRAINT "print_job_subject_check";--> statement-breakpoint
ALTER TABLE "pos"."receipt_series" DROP CONSTRAINT "receipt_series_kind_check";--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD COLUMN "override_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD COLUMN "override_stranded" jsonb;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD COLUMN "receipt_number" text;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD COLUMN "receipt_station_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."occupancy_resolution" ADD CONSTRAINT "occupancy_resolution_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."occupancy_resolution" ADD CONSTRAINT "occupancy_resolution_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."occupancy_resolution" ADD CONSTRAINT "occupancy_resolution_band_id_band_id_fk" FOREIGN KEY ("band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."occupancy_resolution" ADD CONSTRAINT "occupancy_resolution_checkin_id_checkin_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "pos"."checkin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."occupancy_resolution" ADD CONSTRAINT "occupancy_resolution_resolved_by_account_id_account_id_fk" FOREIGN KEY ("resolved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "occupancy_resolution_action_unique" ON "pos"."occupancy_resolution" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE INDEX "occupancy_resolution_branch_date_idx" ON "pos"."occupancy_resolution" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "occupancy_resolution_operator_idx" ON "pos"."occupancy_resolution" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "occupancy_resolution_band_idx" ON "pos"."occupancy_resolution" USING btree ("band_id","resolved_at");--> statement-breakpoint
CREATE INDEX "occupancy_resolution_checkin_idx" ON "pos"."occupancy_resolution" USING btree ("checkin_id");--> statement-breakpoint
CREATE INDEX "occupancy_resolution_resolved_by_idx" ON "pos"."occupancy_resolution" USING btree ("resolved_by_account_id");--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_override_by_account_id_account_id_fk" FOREIGN KEY ("override_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_receipt_station_id_station_id_fk" FOREIGN KEY ("receipt_station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "end_of_day_override_by_idx" ON "pos"."end_of_day" USING btree ("override_by_account_id");--> statement-breakpoint
CREATE INDEX "end_of_day_receipt_station_idx" ON "pos"."end_of_day" USING btree ("receipt_station_id");--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_override_check" CHECK (("pos"."end_of_day"."override_by_account_id" is null and "pos"."end_of_day"."override_reason" is null and "pos"."end_of_day"."override_stranded" is null)
          or ("pos"."end_of_day"."override_by_account_id" is not null
              and "pos"."end_of_day"."override_reason" is not null and length(trim("pos"."end_of_day"."override_reason")) > 0
              and "pos"."end_of_day"."override_stranded" is not null and jsonb_typeof("pos"."end_of_day"."override_stranded") = 'array'));--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_receipt_check" CHECK (("pos"."end_of_day"."receipt_number" is null) = ("pos"."end_of_day"."receipt_station_id" is null));--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_subject_check" CHECK ("edge"."print_job"."subject_type" is null or "edge"."print_job"."subject_type" in ('sale','sale_line','band','voucher','booking','visit','station','wallet','end_of_day'));--> statement-breakpoint
ALTER TABLE "pos"."receipt_series" ADD CONSTRAINT "receipt_series_kind_check" CHECK ("pos"."receipt_series"."kind" in ('sale','refund','end_of_day'));
--> statement-breakpoint
CREATE FUNCTION "pos"."occupancy_resolution_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('oto.cash_ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pos.% is append-only: a manual resolution is recorded once and never edited or removed', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER "occupancy_resolution_append_only" BEFORE UPDATE OR DELETE ON "pos"."occupancy_resolution"
FOR EACH ROW EXECUTE FUNCTION "pos"."occupancy_resolution_append_only"();
