-- SCRUM-494 (consistency register) — a walk-in's tier claim with no document expiry.
--
-- The approved design's verify step asks for the proof type only; the
-- document's expiry date is optional for a member and for a visitor who is
-- not a member yet alike. A claim recorded without one never expires, as a
-- member verification with no expiry never does (crm.member_tier_verification
-- has always allowed it).
--
-- Relax-only: pos.sale_tier_claim.evidence_expires_at drops NOT NULL. Every
-- existing row keeps its date.
--
-- Undo (only while no row holds a null):
-- ALTER TABLE "pos"."sale_tier_claim" ALTER COLUMN "evidence_expires_at" SET NOT NULL;

ALTER TABLE "pos"."sale_tier_claim" ALTER COLUMN "evidence_expires_at" DROP NOT NULL;
