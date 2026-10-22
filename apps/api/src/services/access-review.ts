import { and, eq, inArray, isNotNull, isNull, max, notExists, or } from 'drizzle-orm';
import { account, auditLog, branch, employee, role, roleAssignment, type Db } from '@oto/db';
import { accountScopeFilter, assertRoleDominated, branchReach, reachCovers, scopeToTarget } from './access-control';
import { hasPermission, type EffectivePermission } from './permissions';

interface Reader { operatorId: string; effective: EffectivePermission[] }
export interface ReviewAccount {
  id: string;
  phone: string;
  status: typeof account.$inferSelect.status;
  employee: { id: string; name: string } | null;
  lastSignInAt: string | null;
  mustChangePassword: boolean;
}
export interface ReviewHolder extends ReviewAccount {
  assignments: Array<{ id: string; roleName: string; scopeId: string | null }>;
}
export interface ReviewEmployee {
  id: string;
  name: string;
  nickname: string | null;
  source: typeof employee.$inferSelect.source;
  archivedAt: string | null;
  branch: { id: string; name: string } | null;
}
export interface AccessReview {
  operatorWideHolders: ReviewHolder[];
  platformWideHolders: ReviewHolder[];
  accountsWithoutEmployee: ReviewAccount[];
  employeesWithoutAccount: ReviewEmployee[];
  accountsNeverSignedIn: ReviewAccount[];
  temporaryPasswordsOutstanding: ReviewAccount[];
}

const accountOrder = (a: ReviewAccount, b: ReviewAccount) =>
  (a.employee?.name ?? a.phone).localeCompare(b.employee?.name ?? b.phone) || a.id.localeCompare(b.id);

