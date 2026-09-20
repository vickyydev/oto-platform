-- Migration: Replace theme_name with activities and decoration
-- This migration renames the existing theme_name column to activities (preserving data)
-- and adds a new decoration column.
--
-- For production: Run this SQL before deploying the new code, or use `npm run db:push`.

ALTER TABLE core_events RENAME COLUMN theme_name TO activities;--> statement-breakpoint
ALTER TABLE core_events ADD COLUMN IF NOT EXISTS decoration text;
