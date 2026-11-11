-- SCRUM-862 (a waiting drop-off or nanny booking can be cancelled at the till)
-- - expand-only: three nullable columns, one index, one FK and two CHECK swaps
-- that only WIDEN a list. No row is written or changed here.
--
--   pos.checkin.status
--       + cancelled: a waiting (registered, unpaid, not checked-in) stay that
--         staff cancelled. The row, its registration and the signed consent
--         stay; the stay is never on a sale, a board or the till's waiting
--         picker again.
--   pos.checkin.cancelled_at, cancelled_by_account_id, cancel_reason
--       when, by whom (core.account, soft FK on delete restrict) and the
--       reason the counter gave, beside the audit row that holds before/after.
--   checkin_in_park_check
--       a cancelled stay has no checked_in_at, like a registered one.
--   checkin_cancelled_check
--       a cancelled stay always says when.
--
-- NUMBERED PROVISIONALLY as 0116 on top of 0115_party_deposit_request; the
-- lander renumbers if another lane took 0116 first.
--
-- TO REVERSE (the CHECK restore fails while a row is cancelled - set those rows'
-- status back to 'registered' first, or delete them): drop constraint
-- checkin_cancelled_check, checkin_status_check and checkin_in_park_check; drop
-- index checkin_cancelled_by_idx and constraint
-- checkin_cancelled_by_account_id_account_id_fk; drop the three columns; then
-- re-add checkin_status_check as status in ('registered','in_park','out') and
-- checkin_in_park_check as status = 'registered' or checked_in_at is not null.
ALTER TABLE "pos"."checkin" DROP CONSTRAINT "checkin_status_check";--> statement-breakpoint
ALTER TABLE "pos"."checkin" DROP CONSTRAINT "checkin_in_park_check";--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD COLUMN "cancelled_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_cancelled_by_account_id_account_id_fk" FOREIGN KEY ("cancelled_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkin_cancelled_by_idx" ON "pos"."checkin" USING btree ("cancelled_by_account_id");--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_cancelled_check" CHECK ("pos"."checkin"."status" <> 'cancelled' or "pos"."checkin"."cancelled_at" is not null);--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_status_check" CHECK ("pos"."checkin"."status" in ('registered','in_park','out','cancelled'));--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_in_park_check" CHECK ("pos"."checkin"."status" in ('registered','cancelled') or "pos"."checkin"."checked_in_at" is not null);