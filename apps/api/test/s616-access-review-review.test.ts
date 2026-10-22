import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, appIdentity, auditLog, branch, department, employee, role, roleAssignment, rolePermission, session } from '@oto/db';
import { newId } from '@oto/shared';
import { resolveEffectivePermissions } from '../src/services/permissions';
import {
  BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE,
  branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

interface AccountRow {
  id: string; phone: string; status: string; employee: { id: string; name: string } | null;
  lastSignInAt: string | null; mustChangePassword: boolean;
}
interface HolderRow extends AccountRow { assignments: Array<{ id: string; roleName: string; scopeId: string | null }> }
interface EmployeeRow { id: string; name: string; nickname: string | null; source: string; archivedAt: string | null; branch: { id: string; name: string } | null }
interface Review {
  operatorWideHolders: HolderRow[]; platformWideHolders: HolderRow[];
  accountsWithoutEmployee: AccountRow[]; employeesWithoutAccount: EmployeeRow[];
  accountsNeverSignedIn: AccountRow[]; temporaryPasswordsOutstanding: AccountRow[];
}
let ctx: TestContext;
let cookie: string, caller: string, operatorId: string, foreignOperator: string;
let central: string, chalong: string, foreignPark: string, localDepartment: string, readRole: string;
let unlinked: string, archived: string, branchless: string, foreignOnlyLink: string, inactiveEmployee: string;
let remoteEmployee: string, corruptParkEmployee: string, invalidUnlinked: string, foreignEmployee: string;
let invitedAccount: string, inactiveAccount: string, foreignAccount: string, corruptEmployeeAccount: string;
let remoteAccount: string, corruptParkAccount: string, signedAccount: string, neverAccount: string, holder: string;
let ownAssignment: string, emptyAssignment: string, systemAssignment: string, nullAssignment: string;
let foreignRoleAssignment: string, undominatedAssignment: string, foreignScopeAssignment: string;
let serial = 0;
const read = () => ctx.app.inject({ method: 'GET', url: '/access-review', headers: { cookie } });
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
const find = <T extends { id: string }>(rows: T[], id: string): T => {
  const row = rows.find(item => item.id === id); expect(row, `expected review row ${id}`).toBeDefined(); return row!;
};
async function person(name: string, park: string | null = central, extra: Partial<typeof employee.$inferInsert> = {}) {
  const id = newId(); await ctx.db.insert(employee).values({ id, operatorId, name: `ZZ TEST Access review ${name}`, branchId: park, ...extra }); return id;
}
async function login(employeeId: string | null, extra: Partial<typeof account.$inferInsert> = {}) {
  const id = newId(); await ctx.db.insert(account).values({ id, operatorId, employeeId, phone: `+66999616${String(++serial).padStart(3, '0')}`, status: 'active', ...extra }); return id;
}
async function assignment(accountId: string, roleId = readRole, scopeId: string | null = operatorId, scopeType: 'operator' | 'branch' = 'operator') {
  const id = newId(); await ctx.db.insert(roleAssignment).values({ id, accountId, roleId, scopeId, scopeType }); return id;
}
async function readerGrant(scopeType: 'operator' | 'branch' | 'department', scopeId: string | null) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, caller));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: caller, roleId: readRole, scopeType, scopeId });
}
async function event(actorAccountId: string, at: string, action = 'auth.sign_in', owner = operatorId, entityType = 'session') {
  await ctx.db.insert(auditLog).values({ id: newId(), operatorId: owner, actorAccountId, action, entityType, entityId: newId(), createdAt: new Date(at) });
}

