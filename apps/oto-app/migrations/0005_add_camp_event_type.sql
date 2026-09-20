-- Migration: Add 'camp' value to core_event_type enum
-- Camp events are calendar-only; they appear in the calendar view
-- with a teal color but are hidden from Kanban and List views.

ALTER TYPE core_event_type ADD VALUE IF NOT EXISTS 'camp';
