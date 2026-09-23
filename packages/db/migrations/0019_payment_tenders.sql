-- SCRUM-206 (S2-10a) — the tender ledger gets its columns, and the park gets a
-- list of the ways it takes money.
--
-- `pos.payment_attempt` has been the Sprint 1 placeholder since 0014, whose own
-- comment says "S2-10a owns its columns": a sale id, a free-text `method`, an
-- amount, a status with no CHECK, and a jsonb. One writer, one status value
-- ever written, and nowhere at all to put a TID, an approval code, a gateway
-- invoice number, or the fact that a terminal answered nothing. This is the
-- whole column set for the ticket — including the columns only the QR half and
-- the offline half will write — so that no later slice of this ticket, and
-- neither of the two after it, has to add a second migration to the same table.
--
-- **Expand only, and it backfills.** Nothing is dropped, retyped or emptied.
-- Three columns arrive NOT NULL (`operator_id`, `branch_id`, `business_date`)
-- and the eleven attempts on a running database have no values for them, so
-- they are added nullable, filled from the sale each one already points at, and
-- only then made NOT NULL. That is the expand/contract rule from 0004: a
-- migration that cannot run on a live database is a migration that cannot be
-- deployed.
--
-- **The backfill is deliberately loud**, as 0018's was. An attempt that names
-- no sale, or whose tender word cannot be mapped, stops the migration instead
-- of being quietly given a plausible operator or a plausible method — this is
-- the money table, and a guess here is a figure in somebody's day-end report.
--
-- **Two words change meaning, and the old values are kept.** `method` used to
-- hold the TENDER TOKEN the till sent (`cash`, and after S2-10a's admin panel
-- also `promptpay`); it now holds what kind of money it was, from a CHECK, and
-- the token moves to the new `method_code` beside it. The status default
-- `recorded`, which nothing ever wrote deliberately, maps to `created` — the
-- new word for "the row exists and nothing has happened yet". Neither remap can
-- turn money into more or less money: `outstandingOf` counts `approved` and
-- nothing else, before and after.
--
-- **Three unique indexes are the point of the table.** `invoice_no` unique for
-- ever, because 2C2P refuses a reused one; `(operator_id, action_id)`, which is
-- what stops a retried tender charging a card twice now that a sale may sit
-- part-paid; and `(device_id, business_date, terminal_ref)`, which is the
-- ticket's "refs are unique per terminal per day".
--
-- **The webhook's key is two partial indexes and a CHECK, not one index.**
-- `(invoice_no, tran_ref)` is the gateway's idempotency key with
-- `(invoice_no, payment_id)` behind it, and Postgres treats nulls as distinct —
-- so a single index over both columns would let every `tran_ref`-less delivery
-- through as often as it arrived. The CHECK closes the third case: a delivery
-- carrying neither reference falls between both indexes, cannot be matched to
-- an attempt, and is not a row this table can hold.
--
-- **No `terminal_counter` table.** The counter that mints those refs is
-- `edge.box_counter` under scope `terminal_ref` with the device id as the key —
-- its primary key already carries the business date, and `BoxStore.bumpCounter`
-- already mints atomically against it. That is decision D-1, and it is why this
-- migration creates two tables rather than three.
--
-- `edge.box_command`'s kind CHECK gains `terminal_sale` and `drawer_kick`.
-- Neither is a simulator action: a tender really is sent to a terminal on a
-- serial cable, and the drawer really does open.

