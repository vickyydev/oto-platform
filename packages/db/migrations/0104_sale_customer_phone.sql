-- SCRUM-762 (the phone number asked once, at the start, for the child's
-- safety) - expand-only: one nullable column, which PostgreSQL adds without
-- rewriting the table, and its E.164 check (SCRUM-292's rule for every phone
-- column), which every existing row passes because each is null. A release
-- that does not know the column never reads it.
--
--   pos.sale.customer_phone   text, null
--       the number the family gave at the counter, E.164, printed on the
--       child's band when an adult stays. Null on every sale before this.
ALTER TABLE "pos"."sale" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_customer_phone_check" CHECK ("pos"."sale"."customer_phone" is null or "pos"."sale"."customer_phone" ~ '^\+[1-9][0-9]{6,14}$');