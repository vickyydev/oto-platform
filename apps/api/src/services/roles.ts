import { and, eq, isNull, or } from 'drizzle-orm';
import { account, branch, department, employee, operator, role, roleAssignment, rolePermission, type Db } from '@oto/db';
import { PERMISSIONS, PERMISSION_WORDS, type Permission, type ScopeType } from '@oto/shared/permissions';
import { errors } from '../lib/errors';
import {
  accountScopeFilter, assertAccountInScope, assertDominatesAccount, assertNotLastOperatorAdmin,
  assertRoleDominated, assertScopeOwned, loadRoleForOperator, loadTargetAccount, scopeToTarget,
} from './access-control';
import { hasPermission, resolveEffectivePermissions, type EffectivePermission } from './permissions';

interface Reader {
  operatorId: string;
  effective: EffectivePermission[];
}

export type RolePreviewChange =
  | { accountId: string; operation: 'grant'; roleName: string; scopeType: ScopeType; scopeId: string | null }
  | { accountId: string; operation: 'remove'; assignmentId: string };

const wordsFor = (permission: string): string =>
  PERMISSION_WORDS[permission as Permission] ?? permission;

export async function roleCatalogue(db: Db, operatorId: string) {
  const rows = await db.select().from(role)
    .where(or(isNull(role.operatorId), eq(role.operatorId, operatorId)));
  const permissions = await db.select().from(rolePermission);
  return {
    roles: rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((r) => ({
      id: r.id, name: r.name, description: r.description, system: r.isSystem,
      permissions: permissions.filter((p) => p.roleId === r.id)
        .sort((a, b) => a.permission.localeCompare(b.permission))
        .map((p) => ({ permission: p.permission, words: wordsFor(p.permission) })),
    })),
    permissions: PERMISSIONS.map((permission) => ({ permission, words: wordsFor(permission) })),
  };
}

/** A scope is visible only when the read grant covers that same scope. */
function readsScope(reader: Reader, scope: { scopeType: ScopeType; scopeId: string | null }): boolean {
  if (scope.scopeType === 'operator' && scope.scopeId === null) {
    return reader.effective.some((p) => p.permission === 'admin:role:read' && p.scopeType === 'operator' && p.scopeId === null);
  }
  return hasPermission(reader.effective, 'admin:role:read', scopeToTarget(reader.operatorId, scope));
}

export async function permissionHolders(db: Db, reader: Reader, permission: Permission) {
  const { filter, empty } = accountScopeFilter(reader.effective, reader.operatorId, 'admin:role:read');
  const answer = { permission, words: wordsFor(permission), holders: [] as Array<{
    accountId: string; phone: string; status: typeof account.$inferSelect.status;
    employee: { id: string; name: string } | null;
    assignments: Array<{ id: string; roleName: string; scopeType: ScopeType; scopeId: string | null; scopeName: string }>;
  }> };
  if (empty) return answer;
  const rows = await db.select({ a: account, e: employee, assignment: roleAssignment, roleName: role.name })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .innerJoin(roleAssignment, eq(roleAssignment.accountId, account.id))
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(eq(account.operatorId, reader.operatorId), eq(rolePermission.permission, permission), filter ?? undefined));
  const [parks, departments, operators] = await Promise.all([
    db.select({ id: branch.id, name: branch.name }).from(branch).where(eq(branch.operatorId, reader.operatorId)),
    db.select({ id: department.id, name: department.name }).from(department).where(eq(department.operatorId, reader.operatorId)),
    db.select({ id: operator.id, name: operator.name }).from(operator).where(eq(operator.id, reader.operatorId)),
  ]);
  const parkNames = new Map(parks.map((p) => [p.id, p.name]));
  const departmentNames = new Map(departments.map((d) => [d.id, d.name]));
  for (const row of rows) {
    const assignment = row.assignment;
    if (!readsScope(reader, assignment)) continue;
    let scopeName: string | undefined;
    switch (assignment.scopeType) {
      case 'operator':
        if (assignment.scopeId === null) scopeName = 'Whole platform';
        else if (assignment.scopeId === reader.operatorId) scopeName = operators[0]?.name;
        break;
      case 'branch': scopeName = parkNames.get(assignment.scopeId ?? ''); break;
      case 'department': scopeName = departmentNames.get(assignment.scopeId ?? ''); break;
      // Record grants cannot be assigned: there is no owned record target to resolve.
      case 'record': break;
    }
    if (scopeName === undefined) continue;
    // An assignment discloses the complete role. Apply the same dominance
    // check as its existing grant/remove surface, at this assignment's scope.
    try {
      await assertRoleDominated(db, reader.effective, reader.operatorId, assignment.roleId, assignment);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ROLE_NOT_DOMINATED') continue;
      throw error;
    }
    let holder = answer.holders.find((h) => h.accountId === row.a.id);
    if (!holder) {
      holder = { accountId: row.a.id, phone: row.a.phone, status: row.a.status,
        employee: row.e ? { id: row.e.id, name: row.e.name } : null, assignments: [] };
      answer.holders.push(holder);
    }
    holder.assignments.push({ id: assignment.id, roleName: row.roleName,
      scopeType: assignment.scopeType, scopeId: assignment.scopeId, scopeName });
  }
  answer.holders.sort((a, b) => (a.employee?.name ?? a.phone).localeCompare(b.employee?.name ?? b.phone) || a.accountId.localeCompare(b.accountId));
  for (const holder of answer.holders) holder.assignments.sort((a, b) => a.roleName.localeCompare(b.roleName) || a.id.localeCompare(b.id));
  return answer;
}