CREATE TABLE "pos"."payment_method" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "payment_method_kind_check" CHECK ("pos"."payment_method"."kind" in ('cash','card','qr','other')),
	CONSTRAINT "payment_method_code_check" CHECK ("pos"."payment_method"."code" ~ '^[a-z0-9_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "pos"."payment_notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"attempt_id" uuid,
	"invoice_no" text NOT NULL,
	"tran_ref" text,
	"payment_id" text,
	"resp_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	"ops_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_notification_key_check" CHECK ("pos"."payment_notification"."tran_ref" is not null or "pos"."payment_notification"."payment_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "edge"."box_command" DROP CONSTRAINT "box_command_kind_check";--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" DROP CONSTRAINT "payment_attempt_sale_id_sale_id_fk";
--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ALTER COLUMN "status" SET DEFAULT 'created';--> statement-breakpoint
-- The three that will be NOT NULL arrive nullable; they are filled below.
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "operator_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "station_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "method_code" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "provider" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "tendered_satang" bigint;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "change_satang" bigint;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "terminal_ref" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "tid" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "mid" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "approval_code" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "last4" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "invoice_no" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "tran_ref" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "payment_id" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "qr_payload" text;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "staff_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "box_seq" bigint;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD COLUMN "action_id" text;--> statement-breakpoint

-- Where, when and for whom, from the sale the attempt already points at. The
-- station comes with it: every attempt written so far was a cash tender taken
-- at the counter that rang the sale up.
--
-- `paid_at` is `created_at`, and ONLY on an approved row: a cash tender is paid
-- at the moment it is recorded, and a row that never reached `approved` was
-- never paid at all. Stamping every row would put a payment time on an attempt
-- that took no money, which is a figure in somebody's day-end report.
UPDATE "pos"."payment_attempt" a
   SET "operator_id"   = s."operator_id",
       "branch_id"     = s."branch_id",
       "station_id"    = s."station_id",
       "business_date" = s."business_date",
       "paid_at"       = CASE
         WHEN a."status" = 'approved' THEN COALESCE(a."paid_at", a."created_at")
         ELSE a."paid_at"
       END
  FROM "pos"."sale" s
 WHERE s."id" = a."sale_id"
   AND a."operator_id" IS NULL;
--> statement-breakpoint

-- The tender token moves to `method_code`; `method` becomes the kind of money.
-- `payload->>'kind'` is the till's own word for it, written by the finalise
-- path since S2-09a, so a `promptpay` token resolves to `qr` from the row
-- itself rather than from a list of tokens kept in a migration.
UPDATE "pos"."payment_attempt"
   SET "method_code" = COALESCE("method_code", "method"),
       "method" = CASE
         WHEN "method" IN ('cash','card','qr','wallet','voucher','transfer') THEN "method"
         WHEN "method" = 'credit_card' THEN 'card'
         WHEN "payload"->>'kind' IN ('cash','card','qr') THEN "payload"->>'kind'
       END,
       "status" = CASE WHEN "status" = 'recorded' THEN 'created' ELSE "status" END;
--> statement-breakpoint

-- Loud, as 0018's backfill is. An attempt with no sale behind it has no
-- operator, a branch or a trading day that can be inferred, and a tender word
-- nothing recognises is not a tender word to guess at.
DO $$
DECLARE
  orphans bigint;
  unmapped bigint;
BEGIN
  SELECT count(*) INTO orphans FROM "pos"."payment_attempt"
   WHERE "operator_id" IS NULL OR "branch_id" IS NULL OR "business_date" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION '% payment_attempt row(s) name no sale, so their operator, branch and business date cannot be filled in. Resolve them before migrating.', orphans;
  END IF;

  SELECT count(*) INTO unmapped FROM "pos"."payment_attempt" WHERE "method" IS NULL;
  IF unmapped > 0 THEN
    RAISE EXCEPTION '% payment_attempt row(s) carry a tender token this migration cannot map to cash/card/qr/wallet/voucher/transfer. The original value is in method_code.', unmapped;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "pos"."payment_attempt" ALTER COLUMN "operator_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ALTER COLUMN "business_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."payment_method" ADD CONSTRAINT "payment_method_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_notification" ADD CONSTRAINT "payment_notification_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_notification" ADD CONSTRAINT "payment_notification_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_method_operator_idx" ON "pos"."payment_method" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_code_unique" ON "pos"."payment_method" USING btree ("operator_id","code") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "payment_notification_attempt_idx" ON "pos"."payment_notification" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "payment_notification_operator_idx" ON "pos"."payment_notification" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "payment_notification_invoice_idx" ON "pos"."payment_notification" USING btree ("invoice_no");--> statement-breakpoint
CREATE INDEX "payment_notification_received_idx" ON "pos"."payment_notification" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_notification_tran_unique" ON "pos"."payment_notification" USING btree ("invoice_no","tran_ref") WHERE tran_ref is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_notification_payment_unique" ON "pos"."payment_notification" USING btree ("invoice_no","payment_id") WHERE tran_ref is null and payment_id is not null;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_staff_confirmed_by_account_id_fk" FOREIGN KEY ("staff_confirmed_by") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempt_station_idx" ON "pos"."payment_attempt" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "payment_attempt_device_idx" ON "pos"."payment_attempt" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "payment_attempt_staff_confirmed_idx" ON "pos"."payment_attempt" USING btree ("staff_confirmed_by");--> statement-breakpoint
CREATE INDEX "payment_attempt_status_created_idx" ON "pos"."payment_attempt" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempt_operator_date_idx" ON "pos"."payment_attempt" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE INDEX "payment_attempt_branch_date_idx" ON "pos"."payment_attempt" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "payment_attempt_tran_ref_idx" ON "pos"."payment_attempt" USING btree ("tran_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_invoice_unique" ON "pos"."payment_attempt" USING btree ("invoice_no") WHERE invoice_no is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_action_unique" ON "pos"."payment_attempt" USING btree ("operator_id","action_id") WHERE action_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_terminal_ref_unique" ON "pos"."payment_attempt" USING btree ("device_id","business_date","terminal_ref") WHERE device_id is not null and terminal_ref is not null;--> statement-breakpoint
ALTER TABLE "edge"."box_command" ADD CONSTRAINT "box_command_kind_check" CHECK ("edge"."box_command"."kind" in ('test_print','config_apply','clear_cache','collect_logs','restart','go_offline','go_online','reset_store','simulate','terminal_sale','drawer_kick'));--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_method_check" CHECK ("pos"."payment_attempt"."method" in ('cash','card','qr','wallet','voucher','transfer'));--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_provider_check" CHECK ("pos"."payment_attempt"."provider" in ('simulator','ghl','digio','2c2p','manual'));--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_status_check" CHECK ("pos"."payment_attempt"."status" in ('created','sent_to_terminal','approved','declined','cancelled','unknown','inquiring','not_found','awaiting_staff_confirmation','awaiting_settlement'));--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_amount_check" CHECK ("pos"."payment_attempt"."amount_satang" >= 0
          and ("pos"."payment_attempt"."tendered_satang" is null or "pos"."payment_attempt"."tendered_satang" >= 0)
          and ("pos"."payment_attempt"."change_satang" is null or "pos"."payment_attempt"."change_satang" >= 0));--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_tendered_check" CHECK ("pos"."payment_attempt"."tendered_satang" is null or "pos"."payment_attempt"."tendered_satang" >= "pos"."payment_attempt"."amount_satang");--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_invoice_no_check" CHECK ("pos"."payment_attempt"."invoice_no" is null or "pos"."payment_attempt"."invoice_no" ~ '^[A-Z0-9]{1,20}$');--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_last4_check" CHECK ("pos"."payment_attempt"."last4" is null or "pos"."payment_attempt"."last4" ~ '^[0-9]{4}$');--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_staff_confirmed_check" CHECK ("pos"."payment_attempt"."staff_confirmed_by" is null or "pos"."payment_attempt"."status" <> 'created');
