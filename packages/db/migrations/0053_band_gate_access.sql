-- SCRUM-494 (consistency register item 4) — each band's Gate access.
--
-- The approved design gives every band a gateAccess flag taken from the ticket
-- package of the line it was issued against: an adult band carries its
-- package's Gate access, a kids band never has it (lib/sale.ts
-- buildPersonGrants; mockApi.ts issueWalkInBands / issueBookingBands). The gate
-- checks that flag, and occupancy counts only bands with it as adults; every
-- band without it follows its group (mockApi.ts getLiveOccupancy).
--
-- Add-only:
--   - pos.band.gate_access boolean NOT NULL DEFAULT false;
--   - band_gate_access_kind_check: a kids band never has it.
-- The bands already issued take the setting of their line's ticket package
-- as it stands now; an adult band whose line names no package stays false.
--
-- Undo: ALTER TABLE "pos"."band" DROP CONSTRAINT "band_gate_access_kind_check";
-- ALTER TABLE "pos"."band" DROP COLUMN "gate_access";

ALTER TABLE "pos"."band" ADD COLUMN "gate_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "pos"."band" AS b
SET "gate_access" = tp."gate_access"
FROM "pos"."sale_line" AS sl
JOIN "pos"."ticket_package" AS tp ON tp."id" = sl."ticket_package_id"
WHERE sl."id" = b."sale_line_id"
  AND b."kind" = 'adult';--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_gate_access_kind_check" CHECK (not "pos"."band"."gate_access" or "pos"."band"."kind" = 'adult');
