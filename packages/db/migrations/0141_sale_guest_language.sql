-- SCRUM-1077 (the gate's messages in the language the guest chose at the
-- till) - expand-only: one nullable column, which PostgreSQL adds without
-- rewriting the table, and its check, which every existing row passes
-- because each is null. A release that does not know the column never
-- reads it.
--
--   pos.sale.guest_language   text, null
--       one of the customer display's five languages (en, zh, th, ru, fr),
--       chosen by the guest in that sale; sent to the gate box with each of
--       the sale's bands. Null on every sale before this, and on a sale
--       where nobody chose.
ALTER TABLE "pos"."sale" ADD COLUMN "guest_language" text;--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_guest_language_check" CHECK ("pos"."sale"."guest_language" is null or "pos"."sale"."guest_language" in ('en','zh','th','ru','fr'));