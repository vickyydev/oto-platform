-- S2-15a round 1 (plan docs/progress/plans/cash/PLAN.md §6, revised 2 Oct
-- after the owner's ruling on SCRUM-488) — the End of Day.
--
-- ONE combined cash count for the whole branch per business day, as the
-- prototype's Today > End of Day has it. Add-only:
--   - pos.end_of_day: one row per (branch, business_date), written ONLY at
--     Close Day — the channel lines as they stood (expected, actual,
--     difference), the count, the float and the close it was carried from,
--     the float left for tomorrow, the voucher counts, the notes, the totals,
--     who closed it and when. Unique on (branch_id, business_date), so a
--     second close is refused by the database as well as by the service.
--   - pos.cash_movement: append-only paid-outs (with an approver) and safe
--     drops (with a witness), each never the person who took the cash out;
--     action_id unique per operator, so a retried press records once.
-- Both refuse UPDATE, and DELETE except under the demo reset's purge flag
-- (oto.cash_ledger_purge): a closed day is read back exactly as saved, and a
-- recorded movement is explained, never rewritten.
--
-- No drawer sessions, no refund business_date column, no correction table.
--
-- Undo (before anything is written to them): DROP TABLE "pos"."cash_movement";
-- DROP TABLE "pos"."end_of_day"; DROP FUNCTION "pos"."cash_ledger_append_only"();

CREATE TABLE "pos"."cash_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"reason" text NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"approver_account_id" uuid,
	"witness_account_id" uuid,
	"action_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_kind_check" CHECK ("pos"."cash_movement"."kind" in ('paid_out','safe_drop')),
	CONSTRAINT "cash_movement_amount_check" CHECK ("pos"."cash_movement"."amount_satang" > 0),
	CONSTRAINT "cash_movement_reason_check" CHECK (length(trim("pos"."cash_movement"."reason")) > 0),
	CONSTRAINT "cash_movement_action_check" CHECK (length("pos"."cash_movement"."action_id") between 1 and 200),
	CONSTRAINT "cash_movement_second_person_check" CHECK (("pos"."cash_movement"."kind" = 'paid_out' and "pos"."cash_movement"."approver_account_id" is not null and "pos"."cash_movement"."witness_account_id" is null
             and "pos"."cash_movement"."approver_account_id" <> "pos"."cash_movement"."actor_account_id")
          or ("pos"."cash_movement"."kind" = 'safe_drop' and "pos"."cash_movement"."witness_account_id" is not null and "pos"."cash_movement"."approver_account_id" is null
             and "pos"."cash_movement"."witness_account_id" <> "pos"."cash_movement"."actor_account_id"))
);
--> statement-breakpoint
CREATE TABLE "pos"."end_of_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"lines" jsonb NOT NULL,
	"counted_satang" bigint,
	"float_satang" bigint NOT NULL,
	"float_from_date" date,
	"float_left_satang" bigint,
	"vouchers_handed_out" integer,
	"vouchers_redeemed" integer,
	"notes" text,
	"total_expected_satang" bigint NOT NULL,
	"total_actual_satang" bigint NOT NULL,
	"total_difference_satang" bigint NOT NULL,
	"closed_by_account_id" uuid NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "end_of_day_amounts_check" CHECK ("pos"."end_of_day"."float_satang" >= 0
          and ("pos"."end_of_day"."counted_satang" is null or "pos"."end_of_day"."counted_satang" >= 0)
          and ("pos"."end_of_day"."float_left_satang" is null or "pos"."end_of_day"."float_left_satang" >= 0)),
	CONSTRAINT "end_of_day_vouchers_check" CHECK (("pos"."end_of_day"."vouchers_handed_out" is null or "pos"."end_of_day"."vouchers_handed_out" >= 0)
          and ("pos"."end_of_day"."vouchers_redeemed" is null or "pos"."end_of_day"."vouchers_redeemed" >= 0)),
	CONSTRAINT "end_of_day_lines_check" CHECK (jsonb_typeof("pos"."end_of_day"."lines") = 'array')
);
--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_approver_account_id_account_id_fk" FOREIGN KEY ("approver_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_witness_account_id_account_id_fk" FOREIGN KEY ("witness_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_closed_by_account_id_account_id_fk" FOREIGN KEY ("closed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_action_unique" ON "pos"."cash_movement" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE INDEX "cash_movement_branch_date_idx" ON "pos"."cash_movement" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_movement_operator_idx" ON "pos"."cash_movement" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "cash_movement_actor_idx" ON "pos"."cash_movement" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "cash_movement_approver_idx" ON "pos"."cash_movement" USING btree ("approver_account_id");--> statement-breakpoint
CREATE INDEX "cash_movement_witness_idx" ON "pos"."cash_movement" USING btree ("witness_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "end_of_day_branch_date_unique" ON "pos"."end_of_day" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "end_of_day_operator_idx" ON "pos"."end_of_day" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "end_of_day_closed_by_idx" ON "pos"."end_of_day" USING btree ("closed_by_account_id");--> statement-breakpoint
CREATE FUNCTION "pos"."cash_ledger_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('oto.cash_ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pos.% is append-only: a closed day and a recorded paid-out or safe drop are never edited or removed', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER "end_of_day_append_only" BEFORE UPDATE OR DELETE ON "pos"."end_of_day"
FOR EACH ROW EXECUTE FUNCTION "pos"."cash_ledger_append_only"();
--> statement-breakpoint
CREATE TRIGGER "cash_movement_append_only" BEFORE UPDATE OR DELETE ON "pos"."cash_movement"
FOR EACH ROW EXECUTE FUNCTION "pos"."cash_ledger_append_only"();
