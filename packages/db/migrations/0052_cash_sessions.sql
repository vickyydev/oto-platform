-- S2-15a round 1 (plan docs/progress/plans/cash/PLAN.md §2.1) — cash sessions
-- and the End of Day, every table at once (used from rounds 1, 2 and 3).
--
--   pos.cash_session        one per station drawer, open to close: the float
--                           (carried from the drawer's last close, else the
--                           branch default), and at close the count, the
--                           expected figure, the variance, the tolerance in
--                           force, the float left and the closer's sign-off.
--                           One open session per station (partial unique).
--   pos.cash_movement       the drawer's append-only, action-keyed ledger:
--                           float, paid_out (an approver who is not the actor),
--                           safe_drop (a witness who is not the actor), top_up,
--                           refund_out (names its refund). A trigger refuses
--                           UPDATE and DELETE except under the demo reset's
--                           `oto.cash_ledger_purge` flag.
--   pos.end_of_day, pos.recon_line, pos.eod_correction      round 2
--   pos.settlement_batch, pos.settlement_line               round 3
--   analytics.fact_cash_daily                               per branch, date, line
--
-- core.branch gains the drawer's settings: cash_default_float_satang (฿6,000)
-- and cash_tolerance_satang (฿1), in satang (OD-CS3).
--
-- pos.refund gains business_date (OD-CS4): the trading day the money left, at
-- the branch, from its day start. Existing rows are backfilled from created_at
-- in the branch's own business day; a BEFORE INSERT trigger fills it the same
-- way for any writer that does not say (the service always does).
--
-- Undo: drop the eight new tables, the two trigger functions and their
-- triggers, refund.business_date and refund_branch_date_idx, and the two
-- branch columns with branch_cash_settings_check.

