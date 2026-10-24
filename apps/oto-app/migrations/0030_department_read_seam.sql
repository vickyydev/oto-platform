-- Department metadata for the platform copy job. The app remains the master.
-- These additive views carry no employee names, contacts or HR values and do
-- not change the existing employee view or grant access to the app's tables.
CREATE VIEW otoapp_v.departments AS
SELECT
  d.id::text AS id,
  d.tenant_id,
  d.name,
  d.is_active,
  d.updated_at
FROM otoapp.departments d;
--> statement-breakpoint

-- Preserve every assignment, even when its branch cannot be mapped. Filtering
-- those rows out would make an assigned department look genuinely unassigned.
CREATE VIEW otoapp_v.department_branches AS
SELECT
  d.id::text AS department_id,
  d.tenant_id,
  a.branch_id::text AS otoapp_branch_id,
  CASE
    WHEN b.core_branch_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN b.core_branch_id::uuid
  END AS branch_id
FROM otoapp.department_branch_assignments a
JOIN otoapp.departments d ON d.id = a.department_id
LEFT JOIN otoapp.branches b ON b.id = a.branch_id AND b.tenant_id = d.tenant_id;
--> statement-breakpoint

-- Keep null and invalid source memberships visible to the repository. The copy
-- validates department tenancy before resolving a core department.
CREATE VIEW otoapp_v.employee_departments AS
SELECT
  e.id::text AS id,
  e.tenant_id,
  e.branch_id::text AS otoapp_branch_id,
  CASE
    WHEN b.core_branch_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN b.core_branch_id::uuid
  END AS branch_id,
  e.primary_department_id::text AS primary_department_id
FROM otoapp.employees e
LEFT JOIN otoapp.branches b ON b.id = e.branch_id AND b.tenant_id = e.tenant_id;
