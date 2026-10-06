-- S2-14a round 1 (plan docs/progress/plans/wallet/PLAN.md §2.1) — stored
-- value. The Sprint 1 placeholders pos.wallet / pos.wallet_entry are reshaped
-- in place, forward-only: the ledger becomes the truth (every movement an
-- entry, unique per operator on its action key, signed, with its sale /
-- refund / attempt backlinks, where and when it happened and the balance it
-- left), and wallet.balance_satang becomes the guarded projection the service
-- writes only with its entry, under a row lock. New: pos.wallet_key (band,
-- voucher QR, child, phone -> one wallet, unique per operator on kind and
-- value), pos.wallet_policy (per branch: expiry, the offline cap, unused
-- prepaid food) and analytics.fact_wallet_liability_daily. edge.print_job may
-- now name a wallet as its subject (the credit voucher prints one wallet).
--
-- The placeholders were never written by any flow; this refuses to run if
-- either holds a row, because the new NOT NULL columns have no value to give
-- one. Every existing branch is given the seeded policy (OD-W1 = OD-14):
-- same-day expiry, ฿300 offline cap, and the unused-prepaid rule its landed
-- drop-off pricing row already carries (refund when it has none).
--
-- Ids of the seeded policy rows are gen_random_uuid() (v4), as in 0043: this
-- runs in SQL, and nothing reads order from a config row's id.
--
-- The 0044 snapshot still described booth_duty_assignment.casual_worker_id as
-- uuid; 0040 had already created it as text, so the 0045 snapshot records it
-- as it is and no statement here touches it.
--
-- Undo: drop fact_wallet_liability_daily, wallet_policy and wallet_key; drop
-- the added wallet_entry and wallet columns and their constraints; put the
-- old print_job_subject_check back.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pos"."wallet_entry") OR EXISTS (SELECT 1 FROM "pos"."wallet") THEN
    RAISE EXCEPTION '0045: pos.wallet / pos.wallet_entry are expected to be empty before the reshape';
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "analytics"."fact_wallet_liability_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"granted_satang" bigint DEFAULT 0 NOT NULL,
	"spent_satang" bigint DEFAULT 0 NOT NULL,
	"refunded_satang" bigint DEFAULT 0 NOT NULL,
	"expired_satang" bigint DEFAULT 0 NOT NULL,
	"reactivated_satang" bigint DEFAULT 0 NOT NULL,
	"outstanding_satang" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_wallet_liability_daily_amounts_check" CHECK ("analytics"."fact_wallet_liability_daily"."granted_satang" >= 0 and "analytics"."fact_wallet_liability_daily"."spent_satang" >= 0 and "analytics"."fact_wallet_liability_daily"."refunded_satang" >= 0 and "analytics"."fact_wallet_liability_daily"."expired_satang" >= 0 and "analytics"."fact_wallet_liability_daily"."reactivated_satang" >= 0 and "analytics"."fact_wallet_liability_daily"."outstanding_satang" >= 0)
);--> statement-breakpoint
CREATE TABLE "pos"."wallet_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_key_kind_check" CHECK ("pos"."wallet_key"."kind" in ('band','voucher_qr','child','phone')),
	CONSTRAINT "wallet_key_value_check" CHECK (length("pos"."wallet_key"."value") between 1 and 200)
);--> statement-breakpoint
CREATE TABLE "pos"."wallet_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"expiry" text DEFAULT 'same_day' NOT NULL,
	"expiry_days" integer,
	"offline_cap_satang" bigint DEFAULT 30000 NOT NULL,
	"prepaid_unused" text DEFAULT 'refund' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_policy_expiry_check" CHECK ("pos"."wallet_policy"."expiry" in ('same_day','days_n','never')),
	CONSTRAINT "wallet_policy_days_check" CHECK (("pos"."wallet_policy"."expiry" = 'days_n' and "pos"."wallet_policy"."expiry_days" is not null and "pos"."wallet_policy"."expiry_days" >= 1) or ("pos"."wallet_policy"."expiry" <> 'days_n' and "pos"."wallet_policy"."expiry_days" is null)),
	CONSTRAINT "wallet_policy_cap_check" CHECK ("pos"."wallet_policy"."offline_cap_satang" >= 0),
	CONSTRAINT "wallet_policy_prepaid_check" CHECK ("pos"."wallet_policy"."prepaid_unused" in ('refund','forfeit'))
);--> statement-breakpoint
ALTER TABLE "edge"."print_job" DROP CONSTRAINT "print_job_subject_check";--> statement-breakpoint
ALTER TABLE "pos"."wallet" DROP CONSTRAINT "wallet_operator_id_operator_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."wallet" DROP CONSTRAINT "wallet_member_id_member_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" DROP CONSTRAINT "wallet_entry_wallet_id_wallet_id_fk";--> statement-breakpoint
DROP INDEX "pos"."wallet_entry_wallet_idx";--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD COLUMN "holder_name" text;--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "operator_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "action_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "payment_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "station_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "box_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "actor_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD COLUMN "balance_after" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics"."fact_wallet_liability_daily" ADD CONSTRAINT "fact_wallet_liability_daily_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_wallet_liability_daily" ADD CONSTRAINT "fact_wallet_liability_daily_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_key" ADD CONSTRAINT "wallet_key_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_key" ADD CONSTRAINT "wallet_key_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "pos"."wallet"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_policy" ADD CONSTRAINT "wallet_policy_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_policy" ADD CONSTRAINT "wallet_policy_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_wallet_liability_daily_branch_date_unique" ON "analytics"."fact_wallet_liability_daily" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "fact_wallet_liability_daily_operator_idx" ON "analytics"."fact_wallet_liability_daily" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_key_value_unique" ON "pos"."wallet_key" USING btree ("operator_id","kind","value");--> statement-breakpoint
CREATE INDEX "wallet_key_wallet_idx" ON "pos"."wallet_key" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_policy_branch_unique" ON "pos"."wallet_policy" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "wallet_policy_operator_idx" ON "pos"."wallet_policy" USING btree ("operator_id");--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD CONSTRAINT "wallet_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD CONSTRAINT "wallet_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD CONSTRAINT "wallet_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "pos"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "pos"."wallet"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_branch_idx" ON "pos"."wallet" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entry_action_unique" ON "pos"."wallet_entry" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_sale_idx" ON "pos"."wallet_entry" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_refund_idx" ON "pos"."wallet_entry" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_attempt_idx" ON "pos"."wallet_entry" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_branch_date_idx" ON "pos"."wallet_entry" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "wallet_entry_station_idx" ON "pos"."wallet_entry" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_box_idx" ON "pos"."wallet_entry" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_actor_idx" ON "pos"."wallet_entry" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_wallet_idx" ON "pos"."wallet_entry" USING btree ("wallet_id","created_at");--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_subject_check" CHECK ("edge"."print_job"."subject_type" is null or "edge"."print_job"."subject_type" in ('sale','sale_line','band','voucher','booking','visit','station','wallet'));--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD CONSTRAINT "wallet_status_check" CHECK ("pos"."wallet"."status" in ('active','expired'));--> statement-breakpoint
ALTER TABLE "pos"."wallet" ADD CONSTRAINT "wallet_balance_check" CHECK ("pos"."wallet"."balance_satang" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_kind_check" CHECK ("pos"."wallet_entry"."kind" in ('grant','spend','refund','expire','reactivate'));--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_source_check" CHECK ("pos"."wallet_entry"."source" in ('ticket_sale','prepaid_food','fnb_order','merch_order','refund','expiry','reactivation'));--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_sign_check" CHECK (("pos"."wallet_entry"."kind" in ('grant','refund','reactivate') and "pos"."wallet_entry"."amount_satang" > 0) or ("pos"."wallet_entry"."kind" in ('spend','expire') and "pos"."wallet_entry"."amount_satang" < 0));--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_balance_after_check" CHECK ("pos"."wallet_entry"."balance_after" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_action_check" CHECK (length("pos"."wallet_entry"."action_id") between 1 and 200);--> statement-breakpoint
INSERT INTO "pos"."wallet_policy" ("id", "operator_id", "branch_id", "expiry", "expiry_days", "offline_cap_satang", "prepaid_unused")
SELECT gen_random_uuid(), b."operator_id", b."id", 'same_day', NULL, 30000, COALESCE(p."prepaid_food_unused", 'refund')
FROM "core"."branch" b
LEFT JOIN "pos"."drop_off_pricing" p ON p."branch_id" = b."id"
ON CONFLICT ("branch_id") DO NOTHING;
