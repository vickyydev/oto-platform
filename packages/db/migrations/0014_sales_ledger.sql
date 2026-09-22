-- S2-09a (SCRUM-203) — the sales ledger.
--
-- Until this migration the till could be driven from the lock screen to
-- "Pay ฿1,440" and there was nowhere to write the result. `pos.sale` and
-- `pos.sale_line` were the Sprint 1 placeholders — an operator, a branch, a
-- status, one `total_satang` and a jsonb — with no station, no box, no
-- business date, no pricing mode, no tier, no VAT or service split and no
-- receipt number. Nothing in `apps/api` wrote them; the POS pushed each sale
-- onto an in-memory array that a page refresh emptied.
--
-- **THIS MIGRATION DROPS TWO TABLES, WHICH THIS SPRINT'S RULE NORMALLY
-- FORBIDS** (expand/contract from 0004: never remove what the previous release
-- reads). It is allowed here because nothing reads them. The only reference to
-- either in the deployed release is `apps/api/src/services/demo-reset.ts`,
-- which DELETEs from them by name and takes back `id` — both of which still
-- work against the tables this migration creates, so the running release keeps
-- working unchanged. The claim that they are empty is not left as a comment
-- either: the first statement below refuses the whole migration if either
-- table has a single row.
--
-- WHAT THE SHAPE IS TAKEN FROM. The park's rules are the prototype's —
-- `imports/oto-pos/artifacts/oto-till/src/lib/sale.ts` (`buildSale`,
-- `computeTotals`, `tillTaxInputs`) and `mockApi.ts:1295` (`recordSale`) — and
-- they are already ported, tested and versioned in `@oto/shared`. The columns
-- here are that engine's own result shapes (`TicketCartTotals`,
-- `TaxBreakdown`, `CartUnit`, `ManualDiscountRecord`, `AppliedPromo`) so that
-- reading a sale back needs no re-derivation. The reasoning for each column,
-- and for the receipt-number scheme, is on the tables in
-- `packages/db/src/schema/sales.ts`.
--
-- THE FOUR DECISIONS WORTH READING TWICE:
--
--   1. `business_date` is a stored column, not a cast of `occurred_at`. The
--      park's day starts at 05:00 (`core.branch.business_day_start`): a sale
--      at 00:30 belongs to the day that is finishing, and the cash-up, the
--      till roll, the price that was charged and the promo expiry all answer
--      to that one date.
--
--   2. The receipt number is allocated PER STATION from `pos.receipt_series`,
--      on the box, and is gapless within that station's series rather than
--      across the branch. A branch-wide gapless counter needs a single
--      allocator, and a single allocator stops the counter when the mall's
--      internet — or one box — goes down. `sale_receipt_unique` is what makes
--      two allocators in one series a loud conflict instead of two guests
--      holding the same receipt number.
--
--   3. Totals are split — net, service charge, VAT already inside the price,
--      VAT added on top — and `sale_totals_check` makes the database refuse a
--      row whose parts do not add up to what the guest paid.
--
--   4. A sale is frozen once it is finalised, by the trigger at the end of
--      this file rather than by convention, so no service, script or psql
--      session can quietly rewrite what somebody was charged. It guards
--      UPDATE only: the staging demo reset deletes a day's facts on purpose,
--      so what is guaranteed is "no silent rewrite", not "indestructible".
--
-- `pos.payment_attempt` is untouched — it keeps its Sprint 1 shape and S2-10a
-- fills it in. Its foreign key, and `promo.voucher`'s, are dropped and
-- recreated because they point at the table being replaced.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pos"."sale") OR EXISTS (SELECT 1 FROM "pos"."sale_line") THEN
    RAISE EXCEPTION 'pos.sale / pos.sale_line are not empty: this migration replaces the Sprint 1 placeholders and would destroy real sales. Migrate the rows before running it.';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" DROP CONSTRAINT "payment_attempt_sale_id_sale_id_fk";
--> statement-breakpoint
ALTER TABLE "promo"."voucher" DROP CONSTRAINT "voucher_sale_id_sale_id_fk";
--> statement-breakpoint
DROP TABLE "pos"."sale_line";
--> statement-breakpoint
DROP TABLE "pos"."sale";
--> statement-breakpoint
CREATE TABLE "pos"."receipt_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"series" text NOT NULL,
	"kind" text DEFAULT 'sale' NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"seq_padding" integer DEFAULT 6 NOT NULL,
	"last_issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_series_kind_check" CHECK ("pos"."receipt_series"."kind" in ('sale','refund')),
	CONSTRAINT "receipt_series_next_check" CHECK ("pos"."receipt_series"."next_seq" > 0),
	CONSTRAINT "receipt_series_padding_check" CHECK ("pos"."receipt_series"."seq_padding" between 1 and 12)
);

