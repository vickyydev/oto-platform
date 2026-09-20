ALTER TABLE "camp_registrations"
  ADD COLUMN IF NOT EXISTS "is_one_time" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "added_by_manager" boolean NOT NULL DEFAULT false;
