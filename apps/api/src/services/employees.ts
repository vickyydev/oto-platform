import { and, eq, inArray, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { account, auditLog, branch, department, employee, type Db } from '@oto/db';
import { accountScopeFilter, branchReach, reachCovers } from './access-control';
import type { EffectivePermission } from './permissions';

interface EmployeeReader {
  operatorId: string;
  effective: EffectivePermission[];
}

interface EmployeeLogin {
  id: string;
  phone: string;
  status: typeof account.$inferSelect.status;
  lastSignInAt: string | null;
}

export interface EmployeeSummary {
  id: string;
  name: string;
  nickname: string | null;
  source: typeof employee.$inferSelect.source;
  externalId: string | null;
  archivedAt: string | null;
  branch: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  accounts: EmployeeLogin[];
  lastSignInAt: string | null;
}

/** Read the existing mirror; neither the source app nor its copy job is queried or changed. */
export async function listEmployees(db: Db, reader: EmployeeReader, query: { q?: string }) {
  const reach = branchReach(reader.effective, 'admin:account:read', reader.operatorId);
  if (reach.kind === 'branches' && reach.branchIds.length === 0) return { employees: [] as EmployeeSummary[] };
  const departmentBranch = alias(branch, 'employee_department_branch');
  const people = await db.select({ person: employee, park: branch, team: department, teamPark: departmentBranch })
    .from(employee)
    .leftJoin(branch, and(eq(branch.id, employee.branchId), eq(branch.operatorId, reader.operatorId)))
    .leftJoin(department, and(eq(department.id, employee.departmentId), eq(department.operatorId, reader.operatorId)))
    .leftJoin(departmentBranch, and(eq(departmentBranch.id, department.branchId), eq(departmentBranch.operatorId, reader.operatorId)))
    .where(and(eq(employee.operatorId, reader.operatorId), reach.kind === 'branches' ? inArray(branch.id, reach.branchIds) : undefined));
  if (people.length === 0) return { employees: [] as EmployeeSummary[] };

  // A visible employee does not make a foreign or unreadable login visible.
  const { filter, empty } = accountScopeFilter(reader.effective, reader.operatorId, 'admin:account:read');
  const logins = empty ? [] : await db.select({ id: account.id, employeeId: account.employeeId, phone: account.phone, status: account.status })
    .from(account)
    .innerJoin(employee, and(eq(employee.id, account.employeeId), eq(employee.operatorId, reader.operatorId)))
    .where(and(eq(account.operatorId, reader.operatorId), inArray(employee.id, people.map(row => row.person.id)), filter ?? undefined));
  const history = logins.length === 0 ? [] : await db.select({ accountId: auditLog.actorAccountId, lastSignInAt: max(auditLog.createdAt) })
    .from(auditLog)
    .where(and(eq(auditLog.operatorId, reader.operatorId), eq(auditLog.action, 'auth.sign_in'),
      eq(auditLog.entityType, 'session'), inArray(auditLog.actorAccountId, logins.map(row => row.id))))
    .groupBy(auditLog.actorAccountId);
  const lastSignIns = new Map(history.map(row => [row.accountId, row.lastSignInAt?.toISOString() ?? null]));
  const accounts = new Map<string, EmployeeLogin[]>();
  for (const login of logins) {
    const linked = accounts.get(login.employeeId!) ?? [];
    linked.push({ id: login.id, phone: login.phone, status: login.status, lastSignInAt: lastSignIns.get(login.id) ?? null });
    accounts.set(login.employeeId!, linked);
  }
  const q = query.q?.trim().toLowerCase();
  const employees = people.map(({ person, park, team, teamPark }): EmployeeSummary => {
    const linked = (accounts.get(person.id) ?? []).sort((a, b) => a.phone.localeCompare(b.phone) || a.id.localeCompare(b.id));
    const signIns = linked.flatMap(login => login.lastSignInAt ? [login.lastSignInAt] : []).sort();
    const readableDepartment = team && (team.branchId === null
      ? reach.kind === 'operator'
      : teamPark && reachCovers(reach, teamPark.id));
    return { id: person.id, name: person.name, nickname: person.nickname, source: person.source,
      externalId: person.externalId, archivedAt: person.archivedAt?.toISOString() ?? null,
      branch: park ? { id: park.id, name: park.name } : null,
      department: readableDepartment ? { id: team.id, name: team.name } : null,
      accounts: linked, lastSignInAt: signIns.at(-1) ?? null };
  }).filter(person => !q || person.name.toLowerCase().includes(q) || person.nickname?.toLowerCase().includes(q)
    || person.accounts.some(login => login.phone.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { employees };
}