type Grant = Pick<EffectivePermission, 'permission' | 'scopeType' | 'scopeId'>;

/** Compare permission reach using the resolver's own covering semantics. */
function covers(grants: Grant[], grant: Grant, operatorId: string): boolean {
  if (grant.scopeType === 'operator' && grant.scopeId === null) {
    return grants.some((g) => g.permission === grant.permission && g.scopeType === 'operator' && g.scopeId === null);
  }
  return hasPermission(grants.map((g) => ({ ...g, roleName: '' })), grant.permission, scopeToTarget(operatorId, grant));
}

/** Remove duplicate and shadowed grants; a wider surviving grant keeps access. */
function canonical(grants: Grant[], operatorId: string): Grant[] {
  const unique = [...new Map(grants.map((g) => [`${g.permission}:${g.scopeType}:${g.scopeId?.toLowerCase() ?? ''}`, {
    permission: g.permission, scopeType: g.scopeType, scopeId: g.scopeId?.toLowerCase() ?? null,
  }])).values()];
  return unique.filter((grant, index) => !covers(unique.filter((_, i) => i !== index), grant, operatorId))
    .sort((a, b) => a.permission.localeCompare(b.permission) || a.scopeType.localeCompare(b.scopeType) || (a.scopeId ?? '').localeCompare(b.scopeId ?? ''));
}

export function effectivePermissionDiff(before: Grant[], after: Grant[], operatorId: string) {
  const canonicalOperatorId = operatorId.toLowerCase();
  const previous = canonical(before, canonicalOperatorId);
  const next = canonical(after, canonicalOperatorId);
  const worded = (grants: Grant[]) => grants.map((g) => ({ ...g, words: wordsFor(g.permission) }));
  return {
    before: worded(previous), after: worded(next),
    added: worded(next.filter((g) => !covers(previous, g, canonicalOperatorId))),
    removed: worded(previous.filter((g) => !covers(next, g, canonicalOperatorId))),
    unchanged: worded(next.filter((g) => covers(previous, g, canonicalOperatorId))),
  };
}

export async function previewRoleChange(db: Db, reader: Reader, change: RolePreviewChange) {
  await loadTargetAccount(db, reader.operatorId, change.accountId);
  // A before/after answer exposes everything the existing permissions read
  // exposes, so keep both its account reach and its dominance check.
  await assertAccountInScope(db, reader.effective, reader.operatorId, change.accountId, 'admin:role:read');
  await assertDominatesAccount(db, reader.effective, reader.operatorId, change.accountId);
  const before = await resolveEffectivePermissions(db, change.accountId);
  let after: EffectivePermission[];
  if (change.operation === 'grant') {
    const grantedRole = await loadRoleForOperator(db, reader.operatorId, change.roleName);
    await assertAccountInScope(db, reader.effective, reader.operatorId, change.accountId, 'admin:role:assign');
    const scope = { scopeType: change.scopeType, scopeId: change.scopeId };
    await assertScopeOwned(db, reader.effective, reader.operatorId, scope);
    await assertRoleDominated(db, reader.effective, reader.operatorId, grantedRole.id, scope);
    const permissions = await db.select({ permission: rolePermission.permission }).from(rolePermission)
      .where(eq(rolePermission.roleId, grantedRole.id));
    after = [...before, ...permissions.map((p) => ({ permission: p.permission as Permission, roleName: grantedRole.name, ...scope }))];
  } else {
    const [assignment] = await db.select().from(roleAssignment).where(eq(roleAssignment.id, change.assignmentId)).limit(1);
    if (!assignment || assignment.accountId !== change.accountId) throw errors.notFound('Assignment not found');
    await assertAccountInScope(db, reader.effective, reader.operatorId, change.accountId, 'admin:role:assign');
    await assertRoleDominated(db, reader.effective, reader.operatorId, assignment.roleId, assignment);
    await assertNotLastOperatorAdmin(db, reader.operatorId, { accountId: change.accountId, assignmentId: assignment.id });
    // Resolve the same role-permission join as the canonical resolver, with
    // only the proposed assignment omitted; removing one role must preserve
    // permission rows supplied by another assignment of the same role.
    const remaining = await db.select({
      assignmentId: roleAssignment.id, permission: rolePermission.permission,
      scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId, roleName: role.name,
    }).from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
      .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
      .where(eq(roleAssignment.accountId, change.accountId));
    after = remaining.filter((r) => r.assignmentId !== assignment.id).map((r) => ({
      permission: r.permission as Permission, scopeType: r.scopeType, scopeId: r.scopeId, roleName: r.roleName,
    }));
  }
  return { accountId: change.accountId, operation: change.operation, ...effectivePermissionDiff(before, after, reader.operatorId) };
}
