import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, employee, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import { resolveEffectivePermissions } from '../src/services/permissions';
import {
  ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

interface AccountRow {
  id: string; phone: string; status: 'active' | 'invited' | 'inactive';
  employee: { id: string; name: string } | null; lastSignInAt: string | null; mustChangePassword: boolean;
}
interface HolderRow extends AccountRow { assignments: Array<{ id: string; roleName: string; scopeId: string | null }> }
interface EmployeeRow {
  id: string; name: string; nickname: string | null; source: 'platform' | 'otoapp'; archivedAt: string | null;
  branch: { id: string; name: string } | null;
}
interface Review {
  operatorWideHolders: HolderRow[]; platformWideHolders: HolderRow[]; accountsWithoutEmployee: AccountRow[];
  employeesWithoutAccount: EmployeeRow[]; accountsNeverSignedIn: AccountRow[]; temporaryPasswordsOutstanding: AccountRow[];
}
let ctx: TestContext;
let admin: string, manager: string, reception: string, foreignAdmin: string;
let operatorId: string, foreignOperator: string, central: string, chalong: string, foreignPark: string;
let adminId: string, receptionId: string, staffRole: string, readRole: string;
let orphanAccount: string, inactiveAccount: string, invitedAccount: string;
let orphanEmployee: string, archivedEmployee: string, inactiveLinkedEmployee: string, foreignLinkedEmployee: string;
let awayEmployee: string, branchlessEmployee: string, malformedEmployee: string;
let hiddenLinkAccount: string, malformedLinkAccount: string, foreignLinkAccount: string;
let wideAccount: string, platformAccount: string, foreignWideAccount: string;
let wideAssignment: string, protectedWideAssignment: string, platformAssignment: string, invalidRoleAssignment: string, invalidScopeAssignment: string;
let serial = 0;

async function person(name: string, park: string | null = central, owner = operatorId, archived = false) {
  const id = newId();
  await ctx.db.insert(employee).values({ id, operatorId: owner, branchId: park, name: 'ZZ TEST Access review ' + name,
    ...(archived ? { archivedAt: new Date('2026-01-02T03:04:05Z'), source: 'otoapp' as const, externalId: 'zz-test-access-' + id } : {}) });
  return id;
}
async function login(employeeId: string | null, options: Partial<typeof account.$inferInsert> = {}, localGrant = true) {
  const id = newId();
  await ctx.db.insert(account).values({ id, operatorId, employeeId, phone: '+669990616' + String(++serial).padStart(2, '0'), status: 'active', ...options });
  if (localGrant) await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId: staffRole, scopeType: 'branch', scopeId: central });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const parks = await ctx.db.select().from(branch);
  const home = parks.find(row => row.code === 'hkt-central')!;
  operatorId = home.operatorId; central = home.id;
  chalong = parks.find(row => row.code === 'robinson-chalong')!.id;
  const foreign = parks.find(row => row.code === 'second-operator-1')!;
  foreignOperator = foreign.operatorId; foreignPark = foreign.id;
  const [adminRow] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone));
  const [receptionRow] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
  adminId = adminRow!.id; receptionId = receptionRow!.id;
  const [staff] = await ctx.db.select({ id: role.id }).from(role).where(eq(role.name, 'staff'));
  staffRole = staff!.id;
  readRole = newId(); const emptyRole = newId(); const protectedRole = newId(); const foreignRole = newId();
  await ctx.db.insert(role).values([
    { id: readRole, operatorId, name: 'ZZ TEST Access review role reader' },
    { id: emptyRole, operatorId, name: 'ZZ TEST Access review empty role' },
    { id: protectedRole, operatorId, name: 'ZZ TEST Access review account reader' },
    { id: foreignRole, operatorId: foreignOperator, name: 'ZZ TEST Access review foreign role' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: readRole, permission: 'admin:role:read' },
    { id: newId(), roleId: protectedRole, permission: 'admin:account:read' },
  ]);
  orphanAccount = await login(null, { mustChangePassword: true });
  inactiveAccount = await login(null, { status: 'inactive', mustChangePassword: true });
  invitedAccount = await login(null, { status: 'invited', mustChangePassword: true });
  orphanEmployee = await person('unlinked employee');
  archivedEmployee = await person('archived unlinked employee', central, operatorId, true);
  inactiveLinkedEmployee = await person('hidden inactive login');
  await login(inactiveLinkedEmployee, { status: 'inactive' });
  foreignLinkedEmployee = await person('foreign-only login');
  await login(foreignLinkedEmployee, { operatorId: foreignOperator }, false);
  awayEmployee = await person('away employee', chalong);
  branchlessEmployee = await person('branchless employee', null);
  malformedEmployee = await person('malformed park employee', foreignPark);
  malformedLinkAccount = await login(malformedEmployee, { mustChangePassword: true });
  const hiddenEmployee = await person('hidden owned employee', chalong);
  hiddenLinkAccount = await login(hiddenEmployee, { mustChangePassword: true });
  const foreignEmployee = await person('foreign employee', foreignPark, foreignOperator);
  foreignLinkAccount = await login(foreignEmployee, { mustChangePassword: true });
  wideAccount = await login(null, {}, false);
  platformAccount = await login(await person('platform assignment employee'));
  foreignWideAccount = await login(null, { operatorId: foreignOperator }, false);
  wideAssignment = newId(); protectedWideAssignment = newId(); platformAssignment = newId(); invalidRoleAssignment = newId(); invalidScopeAssignment = newId();
  await ctx.db.insert(roleAssignment).values([
    { id: wideAssignment, accountId: wideAccount, roleId: emptyRole, scopeType: 'operator', scopeId: operatorId },
    { id: protectedWideAssignment, accountId: wideAccount, roleId: protectedRole, scopeType: 'operator', scopeId: operatorId },
    { id: platformAssignment, accountId: platformAccount, roleId: emptyRole, scopeType: 'operator', scopeId: null },
    { id: invalidRoleAssignment, accountId: wideAccount, roleId: foreignRole, scopeType: 'operator', scopeId: operatorId },
    { id: invalidScopeAssignment, accountId: wideAccount, roleId: readRole, scopeType: 'operator', scopeId: foreignOperator },
    { id: newId(), accountId: foreignWideAccount, roleId: foreignRole, scopeType: 'operator', scopeId: null },
  ]);
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const get = (cookie = admin) => ctx.app.inject({ method: 'GET', url: '/access-review', headers: { cookie } });
const body = (response: Awaited<ReturnType<typeof get>>): Review => response.json();

