-- SCRUM-499: optional existing-POS QR; internal voucher codes stay unchanged.
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "legacy_qr_payload" text;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_legacy_qr_check" CHECK ("promo"."voucher_definition"."legacy_qr_payload" is null or (length("promo"."voucher_definition"."legacy_qr_payload") between 1 and 512 and "promo"."voucher_definition"."legacy_qr_payload" ~ '^[!-~]+$'));
