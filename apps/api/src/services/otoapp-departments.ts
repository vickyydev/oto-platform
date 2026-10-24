import { sql } from 'drizzle-orm';
import { OtoAppSeamNotGrantedError } from './otoapp-events';
import type { Exec } from './tx';

export interface AppDepartment {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  updatedAt: Date;
}

export interface AppDepartmentBranch {
  departmentId: string;
  tenantId: string;
  otoappBranchId: string;
  branchId: string | null;
}

export interface AppEmployeeDepartment {
  id: string;
  tenantId: string;
  otoappBranchId: string | null;
  branchId: string | null;
  primaryDepartmentId: string | null;
}

export interface AppDepartmentSnapshot {
  departments: AppDepartment[];
  branches: AppDepartmentBranch[];
  members: AppEmployeeDepartment[];
}

const VIEWS = [
  'otoapp_v.departments',
  'otoapp_v.department_branches',
  'otoapp_v.employee_departments',
] as const;

/** Absence is not a ready source; missing privileges are a deployment fault. */
export async function otoAppDepartmentsInstalled(exec: Exec): Promise<boolean> {
  const schema = await exec.execute<{ usage: boolean | null }>(
    sql`select has_schema_privilege(to_regnamespace('otoapp_v')::oid, 'USAGE') as usage`,
  );
  const usage = schema.rows[0]?.usage ?? null;
  if (usage === null) return false;
  if (!usage) throw new OtoAppSeamNotGrantedError(['USAGE on schema otoapp_v']);

  const views = await exec.execute<{ readable: Array<boolean | null> }>(sql`
    select array[${sql.join(
      VIEWS.map(view => sql`has_table_privilege(to_regclass(${view})::oid, 'SELECT')`),
      sql`, `,
    )}] as readable`);
  const readable = views.rows[0]?.readable ?? [];
  const denied = VIEWS.filter((_, index) => readable[index] === false);
  if (denied.length) throw new OtoAppSeamNotGrantedError(denied.map(view => `SELECT on ${view}`));
  return VIEWS.every((_, index) => readable[index] === true);
}

interface SnapshotRow extends Record<string, unknown> {
  departments: Array<{
    id: string;
    tenant_id: string;
    name: string;
    is_active: boolean;
    updated_at: string;
  }>;
  branches: Array<{
    department_id: string;
    tenant_id: string;
    otoapp_branch_id: string;
    branch_id: string | null;
  }>;
  members: Array<{
    id: string;
    tenant_id: string;
    otoapp_branch_id: string | null;
    branch_id: string | null;
    primary_department_id: string | null;
  }>;
}

/**
 * One statement reads the three collections at the same PostgreSQL snapshot.
 * All tenants and raw source references remain visible to the copy's anchor
 * and ownership checks. A null mapped branch is never made operator-wide here.
 */
export async function readAppDepartmentSnapshot(exec: Exec): Promise<AppDepartmentSnapshot | null> {
  if (!(await otoAppDepartmentsInstalled(exec))) return null;
  const result = await exec.execute<SnapshotRow>(sql`
    select
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'tenant_id', tenant_id::text, 'name', name,
          'is_active', is_active, 'updated_at', updated_at
        ) order by id)
        from otoapp_v.departments
      ), '[]'::jsonb) as departments,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'department_id', department_id, 'tenant_id', tenant_id::text,
          'otoapp_branch_id', otoapp_branch_id, 'branch_id', branch_id::text
        ) order by department_id, otoapp_branch_id)
        from otoapp_v.department_branches
      ), '[]'::jsonb) as branches,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'tenant_id', tenant_id::text, 'otoapp_branch_id', otoapp_branch_id,
          'branch_id', branch_id::text, 'primary_department_id', primary_department_id
        ) order by id)
        from otoapp_v.employee_departments
      ), '[]'::jsonb) as members`);
  const row = result.rows[0];
  if (!row) throw new Error('The OTO App department metadata snapshot was not returned.');
  return {
    departments: row.departments.map(department => ({
      id: department.id,
      tenantId: department.tenant_id,
      name: department.name,
      isActive: department.is_active,
      updatedAt: new Date(department.updated_at),
    })),
    branches: row.branches.map(branch => ({
      departmentId: branch.department_id,
      tenantId: branch.tenant_id,
      otoappBranchId: branch.otoapp_branch_id,
      branchId: branch.branch_id,
    })),
    members: row.members.map(member => ({
      id: member.id,
      tenantId: member.tenant_id,
      otoappBranchId: member.otoapp_branch_id,
      branchId: member.branch_id,
      primaryDepartmentId: member.primary_department_id,
    })),
  };
}
