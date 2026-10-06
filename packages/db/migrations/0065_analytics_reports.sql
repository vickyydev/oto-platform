-- S2-15b (SCRUM-216), analytics rounds 4 and 5 — the Reports panels' rows and
-- the booth's day. The plan is docs/progress/plans/analytics/PLAN.md §7 and §8
-- rounds 4-5; migration 0064 created the report tables, this one gives them
-- what the panels show that 0064 had no column for.
--
-- 1. THE REPORT ROWS' MISSING COLUMNS. The Tax & VAT panel shows VAT inside
--    the price and VAT added to it as two columns (`tax_inclusive_satang`,
--    `tax_exclusive_satang` on the category rows); the Profitability panel
--    flags an item sold with no cost known (`cost_untracked_quantity`); the
--    Discounts & Comps panel groups manual discounts by who applied them and
--    names a promo by its receipt label (`applied_by_*`, `label`). And the
--    Sales panel's ticket side — sales by tier, the ticket type breakdown,
--    drop-off and nanny sessions, and through the tiers the weekday / weekend
--    split — gets `analytics.daily_ticket_summary`. Every report table is
--    still written by the jobs process only.
--
-- 2. THE BOOTH'S DIRTY DAYS. `analytics.dirty_date` kind `booth` (0064) is
--    marked at the commit of the transaction that wrote a booth fact: a spin
--    filed (or its voucher linked, or the spin removed), and a booth voucher
--    redeemed, expired or voided — the redemption counts on the day the
--    voucher was SPUN, so a voucher redeemed a week later re-marks that day.
--    A simulated spin (the `#debug` distribution run) marks nothing.
--
-- 3. THE BACKLOG. Every day that already has counted sales is queued for the
--    daily rollup again, so the report rows are written for the past as well
--    as for today (the daily summary itself is unchanged: its fingerprint has
--    not moved, so nothing is rewritten there); and every day a booth spun is
--    queued for the booth rollup.
--
CREATE TABLE "analytics"."daily_ticket_summary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'oto_pos' NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sale_count" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"kids" integer DEFAULT 0 NOT NULL,
	"adults" integer DEFAULT 0 NOT NULL,
	"hours" integer DEFAULT 0 NOT NULL,
	"revenue_satang" bigint DEFAULT 0 NOT NULL,
	"dropoff_satang" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_ticket_summary_source_check" CHECK ("analytics"."daily_ticket_summary"."source" in ('oto_pos','pisell','papaya')),
	CONSTRAINT "daily_ticket_summary_kind_check" CHECK ("analytics"."daily_ticket_summary"."kind" in ('tier','ticket_type','service')),
	CONSTRAINT "daily_ticket_summary_counts_check" CHECK ("analytics"."daily_ticket_summary"."sale_count" >= 0 and "analytics"."daily_ticket_summary"."line_count" >= 0 and "analytics"."daily_ticket_summary"."kids" >= 0 and "analytics"."daily_ticket_summary"."adults" >= 0 and "analytics"."daily_ticket_summary"."hours" >= 0 and "analytics"."daily_ticket_summary"."dropoff_satang" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analytics"."daily_category_summary" ADD COLUMN "tax_inclusive_satang" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics"."daily_category_summary" ADD COLUMN "tax_exclusive_satang" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics"."daily_discount_summary" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "analytics"."daily_discount_summary" ADD COLUMN "applied_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "analytics"."daily_discount_summary" ADD COLUMN "applied_by_name" text;--> statement-breakpoint
ALTER TABLE "analytics"."daily_item_summary" ADD COLUMN "cost_untracked_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics"."daily_ticket_summary" ADD CONSTRAINT "daily_ticket_summary_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."daily_ticket_summary" ADD CONSTRAINT "daily_ticket_summary_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_ticket_summary_unique" ON "analytics"."daily_ticket_summary" USING btree ("branch_id","business_date","source","kind","key");--> statement-breakpoint
CREATE INDEX "daily_ticket_summary_operator_date_idx" ON "analytics"."daily_ticket_summary" USING btree ("operator_id","business_date");--> statement-breakpoint
ALTER TABLE "analytics"."daily_discount_summary" ADD CONSTRAINT "daily_discount_summary_applied_by_account_id_account_id_fk" FOREIGN KEY ("applied_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_discount_summary_applied_by_idx" ON "analytics"."daily_discount_summary" USING btree ("applied_by_account_id");--> statement-breakpoint
ALTER TABLE "analytics"."daily_category_summary" ADD CONSTRAINT "daily_category_summary_tax_split_check" CHECK ("analytics"."daily_category_summary"."tax_inclusive_satang" >= 0 and "analytics"."daily_category_summary"."tax_exclusive_satang" >= 0);--> statement-breakpoint
ALTER TABLE "analytics"."daily_item_summary" ADD CONSTRAINT "daily_item_summary_kind_check" CHECK ("analytics"."daily_item_summary"."kind" in ('fnb','merch'));--> statement-breakpoint
ALTER TABLE "analytics"."daily_item_summary" ADD CONSTRAINT "daily_item_summary_untracked_check" CHECK ("analytics"."daily_item_summary"."cost_untracked_quantity" >= 0 and "analytics"."daily_item_summary"."cost_untracked_quantity" <= "analytics"."daily_item_summary"."quantity");

--> statement-breakpoint
-- A spin marks its own trading day; a removed spin, or one moved to another
-- day, the day it was on. Simulated spins never reach the booth figures.
CREATE OR REPLACE FUNCTION "analytics"."spin_marks_dirty_date"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND NOT OLD."simulated" THEN
    IF TG_OP = 'DELETE' OR OLD."business_date" IS DISTINCT FROM NEW."business_date" THEN
      PERFORM "analytics"."mark_dirty_date"(OLD."operator_id", OLD."branch_id", OLD."business_date", 'booth', 'spin:moved');
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT NEW."simulated" THEN
    PERFORM "analytics"."mark_dirty_date"(NEW."operator_id", NEW."branch_id", NEW."business_date", 'booth', 'spin');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "spin_insert_marks_dirty_date" AFTER INSERT ON "booth"."spin"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NOT NEW."simulated")
  EXECUTE FUNCTION "analytics"."spin_marks_dirty_date"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "spin_update_marks_dirty_date" AFTER UPDATE OF "voucher_id", "prize_id", "outcome", "staff_account_id", "business_date", "simulated" ON "booth"."spin"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD."voucher_id" IS DISTINCT FROM NEW."voucher_id" OR OLD."prize_id" IS DISTINCT FROM NEW."prize_id"
         OR OLD."outcome" IS DISTINCT FROM NEW."outcome" OR OLD."staff_account_id" IS DISTINCT FROM NEW."staff_account_id"
         OR OLD."business_date" IS DISTINCT FROM NEW."business_date" OR OLD."simulated" IS DISTINCT FROM NEW."simulated")
        AND (NOT OLD."simulated" OR NOT NEW."simulated"))
  EXECUTE FUNCTION "analytics"."spin_marks_dirty_date"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "spin_delete_marks_dirty_date" AFTER DELETE ON "booth"."spin"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NOT OLD."simulated")
  EXECUTE FUNCTION "analytics"."spin_marks_dirty_date"();
