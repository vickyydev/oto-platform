-- Migration: Add BEO Timeline suppression tracking and entertainment start time
-- Uses IF NOT EXISTS / DO-EXCEPTION guards so this is safe to re-run.

-- 1. Add source_key to beo_timeline_items (links auto-generated rows back to their source)
DO $$ BEGIN
  ALTER TABLE beo_timeline_items ADD COLUMN source_key text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 2. Add start_time to beo_entertainment_items (drives timeline auto-sync for each entertainment act)
DO $$ BEGIN
  ALTER TABLE beo_entertainment_items ADD COLUMN start_time text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. Add suppressed_timeline_sources to core_events (persists user-deleted auto items so they don't reappear)
DO $$ BEGIN
  ALTER TABLE core_events ADD COLUMN suppressed_timeline_sources text[] DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
