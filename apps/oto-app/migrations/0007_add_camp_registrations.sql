-- Migration: Add camp_registrations table
-- Run: node -e "require('./server/db/migrate.js')" or via the migrate script

CREATE TABLE IF NOT EXISTS camp_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  event_id UUID NOT NULL REFERENCES core_events(id) ON DELETE CASCADE,
  child_full_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  parent_guardian_name TEXT NOT NULL,
  emergency_contact_number TEXT NOT NULL,
  allergies_notes TEXT,
  authorized_pickup_persons TEXT,
  agreed_camp_rules BOOLEAN NOT NULL DEFAULT FALSE,
  agreed_child_healthy BOOLEAN NOT NULL DEFAULT FALSE,
  parent_signature TEXT NOT NULL,
  signature_date TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_camp_registrations_event ON camp_registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_camp_registrations_tenant ON camp_registrations(tenant_id);