--> statement-breakpoint
-- A booth voucher redeemed, expired or voided — whenever — changes the day it
-- was spun on: the funnel counts a voucher on its issue day.
CREATE OR REPLACE FUNCTION "analytics"."voucher_marks_booth_dirty_date"() RETURNS trigger AS $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT DISTINCT sp."operator_id", sp."branch_id", sp."business_date"
      FROM "booth"."spin" sp
     WHERE sp."voucher_id" = NEW."id" AND NOT sp."simulated"
  LOOP
    PERFORM "analytics"."mark_dirty_date"(s."operator_id", s."branch_id", s."business_date", 'booth', 'voucher:' || NEW."status");
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "voucher_marks_booth_dirty_date" AFTER UPDATE OF "status", "redeemed_at", "cost_satang" ON "promo"."voucher"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."redeemed_at" IS DISTINCT FROM NEW."redeemed_at"
        OR OLD."cost_satang" IS DISTINCT FROM NEW."cost_satang")
  EXECUTE FUNCTION "analytics"."voucher_marks_booth_dirty_date"();
--> statement-breakpoint
INSERT INTO "analytics"."dirty_date"
  ("id", "operator_id", "branch_id", "business_date", "kind", "reason", "marked_at", "mark_count", "created_at", "updated_at")
SELECT gen_random_uuid(), s."operator_id", s."branch_id", s."business_date", 'sales', 'migration:0065', now(), 1, now(), now()
  FROM "pos"."sale" s
 WHERE s."status" IN ('finalised', 'refunded')
 GROUP BY s."operator_id", s."branch_id", s."business_date"
ON CONFLICT ("branch_id", "business_date", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "analytics"."dirty_date"
  ("id", "operator_id", "branch_id", "business_date", "kind", "reason", "marked_at", "mark_count", "created_at", "updated_at")
SELECT gen_random_uuid(), sp."operator_id", sp."branch_id", sp."business_date", 'booth', 'migration:0065', now(), 1, now(), now()
  FROM "booth"."spin" sp
 WHERE NOT sp."simulated"
 GROUP BY sp."operator_id", sp."branch_id", sp."business_date"
ON CONFLICT ("branch_id", "business_date", "kind") DO NOTHING;
