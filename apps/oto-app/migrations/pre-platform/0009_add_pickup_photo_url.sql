-- Migration: Add pickup_photo_url to camp_registrations
ALTER TABLE camp_registrations ADD COLUMN IF NOT EXISTS pickup_photo_url text;
