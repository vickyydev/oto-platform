import { and, count, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { branch, department, employee, type Db } from '@oto/db';
import { branchReach } from './access-control';
import type { EffectivePermission } from './permissions';

interface DepartmentReader {
  operatorId: string;
  effective: EffectivePermission[];
}

export interface DepartmentSummary {
  id: string;
  name: string;
  branch: { id: string; name: string } | null;
  memberCount: number;
}

/** Current core records only; the department mirror and its copy job are separate work. */
export async function listDepartments(db: Db, reader: DepartmentReader, query: { q?: string }) {
  const reach = branchReach(reader.effective, 'admin:account:read', reader.operatorId);
  if (reach.kind === 'branches' && reach.branchIds.length === 0) return { departments: [] as DepartmentSummary[] };
  const rows = await db.select({ team: department, park: branch })
    .from(department)
    .leftJoin(branch, and(eq(branch.id, department.branchId), eq(branch.operatorId, reader.operatorId)))
    .where(and(eq(department.operatorId, reader.operatorId), reach.kind === 'branches'
      ? inArray(branch.id, reach.branchIds)
      : or(isNull(department.branchId), isNotNull(branch.id))));
  const q = query.q?.trim().toLowerCase();
  const visible = rows.filter(({ team, park }) => !q || team.name.toLowerCase().includes(q) || park?.name.toLowerCase().includes(q));
  if (visible.length === 0) return { departments: [] as DepartmentSummary[] };

  // Like the original department list, archived employees still count. Each
  // employee must independently be in reach; accounts and roles add no members.
  const members = await db.select({ departmentId: employee.departmentId, memberCount: count() })
    .from(employee)
    .leftJoin(branch, and(eq(branch.id, employee.branchId), eq(branch.operatorId, reader.operatorId)))
    .where(and(eq(employee.operatorId, reader.operatorId), inArray(employee.departmentId, visible.map(row => row.team.id)),
      reach.kind === 'branches' ? inArray(branch.id, reach.branchIds)
        : or(isNull(employee.branchId), isNotNull(branch.id))))
    .groupBy(employee.departmentId);
  const memberCounts = new Map(members.map(row => [row.departmentId, row.memberCount]));
  const departments: DepartmentSummary[] = visible.map(({ team, park }) => ({
    id: team.id, name: team.name, branch: park ? { id: park.id, name: park.name } : null,
    memberCount: memberCounts.get(team.id) ?? 0,
  })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { departments };
}
