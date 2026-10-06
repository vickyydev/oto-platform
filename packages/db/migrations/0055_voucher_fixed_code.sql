-- Voucher types with a fixed code.
--
-- A type can print one code the park chose (for example a code already set
-- up in another till system) on every slip, instead of a minted code per
-- voucher. Each win is still its own voucher row with a minted code; a till
-- redeems the shared code against the type, minting a `fixed` voucher row for
-- that redemption so the type's window and limits apply as for any voucher.
--
-- Add-only: two columns with a default, two checks that hold for every
-- existing row (all `generated`, no fixed code), a partial unique index, and
-- the voucher source check widened by one value.
--
-- Undo:
-- ALTER TABLE "promo"."voucher" DROP CONSTRAINT "voucher_source_check";
-- ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_source_check" CHECK ("promo"."voucher"."source" in ('booth','legacy','manual','campaign'));
-- DROP INDEX "promo"."voucher_definition_fixed_code_unique";
-- ALTER TABLE "promo"."voucher_definition" DROP CONSTRAINT "voucher_definition_fixed_code_check";
-- ALTER TABLE "promo"."voucher_definition" DROP CONSTRAINT "voucher_definition_code_mode_check";
-- ALTER TABLE "promo"."voucher_definition" DROP COLUMN "fixed_code";
-- ALTER TABLE "promo"."voucher_definition" DROP COLUMN "code_mode";

ALTER TABLE "promo"."voucher_definition" ADD COLUMN "code_mode" text DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "fixed_code" text;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_code_mode_check" CHECK ("promo"."voucher_definition"."code_mode" in ('generated','fixed'));--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_fixed_code_check" CHECK (("promo"."voucher_definition"."code_mode" = 'fixed') = ("promo"."voucher_definition"."fixed_code" is not null) and ("promo"."voucher_definition"."fixed_code" is null or "promo"."voucher_definition"."fixed_code" ~ '^[0-9A-Z-]{4,32}$'));--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_definition_fixed_code_unique" ON "promo"."voucher_definition" USING btree ("operator_id","fixed_code") WHERE fixed_code is not null and archived_at is null;--> statement-breakpoint
ALTER TABLE "promo"."voucher" DROP CONSTRAINT "voucher_source_check";--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_source_check" CHECK ("promo"."voucher"."source" in ('booth','legacy','manual','campaign','fixed'));
