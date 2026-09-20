-- Migration: Add assigned_department_id to fix_reports
-- Supports department-based auto-assignment for Fix module

ALTER TABLE fix_reports
  ADD COLUMN IF NOT EXISTS assigned_department_id VARCHAR REFERENCES departments(id);

CREATE INDEX IF NOT EXISTS idx_fix_reports_dept ON fix_reports (assigned_department_id);
