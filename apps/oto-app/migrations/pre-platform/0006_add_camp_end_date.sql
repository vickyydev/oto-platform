-- Migration: Add camp_end_date column to core_events
-- Used by Camp event type to store the last day of the camp (inclusive).

ALTER TABLE core_events ADD COLUMN IF NOT EXISTS camp_end_date text;
