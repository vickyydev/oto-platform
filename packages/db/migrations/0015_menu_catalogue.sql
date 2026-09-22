CREATE TABLE "pos"."discount_definition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"value_bp" integer,
	"value_satang" integer,
	"free_product_id" uuid,
	"target" jsonb,
	"valid_from" date,
	"valid_until" date,
	"usage_limit" integer,
	"per_customer_limit" integer,
	"stackable" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "discount_definition_kind_check" CHECK ("pos"."discount_definition"."kind" in ('percent','fixed','free_item')),
	CONSTRAINT "discount_definition_value_bp_check" CHECK ("pos"."discount_definition"."value_bp" is null or ("pos"."discount_definition"."value_bp" >= 0 and "pos"."discount_definition"."value_bp" <= 10000)),
	CONSTRAINT "discount_definition_value_satang_check" CHECK ("pos"."discount_definition"."value_satang" is null or "pos"."discount_definition"."value_satang" >= 0),
	CONSTRAINT "discount_definition_value_for_kind_check" CHECK (("pos"."discount_definition"."kind" = 'percent' and "pos"."discount_definition"."value_bp" is not null) or ("pos"."discount_definition"."kind" = 'fixed' and "pos"."discount_definition"."value_satang" is not null) or ("pos"."discount_definition"."kind" = 'free_item' and "pos"."discount_definition"."free_product_id" is not null)),
	CONSTRAINT "discount_definition_validity_check" CHECK ("pos"."discount_definition"."valid_from" is null or "pos"."discount_definition"."valid_until" is null or "pos"."discount_definition"."valid_until" >= "pos"."discount_definition"."valid_from"),
	CONSTRAINT "discount_definition_usage_limit_check" CHECK (("pos"."discount_definition"."usage_limit" is null or "pos"."discount_definition"."usage_limit" > 0) and ("pos"."discount_definition"."per_customer_limit" is null or "pos"."discount_definition"."per_customer_limit" > 0))
);
--> statement-breakpoint
CREATE TABLE "pos"."modifier_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"selection_type" text DEFAULT 'single' NOT NULL,
	"min_select" integer,
	"max_select" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"translations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "modifier_group_selection_type_check" CHECK ("pos"."modifier_group"."selection_type" in ('single','multi')),
	CONSTRAINT "modifier_group_bounds_check" CHECK (("pos"."modifier_group"."min_select" is null or "pos"."modifier_group"."min_select" >= 0) and ("pos"."modifier_group"."max_select" is null or "pos"."modifier_group"."max_select" >= 1) and ("pos"."modifier_group"."min_select" is null or "pos"."modifier_group"."max_select" is null or "pos"."modifier_group"."max_select" >= "pos"."modifier_group"."min_select")),
	CONSTRAINT "modifier_group_single_no_bounds_check" CHECK ("pos"."modifier_group"."selection_type" = 'multi' or ("pos"."modifier_group"."min_select" is null and "pos"."modifier_group"."max_select" is null))
);
--> statement-breakpoint
CREATE TABLE "pos"."modifier_option" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_satang" integer DEFAULT 0 NOT NULL,
	"price_weekend_satang" integer,
	"cost_satang" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"translations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "modifier_option_price_check" CHECK ("pos"."modifier_option"."price_satang" >= 0),
	CONSTRAINT "modifier_option_price_weekend_check" CHECK ("pos"."modifier_option"."price_weekend_satang" is null or "pos"."modifier_option"."price_weekend_satang" >= 0),
	CONSTRAINT "modifier_option_cost_check" CHECK ("pos"."modifier_option"."cost_satang" is null or "pos"."modifier_option"."cost_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."product_modifier_group" (
	"operator_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_modifier_group_product_id_modifier_group_id_pk" PRIMARY KEY("product_id","modifier_group_id")
);
--> statement-breakpoint
ALTER TABLE "pos"."product_category" ALTER COLUMN "taxable_category" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ALTER COLUMN "taxable_category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "kind" text DEFAULT 'menu' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "price_weekend_satang" integer;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "cost_satang" integer;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "prep_station_override" text;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "tax_category_override" text;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "translations" jsonb;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "stock_item_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD COLUMN "default_prep_station" text;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD COLUMN "translations" jsonb;--> statement-breakpoint
ALTER TABLE "pos"."discount_definition" ADD CONSTRAINT "discount_definition_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."discount_definition" ADD CONSTRAINT "discount_definition_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."discount_definition" ADD CONSTRAINT "discount_definition_free_product_id_product_id_fk" FOREIGN KEY ("free_product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."modifier_group" ADD CONSTRAINT "modifier_group_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."modifier_group" ADD CONSTRAINT "modifier_group_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."modifier_option" ADD CONSTRAINT "modifier_option_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."modifier_option" ADD CONSTRAINT "modifier_option_modifier_group_id_modifier_group_id_fk" FOREIGN KEY ("modifier_group_id") REFERENCES "pos"."modifier_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."product_modifier_group" ADD CONSTRAINT "product_modifier_group_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."product_modifier_group" ADD CONSTRAINT "product_modifier_group_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."product_modifier_group" ADD CONSTRAINT "product_modifier_group_modifier_group_id_modifier_group_id_fk" FOREIGN KEY ("modifier_group_id") REFERENCES "pos"."modifier_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discount_definition_operator_idx" ON "pos"."discount_definition" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "discount_definition_branch_idx" ON "pos"."discount_definition" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "discount_definition_free_product_idx" ON "pos"."discount_definition" USING btree ("free_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_definition_code_unique" ON "pos"."discount_definition" USING btree ("operator_id","code") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "modifier_group_operator_idx" ON "pos"."modifier_group" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "modifier_group_product_idx" ON "pos"."modifier_group" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_group_library_name_unique" ON "pos"."modifier_group" USING btree ("operator_id","name") WHERE product_id is null and archived_at is null;--> statement-breakpoint
CREATE INDEX "modifier_option_operator_idx" ON "pos"."modifier_option" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "modifier_option_group_idx" ON "pos"."modifier_option" USING btree ("modifier_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_option_name_unique" ON "pos"."modifier_option" USING btree ("modifier_group_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "product_modifier_group_operator_idx" ON "pos"."product_modifier_group" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "product_modifier_group_group_idx" ON "pos"."product_modifier_group" USING btree ("modifier_group_id");--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD CONSTRAINT "product_category_parent_id_product_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "pos"."product_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_kind_idx" ON "pos"."product" USING btree ("operator_id","kind");--> statement-breakpoint
CREATE INDEX "product_stock_item_idx" ON "pos"."product" USING btree ("stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_code_unique" ON "pos"."product" USING btree ("operator_id","code") WHERE code is not null and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_sku_unique" ON "pos"."product" USING btree ("operator_id","sku") WHERE sku is not null and archived_at is null;--> statement-breakpoint
CREATE INDEX "product_category_parent_idx" ON "pos"."product_category" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_category_code_unique" ON "pos"."product_category" USING btree ("operator_id","code") WHERE code is not null and archived_at is null;--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_kind_check" CHECK ("pos"."product"."kind" in ('menu','merch','addon'));--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_price_check" CHECK ("pos"."product"."price_satang" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_price_weekend_check" CHECK ("pos"."product"."price_weekend_satang" is null or "pos"."product"."price_weekend_satang" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_cost_check" CHECK ("pos"."product"."cost_satang" is null or "pos"."product"."cost_satang" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_prep_station_check" CHECK ("pos"."product"."prep_station_override" is null or "pos"."product"."prep_station_override" in ('kitchen','bar','none'));--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_tax_category_check" CHECK ("pos"."product"."tax_category_override" is null or "pos"."product"."tax_category_override" in ('tickets','fnb','bar','drop_off','parties','addons','merch','stored_value'));--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD CONSTRAINT "product_category_parent_not_self_check" CHECK ("pos"."product_category"."parent_id" is null or "pos"."product_category"."parent_id" <> "pos"."product_category"."id");--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD CONSTRAINT "product_category_top_level_taxable_check" CHECK ("pos"."product_category"."parent_id" is not null or "pos"."product_category"."taxable_category" is not null);--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD CONSTRAINT "product_category_taxable_check" CHECK ("pos"."product_category"."taxable_category" is null or "pos"."product_category"."taxable_category" in ('tickets','fnb','bar','drop_off','parties','addons','merch','stored_value'));--> statement-breakpoint
ALTER TABLE "pos"."product_category" ADD CONSTRAINT "product_category_prep_station_check" CHECK ("pos"."product_category"."default_prep_station" is null or "pos"."product_category"."default_prep_station" in ('kitchen','bar','none'));