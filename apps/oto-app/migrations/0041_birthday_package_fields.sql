ALTER TABLE "beo_package_snapshots" ADD COLUMN "kids_included" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "adults_included" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "socks_included" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "hours" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "price_weekday" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "price_weekend" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "extra_child_weekday" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "extra_child_weekend" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "extra_adult_weekday" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "extra_adult_weekend" integer;--> statement-breakpoint
ALTER TABLE "beo_package_snapshots" ADD COLUMN "slips_time" time;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "kids_included" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "adults_included" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "socks_included" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "hours" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "price_weekday" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "price_weekend" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "extra_child_weekday" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "extra_child_weekend" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "extra_adult_weekday" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "extra_adult_weekend" integer;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "set_menu_template_id" uuid;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "slips_time" time DEFAULT '11:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD COLUMN "branch_id" varchar;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD COLUMN "age_range" text;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD COLUMN "max_kids" integer;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD COLUMN "extra_child_price" integer;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD COLUMN "price_is_from" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "package_line_item_templates" ADD COLUMN "fnb_credit" integer;--> statement-breakpoint
ALTER TABLE "package_line_item_templates" ADD COLUMN "prints_voucher" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "package_line_item_templates" ADD COLUMN "price_is_from" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD CONSTRAINT "birthday_package_templates_set_menu_template_id_beo_set_menu_templates_id_fk" FOREIGN KEY ("set_menu_template_id") REFERENCES "beo_set_menu_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD CONSTRAINT "birthday_package_templates_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_birthday_package_templates_branch" ON "birthday_package_templates" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_birthday_package_templates_set_menu" ON "birthday_package_templates" USING btree ("set_menu_template_id");--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD CONSTRAINT "birthday_package_templates_limits_check" CHECK (("birthday_package_templates"."kids_included" IS NULL OR "birthday_package_templates"."kids_included" >= 0) AND ("birthday_package_templates"."adults_included" IS NULL OR "birthday_package_templates"."adults_included" >= 0) AND ("birthday_package_templates"."socks_included" IS NULL OR "birthday_package_templates"."socks_included" >= -1) AND ("birthday_package_templates"."hours" IS NULL OR "birthday_package_templates"."hours" > 0));--> statement-breakpoint
ALTER TABLE "birthday_package_templates" ADD CONSTRAINT "birthday_package_templates_prices_check" CHECK (("birthday_package_templates"."price_weekday" IS NULL OR "birthday_package_templates"."price_weekday" >= 0) AND ("birthday_package_templates"."price_weekend" IS NULL OR "birthday_package_templates"."price_weekend" >= 0) AND ("birthday_package_templates"."extra_child_weekday" IS NULL OR "birthday_package_templates"."extra_child_weekday" >= 0) AND ("birthday_package_templates"."extra_child_weekend" IS NULL OR "birthday_package_templates"."extra_child_weekend" >= 0) AND ("birthday_package_templates"."extra_adult_weekday" IS NULL OR "birthday_package_templates"."extra_adult_weekday" >= 0) AND ("birthday_package_templates"."extra_adult_weekend" IS NULL OR "birthday_package_templates"."extra_adult_weekend" >= 0));--> statement-breakpoint
ALTER TABLE "entertainment_package_templates" ADD CONSTRAINT "entertainment_package_templates_menu_check" CHECK (("entertainment_package_templates"."max_kids" IS NULL OR "entertainment_package_templates"."max_kids" > 0) AND ("entertainment_package_templates"."extra_child_price" IS NULL OR "entertainment_package_templates"."extra_child_price" >= 0) AND ("entertainment_package_templates"."unit" IS NULL OR "entertainment_package_templates"."unit" IN ('session', 'piece', 'hour')));--> statement-breakpoint
ALTER TABLE "package_line_item_templates" ADD CONSTRAINT "package_line_item_templates_fnb_credit_check" CHECK ("package_line_item_templates"."fnb_credit" IS NULL OR "package_line_item_templates"."fnb_credit" >= 0);