--> statement-breakpoint
CREATE TABLE "pos"."sale" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid,
	"business_date" date NOT NULL,
	"business_day_start" time NOT NULL,
	"timezone" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_trust" text DEFAULT 'trusted' NOT NULL,
	"origin" text DEFAULT 'cloud' NOT NULL,
	"sales_channel" text DEFAULT 'till' NOT NULL,
	"box_seq" bigint,
	"source_event_id" uuid,
	"action_id" text,
	"created_by_account_id" uuid NOT NULL,
	"staff_token_jti" uuid,
	"member_id" uuid,
	"visit_id" uuid,
	"booking_id" uuid,
	"pricing_mode" text NOT NULL,
	"pricing_mode_reason" text NOT NULL,
	"holiday_id" uuid,
	"holiday_name" text,
	"customer_tier" text NOT NULL,
	"engine_version" text NOT NULL,
	"catalogue_version" text,
	"tax_config" jsonb NOT NULL,
	"tax_breakdown" jsonb NOT NULL,
	"subtotal_satang" bigint DEFAULT 0 NOT NULL,
	"manual_discount_satang" bigint DEFAULT 0 NOT NULL,
	"promo_discount_satang" bigint DEFAULT 0 NOT NULL,
	"discount_satang" bigint DEFAULT 0 NOT NULL,
	"net_satang" bigint DEFAULT 0 NOT NULL,
	"service_charge_satang" bigint DEFAULT 0 NOT NULL,
	"tax_inclusive_satang" bigint DEFAULT 0 NOT NULL,
	"tax_exclusive_satang" bigint DEFAULT 0 NOT NULL,
	"gross_satang" bigint DEFAULT 0 NOT NULL,
	"unapplied_discount_satang" bigint DEFAULT 0 NOT NULL,
	"refunded_satang" bigint DEFAULT 0 NOT NULL,
	"receipt_series" text,
	"receipt_seq" bigint,
	"receipt_number" text,
	"status" text DEFAULT 'tendering' NOT NULL,
	"finalised_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by_account_id" uuid,
	"void_reason" text,
	"refunded_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_status_check" CHECK ("pos"."sale"."status" in ('tendering','paid','finalised','voided','refunded')),
	CONSTRAINT "sale_origin_check" CHECK ("pos"."sale"."origin" in ('box','cloud','import')),
	CONSTRAINT "sale_channel_check" CHECK ("pos"."sale"."sales_channel" in ('till','kiosk','booking','booth','fnb','shop')),
	CONSTRAINT "sale_pricing_mode_check" CHECK ("pos"."sale"."pricing_mode" in ('weekday','weekend')),
	CONSTRAINT "sale_clock_trust_check" CHECK ("pos"."sale"."clock_trust" in ('trusted','skewed','untrusted')),
	CONSTRAINT "sale_totals_check" CHECK ("pos"."sale"."gross_satang" = "pos"."sale"."net_satang" + "pos"."sale"."service_charge_satang" + "pos"."sale"."tax_inclusive_satang" + "pos"."sale"."tax_exclusive_satang"),
	CONSTRAINT "sale_discount_parts_check" CHECK ("pos"."sale"."discount_satang" = "pos"."sale"."manual_discount_satang" + "pos"."sale"."promo_discount_satang"),
	CONSTRAINT "sale_non_negative_check" CHECK ("pos"."sale"."subtotal_satang" >= 0 and "pos"."sale"."discount_satang" >= 0 and "pos"."sale"."manual_discount_satang" >= 0 and "pos"."sale"."promo_discount_satang" >= 0 and "pos"."sale"."net_satang" >= 0 and "pos"."sale"."service_charge_satang" >= 0 and "pos"."sale"."tax_inclusive_satang" >= 0 and "pos"."sale"."tax_exclusive_satang" >= 0 and "pos"."sale"."gross_satang" >= 0 and "pos"."sale"."unapplied_discount_satang" >= 0 and "pos"."sale"."refunded_satang" >= 0),
	CONSTRAINT "sale_refund_bound_check" CHECK ("pos"."sale"."refunded_satang" <= "pos"."sale"."gross_satang"),
	CONSTRAINT "sale_receipt_parts_check" CHECK (("pos"."sale"."receipt_number" is null and "pos"."sale"."receipt_series" is null and "pos"."sale"."receipt_seq" is null)
          or ("pos"."sale"."receipt_number" is not null and "pos"."sale"."receipt_series" is not null and "pos"."sale"."receipt_seq" is not null and "pos"."sale"."receipt_seq" > 0)),
	CONSTRAINT "sale_finalised_check" CHECK ("pos"."sale"."status" not in ('finalised','refunded') or ("pos"."sale"."receipt_number" is not null and "pos"."sale"."finalised_at" is not null)),
	CONSTRAINT "sale_void_check" CHECK ("pos"."sale"."status" <> 'voided' or ("pos"."sale"."voided_at" is not null and "pos"."sale"."void_reason" is not null)),
	CONSTRAINT "sale_refunded_check" CHECK ("pos"."sale"."status" <> 'refunded' or "pos"."sale"."refunded_at" is not null)
);