describe('SCRUM-616 read-only access review', () => {
  it('returns six actual review lists and preserves invited, inactive and archived records under operator reach', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    const result = body(response);
    expect(Object.keys(result).sort()).toEqual(['operatorWideHolders', 'platformWideHolders', 'accountsWithoutEmployee',
      'employeesWithoutAccount', 'accountsNeverSignedIn', 'temporaryPasswordsOutstanding'].sort());
    expect(result.accountsWithoutEmployee.map(row => row.id)).toEqual(expect.arrayContaining([orphanAccount, inactiveAccount, invitedAccount, foreignLinkAccount]));
    expect(result.employeesWithoutAccount.map(row => row.id)).toEqual(expect.arrayContaining([orphanEmployee, archivedEmployee, foreignLinkedEmployee, awayEmployee, branchlessEmployee]));
    expect(result.employeesWithoutAccount.find(row => row.id === archivedEmployee)).toMatchObject({ source: 'otoapp', archivedAt: '2026-01-02T03:04:05.000Z', branch: { id: central } });
    expect(result.employeesWithoutAccount.some(row => [inactiveLinkedEmployee, malformedEmployee].includes(row.id))).toBe(false);
  });

  it('reports only readable dominated wide assignments with valid owned roles, scopes and account tenancy', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    const result = body(response);
    const holder = result.operatorWideHolders.find(row => row.id === wideAccount)!;
    expect(holder.assignments.map(row => row.id).sort()).toEqual([wideAssignment, protectedWideAssignment].sort());
    expect(holder.assignments.every(row => row.scopeId === operatorId)).toBe(true);
    expect(result.platformWideHolders.find(row => row.id === platformAccount)?.assignments).toEqual([
      { id: platformAssignment, roleName: 'ZZ TEST Access review empty role', scopeId: null },
    ]);
    expect([...result.operatorWideHolders, ...result.platformWideHolders].some(row => row.id === foreignWideAccount)).toBe(false);
    const branchResponse = await get(manager);
    expect(branchResponse.statusCode).toBe(200);
    expect(body(branchResponse).operatorWideHolders).toEqual([]);
    expect(body(branchResponse).platformWideHolders).toEqual([]);
  });

  it('keeps employee projection and branch reach separate from actual owned-link absence', async () => {
    const response = await get(manager);
    expect(response.statusCode).toBe(200);
    const result = body(response);
    expect(result.accountsWithoutEmployee.some(row => [hiddenLinkAccount, malformedLinkAccount].includes(row.id))).toBe(false);
    expect(result.temporaryPasswordsOutstanding.find(row => row.id === hiddenLinkAccount)?.employee).toBeNull();
    expect(result.temporaryPasswordsOutstanding.find(row => row.id === malformedLinkAccount)?.employee).toBeNull();
    expect(result.accountsWithoutEmployee.find(row => row.id === foreignLinkAccount)?.employee).toBeNull();
    expect(result.employeesWithoutAccount.map(row => row.id)).toEqual(expect.arrayContaining([orphanEmployee, archivedEmployee, foreignLinkedEmployee]));
    expect(result.employeesWithoutAccount.some(row => [inactiveLinkedEmployee, awayEmployee, branchlessEmployee, malformedEmployee].includes(row.id))).toBe(false);
    expect(result.temporaryPasswordsOutstanding.some(row => row.id === inactiveAccount)).toBe(false);
    const foreign = await get(foreignAdmin);
    expect(foreign.statusCode).toBe(200);
    for (const list of Object.values(body(foreign))) expect(list.some((row: { id: string }) => row.id === orphanAccount || row.id === orphanEmployee)).toBe(false);
  });

  it('uses successful same-operator sign-in audits and exposes only the password-change boolean', async () => {
    const [signedIn] = await ctx.db.select({ createdAt: auditLog.createdAt }).from(auditLog)
      .where(and(eq(auditLog.actorAccountId, adminId), eq(auditLog.action, 'auth.sign_in'), eq(auditLog.entityType, 'session')));
    await ctx.db.insert(auditLog).values([
      { id: newId(), actorAccountId: adminId, operatorId, action: 'auth.sign_in_failed', entityType: 'session', entityId: newId(), createdAt: new Date('2030-01-01T00:00:00Z') },
      { id: newId(), actorAccountId: adminId, operatorId: foreignOperator, action: 'auth.sign_in', entityType: 'session', entityId: newId(), createdAt: new Date('2030-01-02T00:00:00Z') },
    ]);
    const response = await get();
    expect(response.statusCode).toBe(200);
    const result = body(response);
    expect(result.platformWideHolders.find(row => row.id === adminId)?.lastSignInAt).toBe(signedIn!.createdAt.toISOString());
    expect(result.accountsNeverSignedIn.some(row => row.id === adminId)).toBe(false);
    expect(result.accountsNeverSignedIn.find(row => row.id === orphanAccount)?.lastSignInAt).toBeNull();
    expect(result.temporaryPasswordsOutstanding.map(row => row.id)).toEqual(expect.arrayContaining([orphanAccount, inactiveAccount, invitedAccount]));
    for (const row of result.temporaryPasswordsOutstanding) {
      expect(row.mustChangePassword).toBe(true);
      expect(Object.keys(row).sort()).toEqual(['id', 'phone', 'status', 'employee', 'lastSignInAt', 'mustChangePassword'].sort());
    }
  });

  it('requires role-read authentication while allowing role-read without account-read', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/access-review' })).statusCode).toBe(401);
    expect((await get(reception)).statusCode).toBe(403);
    const assignmentId = newId();
    await ctx.db.insert(roleAssignment).values({ id: assignmentId, accountId: receptionId, roleId: readRole, scopeType: 'operator', scopeId: operatorId });
    try {
      expect((await resolveEffectivePermissions(ctx.db, receptionId)).some(row => row.permission === 'admin:account:read')).toBe(false);
      const response = await get(reception);
      expect(response.statusCode).toBe(200);
      expect(body(response).platformWideHolders).toEqual([]);
      expect(body(response).operatorWideHolders.find(row => row.id === wideAccount)?.assignments.map(row => row.id)).toEqual([wideAssignment]);
    } finally { await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, assignmentId)); }
  });

  it('reads the review without changing accounts, employees, role assignments or audit records', async () => {
    const accountsBefore = await ctx.db.select({ id: account.id, employeeId: account.employeeId, status: account.status, mustChangePassword: account.mustChangePassword }).from(account);
    const employeesBefore = await ctx.db.select().from(employee);
    const assignmentsBefore = await ctx.db.select().from(roleAssignment);
    const auditsBefore = await ctx.db.select({ id: auditLog.id }).from(auditLog);
    expect((await get()).statusCode).toBe(200);
    expect(await ctx.db.select({ id: account.id, employeeId: account.employeeId, status: account.status, mustChangePassword: account.mustChangePassword }).from(account)).toEqual(accountsBefore);
    expect(await ctx.db.select().from(employee)).toEqual(employeesBefore);
    expect(await ctx.db.select().from(roleAssignment)).toEqual(assignmentsBefore);
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog)).toEqual(auditsBefore);
  });
});
