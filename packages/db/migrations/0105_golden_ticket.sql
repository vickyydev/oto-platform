-- SCRUM-798 (the Golden Ticket: a gift voucher sold as a shop item and
-- redeemed at the ticket till) - expand-only: one new table, two new columns,
-- one new check. Nothing existing is rewritten or dropped, and a release that
-- does not know them never reads them.
--
--   promo.voucher_sale_item              new table
--       an item whose sale issues one voucher of a definition per unit sold
--       when the sale closes. Empty until platform-sync links the Golden
--       Ticket items (CF-TK-GOLDEN, RC-TK-GOLDEN).
--   promo.voucher.issued_sale_id         uuid, null, FK pos.sale
--       the sale that sold the voucher. Null on every voucher before this.
--       PostgreSQL adds a nullable column without rewriting the table.
--   promo.voucher_definition.ticket_offer  text, not null, default 'one_plus_one'
--       what a free_ticket admits: the booth's 1+1 (every definition before
--       this, hence the default) or 'gift_day', the Golden Ticket. A constant
--       default is stored in the catalogue, so the table is not rewritten.
CREATE TABLE "promo"."voucher_sale_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"voucher_definition_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "issued_sale_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "ticket_offer" text DEFAULT 'one_plus_one' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."voucher_sale_item" ADD CONSTRAINT "voucher_sale_item_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_sale_item" ADD CONSTRAINT "voucher_sale_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_sale_item" ADD CONSTRAINT "voucher_sale_item_definition_fk" FOREIGN KEY ("voucher_definition_id") REFERENCES "promo"."voucher_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_sale_item_product_unique" ON "promo"."voucher_sale_item" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "voucher_sale_item_operator_idx" ON "promo"."voucher_sale_item" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "voucher_sale_item_definition_idx" ON "promo"."voucher_sale_item" USING btree ("voucher_definition_id");--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_issued_sale_id_sale_id_fk" FOREIGN KEY ("issued_sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_issued_sale_idx" ON "promo"."voucher" USING btree ("issued_sale_id");--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_ticket_offer_check" CHECK ("promo"."voucher_definition"."ticket_offer" in ('one_plus_one','gift_day'));