--> statement-breakpoint
CREATE TABLE "pos"."sale_discount" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"discount_type" text NOT NULL,
	"percent_bp" integer,
	"value_satang" bigint,
	"amount_satang" bigint DEFAULT 0 NOT NULL,
	"allocations" jsonb,
	"scope" text DEFAULT 'order' NOT NULL,
	"target_line_id" uuid,
	"target_component" text,
	"target_label" text,
	"code" text,
	"label" text,
	"exhausted_reason" text,
	"reason" text,
	"note" text,
	"applied_by_account_id" uuid,
	"applied_by_name" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_discount_kind_check" CHECK ("pos"."sale_discount"."kind" in ('manual','promo')),
	CONSTRAINT "sale_discount_type_check" CHECK ("pos"."sale_discount"."discount_type" in ('percent','fixed','comp','free_item')),
	CONSTRAINT "sale_discount_scope_check" CHECK ("pos"."sale_discount"."scope" in ('order','line','component')),
	CONSTRAINT "sale_discount_sequence_check" CHECK ("pos"."sale_discount"."sequence" > 0),
	CONSTRAINT "sale_discount_amount_check" CHECK ("pos"."sale_discount"."amount_satang" >= 0),
	CONSTRAINT "sale_discount_manual_check" CHECK ("pos"."sale_discount"."kind" <> 'manual' or ("pos"."sale_discount"."reason" is not null and "pos"."sale_discount"."applied_by_account_id" is not null)),
	CONSTRAINT "sale_discount_promo_check" CHECK ("pos"."sale_discount"."kind" <> 'promo' or "pos"."sale_discount"."code" is not null),
	CONSTRAINT "sale_discount_value_check" CHECK (("pos"."sale_discount"."discount_type" <> 'percent' or "pos"."sale_discount"."percent_bp" is not null)
          and ("pos"."sale_discount"."discount_type" <> 'fixed' or "pos"."sale_discount"."value_satang" is not null))
);

--> statement-breakpoint
CREATE TABLE "pos"."sale_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"line_no" integer NOT NULL,
	"cart_line_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"component_key" text,
	"ticket_package_id" uuid,
	"product_id" uuid,
	"label" text NOT NULL,
	"revenue_category" text,
	"revenue_sub_category" text,
	"taxable_category" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_satang" bigint DEFAULT 0 NOT NULL,
	"base_satang" bigint DEFAULT 0 NOT NULL,
	"discount_satang" bigint DEFAULT 0 NOT NULL,
	"net_satang" bigint DEFAULT 0 NOT NULL,
	"service_charge_satang" bigint DEFAULT 0 NOT NULL,
	"tax_satang" bigint DEFAULT 0 NOT NULL,
	"tax_mode" text DEFAULT 'inclusive' NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"tax_rate_id" text,
	"tax_name" text,
	"gross_satang" bigint DEFAULT 0 NOT NULL,
	"customer_tier" text NOT NULL,
	"kid_count" integer DEFAULT 0 NOT NULL,
	"adult_count" integer DEFAULT 0 NOT NULL,
	"free_adult_count" integer DEFAULT 0 NOT NULL,
	"stay_hours" integer,
	"stay_duration_label" text,
	"child_id" uuid,
	"band_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_line_kind_check" CHECK ("pos"."sale_line"."kind" in ('kids','adults_paid','adults_free','socks','addon','service_fee','food_provision','promo_item','fnb_item','merch_item')),
	CONSTRAINT "sale_line_tax_mode_check" CHECK ("pos"."sale_line"."tax_mode" in ('inclusive','exclusive','none')),
	CONSTRAINT "sale_line_quantity_check" CHECK ("pos"."sale_line"."quantity" >= 0 and "pos"."sale_line"."line_no" > 0),
	CONSTRAINT "sale_line_totals_check" CHECK ("pos"."sale_line"."gross_satang" = "pos"."sale_line"."net_satang" + "pos"."sale_line"."tax_satang" + "pos"."sale_line"."service_charge_satang"),
	CONSTRAINT "sale_line_non_negative_check" CHECK ("pos"."sale_line"."base_satang" >= 0 and "pos"."sale_line"."discount_satang" >= 0 and "pos"."sale_line"."net_satang" >= 0 and "pos"."sale_line"."service_charge_satang" >= 0 and "pos"."sale_line"."tax_satang" >= 0 and "pos"."sale_line"."gross_satang" >= 0 and "pos"."sale_line"."tax_rate_bp" >= 0)
);

