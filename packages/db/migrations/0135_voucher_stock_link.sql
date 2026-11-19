-- SCRUM-1040 (Mystery Box stock) - 0135: which stock item a hand-over prize
-- takes one from at each park. One row per voucher type and park, beside
-- voucher_product_link; a park with no row takes nothing, as before. A new
-- table only: nothing existing is changed or read differently.
CREATE TABLE "promo"."voucher_stock_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"voucher_definition_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo"."voucher_stock_link" ADD CONSTRAINT "voucher_stock_link_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_stock_link" ADD CONSTRAINT "voucher_stock_link_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_stock_link" ADD CONSTRAINT "voucher_stock_link_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_stock_link" ADD CONSTRAINT "voucher_stock_link_definition_fk" FOREIGN KEY ("voucher_definition_id") REFERENCES "promo"."voucher_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_stock_link_unique" ON "promo"."voucher_stock_link" USING btree ("voucher_definition_id","branch_id");--> statement-breakpoint
CREATE INDEX "voucher_stock_link_operator_idx" ON "promo"."voucher_stock_link" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "voucher_stock_link_branch_idx" ON "promo"."voucher_stock_link" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "voucher_stock_link_stock_item_idx" ON "promo"."voucher_stock_link" USING btree ("stock_item_id");