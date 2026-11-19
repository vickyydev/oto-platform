-- SCRUM-1031: the guests a family expects beyond the planned counts and how the
-- socks are paid for, on the party (shared/beoGuestsSocks.ts). Expand only: four
-- nullable columns and two checks every existing row passes (all null). No view
-- the till reads names them; no stored row is changed.
ALTER TABLE "core_events" ADD COLUMN "expected_extra_kids" integer;--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "expected_extra_adults" integer;--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "socks_arrangement" text;--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "socks_note" text;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_expected_extra_check" CHECK (("core_events"."expected_extra_kids" IS NULL OR "core_events"."expected_extra_kids" >= 0) AND ("core_events"."expected_extra_adults" IS NULL OR "core_events"."expected_extra_adults" >= 0));--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_socks_arrangement_check" CHECK ("core_events"."socks_arrangement" IS NULL OR "core_events"."socks_arrangement" IN ('birthday_parent', 'guests', 'other'));