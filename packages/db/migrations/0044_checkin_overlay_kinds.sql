-- S2-13 round 4 (plan docs/progress/plans/checkin/PLAN.md §2.5) — check-in
-- on the box lane. A counter box keeps what it recorded offline in
-- edge.box_overlay until the platform has it: members, children and visits
-- since 0035, and now the check-in domain's four — a registration, a stay
-- (pos.checkin), a person on a pickup list (crm.guardian) and a release
-- (pos.release). For those, member_id carries the registration's id so one
-- family's rows are listed together, and phone is null.
--
-- The check constraint is widened; no data is rewritten. A Raspberry Pi's
-- SQLite twin is rebuilt by the agent at boot (`widenSqliteOverlayKinds`).
--
-- Undo: delete the rows of the four new kinds, then put the old check back.

ALTER TABLE "edge"."box_overlay" DROP CONSTRAINT "box_overlay_kind_check";--> statement-breakpoint
ALTER TABLE "edge"."box_overlay" ADD CONSTRAINT "box_overlay_kind_check" CHECK ("edge"."box_overlay"."kind" in ('member','child','visit','registration','checkin','guardian','release'));
