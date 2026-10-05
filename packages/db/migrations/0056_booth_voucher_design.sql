-- SCRUM-500: a null design leaves existing paper and published hashes unchanged.
-- A booth opts into the bilingual design through its draft, then publishes.
ALTER TABLE "booth"."booth_settings" ADD COLUMN "voucher_design" jsonb;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_voucher_design_check" CHECK ("booth"."booth_settings"."voucher_design" is null or jsonb_typeof("booth"."booth_settings"."voucher_design") = 'object');