--> statement-breakpoint
ALTER TABLE "pos"."receipt_series" ADD CONSTRAINT "receipt_series_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."receipt_series" ADD CONSTRAINT "receipt_series_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."receipt_series" ADD CONSTRAINT "receipt_series_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "crm"."visit"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "pos"."booking"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_holiday_id_branch_holiday_id_fk" FOREIGN KEY ("holiday_id") REFERENCES "pos"."branch_holiday"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_voided_by_account_id_account_id_fk" FOREIGN KEY ("voided_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ADD CONSTRAINT "sale_discount_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ADD CONSTRAINT "sale_discount_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ADD CONSTRAINT "sale_discount_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ADD CONSTRAINT "sale_discount_applied_by_account_id_account_id_fk" FOREIGN KEY ("applied_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_ticket_package_id_ticket_package_id_fk" FOREIGN KEY ("ticket_package_id") REFERENCES "pos"."ticket_package"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_band_id_band_id_fk" FOREIGN KEY ("band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_series_unique" ON "pos"."receipt_series" USING btree ("station_id","series","kind");
--> statement-breakpoint
CREATE INDEX "receipt_series_branch_idx" ON "pos"."receipt_series" USING btree ("branch_id","kind");
--> statement-breakpoint
CREATE INDEX "receipt_series_operator_idx" ON "pos"."receipt_series" USING btree ("operator_id");
--> statement-breakpoint
CREATE INDEX "sale_branch_date_idx" ON "pos"."sale" USING btree ("branch_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_station_date_idx" ON "pos"."sale" USING btree ("station_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_operator_date_idx" ON "pos"."sale" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_box_occurred_idx" ON "pos"."sale" USING btree ("box_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "sale_member_idx" ON "pos"."sale" USING btree ("member_id");
--> statement-breakpoint
CREATE INDEX "sale_visit_idx" ON "pos"."sale" USING btree ("visit_id");
--> statement-breakpoint
CREATE INDEX "sale_booking_idx" ON "pos"."sale" USING btree ("booking_id");
--> statement-breakpoint
CREATE INDEX "sale_account_idx" ON "pos"."sale" USING btree ("created_by_account_id");
--> statement-breakpoint
CREATE INDEX "sale_voided_by_idx" ON "pos"."sale" USING btree ("voided_by_account_id");
--> statement-breakpoint
CREATE INDEX "sale_holiday_idx" ON "pos"."sale" USING btree ("holiday_id");
--> statement-breakpoint
CREATE INDEX "sale_received_idx" ON "pos"."sale" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX "sale_station_status_idx" ON "pos"."sale" USING btree ("station_id","status") WHERE status in ('tendering','paid');
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_receipt_unique" ON "pos"."sale" USING btree ("station_id","receipt_series","receipt_seq") WHERE receipt_seq is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_receipt_number_unique" ON "pos"."sale" USING btree ("branch_id","receipt_number") WHERE receipt_number is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_action_unique" ON "pos"."sale" USING btree ("station_id","action_id") WHERE action_id is not null;
--> statement-breakpoint
CREATE INDEX "sale_source_event_idx" ON "pos"."sale" USING btree ("source_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_discount_order_unique" ON "pos"."sale_discount" USING btree ("sale_id","sequence");
--> statement-breakpoint
CREATE INDEX "sale_discount_sale_idx" ON "pos"."sale_discount" USING btree ("sale_id");
--> statement-breakpoint
CREATE INDEX "sale_discount_branch_date_idx" ON "pos"."sale_discount" USING btree ("branch_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_discount_operator_date_idx" ON "pos"."sale_discount" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_discount_applied_by_idx" ON "pos"."sale_discount" USING btree ("applied_by_account_id");
--> statement-breakpoint
CREATE INDEX "sale_discount_code_idx" ON "pos"."sale_discount" USING btree ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_line_order_unique" ON "pos"."sale_line" USING btree ("sale_id","line_no");
--> statement-breakpoint
CREATE INDEX "sale_line_sale_idx" ON "pos"."sale_line" USING btree ("sale_id");
--> statement-breakpoint
CREATE INDEX "sale_line_cart_line_idx" ON "pos"."sale_line" USING btree ("cart_line_id");
--> statement-breakpoint
CREATE INDEX "sale_line_branch_date_idx" ON "pos"."sale_line" USING btree ("branch_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_line_operator_date_idx" ON "pos"."sale_line" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_line_package_date_idx" ON "pos"."sale_line" USING btree ("ticket_package_id","business_date");
--> statement-breakpoint
CREATE INDEX "sale_line_product_idx" ON "pos"."sale_line" USING btree ("product_id");
--> statement-breakpoint
CREATE INDEX "sale_line_category_date_idx" ON "pos"."sale_line" USING btree ("taxable_category","business_date");
--> statement-breakpoint
CREATE INDEX "sale_line_child_idx" ON "pos"."sale_line" USING btree ("child_id");
--> statement-breakpoint
CREATE INDEX "sale_line_band_idx" ON "pos"."sale_line" USING btree ("band_id");
--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" ADD CONSTRAINT "payment_attempt_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- A FINALISED SALE IS FROZEN, and this is where that is true rather than
-- hoped for. `withTx` and the service layer are the right place for the rule,
-- and they are one careless `update(sale)` — in any of the tickets still to be
-- built — away from not being the rule any more. A trigger holds for every
-- writer, including a migration, a repair script and a psql session.
--
-- Everything is frozen except the columns a sale's LATER LIFE legitimately
-- writes: `status` (within the transitions below), the void columns, the
-- refund columns S2-11 fills, and `updated_at`. Adding a column adds it to the
-- frozen set by default, which is the correct default for a money record.
--
-- IT GUARDS UPDATE ONLY. Deleting is still possible, because the staging demo
-- reset exists to wipe a day of play (`apps/api/src/services/demo-reset.ts`)
-- and blocking it here would break the thing the park's team use to start
-- over. So the guarantee is that a finalised sale cannot be quietly REWRITTEN.
CREATE OR REPLACE FUNCTION "pos"."sale_freeze"() RETURNS trigger AS $$
DECLARE
  mutable text[] := ARRAY['status', 'voided_at', 'voided_by_account_id', 'void_reason',
                          'refunded_at', 'refunded_satang', 'updated_at'];
BEGIN
  IF OLD.status NOT IN ('finalised', 'voided', 'refunded') THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'sale % is %: its record is frozen and cannot be rewritten (pos.sale_freeze)',
      OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'finalised' AND NEW.status NOT IN ('finalised', 'voided', 'refunded') THEN
    RAISE EXCEPTION 'sale % cannot go from finalised to % (pos.sale_freeze)',
      OLD.id, NEW.status USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('voided', 'refunded') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'sale % is % and its status cannot change again (pos.sale_freeze)',
      OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "sale_freeze" BEFORE UPDATE ON "pos"."sale"
  FOR EACH ROW EXECUTE FUNCTION "pos"."sale_freeze"();
--> statement-breakpoint
-- The lines and the discounts are the same record as the sale, so they are
-- frozen by the same rule, read off the parent's status.
CREATE OR REPLACE FUNCTION "pos"."sale_child_freeze"() RETURNS trigger AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM "pos"."sale" WHERE id = OLD.sale_id;
  IF parent_status IN ('finalised', 'voided', 'refunded') THEN
    RAISE EXCEPTION 'sale % is %: % rows are frozen with it (pos.sale_child_freeze)',
      OLD.sale_id, parent_status, TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "sale_line_freeze" BEFORE UPDATE ON "pos"."sale_line"
  FOR EACH ROW EXECUTE FUNCTION "pos"."sale_child_freeze"();
--> statement-breakpoint
CREATE TRIGGER "sale_discount_freeze" BEFORE UPDATE ON "pos"."sale_discount"
  FOR EACH ROW EXECUTE FUNCTION "pos"."sale_child_freeze"();
