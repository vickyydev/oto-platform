-- Migration: Add expanded fields to camp_registrations
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS allergies text;
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS food_restrictions text;
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS behavioral_notes text;
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS special_notes text;
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS primary_language text;
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS child_photo_url text;
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS parent_photo_url text;