/** Six current core-data reviews; absence is a link fact, not a visible projection. */
export async function readAccessReview(db: Db, reader: Reader): Promise<AccessReview> {
  const result: AccessReview = { operatorWideHolders: [], platformWideHolders: [], accountsWithoutEmployee: [],
    employeesWithoutAccount: [], accountsNeverSignedIn: [], temporaryPasswordsOutstanding: [] };
  const reach = branchReach(reader.effective, 'admin:role:read', reader.operatorId);
  const { filter, empty } = accountScopeFilter(reader.effective, reader.operatorId, 'admin:role:read');
  if (empty) return result;
  // The owned employee join also establishes link existence. Its park/reach
  // controls projection only: a hidden or malformed park never erases a link.
  const accounts = await db.select({ id: account.id, phone: account.phone, status: account.status,
    mustChangePassword: account.mustChangePassword,
    person: { id: employee.id, name: employee.name, branchId: employee.branchId },
    park: { id: branch.id } })
    .from(account)
    .leftJoin(employee, and(eq(employee.id, account.employeeId), eq(employee.operatorId, reader.operatorId)))
    .leftJoin(branch, and(eq(branch.id, employee.branchId), eq(branch.operatorId, reader.operatorId)))
    .where(and(eq(account.operatorId, reader.operatorId), filter ?? undefined));
  const history = accounts.length === 0 ? [] : await db.select({ accountId: auditLog.actorAccountId, lastSignInAt: max(auditLog.createdAt) })
    .from(auditLog)
    .where(and(eq(auditLog.operatorId, reader.operatorId), eq(auditLog.action, 'auth.sign_in'), eq(auditLog.entityType, 'session'),
      inArray(auditLog.actorAccountId, accounts.map(row => row.id))))
    .groupBy(auditLog.actorAccountId);
  const lastSignIns = new Map(history.map(row => [row.accountId, row.lastSignInAt?.toISOString() ?? null]));
  const ownedEmployeeLinks = new Set(accounts.filter(row => row.person !== null).map(row => row.id));
  const summaries: ReviewAccount[] = accounts.map(row => {
    const visiblePerson = row.person && (row.person.branchId === null ? reach.kind === 'operator'
      : row.park && reachCovers(reach, row.park.id));
    return { id: row.id, phone: row.phone, status: row.status, mustChangePassword: row.mustChangePassword,
      employee: visiblePerson ? { id: row.person!.id, name: row.person!.name } : null,
      lastSignInAt: lastSignIns.get(row.id) ?? null };
  }).sort(accountOrder);
  const summaryById = new Map(summaries.map(row => [row.id, row]));
  result.accountsWithoutEmployee = summaries.filter(row => !ownedEmployeeLinks.has(row.id));
  result.accountsNeverSignedIn = summaries.filter(row => row.lastSignInAt === null);
  result.temporaryPasswordsOutstanding = summaries.filter(row => row.mustChangePassword);

  // Hidden or inactive OWN accounts still establish a link. A foreign account
  // cannot mask the absence of a login belonging to this employee's operator.
  const unlinked = await db.select({ id: employee.id, name: employee.name, nickname: employee.nickname,
    source: employee.source, archivedAt: employee.archivedAt, park: { id: branch.id, name: branch.name } })
    .from(employee)
    .leftJoin(branch, and(eq(branch.id, employee.branchId), eq(branch.operatorId, reader.operatorId)))
    .where(and(eq(employee.operatorId, reader.operatorId),
      reach.kind === 'branches' ? inArray(branch.id, reach.branchIds)
        : or(isNull(employee.branchId), isNotNull(branch.id)),
      notExists(db.select({ id: account.id }).from(account)
        .where(and(eq(account.operatorId, reader.operatorId), eq(account.employeeId, employee.id))))));
  result.employeesWithoutAccount = unlinked.map(row => ({ id: row.id, name: row.name, nickname: row.nickname,
    source: row.source, archivedAt: row.archivedAt?.toISOString() ?? null,
    branch: row.park ? { id: row.park.id, name: row.park.name } : null }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  if (summaries.length === 0) return result;
  // These are assignments, including an empty role. Joining role_permission
  // would silently lose real assignments whose role currently grants nothing.
  const assignments = await db.select({ id: roleAssignment.id, accountId: roleAssignment.accountId,
    roleId: role.id, roleName: role.name, scopeId: roleAssignment.scopeId })
    .from(roleAssignment)
    .innerJoin(role, and(eq(role.id, roleAssignment.roleId), or(isNull(role.operatorId), eq(role.operatorId, reader.operatorId))))
    .where(and(inArray(roleAssignment.accountId, summaries.map(row => row.id)), eq(roleAssignment.scopeType, 'operator'),
      or(isNull(roleAssignment.scopeId), eq(roleAssignment.scopeId, reader.operatorId))));
  for (const assignment of assignments) {
    const scope = { scopeType: 'operator' as const, scopeId: assignment.scopeId };
    const readable = scope.scopeId === null
      ? reader.effective.some(row => row.permission === 'admin:role:read' && row.scopeType === 'operator' && row.scopeId === null)
      : hasPermission(reader.effective, 'admin:role:read', scopeToTarget(reader.operatorId, scope));
    if (!readable) continue;
    try { await assertRoleDominated(db, reader.effective, reader.operatorId, assignment.roleId, scope); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ROLE_NOT_DOMINATED') continue;
      throw error;
    }
    const list = scope.scopeId === null ? result.platformWideHolders : result.operatorWideHolders;
    let holder = list.find(row => row.id === assignment.accountId);
    if (!holder) { holder = { ...summaryById.get(assignment.accountId)!, assignments: [] }; list.push(holder); }
    holder.assignments.push({ id: assignment.id, roleName: assignment.roleName, scopeId: assignment.scopeId });
  }
  for (const list of [result.operatorWideHolders, result.platformWideHolders]) {
    list.sort(accountOrder);
    for (const holder of list) holder.assignments.sort((a, b) => a.roleName.localeCompare(b.roleName) || a.id.localeCompare(b.id));
  }
  return result;
}
