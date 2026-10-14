-- SCRUM-405 — which product a free-product voucher hands over at each park.
--
-- A free-product voucher is honoured where its definition's product is on
-- sale; at any other park it is now honoured through the product an
-- administrator links for that park here, and refused where nothing is
-- linked. One link per definition and park. A new, empty table: nothing
-- existing changes.
--
-- TO REVERSE (drops every park link recorded since):
--   DROP TABLE "promo"."voucher_product_link";
CREATE TABLE "promo"."voucher_product_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"voucher_definition_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo"."voucher_product_link" ADD CONSTRAINT "voucher_product_link_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_product_link" ADD CONSTRAINT "voucher_product_link_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_product_link" ADD CONSTRAINT "voucher_product_link_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_product_link" ADD CONSTRAINT "voucher_product_link_definition_fk" FOREIGN KEY ("voucher_definition_id") REFERENCES "promo"."voucher_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_product_link_unique" ON "promo"."voucher_product_link" USING btree ("voucher_definition_id","branch_id");--> statement-breakpoint
CREATE INDEX "voucher_product_link_operator_idx" ON "promo"."voucher_product_link" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "voucher_product_link_branch_idx" ON "promo"."voucher_product_link" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "voucher_product_link_product_idx" ON "promo"."voucher_product_link" USING btree ("product_id");