-- S2-15b (SCRUM-216), analytics round 1 — the summaries' tables, the revenue
-- category every sale line lands in, the dirty-day marks and the calendar.
-- The plan is docs/progress/plans/analytics/PLAN.md §7 and §8 round 1.
--
-- 1. THE REVENUE CATEGORY. A line written without a revenue category now
--    takes the taxable category it was charged under — what the platform's
--    writer records (`buildPricedLines`: tickets, drop_off, fnb, bar, merch,
--    addons, stored_value; an event or camp pass is a ticket line) — by a
--    BEFORE INSERT trigger; existing rows without one are backfilled the same
--    way; and a CHECK holds it for every writer, so no line falls out of the
--    revenue buckets.
--
--    THE FREEZE. pos.sale_child_freeze refuses an UPDATE of a line of a sale
--    that is finalised, voided or refunded, which is every line the backfill
--    touches. Its trigger is disabled for the one statement and enabled again
--    straight after, as migration 0025 did for pos.sale_discount: the migrator
--    runs inside one transaction, so no other session sees the table without
--    its trigger, and the ALTER's lock holds every other writer until commit.
--    Only the null column is written.
--
-- 2. THE TABLES, all in `analytics`, written by the jobs process only.
--
-- 3. THE DIRTY-DAY MARKS. Deferred constraint triggers on pos.sale (a status
--    or refunded amount changing to or from a counted state, and a delete),
--    pos.refund, pos.payment_attempt (money taken, or no longer taken) and
--    pos.wallet_entry mark analytics.dirty_date at the COMMIT of the
--    transaction that wrote the fact. Every writer marks its day: the till,
--    the sync apply path, a correction in psql. The day is the fact's own
--    business date — a box sale synced two days late marks the day it was
--    sold. A mark is taken at commit, after all of the transaction's own work,
--    so it holds the dirty row's lock for the instant of the commit and never
--    while a sale is still being written.
--
-- 4. EXISTING DAYS. Every branch-day with a finalised or refunded sale is
--    marked once, so the first rollup computes the days before this migration.
--
-- 5. THE CALENDAR. analytics.dim_date is filled per live branch from its first
--    sale (or a year back, whichever is earlier) to a year ahead, by the
--    pricing resolver's own rule: inside a live holiday range is `holiday`,
--    Saturday and Sunday are `weekend`, the rest `weekday`. The rollup job
--    keeps it current from then on.
--
-- Ids written here are gen_random_uuid() (v4), as in 0021 and 0045: there is
-- no v7 generator in the database. Everything is additive: nothing that
-- existed before is removed. Undo: drop the triggers and functions below, the
-- CHECK and the trigger on pos.sale_line, and the analytics tables; the
-- backfilled categories may stay (they are the categories the platform
-- writes).

