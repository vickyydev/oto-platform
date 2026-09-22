import { eq } from 'drizzle-orm';
import { role, roleAssignment, rolePermission, type Db } from '@oto/db';
import type { Permission, ScopeType } from '@oto/shared';

/**
 * Scoped permission engine (SCRUM-13, CLAUDE.md §3).
 * Effective permissions are the UNION across all role assignments, each grant
 * carrying its assignment's scope. A grant covers a target when:
 *   operator scope   → scopeId is the target operator (null = platform-wide)
 *   branch scope     → the target names that branch
 *   department scope → the target names that department
 *   record scope     → the target names that record
 */
export interface EffectivePermission {
  permission: Permission;
  scopeType: ScopeType;
  scopeId: string | null;
  roleName: string;
}

export interface ScopeTarget {
  operatorId: string;
  branchId?: string;
  departmentId?: string;
  recordId?: string;
}

export async function resolveEffectivePermissions(
  db: Db,
  accountId: string,
): Promise<EffectivePermission[]> {
  const rows = await db
    .select({
      permission: rolePermission.permission,
      scopeType: roleAssignment.scopeType,
      scopeId: roleAssignment.scopeId,
      roleName: role.name,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(roleAssignment.roleId, role.id))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(eq(roleAssignment.accountId, accountId));
  return rows as EffectivePermission[];
}

/**
 * Does one grant cover one target? A pure comparison of ids, and it reads only
 * the ids it is given.
 *
 * In particular (SCRUM-248): an operator-scoped grant matches on the operator
 * and ignores `target.branchId` entirely — it cannot look up which operator a
 * branch belongs to, so it says yes to a branch id belonging to somebody else.
 * A route whose branch comes out of the URL therefore has to LOAD that branch
 * scoped to the caller's operator; passing the guard is not that check.
 */
export function grantCovers(grant: EffectivePermission, target: ScopeTarget): boolean {
  switch (grant.scopeType) {
    case 'operator':
      return grant.scopeId === null || grant.scopeId === target.operatorId;
    case 'branch':
      return target.branchId !== undefined && grant.scopeId === target.branchId;
    case 'department':
      return target.departmentId !== undefined && grant.scopeId === target.departmentId;
    case 'record':
      return target.recordId !== undefined && grant.scopeId === target.recordId;
  }
}

export function hasPermission(
  effective: EffectivePermission[],
  permission: Permission,
  target: ScopeTarget,
): boolean {
  return effective.some((g) => g.permission === permission && grantCovers(g, target));
}

/** True when any assignment is platform-wide (operator scope, null id). */
export function isPlatformWide(effective: EffectivePermission[]): boolean {
  return effective.some((g) => g.scopeType === 'operator' && g.scopeId === null);
}
