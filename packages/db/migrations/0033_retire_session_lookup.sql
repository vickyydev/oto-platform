-- The no-reader API 85d35e0 must be live before this forward-only change.
-- Rollback must remain on that revision or later; session identity is retained.
ALTER TABLE "core"."session"
  DROP COLUMN "pending_lookup_phone",
  DROP COLUMN "pending_lookup_at";
