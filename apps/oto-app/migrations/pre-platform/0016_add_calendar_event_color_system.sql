-- This file is the single production-safe reconciliation path used by both the
-- deployed start command and the development post-merge hook. It is intentionally
-- idempotent: valid unique assignments remain unchanged, while missing, malformed,
-- semantically reserved, and same-tenant duplicate colors are repaired.
BEGIN;

ALTER TABLE branches ADD COLUMN IF NOT EXISTS calendar_color text;
ALTER TYPE core_event_type ADD VALUE IF NOT EXISTS 'workshop';

CREATE TEMP TABLE birthday_branch_colors_in_use (
  tenant_id uuid NOT NULL,
  calendar_color text NOT NULL,
  PRIMARY KEY (tenant_id, calendar_color)
) ON COMMIT DROP;

DO $$
DECLARE
  tenant_record RECORD;
  branch_record RECORD;
  current_color text;
  expected_named_color text;
  available_color text;
  candidate_color text;
  candidate_index integer;
BEGIN
  FOR tenant_record IN
    SELECT DISTINCT tenant_id
    FROM branches
    ORDER BY tenant_id
  LOOP
    -- Lock before reading this tenant's branches. Live branch creation uses the
    -- same lock, so the reconciliation snapshot cannot miss a concurrent insert.
    PERFORM pg_advisory_xact_lock(hashtextextended(tenant_record.tenant_id::text, 0));

    FOR branch_record IN
      SELECT id, tenant_id, name, calendar_color
      FROM branches
      WHERE tenant_id = tenant_record.tenant_id
      ORDER BY created_at, id
    LOOP
      current_color := lower(branch_record.calendar_color);
      expected_named_color := CASE
        WHEN lower(branch_record.name) LIKE '%chalong%' THEN '#ef4444'
        WHEN lower(branch_record.name) LIKE '%robinson%' THEN '#8b5cf6'
        ELSE NULL
      END;

      IF current_color ~ '^#[0-9a-f]{6}$'
        AND current_color NOT IN (
          '#10b981', '#f97316',
          '#6366f1', '#d946ef', '#0ea5e9', '#84cc16', '#f59e0b', '#64748b'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM birthday_branch_colors_in_use used
          WHERE used.tenant_id = branch_record.tenant_id
            AND used.calendar_color = current_color
        )
      THEN
        INSERT INTO birthday_branch_colors_in_use (tenant_id, calendar_color)
        VALUES (branch_record.tenant_id, current_color);
        CONTINUE;
      END IF;

      -- Prefer the named color when it is still available in this tenant.
      available_color := NULL;
      IF expected_named_color IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM birthday_branch_colors_in_use used
        WHERE used.tenant_id = branch_record.tenant_id
          AND used.calendar_color = expected_named_color
      ) THEN
        available_color := expected_named_color;
      END IF;

      -- Generic branches use the non-named birthday palette first.
      IF available_color IS NULL THEN
        SELECT color INTO available_color
        FROM unnest(ARRAY['#3b82f6', '#ec4899', '#06b6d4', '#eab308']) AS color
        WHERE NOT EXISTS (
          SELECT 1
          FROM birthday_branch_colors_in_use used
          WHERE used.tenant_id = branch_record.tenant_id
            AND used.calendar_color = color
        )
        LIMIT 1;
      END IF;

      IF available_color IS NULL THEN
        candidate_index := 0;
        LOOP
          candidate_color := '#' || lower(substr(md5(branch_record.id::text || ':' || candidate_index::text), 1, 6));
          EXIT WHEN candidate_color NOT IN (
            '#ef4444', '#8b5cf6', '#3b82f6', '#ec4899', '#06b6d4', '#eab308',
            '#10b981', '#f97316',
            '#6366f1', '#d946ef', '#0ea5e9', '#84cc16', '#f59e0b', '#64748b'
          ) AND NOT EXISTS (
            SELECT 1
            FROM birthday_branch_colors_in_use used
            WHERE used.tenant_id = branch_record.tenant_id
              AND used.calendar_color = candidate_color
          );
          candidate_index := candidate_index + 1;
        END LOOP;
        available_color := candidate_color;
      END IF;

      UPDATE branches
      SET calendar_color = available_color
      WHERE id = branch_record.id;

      INSERT INTO birthday_branch_colors_in_use (tenant_id, calendar_color)
      VALUES (branch_record.tenant_id, available_color);
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_calendar_color_unique
  ON branches (tenant_id, lower(calendar_color))
  WHERE calendar_color IS NOT NULL;

COMMIT;