beforeAll(async () => {
  ctx = await createTestContext(); // The source app is neither installed nor queried.
  cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [reader] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  caller = reader!.id; operatorId = reader!.operatorId;
  const [outside] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  foreignOperator = outside!.operatorId;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE); chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [park] = await ctx.db.select().from(branch).where(eq(branch.operatorId, foreignOperator)); foreignPark = park!.id;
  const [team] = await ctx.db.select().from(department).where(eq(department.branchId, central)); localDepartment = team!.id;
  readRole = newId(); const emptyRole = newId(), systemRole = newId(), foreignRole = newId(), powerfulRole = newId();
  await ctx.db.insert(role).values([
    { id: readRole, operatorId, name: 'ZZ TEST Access review reader only' },
    { id: emptyRole, operatorId, name: 'ZZ TEST Access review empty role' },
    { id: systemRole, operatorId: null, isSystem: true, name: 'ZZ TEST Access review system role' },
    { id: foreignRole, operatorId: foreignOperator, name: 'ZZ TEST Access review foreign role' },
    { id: powerfulRole, operatorId, name: 'ZZ TEST Access review undominated role' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: readRole, permission: 'admin:role:read' },
    { id: newId(), roleId: systemRole, permission: 'admin:role:read' },
    { id: newId(), roleId: foreignRole, permission: 'admin:role:read' },
    { id: newId(), roleId: powerfulRole, permission: 'admin:account:update' },
  ]);
  unlinked = await person('without login');
  archived = await person('archived without login', central, { source: 'otoapp', externalId: 'zz-test-access-review/source', archivedAt: new Date('2025-01-01T00:00:00.000Z') });
  branchless = await person('branchless without login', null);
  foreignOnlyLink = await person('foreign login only');
  inactiveEmployee = await person('hidden inactive login');
  remoteEmployee = await person('remote linked', chalong);
  corruptParkEmployee = await person('foreign park linked', foreignPark);
  invalidUnlinked = await person('foreign park without login', foreignPark);
  foreignEmployee = await person('foreign employee', foreignPark, { operatorId: foreignOperator });
  invitedAccount = await login(null, { status: 'invited', mustChangePassword: true }); await assignment(invitedAccount, readRole, central, 'branch');
  inactiveAccount = await login(inactiveEmployee, { status: 'inactive', mustChangePassword: true });
  foreignAccount = await login(foreignOnlyLink, { operatorId: foreignOperator, mustChangePassword: true });
  await assignment(foreignAccount, readRole, null);
  corruptEmployeeAccount = await login(foreignEmployee); await assignment(corruptEmployeeAccount, readRole, central, 'branch');
  remoteAccount = await login(remoteEmployee); await assignment(remoteAccount, readRole, central, 'branch');
  corruptParkAccount = await login(corruptParkEmployee); await assignment(corruptParkAccount, readRole, central, 'branch');
  signedAccount = await login(await person('historical sign-in')); await assignment(signedAccount);
  neverAccount = await login(null); await assignment(neverAccount, readRole, central, 'branch');
  holder = await login(await person('mixed wide holder'));
  ownAssignment = await assignment(holder); emptyAssignment = await assignment(holder, emptyRole); systemAssignment = await assignment(holder, systemRole);
  nullAssignment = await assignment(holder, readRole, null); foreignScopeAssignment = await assignment(holder, readRole, foreignOperator);
  foreignRoleAssignment = await assignment(holder, foreignRole); undominatedAssignment = await assignment(holder, powerfulRole);
  await event(signedAccount, '2024-01-02T03:04:05.000Z');
  await event(signedAccount, '2029-01-01T00:00:00.000Z', 'auth.sign_in', foreignOperator);
  await event(neverAccount, '2030-01-01T00:00:00.000Z', 'auth.sign_in_failed');
  await event(neverAccount, '2030-02-01T00:00:00.000Z', 'auth.handoff_exchange');
  await event(neverAccount, '2030-03-01T00:00:00.000Z', 'auth.sign_in', foreignOperator);
  await event(neverAccount, '2030-04-01T00:00:00.000Z', 'auth.sign_in', operatorId, 'account');
  await ctx.db.insert(session).values([
    { id: newId(), accountId: signedAccount, tokenHash: newId(), branchId: central, expiresAt: new Date('2024-02-01T00:00:00.000Z'), revokedAt: new Date('2024-01-03T00:00:00.000Z') },
    { id: newId(), accountId: neverAccount, tokenHash: newId(), branchId: central, createdAt: new Date('2031-01-01T00:00:00.000Z'), lastSeenAt: new Date('2032-01-01T00:00:00.000Z'), expiresAt: new Date('2033-01-01T00:00:00.000Z') },
  ]);
}, 180_000);
beforeEach(async () => {
  await readerGrant('operator', operatorId);
  await ctx.db.update(session).set({ branchId: central }).where(eq(session.accountId, caller));
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

/** SCRUM-616 house review: the passing findings pin concrete boundary requirements. */
describe('SCRUM-616 Access review adversarial review', () => {
  it('FINDING R1 high: account-read permission must not become a hidden prerequisite; serve all six lists with only the approved role-read grant', async () => {
    const permissions = await resolveEffectivePermissions(ctx.db, caller);
    expect(permissions.map(row => row.permission)).toEqual(['admin:role:read']);
    const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    expect(Object.keys(body).sort()).toEqual(['accountsNeverSignedIn', 'accountsWithoutEmployee', 'employeesWithoutAccount', 'operatorWideHolders', 'platformWideHolders', 'temporaryPasswordsOutstanding']);
    expect(ids(body.accountsWithoutEmployee)).toContain(invitedAccount);
    expect(ids(body.employeesWithoutAccount)).toEqual(expect.arrayContaining([unlinked, archived, branchless]));
  });

  it('FINDING R2 critical: foreign employee, account and role joins must not leak through owned rows; fence each relation before projecting it', async () => {
    const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    expect(find(body.accountsWithoutEmployee, corruptEmployeeAccount).employee).toBeNull();
    expect(ids(body.employeesWithoutAccount)).toContain(foreignOnlyLink);
    for (const hidden of [foreignAccount, foreignEmployee, foreignPark, foreignRoleAssignment, 'ZZ TEST Access review foreign role']) expect(JSON.stringify(body)).not.toContain(hidden);
    await readerGrant('operator', null);
    const platform = await read(); expect(platform.statusCode).toBe(200);
    expect(JSON.stringify(platform.json())).not.toContain(foreignAccount);
  });

  it('FINDING R3 high: a hidden DTO relation does not mean a missing link; check all owned links including inactive accounts and unreadable employees', async () => {
    await readerGrant('branch', central);
    const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    expect(ids(body.employeesWithoutAccount)).not.toContain(inactiveEmployee);
    expect(ids(body.employeesWithoutAccount)).toContain(foreignOnlyLink);
    expect(ids(body.accountsWithoutEmployee)).not.toContain(remoteAccount);
    expect(find(body.accountsNeverSignedIn, remoteAccount).employee).toBeNull();
    expect(ids(body.accountsWithoutEmployee)).not.toContain(corruptParkAccount);
    expect(find(body.accountsNeverSignedIn, corruptParkAccount).employee).toBeNull();
    expect(JSON.stringify(body)).not.toContain(inactiveAccount);
    expect(ids(body.employeesWithoutAccount)).not.toContain(branchless);
    expect(ids(body.employeesWithoutAccount)).not.toContain(invalidUnlinked);
  });

  it('FINDING R4 high: revoked sessions and later failed or foreign activity must not erase successful sign-in history; use the same-operator session audit', async () => {
    const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    expect(ids(body.accountsNeverSignedIn)).not.toContain(signedAccount);
    expect(find(body.operatorWideHolders, signedAccount).lastSignInAt).toBe('2024-01-02T03:04:05.000Z');
    expect(find(body.accountsNeverSignedIn, neverAccount).lastSignInAt).toBeNull();
  });

  it('FINDING R5 medium: temporary-password review means the must-change flag, not a status or session guess; preserve invited and inactive operator-visible rows', async () => {
    const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    expect(find(body.temporaryPasswordsOutstanding, invitedAccount)).toMatchObject({ status: 'invited', mustChangePassword: true });
    expect(find(body.temporaryPasswordsOutstanding, inactiveAccount)).toMatchObject({ status: 'inactive', mustChangePassword: true });
    expect(ids(body.temporaryPasswordsOutstanding)).not.toContain(neverAccount);
    expect(find(body.employeesWithoutAccount, archived)).toMatchObject({ source: 'otoapp', archivedAt: '2025-01-01T00:00:00.000Z' });
    expect(ids(body.employeesWithoutAccount)).not.toContain(invalidUnlinked);
  });

  it('FINDING R6 critical: account visibility cannot disclose unreadable wide assignments; require owned or system roles, exact scope and per-role dominance', async () => {
    const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    const visible = find(body.operatorWideHolders, holder).assignments;
    expect(visible.map(row => row.id).sort()).toEqual([ownAssignment, emptyAssignment, systemAssignment].sort());
    expect(visible.every(row => row.scopeId === operatorId)).toBe(true);
    expect(body.platformWideHolders).toEqual([]);
    for (const hidden of [foreignRoleAssignment, undominatedAssignment, foreignScopeAssignment, nullAssignment]) expect(JSON.stringify(body)).not.toContain(hidden);
    await readerGrant('operator', null);
    const platform = await read(); expect(platform.statusCode).toBe(200);
    expect(find((platform.json() as Review).platformWideHolders, holder).assignments).toEqual([
      { id: nullAssignment, roleName: 'ZZ TEST Access review reader only', scopeId: null },
    ]);
    await readerGrant('branch', central);
    const branchView = await read(); expect(branchView.statusCode).toBe(200);
    expect(branchView.json().operatorWideHolders).toEqual([]); expect(branchView.json().platformWideHolders).toEqual([]);
  });

  it('FINDING R7 high: an unreadable seat, department grant or wrong operator must not bypass the existing role-read route gate', async () => {
    await readerGrant('branch', central);
    try { await ctx.db.update(session).set({ branchId: chalong }).where(eq(session.accountId, caller)); expect((await read()).statusCode).toBe(403); }
    finally { await ctx.db.update(session).set({ branchId: central }).where(eq(session.accountId, caller)); }
    await readerGrant('department', localDepartment); expect((await read()).statusCode).toBe(403);
    await readerGrant('operator', foreignOperator); expect((await read()).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/access-review' })).statusCode).toBe(401);
  });

  it('FINDING R8 critical: a review must neither expose credentials nor repair records; return only approved fields and leave business data unchanged', async () => {
    const fingerprint = async () => createHash('sha256').update(JSON.stringify({
      accounts: await ctx.db.select().from(account).orderBy(account.id), employees: await ctx.db.select().from(employee).orderBy(employee.id),
      roles: await ctx.db.select().from(role).orderBy(role.id), permissions: await ctx.db.select().from(rolePermission).orderBy(rolePermission.id),
      assignments: await ctx.db.select().from(roleAssignment).orderBy(roleAssignment.id), identities: await ctx.db.select().from(appIdentity).orderBy(appIdentity.id),
    })).digest('hex');
    const before = await fingerprint(); const response = await read(); expect(response.statusCode).toBe(200); const body: Review = response.json();
    const base = ['employee', 'id', 'lastSignInAt', 'mustChangePassword', 'phone', 'status'];
    for (const key of ['accountsWithoutEmployee', 'accountsNeverSignedIn', 'temporaryPasswordsOutstanding'] as const) {
      for (const row of body[key]) {
        expect(Object.keys(row).sort()).toEqual(base);
        if (row.employee) expect(Object.keys(row.employee).sort()).toEqual(['id', 'name']);
      }
    }
    for (const key of ['operatorWideHolders', 'platformWideHolders'] as const) for (const row of body[key]) {
      expect(Object.keys(row).sort()).toEqual(['assignments', ...base]);
      if (row.employee) expect(Object.keys(row.employee).sort()).toEqual(['id', 'name']);
      for (const assignment of row.assignments) expect(Object.keys(assignment).sort()).toEqual(['id', 'roleName', 'scopeId']);
    }
    for (const row of body.employeesWithoutAccount) {
      expect(Object.keys(row).sort()).toEqual(['archivedAt', 'branch', 'id', 'name', 'nickname', 'source']);
      if (row.branch) expect(Object.keys(row.branch).sort()).toEqual(['id', 'name']);
    }
    expect(await fingerprint()).toBe(before); expect(ctx.smsLog).toEqual([]);
  });
});
