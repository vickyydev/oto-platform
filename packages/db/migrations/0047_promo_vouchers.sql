-- S2-14a round 5 (plan docs/progress/plans/wallet/PLAN.md §2.7) — promotional
-- vouchers.
--
-- promo.voucher_definition gains its promotional rules: what a discount
-- voucher comes off (target, the pricing engine's own scope), a global and a
-- per-customer redemption limit, and a validity window on the redeeming
-- branch's trading day. All nullable: a definition written before this is
-- exactly what it was (tickets, unlimited, always valid).
--
-- promo.voucher_campaign (new): a batch of codes minted on the platform in
-- one press — who, how many, of which definition, at which branch. Each code
-- is its own promo.voucher with source 'campaign' and campaign_id naming the
-- batch; voucher_code_unique keeps every code unique.
--
-- pos.wallet_entry may now carry source 'promo_voucher': the credit a
-- wallet_credit voucher loads when the sale carrying it closes (a grant).
--
-- The check constraints are widened; no data is rewritten.
--
-- Undo: drop voucher.campaign_id and promo.voucher_campaign, the five new
-- voucher_definition columns and their two checks; put the 0045 lists back on
-- voucher_source_check and wallet_entry_source_check (delete the rows that
-- carry the new values first).

CREATE TABLE "promo"."voucher_campaign" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"voucher_definition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_campaign_quantity_check" CHECK ("promo"."voucher_campaign"."quantity" > 0),
	CONSTRAINT "voucher_campaign_name_check" CHECK (length("promo"."voucher_campaign"."name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "promo"."voucher" DROP CONSTRAINT "voucher_source_check";--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" DROP CONSTRAINT "wallet_entry_source_check";--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "usage_limit" integer;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "per_customer_limit" integer;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "promo"."voucher_campaign" ADD CONSTRAINT "voucher_campaign_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_campaign" ADD CONSTRAINT "voucher_campaign_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_campaign" ADD CONSTRAINT "voucher_campaign_voucher_definition_id_voucher_definition_id_fk" FOREIGN KEY ("voucher_definition_id") REFERENCES "promo"."voucher_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_campaign" ADD CONSTRAINT "voucher_campaign_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_campaign_operator_idx" ON "promo"."voucher_campaign" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "voucher_campaign_branch_idx" ON "promo"."voucher_campaign" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "voucher_campaign_definition_idx" ON "promo"."voucher_campaign" USING btree ("voucher_definition_id");--> statement-breakpoint
CREATE INDEX "voucher_campaign_created_by_idx" ON "promo"."voucher_campaign" USING btree ("created_by_account_id");--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_campaign_id_voucher_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "promo"."voucher_campaign"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_campaign_idx" ON "promo"."voucher" USING btree ("campaign_id");--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_source_check" CHECK ("promo"."voucher"."source" in ('booth','legacy','manual','campaign'));--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_limits_check" CHECK (("promo"."voucher_definition"."usage_limit" is null or "promo"."voucher_definition"."usage_limit" > 0) and ("promo"."voucher_definition"."per_customer_limit" is null or "promo"."voucher_definition"."per_customer_limit" > 0));--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_window_check" CHECK ("promo"."voucher_definition"."valid_from" is null or "promo"."voucher_definition"."valid_until" is null or "promo"."voucher_definition"."valid_from" <= "promo"."voucher_definition"."valid_until");--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_source_check" CHECK ("pos"."wallet_entry"."source" in ('ticket_sale','prepaid_food','fnb_order','merch_order','refund','expiry','reactivation','promo_voucher'));