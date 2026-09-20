-- Migration: Add missing BEO tables
-- Creates all core BEO sub-tables and supporting structures that were not covered
-- by earlier migration files. Uses IF NOT EXISTS / DO-EXCEPTION guards so this
-- migration is safe to run against a database that already has some or all of
-- these tables (e.g. applied previously via drizzle-kit push).

-- ============================================================
-- ENUM TYPES
-- ============================================================

DO $$ BEGIN
  CREATE TYPE beo_assignment_mode AS ENUM ('INDIVIDUAL', 'ROLE', 'DEPARTMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_host_responsibility AS ENUM (
    'GUEST_COORDINATION', 'TIMELINE_ADHERENCE',
    'PARENT_COMMUNICATION', 'ISSUE_ESCALATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_entertainment_type AS ENUM (
    'MASCOT', 'FACE_PAINT', 'GAME_LEADER', 'EXTERNAL_PERFORMER', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_entertainment_assignment_mode AS ENUM (
    'INDIVIDUAL', 'ROLE', 'EXTERNAL_VENDOR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_setup_item AS ENUM (
    'BALLOONS', 'BACKDROP', 'TABLE_LAYOUT', 'CAKE_TABLE',
    'SIGNAGE', 'DECORATIONS', 'PARTY_SUPPLIES', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_dietary_tag AS ENUM (
    'VEG', 'VEGAN', 'HALAL', 'NO_PORK', 'NUT_ALLERGY',
    'DAIRY_FREE', 'GLUTEN_FREE', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_cake_mode AS ENUM ('INTERNAL', 'EXTERNAL', 'NONE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_deposit_payment_method AS ENUM (
    'CASH', 'CARD', 'TRANSFER', 'QR_PAYMENT', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_timeline_assigned_to_type AS ENUM (
    'PARTY_HOST', 'SETUP_RESPONSIBLE', 'KITCHEN_RESPONSIBLE',
    'ENTERTAINMENT', 'SPECIFIC_USER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_setup_charge_mode AS ENUM ('included', 'per_item', 'total');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE beo_assignment_target_type AS ENUM ('DEPARTMENT', 'ROLE', 'USER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE event_line_item_category AS ENUM (
    'ENTERTAINMENT', 'FOOD', 'SERVICE', 'ADD_ON', 'PACKAGE', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE event_line_item_source_type AS ENUM (
    'manual', 'setup', 'package', 'food', 'addon', 'entertainment', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- ============================================================
-- BEO LOCATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id varchar NOT NULL REFERENCES branches(id),
  branch_ids text[] DEFAULT '{}',
  name text NOT NULL,
  capacity integer,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_locations_tenant ON beo_locations(tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_locations_branch ON beo_locations(branch_id);
--> statement-breakpoint

-- ============================================================
-- BEO ENTERTAINMENT OPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_entertainment_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  default_duration_minutes integer,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_entertainment_options_tenant ON beo_entertainment_options(tenant_id);
--> statement-breakpoint

-- ============================================================
-- BEO SETUP ITEM OPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_setup_item_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  category text,
  notes text,
  default_cost integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_setup_item_options_tenant ON beo_setup_item_options(tenant_id);
--> statement-breakpoint

-- ============================================================
-- BEO ASSIGNMENT TARGETS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_assignment_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  target_type beo_assignment_target_type NOT NULL,
  department_id varchar REFERENCES departments(id),
  role_id varchar REFERENCES roles(id),
  user_id varchar REFERENCES users(id),
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_assignment_targets_tenant ON beo_assignment_targets(tenant_id);
--> statement-breakpoint

-- ============================================================
-- BEO SETUP ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_setup_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES core_events(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  category text,
  assignment_target_id uuid REFERENCES beo_assignment_targets(id),
  deadline_offset_minutes integer,
  notes text,
  price_amount integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_setup_items_event ON beo_setup_items(event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_setup_items_tenant ON beo_setup_items(tenant_id);
--> statement-breakpoint

-- ============================================================
-- BEO ENTERTAINMENT ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_entertainment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES core_events(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entertainment_option_id uuid REFERENCES beo_entertainment_options(id),
  custom_name text,
  assignment_target_id uuid REFERENCES beo_assignment_targets(id),
  duration_minutes integer,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_entertainment_items_event ON beo_entertainment_items(event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_entertainment_items_tenant ON beo_entertainment_items(tenant_id);
--> statement-breakpoint

-- ============================================================
-- BEO PARTY HOST ASSIGNMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_party_host_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  assignment_mode beo_assignment_mode NOT NULL DEFAULT 'INDIVIDUAL',
  assigned_user_id varchar REFERENCES users(id),
  assigned_role_id varchar REFERENCES roles(id),
  resolved_user_id varchar REFERENCES users(id),
  resolved_at timestamp,
  backup_user_id varchar REFERENCES users(id),
  assigned_employee_id varchar REFERENCES employees(id),
  backup_employee_id varchar REFERENCES employees(id),
  responsibilities text[],
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_party_host_event ON beo_party_host_assignments(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO ENTERTAINMENT ASSIGNMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_entertainment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  entertainment_required boolean NOT NULL DEFAULT false,
  entertainment_type beo_entertainment_type,
  assignment_mode beo_entertainment_assignment_mode,
  assigned_user_id varchar REFERENCES users(id),
  assigned_role_id varchar REFERENCES roles(id),
  vendor_name text,
  vendor_contact text,
  resolved_user_id varchar REFERENCES users(id),
  resolved_at timestamp,
  requirements_notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_entertainment_event ON beo_entertainment_assignments(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO SETUP PLANS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_setup_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  setup_required boolean NOT NULL DEFAULT true,
  setup_items text[],
  setup_notes text,
  setup_responsible_mode beo_assignment_mode,
  setup_responsible_user_id varchar REFERENCES users(id),
  setup_responsible_role_id varchar REFERENCES roles(id),
  setup_responsible_department_id varchar REFERENCES departments(id),
  setup_deadline_offset_minutes integer NOT NULL DEFAULT 30,
  setup_resolved_user_id varchar REFERENCES users(id),
  setup_resolved_at timestamp,
  setup_charge_mode beo_setup_charge_mode DEFAULT 'included',
  setup_total_price integer,
  setup_tasks jsonb DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_setup_plans_event ON beo_setup_plans(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO KITCHEN PLANS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_kitchen_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  food_required boolean NOT NULL DEFAULT true,
  food_package_id text,
  food_package_name text,
  dietary_tags text[],
  dietary_notes text,
  cake_mode beo_cake_mode DEFAULT 'NONE',
  cake_quantity integer NOT NULL DEFAULT 1,
  own_cake_charge integer,
  cake_time text,
  cake_notes text,
  kitchen_ready_offset_minutes integer NOT NULL DEFAULT 20,
  kitchen_responsible_type text,
  kitchen_responsible_id text,
  kitchen_responsible_mode beo_assignment_mode,
  kitchen_responsible_user_id varchar REFERENCES users(id),
  kitchen_responsible_role_id varchar REFERENCES roles(id),
  kitchen_resolved_user_id varchar REFERENCES users(id),
  kitchen_resolved_at timestamp,
  kitchen_notes text,
  service_schedule jsonb,
  menus jsonb,
  set_menu_enabled boolean NOT NULL DEFAULT false,
  set_menu_template_id uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_kitchen_plans_event ON beo_kitchen_plans(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO BAR PLANS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_bar_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  service_time text,
  items jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_bar_plans_event ON beo_bar_plans(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO EVENT BILLING
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_event_billing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  package_price integer,
  add_ons jsonb,
  total_calculated integer,
  deposit_required boolean NOT NULL DEFAULT false,
  deposit_amount integer,
  deposit_paid boolean NOT NULL DEFAULT false,
  deposit_paid_amount integer,
  deposit_payment_method beo_deposit_payment_method,
  deposit_paid_at timestamp,
  pos_order_ref text,
  billing_notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_event_billing_event ON beo_event_billing(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO TIMELINE ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_timeline_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES core_events(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  offset_from_start_minutes integer NOT NULL DEFAULT 0,
  assigned_to_type beo_timeline_assigned_to_type NOT NULL DEFAULT 'PARTY_HOST',
  assigned_user_id varchar REFERENCES users(id),
  is_system_generated boolean NOT NULL DEFAULT false,
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamp,
  completed_by_user_id varchar REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_timeline_items_event ON beo_timeline_items(event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_timeline_items_sort ON beo_timeline_items(event_id, sort_order);
--> statement-breakpoint

-- ============================================================
-- EVENT LINE ITEM TEMPLATES
-- ============================================================

CREATE TABLE IF NOT EXISTS event_line_item_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  default_unit_price_inc_vat integer NOT NULL DEFAULT 0,
  default_qty integer NOT NULL DEFAULT 1,
  category event_line_item_category NOT NULL DEFAULT 'OTHER',
  is_included_by_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  description text,
  internal_note text,
  created_by_user_id varchar REFERENCES users(id),
  updated_by_user_id varchar REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_line_item_templates_tenant ON event_line_item_templates(tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_line_item_templates_category ON event_line_item_templates(category);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_line_item_templates_active ON event_line_item_templates(is_active);
--> statement-breakpoint

-- ============================================================
-- EVENT LINE ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS event_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES core_events(id) ON DELETE CASCADE,
  template_id uuid REFERENCES event_line_item_templates(id) ON DELETE SET NULL,
  name text NOT NULL,
  category event_line_item_category NOT NULL DEFAULT 'OTHER',
  qty integer NOT NULL DEFAULT 1,
  unit_price_inc_vat integer NOT NULL DEFAULT 0,
  is_included boolean NOT NULL DEFAULT false,
  is_manual boolean NOT NULL DEFAULT false,
  auto_generated boolean NOT NULL DEFAULT false,
  source_type event_line_item_source_type DEFAULT 'manual',
  source_id text,
  notes text,
  override_reason text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by_user_id varchar REFERENCES users(id),
  updated_by_user_id varchar REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_line_items_event ON event_line_items(event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_line_items_template ON event_line_items(template_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_line_items_sort ON event_line_items(event_id, sort_order);
--> statement-breakpoint

-- ============================================================
-- BEO PACKAGE SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_package_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES core_events(id) ON DELETE CASCADE,
  template_id uuid REFERENCES birthday_package_templates(id) ON DELETE SET NULL,
  template_name_at_apply text,
  template_updated_at_at_apply timestamp,
  applied_at timestamp NOT NULL DEFAULT now(),
  package_name text NOT NULL,
  base_price integer NOT NULL DEFAULT 0,
  included_summary text,
  excluded_summary text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_package_snapshots_event ON beo_package_snapshots(event_id);
--> statement-breakpoint

-- ============================================================
-- BEO PACKAGE SNAPSHOT ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_package_snapshot_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES beo_package_snapshots(id) ON DELETE CASCADE,
  source_template_line_item_id uuid REFERENCES package_line_item_templates(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'other',
  label text NOT NULL,
  description text,
  qty integer NOT NULL DEFAULT 1,
  unit_label text,
  included boolean NOT NULL DEFAULT true,
  unit_price integer NOT NULL DEFAULT 0,
  billable boolean NOT NULL DEFAULT true,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_package_snapshot_items_snapshot ON beo_package_snapshot_items(snapshot_id);
--> statement-breakpoint

-- ============================================================
-- BEO ENTERTAINMENT SELECTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS beo_entertainment_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES core_events(id) ON DELETE CASCADE,
  template_id uuid REFERENCES entertainment_package_templates(id) ON DELETE SET NULL,
  template_name_at_apply text,
  template_updated_at_at_apply timestamp,
  name text NOT NULL,
  description text,
  duration_minutes integer,
  price integer NOT NULL DEFAULT 0,
  billable boolean NOT NULL DEFAULT true,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_beo_entertainment_selections_event ON beo_entertainment_selections(event_id);
