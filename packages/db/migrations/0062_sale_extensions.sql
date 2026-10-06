CREATE TABLE "pos"."sale_extension" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"source_sale_id" uuid NOT NULL,
	"charge_sale_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"option_id" text NOT NULL,
	"label" text NOT NULL,
	"minutes_added" integer NOT NULL,
	"bracelet_count" integer NOT NULL,
	"amount_satang" bigint NOT NULL,
	"selection" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_by_name" text,
	"applied_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	CONSTRAINT "sale_extension_status_check" CHECK ("pos"."sale_extension"."status" in ('pending','applied','voided')),
	CONSTRAINT "sale_extension_positive_check" CHECK ("pos"."sale_extension"."minutes_added" > 0 and "pos"."sale_extension"."bracelet_count" > 0 and "pos"."sale_extension"."amount_satang" > 0),
	CONSTRAINT "sale_extension_distinct_sales_check" CHECK ("pos"."sale_extension"."source_sale_id" <> "pos"."sale_extension"."charge_sale_id")
);
--> statement-breakpoint
CREATE TABLE "pos"."sale_extension_band" (
	"id" uuid PRIMARY KEY NOT NULL,
	"extension_id" uuid NOT NULL,
	"band_id" uuid NOT NULL,
	"minutes_added" integer NOT NULL,
	"applied_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_extension_band_minutes_check" CHECK ("pos"."sale_extension_band"."minutes_added" > 0)
);
--> statement-breakpoint
ALTER TABLE "pos"."sale_extension" ADD CONSTRAINT "sale_extension_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_extension" ADD CONSTRAINT "sale_extension_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_extension" ADD CONSTRAINT "sale_extension_source_sale_id_sale_id_fk" FOREIGN KEY ("source_sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_extension" ADD CONSTRAINT "sale_extension_charge_sale_id_sale_id_fk" FOREIGN KEY ("charge_sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_extension" ADD CONSTRAINT "sale_extension_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_extension_band" ADD CONSTRAINT "sale_extension_band_extension_id_sale_extension_id_fk" FOREIGN KEY ("extension_id") REFERENCES "pos"."sale_extension"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_extension_band" ADD CONSTRAINT "sale_extension_band_band_id_band_id_fk" FOREIGN KEY ("band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_extension_action_unique" ON "pos"."sale_extension" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_extension_charge_unique" ON "pos"."sale_extension" USING btree ("charge_sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_extension_pending_unique" ON "pos"."sale_extension" USING btree ("source_sale_id") WHERE "pos"."sale_extension"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "sale_extension_source_idx" ON "pos"."sale_extension" USING btree ("source_sale_id");--> statement-breakpoint
CREATE INDEX "sale_extension_branch_idx" ON "pos"."sale_extension" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "sale_extension_created_by_idx" ON "pos"."sale_extension" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_extension_band_unique" ON "pos"."sale_extension_band" USING btree ("extension_id","band_id");--> statement-breakpoint
CREATE INDEX "sale_extension_band_band_idx" ON "pos"."sale_extension_band" USING btree ("band_id");