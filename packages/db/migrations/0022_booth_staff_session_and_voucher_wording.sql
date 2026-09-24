-- SCRUM-400 (S2-07d) — what the Console now sets up for a booth, as columns.
--
-- promo.voucher_definition: the park's own words for the slip, a title and an
-- instruction line in English and Thai. All four nullable: a definition nobody
-- has worded prints the prize's names and the generic redemption line, as it
-- did before these columns existed. The words reach a booth inside the
-- published wheel, so they print once the booth is published again.
--
-- booth.booth_settings.staff_session_minutes: how long a sign-in at the booth
-- lasts. Null is the box's own default (twelve hours) and publishes nothing,
-- so every booth keeps the bundle hash it already has; the CHECK is the box's
-- ceiling of one trading day (1440 minutes).
--
-- Adds nullable columns and one CHECK that every existing row (null) passes:
-- no rewrite, no default to backfill, safe to apply on a live database.
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "title_en" text;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "title_th" text;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "instruction_en" text;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD COLUMN "instruction_th" text;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD COLUMN "staff_session_minutes" integer;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_staff_session_minutes_check" CHECK ("booth"."booth_settings"."staff_session_minutes" is null or ("booth"."booth_settings"."staff_session_minutes" > 0 and "booth"."booth_settings"."staff_session_minutes" <= 1440));
