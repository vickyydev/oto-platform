-- SCRUM-471 (plan D2, docs/progress/plans/booth/TEMPLATES_AND_DUTY_PLAN.md) — the
-- booth voucher slip becomes the booth's own, on booth.booth_settings.
--
-- Five columns an administrator sets in Console → Booths → Voucher slip: show
-- the logo, a header line under the venue line, a footer line, show the Staff
-- row, show the terms. They reach a booth inside the published wheel.
--
-- EVERY DEFAULT IS TODAY'S SLIP: the three booleans default true (logo, Staff
-- row and terms print, as they always have) and the two texts are null (no
-- header line, no footer line). The publisher writes a field into the bundle
-- only when it differs from that default, so every existing booth keeps the
-- bundle hash it already has and prints the same bytes.
--
-- The two CHECKs are the print template editor's own limits (200 and 400
-- characters) and every existing row (null) passes them.
--
-- Adds columns with constant defaults and nullable columns: no table rewrite
-- on PostgreSQL 11+, safe on a live database. Forward only.
ALTER TABLE "booth"."booth_settings" ADD COLUMN "voucher_show_logo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "voucher_header_text" text;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "voucher_footer_text" text;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "voucher_show_staff" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "voucher_show_terms" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_voucher_header_text_check" CHECK ("booth"."booth_settings"."voucher_header_text" is null or char_length("booth"."booth_settings"."voucher_header_text") <= 200);--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_voucher_footer_text_check" CHECK ("booth"."booth_settings"."voucher_footer_text" is null or char_length("booth"."booth_settings"."voucher_footer_text") <= 400);