CREATE OR REPLACE FUNCTION "pos"."sale_line_revenue_category"() RETURNS trigger AS $$
BEGIN
  IF NEW."revenue_category" IS NULL THEN
    NEW."revenue_category" := NEW."taxable_category";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "sale_line_revenue_category" BEFORE INSERT ON "pos"."sale_line"
  FOR EACH ROW EXECUTE FUNCTION "pos"."sale_line_revenue_category"();
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" DISABLE TRIGGER "sale_line_freeze";
--> statement-breakpoint
UPDATE "pos"."sale_line" SET "revenue_category" = "taxable_category" WHERE "revenue_category" IS NULL;
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ENABLE TRIGGER "sale_line_freeze";
--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_revenue_category_check" CHECK ("pos"."sale_line"."revenue_category" is not null);
--> statement-breakpoint
CREATE TABLE "analytics"."branch_source_switch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"preference" text DEFAULT 'oto_pos' NOT NULL,
	"switched_at" timestamp with time zone NOT NULL,
	"actor_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_source_switch_source_check" CHECK ("analytics"."branch_source_switch"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "branch_source_switch_preference_check" CHECK ("analytics"."branch_source_switch"."preference" in ('oto_pos','legacy','both'))
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_category_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"key" text NOT NULL,
	"gross_satang" bigint DEFAULT 0 NOT NULL,
	"net_satang" bigint DEFAULT 0 NOT NULL,
	"tax_satang" bigint DEFAULT 0 NOT NULL,
	"service_satang" bigint DEFAULT 0 NOT NULL,
	"txn_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_category_summary_source_check" CHECK ("analytics"."daily_category_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "daily_category_summary_count_check" CHECK ("analytics"."daily_category_summary"."txn_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_discount_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"discount_type" text NOT NULL,
	"code" text,
	"reason" text,
	"amount_satang" bigint DEFAULT 0 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_discount_summary_source_check" CHECK ("analytics"."daily_discount_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "daily_discount_summary_kind_check" CHECK ("analytics"."daily_discount_summary"."kind" in ('manual','promo')),
	CONSTRAINT "daily_discount_summary_amounts_check" CHECK ("analytics"."daily_discount_summary"."amount_satang" >= 0 and "analytics"."daily_discount_summary"."use_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_item_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"revenue_satang" bigint DEFAULT 0 NOT NULL,
	"cost_satang" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_item_summary_source_check" CHECK ("analytics"."daily_item_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "daily_item_summary_amounts_check" CHECK ("analytics"."daily_item_summary"."quantity" >= 0 and "analytics"."daily_item_summary"."revenue_satang" >= 0 and "analytics"."daily_item_summary"."cost_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"formula_version" integer NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"tickets_satang" bigint DEFAULT 0 NOT NULL,
	"fnb_satang" bigint DEFAULT 0 NOT NULL,
	"merch_satang" bigint DEFAULT 0 NOT NULL,
	"parties_satang" bigint DEFAULT 0 NOT NULL,
	"dropoff_satang" bigint DEFAULT 0 NOT NULL,
	"revenue_satang" bigint DEFAULT 0 NOT NULL,
	"txn_count" integer DEFAULT 0 NOT NULL,
	"credit_paid_satang" bigint DEFAULT 0 NOT NULL,
	"guests_kids" integer DEFAULT 0 NOT NULL,
	"guests_adults" integer DEFAULT 0 NOT NULL,
	"mix_1h" integer DEFAULT 0 NOT NULL,
	"mix_2h" integer DEFAULT 0 NOT NULL,
	"mix_full_day" integer DEFAULT 0 NOT NULL,
	"parties_count" integer DEFAULT 0 NOT NULL,
	"refunds_satang" bigint DEFAULT 0 NOT NULL,
	"discounts_satang" bigint DEFAULT 0 NOT NULL,
	"comps_satang" bigint DEFAULT 0 NOT NULL,
	"vat_satang" bigint DEFAULT 0 NOT NULL,
	"service_satang" bigint DEFAULT 0 NOT NULL,
	"by_channel" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_summary_source_check" CHECK ("analytics"."daily_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "daily_summary_formula_check" CHECK ("analytics"."daily_summary"."formula_version" > 0),
	CONSTRAINT "daily_summary_amounts_check" CHECK ("analytics"."daily_summary"."tickets_satang" >= 0 and "analytics"."daily_summary"."fnb_satang" >= 0 and "analytics"."daily_summary"."merch_satang" >= 0 and "analytics"."daily_summary"."parties_satang" >= 0 and "analytics"."daily_summary"."dropoff_satang" >= 0 and "analytics"."daily_summary"."revenue_satang" >= 0 and "analytics"."daily_summary"."credit_paid_satang" >= 0 and "analytics"."daily_summary"."refunds_satang" >= 0 and "analytics"."daily_summary"."discounts_satang" >= 0 and "analytics"."daily_summary"."comps_satang" >= 0 and "analytics"."daily_summary"."vat_satang" >= 0 and "analytics"."daily_summary"."service_satang" >= 0),
	CONSTRAINT "daily_summary_counts_check" CHECK ("analytics"."daily_summary"."txn_count" >= 0 and "analytics"."daily_summary"."guests_kids" >= 0 and "analytics"."daily_summary"."guests_adults" >= 0 and "analytics"."daily_summary"."mix_1h" >= 0 and "analytics"."daily_summary"."mix_2h" >= 0 and "analytics"."daily_summary"."mix_full_day" >= 0 and "analytics"."daily_summary"."parties_count" >= 0),
	CONSTRAINT "daily_summary_revenue_check" CHECK ("analytics"."daily_summary"."source" <> 'oto_pos' or "analytics"."daily_summary"."revenue_satang" = "analytics"."daily_summary"."tickets_satang" + "analytics"."daily_summary"."fnb_satang" + "analytics"."daily_summary"."merch_satang" + "analytics"."daily_summary"."parties_satang" + "analytics"."daily_summary"."dropoff_satang"),
	CONSTRAINT "daily_summary_frozen_check" CHECK (not ("analytics"."daily_summary"."frozen" and "analytics"."daily_summary"."provisional")),
	CONSTRAINT "daily_summary_by_channel_check" CHECK (jsonb_typeof("analytics"."daily_summary"."by_channel") = 'object')
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_tender_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"key" text NOT NULL,
	"method" text,
	"amount_satang" bigint DEFAULT 0 NOT NULL,
	"refunded_satang" bigint DEFAULT 0 NOT NULL,
	"txn_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_tender_summary_source_check" CHECK ("analytics"."daily_tender_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "daily_tender_summary_amounts_check" CHECK ("analytics"."daily_tender_summary"."amount_satang" >= 0 and "analytics"."daily_tender_summary"."refunded_satang" >= 0 and "analytics"."daily_tender_summary"."txn_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."dim_date" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"date" date NOT NULL,
	"weekday" smallint NOT NULL,
	"rate_mode" text NOT NULL,
	"holiday_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dim_date_weekday_check" CHECK ("analytics"."dim_date"."weekday" between 1 and 7),
	CONSTRAINT "dim_date_rate_mode_check" CHECK ("analytics"."dim_date"."rate_mode" in ('weekday','weekend','holiday')),
	CONSTRAINT "dim_date_holiday_check" CHECK (("analytics"."dim_date"."rate_mode" = 'holiday') = ("analytics"."dim_date"."holiday_name" is not null))
);
--> statement-breakpoint
CREATE TABLE "analytics"."dirty_date" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"marked_at" timestamp with time zone NOT NULL,
	"mark_count" bigint DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dirty_date_kind_check" CHECK ("analytics"."dirty_date"."kind" in ('sales','hourly','booth','wallet')),
	CONSTRAINT "dirty_date_claim_check" CHECK (("analytics"."dirty_date"."claimed_at" is null) = ("analytics"."dirty_date"."claimed_by" is null)),
	CONSTRAINT "dirty_date_mark_count_check" CHECK ("analytics"."dirty_date"."mark_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."fact_booth_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"booth_id" uuid NOT NULL,
	"staff_account_id" uuid,
	"prize_id" uuid,
	"spins" integer DEFAULT 0 NOT NULL,
	"vouchers_issued" integer DEFAULT 0 NOT NULL,
	"vouchers_redeemed" integer DEFAULT 0 NOT NULL,
	"redemption_lag_sum_s" bigint DEFAULT 0 NOT NULL,
	"uptime_s" bigint DEFAULT 0 NOT NULL,
	"prize_cost_satang" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_booth_daily_counts_check" CHECK ("analytics"."fact_booth_daily"."spins" >= 0 and "analytics"."fact_booth_daily"."vouchers_issued" >= 0 and "analytics"."fact_booth_daily"."vouchers_redeemed" >= 0 and "analytics"."fact_booth_daily"."redemption_lag_sum_s" >= 0 and "analytics"."fact_booth_daily"."uptime_s" >= 0 and "analytics"."fact_booth_daily"."prize_cost_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."hourly_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"hour" smallint NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"formula_version" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"tickets_satang" bigint DEFAULT 0 NOT NULL,
	"fnb_satang" bigint DEFAULT 0 NOT NULL,
	"merch_satang" bigint DEFAULT 0 NOT NULL,
	"parties_satang" bigint DEFAULT 0 NOT NULL,
	"dropoff_satang" bigint DEFAULT 0 NOT NULL,
	"revenue_satang" bigint DEFAULT 0 NOT NULL,
	"txn_count" integer DEFAULT 0 NOT NULL,
	"guests" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hourly_summary_hour_check" CHECK ("analytics"."hourly_summary"."hour" between 0 and 23),
	CONSTRAINT "hourly_summary_source_check" CHECK ("analytics"."hourly_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "hourly_summary_amounts_check" CHECK ("analytics"."hourly_summary"."tickets_satang" >= 0 and "analytics"."hourly_summary"."fnb_satang" >= 0 and "analytics"."hourly_summary"."merch_satang" >= 0 and "analytics"."hourly_summary"."parties_satang" >= 0 and "analytics"."hourly_summary"."dropoff_satang" >= 0 and "analytics"."hourly_summary"."revenue_satang" >= 0 and "analytics"."hourly_summary"."txn_count" >= 0 and "analytics"."hourly_summary"."guests" >= 0),
	CONSTRAINT "hourly_summary_revenue_check" CHECK ("analytics"."hourly_summary"."source" <> 'oto_pos' or "analytics"."hourly_summary"."revenue_satang" = "analytics"."hourly_summary"."tickets_satang" + "analytics"."hourly_summary"."fnb_satang" + "analytics"."hourly_summary"."merch_satang" + "analytics"."hourly_summary"."parties_satang" + "analytics"."hourly_summary"."dropoff_satang")
);
--> statement-breakpoint
ALTER TABLE "analytics"."branch_source_switch" ADD CONSTRAINT "branch_source_switch_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."branch_source_switch" ADD CONSTRAINT "branch_source_switch_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."branch_source_switch" ADD CONSTRAINT "branch_source_switch_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_category_summary" ADD CONSTRAINT "daily_category_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_category_summary" ADD CONSTRAINT "daily_category_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_discount_summary" ADD CONSTRAINT "daily_discount_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_discount_summary" ADD CONSTRAINT "daily_discount_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_item_summary" ADD CONSTRAINT "daily_item_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_item_summary" ADD CONSTRAINT "daily_item_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_summary" ADD CONSTRAINT "daily_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_summary" ADD CONSTRAINT "daily_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_tender_summary" ADD CONSTRAINT "daily_tender_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."daily_tender_summary" ADD CONSTRAINT "daily_tender_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."dim_date" ADD CONSTRAINT "dim_date_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."dim_date" ADD CONSTRAINT "dim_date_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."dirty_date" ADD CONSTRAINT "dirty_date_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."dirty_date" ADD CONSTRAINT "dirty_date_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."fact_booth_daily" ADD CONSTRAINT "fact_booth_daily_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."fact_booth_daily" ADD CONSTRAINT "fact_booth_daily_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."fact_booth_daily" ADD CONSTRAINT "fact_booth_daily_booth_id_station_id_fk" FOREIGN KEY ("booth_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."fact_booth_daily" ADD CONSTRAINT "fact_booth_daily_staff_account_id_account_id_fk" FOREIGN KEY ("staff_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."fact_booth_daily" ADD CONSTRAINT "fact_booth_daily_prize_id_booth_prize_id_fk" FOREIGN KEY ("prize_id") REFERENCES "booth"."booth_prize"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."hourly_summary" ADD CONSTRAINT "hourly_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics"."hourly_summary" ADD CONSTRAINT "hourly_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_source_switch_branch_unique" ON "analytics"."branch_source_switch" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX "branch_source_switch_operator_idx" ON "analytics"."branch_source_switch" USING btree ("operator_id");
--> statement-breakpoint
CREATE INDEX "branch_source_switch_actor_idx" ON "analytics"."branch_source_switch" USING btree ("actor_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_category_summary_unique" ON "analytics"."daily_category_summary" USING btree ("branch_id","business_date","source","key");
--> statement-breakpoint
CREATE INDEX "daily_category_summary_operator_date_idx" ON "analytics"."daily_category_summary" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_discount_summary_unique" ON "analytics"."daily_discount_summary" USING btree ("branch_id","business_date","source","key");
--> statement-breakpoint
CREATE INDEX "daily_discount_summary_operator_date_idx" ON "analytics"."daily_discount_summary" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_item_summary_unique" ON "analytics"."daily_item_summary" USING btree ("branch_id","business_date","source","key");
--> statement-breakpoint
CREATE INDEX "daily_item_summary_operator_date_idx" ON "analytics"."daily_item_summary" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_summary_branch_date_source_unique" ON "analytics"."daily_summary" USING btree ("branch_id","business_date","source");
--> statement-breakpoint
CREATE INDEX "daily_summary_operator_date_idx" ON "analytics"."daily_summary" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE INDEX "daily_summary_provisional_idx" ON "analytics"."daily_summary" USING btree ("branch_id","business_date") WHERE provisional;
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_tender_summary_unique" ON "analytics"."daily_tender_summary" USING btree ("branch_id","business_date","source","key");
--> statement-breakpoint
CREATE INDEX "daily_tender_summary_operator_date_idx" ON "analytics"."daily_tender_summary" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "dim_date_branch_date_unique" ON "analytics"."dim_date" USING btree ("branch_id","date");
--> statement-breakpoint
CREATE INDEX "dim_date_operator_idx" ON "analytics"."dim_date" USING btree ("operator_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "dirty_date_branch_date_kind_unique" ON "analytics"."dirty_date" USING btree ("branch_id","business_date","kind");
--> statement-breakpoint
CREATE INDEX "dirty_date_operator_idx" ON "analytics"."dirty_date" USING btree ("operator_id");
--> statement-breakpoint
CREATE INDEX "dirty_date_kind_claim_idx" ON "analytics"."dirty_date" USING btree ("kind","claimed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "fact_booth_daily_unique" ON "analytics"."fact_booth_daily" USING btree ("branch_id","business_date","booth_id",coalesce("staff_account_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("prize_id", '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE INDEX "fact_booth_daily_operator_date_idx" ON "analytics"."fact_booth_daily" USING btree ("operator_id","business_date");
--> statement-breakpoint
CREATE INDEX "fact_booth_daily_booth_idx" ON "analytics"."fact_booth_daily" USING btree ("booth_id");
--> statement-breakpoint
CREATE INDEX "fact_booth_daily_staff_idx" ON "analytics"."fact_booth_daily" USING btree ("staff_account_id");
--> statement-breakpoint
CREATE INDEX "fact_booth_daily_prize_idx" ON "analytics"."fact_booth_daily" USING btree ("prize_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "hourly_summary_branch_date_hour_source_unique" ON "analytics"."hourly_summary" USING btree ("branch_id","business_date","hour","source");
--> statement-breakpoint
CREATE INDEX "hourly_summary_operator_date_idx" ON "analytics"."hourly_summary" USING btree ("operator_id","business_date");
--> statement-breakpoint
-- The mark. A new day inserts its row; a day already marked bumps the count
-- and clears any claim, so a job that claimed it before this mark keeps the
-- row for its next run (analytics.dirty_date in schema/analytics.ts).
CREATE OR REPLACE FUNCTION "analytics"."mark_dirty_date"(
  p_operator_id uuid, p_branch_id uuid, p_business_date date, p_kind text, p_reason text
) RETURNS void AS $$
BEGIN
  IF p_operator_id IS NULL OR p_branch_id IS NULL OR p_business_date IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO "analytics"."dirty_date" AS d
    ("id", "operator_id", "branch_id", "business_date", "kind", "reason", "marked_at", "mark_count", "created_at", "updated_at")
  VALUES (gen_random_uuid(), p_operator_id, p_branch_id, p_business_date, p_kind, p_reason, clock_timestamp(), 1, now(), now())
  ON CONFLICT ("branch_id", "business_date", "kind") DO UPDATE
    SET "reason" = EXCLUDED."reason",
        "marked_at" = EXCLUDED."marked_at",
        "mark_count" = d."mark_count" + 1,
        "claimed_at" = NULL,
        "claimed_by" = NULL,
        "updated_at" = EXCLUDED."marked_at";
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics"."sale_marks_dirty_date"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "analytics"."mark_dirty_date"(OLD."operator_id", OLD."branch_id", OLD."business_date", 'sales', 'sale:deleted');
  ELSE
    PERFORM "analytics"."mark_dirty_date"(NEW."operator_id", NEW."branch_id", NEW."business_date", 'sales', 'sale:' || NEW."status");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sale_insert_marks_dirty_date" AFTER INSERT ON "pos"."sale"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."status" IN ('finalised', 'refunded', 'voided'))
  EXECUTE FUNCTION "analytics"."sale_marks_dirty_date"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sale_update_marks_dirty_date" AFTER UPDATE OF "status", "refunded_satang" ON "pos"."sale"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD."status" IS DISTINCT FROM NEW."status" OR OLD."refunded_satang" IS DISTINCT FROM NEW."refunded_satang")
        AND (OLD."status" IN ('finalised', 'refunded', 'voided') OR NEW."status" IN ('finalised', 'refunded', 'voided')))
  EXECUTE FUNCTION "analytics"."sale_marks_dirty_date"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sale_delete_marks_dirty_date" AFTER DELETE ON "pos"."sale"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."status" IN ('finalised', 'refunded', 'voided'))
  EXECUTE FUNCTION "analytics"."sale_marks_dirty_date"();
--> statement-breakpoint
-- A refund changes the day of the sale it refunds, whenever it is made.
CREATE OR REPLACE FUNCTION "analytics"."refund_marks_dirty_date"() RETURNS trigger AS $$
DECLARE
  refunded record;
BEGIN
  SELECT "operator_id", "branch_id", "business_date" INTO refunded FROM "pos"."sale" WHERE "id" = NEW."sale_id";
  IF FOUND THEN
    PERFORM "analytics"."mark_dirty_date"(refunded."operator_id", refunded."branch_id", refunded."business_date", 'sales', 'refund');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "refund_marks_dirty_date" AFTER INSERT ON "pos"."refund"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "analytics"."refund_marks_dirty_date"();
--> statement-breakpoint
-- Money taken (`approved`, `awaiting_settlement` — PAYMENT_ATTEMPT_TAKEN_STATUSES
-- in @oto/shared) changes the day of the sale it was taken on; an attempt with
-- no sale yet (a booking paid online) marks its own day.
CREATE OR REPLACE FUNCTION "analytics"."payment_attempt_marks_dirty_date"() RETURNS trigger AS $$
DECLARE
  paid record;
BEGIN
  IF NEW."sale_id" IS NOT NULL THEN
    SELECT "operator_id", "branch_id", "business_date" INTO paid FROM "pos"."sale" WHERE "id" = NEW."sale_id";
    IF FOUND THEN
      PERFORM "analytics"."mark_dirty_date"(paid."operator_id", paid."branch_id", paid."business_date", 'sales', 'payment:' || NEW."status");
    END IF;
  ELSE
    PERFORM "analytics"."mark_dirty_date"(NEW."operator_id", NEW."branch_id", NEW."business_date", 'sales', 'payment:' || NEW."status");
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."sale_id" IS NOT NULL AND OLD."sale_id" IS DISTINCT FROM NEW."sale_id" THEN
      SELECT "operator_id", "branch_id", "business_date" INTO paid FROM "pos"."sale" WHERE "id" = OLD."sale_id";
      IF FOUND THEN
        PERFORM "analytics"."mark_dirty_date"(paid."operator_id", paid."branch_id", paid."business_date", 'sales', 'payment:moved');
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "payment_attempt_insert_marks_dirty_date" AFTER INSERT ON "pos"."payment_attempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."status" IN ('approved', 'awaiting_settlement'))
  EXECUTE FUNCTION "analytics"."payment_attempt_marks_dirty_date"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "payment_attempt_update_marks_dirty_date" AFTER UPDATE OF "status", "amount_satang", "sale_id", "method" ON "pos"."payment_attempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD."status" IS DISTINCT FROM NEW."status" OR OLD."amount_satang" IS DISTINCT FROM NEW."amount_satang"
         OR OLD."sale_id" IS DISTINCT FROM NEW."sale_id" OR OLD."method" IS DISTINCT FROM NEW."method")
        AND (OLD."status" IN ('approved', 'awaiting_settlement') OR NEW."status" IN ('approved', 'awaiting_settlement')))
  EXECUTE FUNCTION "analytics"."payment_attempt_marks_dirty_date"();
--> statement-breakpoint
-- A wallet movement marks the wallet's day at its park (the day the money
-- moved, as the wallet liability figures file it) and, when it belongs to a
-- sale — a spend, a grant, credit a refund put back — that sale's day.
CREATE OR REPLACE FUNCTION "analytics"."wallet_entry_marks_dirty_date"() RETURNS trigger AS $$
DECLARE
  park record;
  owner record;
  owner_sale uuid;
BEGIN
  SELECT br."id", br."operator_id",
         coalesce(NEW."business_date",
                  ((NEW."created_at" AT TIME ZONE br."timezone") - (br."business_day_start" - time '00:00'))::date) AS "day"
    INTO park
    FROM "pos"."wallet" w
    JOIN "core"."branch" br ON br."id" = coalesce(w."branch_id", NEW."branch_id")
   WHERE w."id" = NEW."wallet_id";
  IF FOUND THEN
    PERFORM "analytics"."mark_dirty_date"(park."operator_id", park."id", park."day", 'wallet', 'wallet_entry:' || NEW."kind");
  END IF;
  owner_sale := NEW."sale_id";
  IF owner_sale IS NULL AND NEW."refund_id" IS NOT NULL THEN
    SELECT "sale_id" INTO owner_sale FROM "pos"."refund" WHERE "id" = NEW."refund_id";
  END IF;
  IF owner_sale IS NULL AND NEW."payment_attempt_id" IS NOT NULL THEN
    SELECT "sale_id" INTO owner_sale FROM "pos"."payment_attempt" WHERE "id" = NEW."payment_attempt_id";
  END IF;
  IF owner_sale IS NOT NULL THEN
    SELECT "operator_id", "branch_id", "business_date" INTO owner FROM "pos"."sale" WHERE "id" = owner_sale;
    IF FOUND THEN
      PERFORM "analytics"."mark_dirty_date"(owner."operator_id", owner."branch_id", owner."business_date", 'sales', 'wallet_entry:' || NEW."kind");
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "wallet_entry_marks_dirty_date" AFTER INSERT ON "pos"."wallet_entry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "analytics"."wallet_entry_marks_dirty_date"();
--> statement-breakpoint
INSERT INTO "analytics"."dirty_date"
  ("id", "operator_id", "branch_id", "business_date", "kind", "reason", "marked_at", "mark_count", "created_at", "updated_at")
SELECT gen_random_uuid(), s."operator_id", s."branch_id", s."business_date", 'sales', 'migration:0064', now(), 1, now(), now()
  FROM "pos"."sale" s
 WHERE s."status" IN ('finalised', 'refunded')
 GROUP BY s."operator_id", s."branch_id", s."business_date"
ON CONFLICT ("branch_id", "business_date", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "analytics"."dim_date"
  ("id", "operator_id", "branch_id", "date", "weekday", "rate_mode", "holiday_name", "created_at", "updated_at")
SELECT gen_random_uuid(), b."operator_id", b."id", d."day", extract(isodow FROM d."day")::smallint,
       CASE WHEN h."name" IS NOT NULL THEN 'holiday'
            WHEN extract(isodow FROM d."day") IN (6, 7) THEN 'weekend'
            ELSE 'weekday' END,
       h."name", now(), now()
  FROM "core"."branch" b
  CROSS JOIN LATERAL (
    SELECT g::date AS "day"
      FROM generate_series(
             least(coalesce((SELECT min(s."business_date") FROM "pos"."sale" s WHERE s."branch_id" = b."id"), current_date),
                   current_date - 365)::timestamp,
             (current_date + 365)::timestamp,
             interval '1 day') g
  ) d
  LEFT JOIN LATERAL (
    SELECT bh."name"
      FROM "pos"."branch_holiday" bh
     WHERE bh."branch_id" = b."id" AND bh."archived_at" IS NULL AND d."day" BETWEEN bh."starts_on" AND bh."ends_on"
     ORDER BY bh."starts_on", bh."id"
     LIMIT 1
  ) h ON true
 WHERE b."archived_at" IS NULL
ON CONFLICT ("branch_id", "date") DO NOTHING;