CREATE TABLE "pos"."cash_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"reason" text,
	"actor_account_id" uuid NOT NULL,
	"approver_account_id" uuid,
	"witness_account_id" uuid,
	"refund_id" uuid,
	"business_date" date NOT NULL,
	"action_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_kind_check" CHECK ("pos"."cash_movement"."kind" in ('float','paid_out','safe_drop','top_up','refund_out')),
	CONSTRAINT "cash_movement_amount_check" CHECK ("pos"."cash_movement"."amount_satang" > 0 or ("pos"."cash_movement"."kind" = 'float' and "pos"."cash_movement"."amount_satang" = 0)),
	CONSTRAINT "cash_movement_approver_check" CHECK ("pos"."cash_movement"."kind" <> 'paid_out'
          or ("pos"."cash_movement"."approver_account_id" is not null and "pos"."cash_movement"."approver_account_id" <> "pos"."cash_movement"."actor_account_id")),
	CONSTRAINT "cash_movement_witness_check" CHECK ("pos"."cash_movement"."kind" <> 'safe_drop'
          or ("pos"."cash_movement"."witness_account_id" is not null and "pos"."cash_movement"."witness_account_id" <> "pos"."cash_movement"."actor_account_id")),
	CONSTRAINT "cash_movement_refund_check" CHECK (("pos"."cash_movement"."kind" = 'refund_out') = ("pos"."cash_movement"."refund_id" is not null)),
	CONSTRAINT "cash_movement_reason_check" CHECK ("pos"."cash_movement"."kind" not in ('paid_out','safe_drop','top_up') or length(trim(coalesce("pos"."cash_movement"."reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."cash_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by_account_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float_satang" bigint NOT NULL,
	"float_source_session_id" uuid,
	"closed_by_account_id" uuid,
	"closed_at" timestamp with time zone,
	"counted_satang" bigint,
	"expected_satang" bigint,
	"variance_satang" bigint,
	"tolerance_satang" bigint,
	"float_left_satang" bigint,
	"notes" text,
	"signed_off_by_account_id" uuid,
	"signed_off_at" timestamp with time zone,
	"open_action_id" text,
	"close_action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_session_status_check" CHECK ("pos"."cash_session"."status" in ('open','closed')),
	CONSTRAINT "cash_session_amounts_check" CHECK ("pos"."cash_session"."opening_float_satang" >= 0
          and ("pos"."cash_session"."counted_satang" is null or "pos"."cash_session"."counted_satang" >= 0)
          and ("pos"."cash_session"."float_left_satang" is null or "pos"."cash_session"."float_left_satang" >= 0)
          and ("pos"."cash_session"."tolerance_satang" is null or "pos"."cash_session"."tolerance_satang" >= 0)),
	CONSTRAINT "cash_session_close_check" CHECK (("pos"."cash_session"."status" = 'open'
             and "pos"."cash_session"."closed_at" is null and "pos"."cash_session"."closed_by_account_id" is null and "pos"."cash_session"."counted_satang" is null
             and "pos"."cash_session"."expected_satang" is null and "pos"."cash_session"."variance_satang" is null and "pos"."cash_session"."signed_off_at" is null)
          or ("pos"."cash_session"."status" = 'closed'
             and "pos"."cash_session"."closed_at" is not null and "pos"."cash_session"."closed_by_account_id" is not null
             and "pos"."cash_session"."counted_satang" is not null and "pos"."cash_session"."expected_satang" is not null
             and "pos"."cash_session"."variance_satang" = "pos"."cash_session"."counted_satang" - "pos"."cash_session"."expected_satang"
             and "pos"."cash_session"."float_left_satang" is not null and "pos"."cash_session"."float_left_satang" <= "pos"."cash_session"."counted_satang"
             and "pos"."cash_session"."tolerance_satang" is not null
             and "pos"."cash_session"."signed_off_by_account_id" is not null and "pos"."cash_session"."signed_off_at" is not null)),
	CONSTRAINT "cash_session_variance_note_check" CHECK ("pos"."cash_session"."status" = 'open' or abs("pos"."cash_session"."variance_satang") <= "pos"."cash_session"."tolerance_satang"
          or length(trim(coalesce("pos"."cash_session"."notes", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."end_of_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_by_account_id" uuid,
	"closed_at" timestamp with time zone,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"slip_number" text,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "end_of_day_status_check" CHECK ("pos"."end_of_day"."status" in ('open','provisional','closed')),
	CONSTRAINT "end_of_day_closed_check" CHECK (("pos"."end_of_day"."status" = 'closed') = ("pos"."end_of_day"."closed_at" is not null and "pos"."end_of_day"."closed_by_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "pos"."eod_correction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"end_of_day_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"channel" text,
	"amount_satang" bigint NOT NULL,
	"source_entity_type" text,
	"source_entity_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_by_account_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eod_correction_kind_check" CHECK ("pos"."eod_correction"."kind" in ('late_sync','gateway_settle','refund_fallback','other')),
	CONSTRAINT "eod_correction_ack_check" CHECK (("pos"."eod_correction"."acknowledged_at" is null) = ("pos"."eod_correction"."acknowledged_by_account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "analytics"."fact_cash_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"channel" text NOT NULL,
	"key" text NOT NULL,
	"beside_takings" boolean DEFAULT false NOT NULL,
	"expected_satang" bigint DEFAULT 0 NOT NULL,
	"actual_satang" bigint,
	"difference_satang" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_cash_daily_channel_check" CHECK ("analytics"."fact_cash_daily"."channel" in ('cash','card','qr','transfer','wallet_credit','paid_online','booking_web','other'))
);
--> statement-breakpoint
CREATE TABLE "pos"."recon_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"end_of_day_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"key" text NOT NULL,
	"cash_session_id" uuid,
	"tid" text,
	"method_code" text,
	"beside_takings" boolean DEFAULT false NOT NULL,
	"expected_satang" bigint DEFAULT 0 NOT NULL,
	"actual_satang" bigint,
	"difference_satang" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recon_line_channel_check" CHECK ("pos"."recon_line"."channel" in ('cash','card','qr','transfer','wallet_credit','paid_online','booking_web','other')),
	CONSTRAINT "recon_line_status_check" CHECK ("pos"."recon_line"."status" in ('pending','ok','off')),
	CONSTRAINT "recon_line_beside_check" CHECK (not "pos"."recon_line"."beside_takings" or "pos"."recon_line"."channel" in ('wallet_credit','paid_online','booking_web'))
);
--> statement-breakpoint
CREATE TABLE "pos"."settlement_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"device_id" uuid,
	"source" text NOT NULL,
	"tid" text,
	"mid" text,
	"business_date" date NOT NULL,
	"batch_no" text,
	"settled_at" timestamp with time zone,
	"total_satang" bigint DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_batch_source_check" CHECK ("pos"."settlement_batch"."source" in ('terminal','gateway_file')),
	CONSTRAINT "settlement_batch_counts_check" CHECK ("pos"."settlement_batch"."line_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."settlement_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"payment_attempt_id" uuid,
	"invoice_no" text,
	"tran_ref" text,
	"approval_code" text,
	"rrn" text,
	"amount_satang" bigint NOT NULL,
	"match_status" text DEFAULT 'unmatched' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_line_match_check" CHECK ("pos"."settlement_line"."match_status" in ('matched','unmatched','missing'))
);
--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "cash_default_float_satang" bigint DEFAULT 600000 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "cash_tolerance_satang" bigint DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD COLUMN "business_date" date;--> statement-breakpoint
UPDATE "pos"."refund" r
   SET "business_date" = (((r."created_at" AT TIME ZONE b."timezone") - b."business_day_start")::date)
  FROM "core"."branch" b
 WHERE b."id" = r."branch_id" AND r."business_date" IS NULL;--> statement-breakpoint
ALTER TABLE "pos"."refund" ALTER COLUMN "business_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_session_id_cash_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "pos"."cash_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_approver_account_id_account_id_fk" FOREIGN KEY ("approver_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_witness_account_id_account_id_fk" FOREIGN KEY ("witness_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_movement" ADD CONSTRAINT "cash_movement_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "pos"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_opened_by_account_id_account_id_fk" FOREIGN KEY ("opened_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_float_source_session_id_cash_session_id_fk" FOREIGN KEY ("float_source_session_id") REFERENCES "pos"."cash_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_closed_by_account_id_account_id_fk" FOREIGN KEY ("closed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."cash_session" ADD CONSTRAINT "cash_session_signed_off_by_account_id_account_id_fk" FOREIGN KEY ("signed_off_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."end_of_day" ADD CONSTRAINT "end_of_day_closed_by_account_id_account_id_fk" FOREIGN KEY ("closed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."eod_correction" ADD CONSTRAINT "eod_correction_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."eod_correction" ADD CONSTRAINT "eod_correction_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."eod_correction" ADD CONSTRAINT "eod_correction_end_of_day_id_end_of_day_id_fk" FOREIGN KEY ("end_of_day_id") REFERENCES "pos"."end_of_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."eod_correction" ADD CONSTRAINT "eod_correction_acknowledged_by_account_id_account_id_fk" FOREIGN KEY ("acknowledged_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_cash_daily" ADD CONSTRAINT "fact_cash_daily_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_cash_daily" ADD CONSTRAINT "fact_cash_daily_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."recon_line" ADD CONSTRAINT "recon_line_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."recon_line" ADD CONSTRAINT "recon_line_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."recon_line" ADD CONSTRAINT "recon_line_end_of_day_id_end_of_day_id_fk" FOREIGN KEY ("end_of_day_id") REFERENCES "pos"."end_of_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."recon_line" ADD CONSTRAINT "recon_line_cash_session_id_cash_session_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "pos"."cash_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_batch" ADD CONSTRAINT "settlement_batch_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_line" ADD CONSTRAINT "settlement_line_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_line" ADD CONSTRAINT "settlement_line_batch_id_settlement_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "pos"."settlement_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."settlement_line" ADD CONSTRAINT "settlement_line_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_action_unique" ON "pos"."cash_movement" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE INDEX "cash_movement_session_idx" ON "pos"."cash_movement" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_movement_branch_date_idx" ON "pos"."cash_movement" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_movement_station_idx" ON "pos"."cash_movement" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "cash_movement_actor_idx" ON "pos"."cash_movement" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "cash_movement_approver_idx" ON "pos"."cash_movement" USING btree ("approver_account_id");--> statement-breakpoint
CREATE INDEX "cash_movement_witness_idx" ON "pos"."cash_movement" USING btree ("witness_account_id");--> statement-breakpoint
CREATE INDEX "cash_movement_refund_idx" ON "pos"."cash_movement" USING btree ("refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_one_open_per_station" ON "pos"."cash_session" USING btree ("station_id") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_open_action_unique" ON "pos"."cash_session" USING btree ("operator_id","open_action_id") WHERE open_action_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_close_action_unique" ON "pos"."cash_session" USING btree ("operator_id","close_action_id") WHERE close_action_id is not null;--> statement-breakpoint
CREATE INDEX "cash_session_operator_idx" ON "pos"."cash_session" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "cash_session_branch_date_idx" ON "pos"."cash_session" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_session_station_opened_idx" ON "pos"."cash_session" USING btree ("station_id","opened_at");--> statement-breakpoint
CREATE INDEX "cash_session_opened_by_idx" ON "pos"."cash_session" USING btree ("opened_by_account_id");--> statement-breakpoint
CREATE INDEX "cash_session_closed_by_idx" ON "pos"."cash_session" USING btree ("closed_by_account_id");--> statement-breakpoint
CREATE INDEX "cash_session_signed_off_by_idx" ON "pos"."cash_session" USING btree ("signed_off_by_account_id");--> statement-breakpoint
CREATE INDEX "cash_session_float_source_idx" ON "pos"."cash_session" USING btree ("float_source_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "end_of_day_branch_date_unique" ON "pos"."end_of_day" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "end_of_day_operator_idx" ON "pos"."end_of_day" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "end_of_day_closed_by_idx" ON "pos"."end_of_day" USING btree ("closed_by_account_id");--> statement-breakpoint
CREATE INDEX "eod_correction_day_idx" ON "pos"."eod_correction" USING btree ("end_of_day_id");--> statement-breakpoint
CREATE INDEX "eod_correction_operator_idx" ON "pos"."eod_correction" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "eod_correction_branch_date_idx" ON "pos"."eod_correction" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "eod_correction_acknowledged_by_idx" ON "pos"."eod_correction" USING btree ("acknowledged_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_cash_daily_unique" ON "analytics"."fact_cash_daily" USING btree ("branch_id","business_date","key");--> statement-breakpoint
CREATE INDEX "fact_cash_daily_operator_idx" ON "analytics"."fact_cash_daily" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "fact_cash_daily_branch_date_idx" ON "analytics"."fact_cash_daily" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "recon_line_day_key_unique" ON "pos"."recon_line" USING btree ("end_of_day_id","key");--> statement-breakpoint
CREATE INDEX "recon_line_operator_idx" ON "pos"."recon_line" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "recon_line_branch_idx" ON "pos"."recon_line" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "recon_line_session_idx" ON "pos"."recon_line" USING btree ("cash_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batch_action_unique" ON "pos"."settlement_batch" USING btree ("operator_id","action_id") WHERE action_id is not null;--> statement-breakpoint
CREATE INDEX "settlement_batch_operator_idx" ON "pos"."settlement_batch" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "settlement_batch_branch_date_idx" ON "pos"."settlement_batch" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "settlement_batch_device_idx" ON "pos"."settlement_batch" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "settlement_line_batch_idx" ON "pos"."settlement_line" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "settlement_line_operator_idx" ON "pos"."settlement_line" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "settlement_line_attempt_idx" ON "pos"."settlement_line" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "settlement_line_invoice_idx" ON "pos"."settlement_line" USING btree ("invoice_no");--> statement-breakpoint
CREATE INDEX "settlement_line_tran_ref_idx" ON "pos"."settlement_line" USING btree ("tran_ref");--> statement-breakpoint
CREATE INDEX "refund_branch_date_idx" ON "pos"."refund" USING btree ("branch_id","business_date");--> statement-breakpoint
ALTER TABLE "core"."branch" ADD CONSTRAINT "branch_cash_settings_check" CHECK ("core"."branch"."cash_default_float_satang" >= 0 and "core"."branch"."cash_tolerance_satang" >= 0);;--> statement-breakpoint
CREATE FUNCTION "pos"."cash_movement_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('oto.cash_ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pos.cash_movement is append-only: a movement is corrected by another movement, never edited or removed';
END $$;
--> statement-breakpoint
CREATE TRIGGER "cash_movement_append_only" BEFORE UPDATE OR DELETE ON "pos"."cash_movement"
FOR EACH ROW EXECUTE FUNCTION "pos"."cash_movement_append_only"();
--> statement-breakpoint
CREATE FUNCTION "pos"."refund_business_date_default"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."business_date" IS NULL THEN
    SELECT ((coalesce(NEW."created_at", now()) AT TIME ZONE b."timezone") - b."business_day_start")::date
      INTO NEW."business_date"
      FROM "core"."branch" b
     WHERE b."id" = NEW."branch_id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "refund_business_date_default" BEFORE INSERT ON "pos"."refund"
FOR EACH ROW EXECUTE FUNCTION "pos"."refund_business_date_default"();
