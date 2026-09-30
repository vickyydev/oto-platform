-- S2-12 round 2 (plan docs/progress/plans/arrival/PLAN.md §2.5) — the gate
-- box's journal on pos.band_event.
--
-- entry / exit: a passage the board reported, credited to the band whose open
-- preceded it. denied: the reader was told not to open, reason in detail.
-- timeout: the lane opened and nobody passed. alarm: reverse or tailgating
-- after an open, crediting nobody.
--
-- The check constraint is widened; no data is rewritten.

ALTER TABLE "pos"."band_event" DROP CONSTRAINT "band_event_kind_check";--> statement-breakpoint
ALTER TABLE "pos"."band_event" ADD CONSTRAINT "band_event_kind_check" CHECK ("pos"."band_event"."kind" in ('minted','reprinted','replaced','revoked','scanned','entry','exit','denied','timeout','alarm'));