-- SCRUM-861 (drop-off bands on their own printer) - expand-only: two CHECK
-- swaps that only WIDEN a list. No row is written and no column changes.
--
--   core.station_device.role   + dropoff_band
--       the third band printer a station can carry, beside kids_band and
--       adult_band: the one loaded with the stock a dropped-off child wears.
--       Assigned in the Console's station form like the other two; a station
--       with none prints its drop-off bands on the kids band printer as
--       before.
--   edge.print_job.role        + dropoff_band
--       the role a job records when it was routed to that printer.
--
-- TO REVERSE (the CHECK restores fail while a row uses the widened value -
-- clear the dropoff_band assignments in the Console, or delete their
-- station_device rows, and update print_job rows with role = 'dropoff_band'
-- to 'kids_band' first): re-add the two swapped CHECKs with the lists of
-- 0009_fleet (station_device_role_check) and 0011_print_and_staff_tokens
-- (print_job_role_check).
ALTER TABLE "core"."station_device" DROP CONSTRAINT "station_device_role_check";--> statement-breakpoint
ALTER TABLE "edge"."print_job" DROP CONSTRAINT "print_job_role_check";--> statement-breakpoint
ALTER TABLE "core"."station_device" ADD CONSTRAINT "station_device_role_check" CHECK ("core"."station_device"."role" in ('receipt','kids_band','adult_band','dropoff_band','kitchen','bar','scanner','card_terminal','qr_terminal','gate','cash_drawer'));--> statement-breakpoint
ALTER TABLE "edge"."print_job" ADD CONSTRAINT "print_job_role_check" CHECK ("edge"."print_job"."role" is null or "edge"."print_job"."role" in ('receipt','kids_band','adult_band','dropoff_band','kitchen','bar','scanner','card_terminal','qr_terminal','gate','cash_drawer'));