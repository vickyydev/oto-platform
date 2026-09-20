-- Migration: BEO Kids Set Menu feature
-- Adds set_menu_enabled/set_menu_template_id to beo_kitchen_plans,
-- and creates beo_set_menu_templates + beo_set_menu_selections tables.
--
-- For production: Run this SQL before deploying the new code, or use `npm run db:push`.

ALTER TABLE beo_kitchen_plans ADD COLUMN IF NOT EXISTS set_menu_enabled boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE beo_kitchen_plans ADD COLUMN IF NOT EXISTS set_menu_template_id uuid;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS beo_set_menu_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_set_menu_templates_tenant ON beo_set_menu_templates(tenant_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS beo_set_menu_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES beo_set_menu_templates(id),
  token text NOT NULL UNIQUE,
  is_submitted boolean NOT NULL DEFAULT false,
  submitted_at timestamp,
  selections jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_set_menu_selections_event ON beo_set_menu_selections(event_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_set_menu_selections_token ON beo_set_menu_selections(token);
