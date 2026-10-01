-- S2-14b round 1 (plan docs/progress/plans/stock/PLAN.md §2.1) — the stock
-- ledger.
--
-- The Sprint 1 placeholders pos.stock_item, pos.stock_location and
-- pos.stock_level are reshaped forward-only:
--   - stock_item becomes ONE STOCKED SIZE AT ONE BRANCH, linked to the
--     sellable it stocks (product_id + variant_id, one live row per branch,
--     product and size), with unit cost, the low-stock threshold, par per
--     location and the prototype's reorder settings;
--   - stock_location gains operator_id, type (bulk / back_of_house /
--     rotation), sell_point (exactly one active rotation per branch, by a
--     partial unique index), active and archived_at;
--   - stock_level gets unique (location, item) and CHECK quantity >= 0. It is a
--     PROJECTION of pos.stock_movement, written only beside its movement.
-- New: pos.stock_unit (pack sizes, integer eaches), pos.stock_movement (the
-- append-only ledger; action_id unique per operator; a trigger refuses UPDATE
-- and DELETE except under the demo reset's purge flag), pos.stock_take(+line),
-- pos.purchase_order(+line), pos.stock_attention (deduped while open) and
-- analytics.fact_stock_daily.
--
-- THE NEVER-NEGATIVE CHOICE. The level CHECK holds on every path, the offline
-- replay included: a paid sale that takes more than the record holds records
-- the movement for what was there (the level floors at zero), the rest as the
-- movement's `shortfall`, and a stock_attention row. The level is always the
-- sum of its movements.
--
-- The placeholders were never written by the platform. A stock_item or
-- stock_level row would have no branch to backfill, so the migration stops
-- with a sentence rather than guessing; a stock_location row (a branch clone
-- copies them) is backfilled from its branch.
--
-- Undo: drop the eight new tables and the trigger function, the new
-- stock_item/stock_location columns, indexes and checks, and
-- stock_level_location_item_unique / stock_level_quantity_check.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pos"."stock_item") OR EXISTS (SELECT 1 FROM "pos"."stock_level") THEN
    RAISE EXCEPTION '0048: pos.stock_item or pos.stock_level holds rows written before the stock ledger existed; they have no branch to backfill. Remove them (they were placeholders) and migrate again.';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "analytics"."fact_stock_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"opening" integer DEFAULT 0 NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"refunded" integer DEFAULT 0 NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"transferred" integer DEFAULT 0 NOT NULL,
	"adjusted" integer DEFAULT 0 NOT NULL,
	"counted" integer DEFAULT 0 NOT NULL,
	"shortfall" integer DEFAULT 0 NOT NULL,
	"closing" integer DEFAULT 0 NOT NULL,
	"value_satang" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_stock_daily_closing_check" CHECK ("analytics"."fact_stock_daily"."opening" >= 0 and "analytics"."fact_stock_daily"."closing" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."purchase_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_contact" text,
	"state" text DEFAULT 'to_order' NOT NULL,
	"receive_location_id" uuid,
	"created_by_account_id" uuid,
	"ordered_at" timestamp with time zone,
	"ordered_by_account_id" uuid,
	"expected_arrival_date" date,
	"received_at" timestamp with time zone,
	"received_by_account_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "purchase_order_state_check" CHECK ("pos"."purchase_order"."state" in ('to_order','ordered','received'))
);
--> statement-breakpoint
CREATE TABLE "pos"."purchase_order_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"item_name" text NOT NULL,
	"variant_label" text,
	"ordered_quantity" integer NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_line_quantities_check" CHECK ("pos"."purchase_order_line"."ordered_quantity" > 0 and "pos"."purchase_order_line"."received_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."stock_attention" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"stock_item_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"rule" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"sale_id" uuid,
	"sale_line_id" uuid,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_attention_kind_check" CHECK ("pos"."stock_attention"."kind" in ('stock_shortfall','size_unknown','low_stock','reorder')),
	CONSTRAINT "stock_attention_quantity_check" CHECK ("pos"."stock_attention"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."stock_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"level_after" integer NOT NULL,
	"shortfall" integer DEFAULT 0 NOT NULL,
	"action_id" text NOT NULL,
	"sale_id" uuid,
	"sale_line_id" uuid,
	"refund_id" uuid,
	"purchase_order_line_id" uuid,
	"stock_take_line_id" uuid,
	"transfer_id" uuid,
	"reason" text,
	"unit_cost_satang" integer,
	"business_date" date NOT NULL,
	"actor_account_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"offline" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_kind_check" CHECK ("pos"."stock_movement"."kind" in ('sale','refund','receive','transfer_out','transfer_in','adjust','count','offline_sale')),
	CONSTRAINT "stock_movement_sign_check" CHECK (("pos"."stock_movement"."kind" not in ('sale','transfer_out','offline_sale') or "pos"."stock_movement"."quantity" <= 0) and ("pos"."stock_movement"."kind" not in ('refund','receive','transfer_in') or "pos"."stock_movement"."quantity" >= 0)),
	CONSTRAINT "stock_movement_nonzero_check" CHECK ("pos"."stock_movement"."quantity" <> 0 or "pos"."stock_movement"."shortfall" > 0),
	CONSTRAINT "stock_movement_shortfall_check" CHECK ("pos"."stock_movement"."shortfall" >= 0 and ("pos"."stock_movement"."shortfall" = 0 or "pos"."stock_movement"."kind" in ('sale','offline_sale'))),
	CONSTRAINT "stock_movement_level_after_check" CHECK ("pos"."stock_movement"."level_after" >= 0),
	CONSTRAINT "stock_movement_unit_cost_check" CHECK ("pos"."stock_movement"."unit_cost_satang" is null or "pos"."stock_movement"."unit_cost_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."stock_take" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opening" boolean DEFAULT false NOT NULL,
	"counted_by_account_id" uuid,
	"committed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_take_status_check" CHECK ("pos"."stock_take"."status" in ('open','committed'))
);
--> statement-breakpoint
CREATE TABLE "pos"."stock_take_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"stock_take_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"expected_quantity" integer NOT NULL,
	"counted_quantity" integer NOT NULL,
	"difference" integer NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"counted_by_account_id" uuid,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by_account_id" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_take_line_quantities_check" CHECK ("pos"."stock_take_line"."expected_quantity" >= 0 and "pos"."stock_take_line"."counted_quantity" >= 0 and "pos"."stock_take_line"."difference" = "pos"."stock_take_line"."counted_quantity" - "pos"."stock_take_line"."expected_quantity"),
	CONSTRAINT "stock_take_line_status_check" CHECK ("pos"."stock_take_line"."status" in ('pending','confirmed','adjusted'))
);
--> statement-breakpoint
CREATE TABLE "pos"."stock_unit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"eaches" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "stock_unit_eaches_check" CHECK ("pos"."stock_unit"."eaches" >= 2)
);
--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "branch_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "variant_label" text;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "unit_cost_satang" integer;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "low_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "par_by_location" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "reorder_point" integer;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "reorder_quantity" integer;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "lead_time_days" integer;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD COLUMN "supplier_contact" text;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD COLUMN "operator_id" uuid;--> statement-breakpoint
UPDATE "pos"."stock_location" l SET "operator_id" = b."operator_id" FROM "core"."branch" b WHERE b."id" = l."branch_id";--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ALTER COLUMN "operator_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD COLUMN "type" text DEFAULT 'back_of_house' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD COLUMN "sell_point" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analytics"."fact_stock_daily" ADD CONSTRAINT "fact_stock_daily_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_stock_daily" ADD CONSTRAINT "fact_stock_daily_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_stock_daily" ADD CONSTRAINT "fact_stock_daily_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order" ADD CONSTRAINT "purchase_order_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order" ADD CONSTRAINT "purchase_order_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order" ADD CONSTRAINT "purchase_order_receive_location_id_stock_location_id_fk" FOREIGN KEY ("receive_location_id") REFERENCES "pos"."stock_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order" ADD CONSTRAINT "purchase_order_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order" ADD CONSTRAINT "purchase_order_ordered_by_account_id_account_id_fk" FOREIGN KEY ("ordered_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order" ADD CONSTRAINT "purchase_order_received_by_account_id_account_id_fk" FOREIGN KEY ("received_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "pos"."purchase_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_attention" ADD CONSTRAINT "stock_attention_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_attention" ADD CONSTRAINT "stock_attention_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_attention" ADD CONSTRAINT "stock_attention_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_attention" ADD CONSTRAINT "stock_attention_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_attention" ADD CONSTRAINT "stock_attention_sale_line_id_sale_line_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "pos"."sale_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_attention" ADD CONSTRAINT "stock_attention_resolved_by_account_id_account_id_fk" FOREIGN KEY ("resolved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_stock_location_id_stock_location_id_fk" FOREIGN KEY ("stock_location_id") REFERENCES "pos"."stock_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_sale_line_id_sale_line_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "pos"."sale_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "pos"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "pos"."purchase_order_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_stock_take_line_id_stock_take_line_id_fk" FOREIGN KEY ("stock_take_line_id") REFERENCES "pos"."stock_take_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_movement" ADD CONSTRAINT "stock_movement_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take" ADD CONSTRAINT "stock_take_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take" ADD CONSTRAINT "stock_take_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take" ADD CONSTRAINT "stock_take_counted_by_account_id_account_id_fk" FOREIGN KEY ("counted_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take_line" ADD CONSTRAINT "stock_take_line_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take_line" ADD CONSTRAINT "stock_take_line_stock_take_id_stock_take_id_fk" FOREIGN KEY ("stock_take_id") REFERENCES "pos"."stock_take"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take_line" ADD CONSTRAINT "stock_take_line_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take_line" ADD CONSTRAINT "stock_take_line_stock_location_id_stock_location_id_fk" FOREIGN KEY ("stock_location_id") REFERENCES "pos"."stock_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take_line" ADD CONSTRAINT "stock_take_line_counted_by_account_id_account_id_fk" FOREIGN KEY ("counted_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_take_line" ADD CONSTRAINT "stock_take_line_confirmed_by_account_id_account_id_fk" FOREIGN KEY ("confirmed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_unit" ADD CONSTRAINT "stock_unit_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_unit" ADD CONSTRAINT "stock_unit_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_stock_daily_unique" ON "analytics"."fact_stock_daily" USING btree ("branch_id","stock_item_id","business_date");--> statement-breakpoint
CREATE INDEX "fact_stock_daily_operator_idx" ON "analytics"."fact_stock_daily" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "fact_stock_daily_item_idx" ON "analytics"."fact_stock_daily" USING btree ("stock_item_id");--> statement-breakpoint
CREATE INDEX "fact_stock_daily_branch_date_idx" ON "analytics"."fact_stock_daily" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "purchase_order_operator_idx" ON "pos"."purchase_order" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "purchase_order_branch_idx" ON "pos"."purchase_order" USING btree ("branch_id","state");--> statement-breakpoint
CREATE INDEX "purchase_order_receive_location_idx" ON "pos"."purchase_order" USING btree ("receive_location_id");--> statement-breakpoint
CREATE INDEX "purchase_order_created_by_idx" ON "pos"."purchase_order" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE INDEX "purchase_order_ordered_by_idx" ON "pos"."purchase_order" USING btree ("ordered_by_account_id");--> statement-breakpoint
CREATE INDEX "purchase_order_received_by_idx" ON "pos"."purchase_order" USING btree ("received_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_open_unique" ON "pos"."purchase_order" USING btree ("branch_id",lower("supplier_name")) WHERE state = 'to_order' and archived_at is null;--> statement-breakpoint
CREATE INDEX "purchase_order_line_operator_idx" ON "pos"."purchase_order_line" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "purchase_order_line_order_idx" ON "pos"."purchase_order_line" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_line_item_idx" ON "pos"."purchase_order_line" USING btree ("stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_line_unique" ON "pos"."purchase_order_line" USING btree ("purchase_order_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "stock_attention_operator_idx" ON "pos"."stock_attention" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "stock_attention_branch_idx" ON "pos"."stock_attention" USING btree ("branch_id","resolved_at");--> statement-breakpoint
CREATE INDEX "stock_attention_item_idx" ON "pos"."stock_attention" USING btree ("stock_item_id");--> statement-breakpoint
CREATE INDEX "stock_attention_sale_idx" ON "pos"."stock_attention" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "stock_attention_sale_line_idx" ON "pos"."stock_attention" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "stock_attention_resolved_by_idx" ON "pos"."stock_attention" USING btree ("resolved_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_attention_open_unique" ON "pos"."stock_attention" USING btree ("operator_id","dedupe_key") WHERE resolved_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_action_unique" ON "pos"."stock_movement" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE INDEX "stock_movement_operator_idx" ON "pos"."stock_movement" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "stock_movement_item_location_idx" ON "pos"."stock_movement" USING btree ("stock_item_id","stock_location_id");--> statement-breakpoint
CREATE INDEX "stock_movement_location_idx" ON "pos"."stock_movement" USING btree ("stock_location_id");--> statement-breakpoint
CREATE INDEX "stock_movement_branch_date_idx" ON "pos"."stock_movement" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "stock_movement_sale_idx" ON "pos"."stock_movement" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "stock_movement_sale_line_idx" ON "pos"."stock_movement" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "stock_movement_refund_idx" ON "pos"."stock_movement" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "stock_movement_po_line_idx" ON "pos"."stock_movement" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "stock_movement_take_line_idx" ON "pos"."stock_movement" USING btree ("stock_take_line_id");--> statement-breakpoint
CREATE INDEX "stock_movement_actor_idx" ON "pos"."stock_movement" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "stock_movement_station_idx" ON "pos"."stock_movement" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "stock_movement_box_idx" ON "pos"."stock_movement" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "stock_take_operator_idx" ON "pos"."stock_take" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "stock_take_branch_idx" ON "pos"."stock_take" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_take_counted_by_idx" ON "pos"."stock_take" USING btree ("counted_by_account_id");--> statement-breakpoint
CREATE INDEX "stock_take_line_operator_idx" ON "pos"."stock_take_line" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "stock_take_line_take_idx" ON "pos"."stock_take_line" USING btree ("stock_take_id");--> statement-breakpoint
CREATE INDEX "stock_take_line_item_idx" ON "pos"."stock_take_line" USING btree ("stock_item_id");--> statement-breakpoint
CREATE INDEX "stock_take_line_location_idx" ON "pos"."stock_take_line" USING btree ("stock_location_id");--> statement-breakpoint
CREATE INDEX "stock_take_line_counted_by_idx" ON "pos"."stock_take_line" USING btree ("counted_by_account_id");--> statement-breakpoint
CREATE INDEX "stock_take_line_confirmed_by_idx" ON "pos"."stock_take_line" USING btree ("confirmed_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_take_line_unique" ON "pos"."stock_take_line" USING btree ("stock_take_id","stock_item_id","stock_location_id");--> statement-breakpoint
CREATE INDEX "stock_unit_operator_idx" ON "pos"."stock_unit" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "stock_unit_item_idx" ON "pos"."stock_unit" USING btree ("stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_unit_code_unique" ON "pos"."stock_unit" USING btree ("stock_item_id","code") WHERE archived_at is null;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD CONSTRAINT "stock_item_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD CONSTRAINT "stock_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD CONSTRAINT "stock_location_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_item_branch_idx" ON "pos"."stock_item" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "stock_item_product_idx" ON "pos"."stock_item" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_item_sellable_unique" ON "pos"."stock_item" USING btree ("branch_id","product_id",coalesce("variant_id", '')) WHERE product_id is not null and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_level_location_item_unique" ON "pos"."stock_level" USING btree ("stock_location_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "stock_location_operator_idx" ON "pos"."stock_location" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_location_sell_point_unique" ON "pos"."stock_location" USING btree ("branch_id") WHERE sell_point and active and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_location_name_unique" ON "pos"."stock_location" USING btree ("branch_id",lower("name")) WHERE archived_at is null;--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD CONSTRAINT "stock_item_variant_needs_product_check" CHECK ("pos"."stock_item"."variant_id" is null or "pos"."stock_item"."product_id" is not null);--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD CONSTRAINT "stock_item_unit_cost_check" CHECK ("pos"."stock_item"."unit_cost_satang" is null or "pos"."stock_item"."unit_cost_satang" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD CONSTRAINT "stock_item_thresholds_check" CHECK (("pos"."stock_item"."low_stock_threshold" is null or "pos"."stock_item"."low_stock_threshold" >= 0) and ("pos"."stock_item"."reorder_point" is null or "pos"."stock_item"."reorder_point" >= 0) and ("pos"."stock_item"."reorder_quantity" is null or "pos"."stock_item"."reorder_quantity" > 0) and ("pos"."stock_item"."lead_time_days" is null or "pos"."stock_item"."lead_time_days" >= 0));--> statement-breakpoint
ALTER TABLE "pos"."stock_item" ADD CONSTRAINT "stock_item_par_object_check" CHECK (jsonb_typeof("pos"."stock_item"."par_by_location") = 'object');--> statement-breakpoint
ALTER TABLE "pos"."stock_level" ADD CONSTRAINT "stock_level_quantity_check" CHECK ("pos"."stock_level"."quantity" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD CONSTRAINT "stock_location_type_check" CHECK ("pos"."stock_location"."type" in ('bulk','back_of_house','rotation'));--> statement-breakpoint
ALTER TABLE "pos"."stock_location" ADD CONSTRAINT "stock_location_sell_point_type_check" CHECK (not "pos"."stock_location"."sell_point" or "pos"."stock_location"."type" = 'rotation');--> statement-breakpoint
CREATE FUNCTION "pos"."stock_movement_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('oto.stock_ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pos.stock_movement is append-only: a movement is corrected by another movement, never edited or removed';
END $$;
--> statement-breakpoint
CREATE TRIGGER "stock_movement_append_only" BEFORE UPDATE OR DELETE ON "pos"."stock_movement"
FOR EACH ROW EXECUTE FUNCTION "pos"."stock_movement_append_only"();
