import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account, appIdentity, auditLog, branch, department, employee, role, roleAssignment, rolePermission, session,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE,
  branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

interface EmployeeRow {
  id: string;
  name: string;
  nickname: string | null;
  source: string;
  externalId: string | null;
  branch: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  accounts: Array<{ id: string; phone: string; status: string; lastSignInAt: string | null }>;
  lastSignInAt: string | null;
}

let ctx: TestContext;
let adminCookie: string;
let managerCookie: string;
let foreignCookie: string;
let managerId: string;
let operatorId: string;
let foreignOperator: string;
let central: string;
let chalong: string;
let foreignPark: string;
let readRole: string;
let centralDepartment: string;
let foreignDepartment: string;
let linked: string;
let mirrored: string;
let unlinked: string;
let remote: string;
let branchless: string;
let foreignPerson: string;
let corruptBranch: string;
let corruptDepartment: string;
let siblingDepartment: string;
let firstLogin: string;
let secondLogin: string;
let neverLogin: string;
let inactiveLogin: string;
let foreignLogin: string;
let serial = 0;

const read = (cookie = managerCookie, query = '') => ctx.app.inject({
  method: 'GET', url: `/employees${query}`, headers: { cookie },
});
const employees = (body: { employees: EmployeeRow[] }) => body.employees;
const find = (rows: EmployeeRow[], id: string) => {
  const row = rows.find(person => person.id === id);
  expect(row, `expected employee ${id}`).toBeDefined();
  return row!;
};

async function person(
  name: string,
  park: string | null = central,
  options: Partial<typeof employee.$inferInsert> = {},
): Promise<string> {
  const id = newId();
  await ctx.db.insert(employee).values({
    id, operatorId, branchId: park, name: `ZZ TEST Employees review ${name}`, ...options,
  });
  return id;
}

async function login(
  employeeId: string,
  options: Partial<typeof account.$inferInsert> = {},
): Promise<string> {
  const id = newId();
  await ctx.db.insert(account).values({
    id, operatorId, employeeId, phone: `+66999614${String(++serial).padStart(3, '0')}`,
    status: 'active', ...options,
  });
  return id;
}

async function readerGrant(scopeType: 'branch' | 'operator' | 'department', scopeId: string) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, managerId));
  await ctx.db.insert(roleAssignment).values({
    id: newId(), accountId: managerId, roleId: readRole, scopeType, scopeId,
  });
}

async function recordSignIn(
  actorAccountId: string,
  createdAt: string,
  action = 'auth.sign_in',
  owner = operatorId,
) {
  await ctx.db.insert(auditLog).values({
    id: newId(), operatorId: owner, actorAccountId, action,
    entityType: 'session', entityId: newId(), createdAt: new Date(createdAt),
  });
}

beforeAll(async () => {
  // No OTO App schema: the mirror directory must read core tables only.
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  foreignCookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [manager] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  managerId = manager!.id;
  operatorId = manager!.operatorId;
  const [outside] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  foreignOperator = outside!.operatorId;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [outsidePark] = await ctx.db.select().from(branch).where(eq(branch.operatorId, foreignOperator));
  foreignPark = outsidePark!.id;
  readRole = newId();
  await ctx.db.insert(role).values({ id: readRole, operatorId, name: 'ZZ TEST Employees directory read only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: readRole, permission: 'admin:account:read' });
  centralDepartment = newId();
  foreignDepartment = newId();
  const otherDepartment = newId();
  await ctx.db.insert(department).values([
    { id: centralDepartment, operatorId, branchId: central, name: 'ZZ TEST Employees local department' },
    { id: otherDepartment, operatorId, branchId: chalong, name: 'ZZ TEST Employees sibling department' },
    { id: foreignDepartment, operatorId: foreignOperator, branchId: foreignPark, name: 'ZZ TEST Employees foreign department' },
  ]);
  linked = await person('linked', central, { departmentId: centralDepartment });
  mirrored = await person('mirrored', central, {
    source: 'otoapp', externalId: 'zz-test-employee/source', nickname: 'ZZ TEST unique mirror nickname',
  });
  unlinked = await person('no login');
  remote = await person('remote', chalong);
  branchless = await person('branchless', null);
  foreignPerson = await person('foreign person', foreignPark, { operatorId: foreignOperator });
  corruptBranch = await person('foreign branch reference', foreignPark);
  corruptDepartment = await person('foreign department reference', central, { departmentId: foreignDepartment });
  siblingDepartment = await person('sibling department reference', central, { departmentId: otherDepartment });
  firstLogin = await login(linked);
  secondLogin = await login(linked);
  neverLogin = await login(linked);
  inactiveLogin = await login(linked, { status: 'inactive' });
  foreignLogin = await login(linked, { operatorId: foreignOperator });
  const remoteLogin = await login(remote);
  await ctx.db.insert(roleAssignment).values({
    id: newId(), accountId: remoteLogin, roleId: readRole, scopeType: 'branch', scopeId: central,
  });
  await recordSignIn(firstLogin, '2024-01-01T12:00:00.000Z');
  await recordSignIn(secondLogin, '2025-02-03T12:00:00.000Z');
  await recordSignIn(inactiveLogin, '2026-03-04T12:00:00.000Z');
  await recordSignIn(firstLogin, '2029-01-01T12:00:00.000Z', 'auth.sign_in', foreignOperator);
  await recordSignIn(firstLogin, '2030-01-01T12:00:00.000Z', 'auth.sign_in_failed');
  await recordSignIn(firstLogin, '2031-01-01T12:00:00.000Z', 'auth.handoff_exchange');
  await recordSignIn(foreignLogin, '2034-01-01T12:00:00.000Z', 'auth.sign_in', foreignOperator);
  await ctx.db.insert(session).values({
    id: newId(), accountId: firstLogin, tokenHash: newId(), branchId: central,
    createdAt: new Date('2032-01-01T12:00:00.000Z'), lastSeenAt: new Date('2033-01-01T12:00:00.000Z'),
    expiresAt: new Date('2035-01-01T12:00:00.000Z'),
  });
}, 180_000);

beforeEach(async () => {
  await readerGrant('branch', central);
  await ctx.db.update(session).set({ branchId: central }).where(eq(session.accountId, managerId));
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

/** SCRUM-614 house review: each passing finding pins its prescribed boundary fix. */
describe('SCRUM-614 Employees adversarial review', () => {
  it('FINDING R1 high: an unreadable seat or linked role must not bypass the route gate or widen employee reach; require the seat grant then filter employee branches', async () => {
    try {
      await ctx.db.update(session).set({ branchId: chalong }).where(eq(session.accountId, managerId));
      expect((await read()).statusCode).toBe(403);
    } finally {
      await ctx.db.update(session).set({ branchId: central }).where(eq(session.accountId, managerId));
    }
    const response = await read();
    expect(response.statusCode).toBe(200);
    const rows = employees(response.json());
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([linked, mirrored, unlinked]));
    for (const hidden of [remote, branchless, foreignPerson, corruptBranch]) {
      expect(rows.some(row => row.id === hidden)).toBe(false);
    }
  });

  it('FINDING R2 high: unlinked mirror rows must not disappear or query the source app; preserve source metadata and empty login state from core', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    const rows = employees(response.json());
    expect(find(rows, mirrored)).toMatchObject({ source: 'otoapp', externalId: 'zz-test-employee/source', accounts: [], lastSignInAt: null });
    expect(find(rows, unlinked)).toMatchObject({ source: 'platform', externalId: null, accounts: [], lastSignInAt: null });
    expect(find(rows, linked)).toMatchObject({ branch: { id: central }, department: { id: centralDepartment } });
  });

  it('FINDING R3 high: a singular or unfenced account join loses logins or exposes foreign data; retain every independently visible login', async () => {
    const response = await read(adminCookie);
    expect(response.statusCode).toBe(200);
    const row = find(employees(response.json()), linked);
    expect(row.accounts.map(item => item.id).sort()).toEqual([firstLogin, secondLogin, neverLogin, inactiveLogin].sort());
    expect(JSON.stringify(response.json())).not.toContain(foreignLogin);
    for (const item of row.accounts) {
      expect(Object.keys(item).sort()).toEqual(['id', 'lastSignInAt', 'phone', 'status']);
    }
    const scoped = await read();
    expect(scoped.statusCode).toBe(200);
    expect(find(employees(scoped.json()), linked).accounts.map(item => item.id).sort())
      .toEqual([firstLogin, secondLogin, neverLogin].sort());
  });

  it('FINDING R4 critical: corrupt foreign branch or department references must not disclose another operator; fence every projection independently', async () => {
    const wide = await read(adminCookie);
    expect(wide.statusCode).toBe(200);
    const rows = employees(wide.json());
    expect(find(rows, corruptBranch).branch).toBeNull();
    expect(find(rows, corruptDepartment).department).toBeNull();
    for (const hidden of [foreignPerson, foreignPark, foreignDepartment, foreignLogin]) {
      expect(JSON.stringify(wide.json())).not.toContain(hidden);
    }
    const scoped = await read();
    expect(scoped.statusCode).toBe(200);
    expect(find(employees(scoped.json()), siblingDepartment).department).toBeNull();
    expect(find(employees(scoped.json()), corruptDepartment).department).toBeNull();
  });

  it('FINDING R5 medium: activity, failed attempts or foreign audits must not masquerade as sign-in; use successful same-operator auth events and visible logins', async () => {
    const scoped = await read();
    expect(scoped.statusCode).toBe(200);
    const row = find(employees(scoped.json()), linked);
    expect(row.accounts.find(item => item.id === firstLogin)?.lastSignInAt).toBe('2024-01-01T12:00:00.000Z');
    expect(row.accounts.find(item => item.id === secondLogin)?.lastSignInAt).toBe('2025-02-03T12:00:00.000Z');
    expect(row.accounts.find(item => item.id === neverLogin)?.lastSignInAt).toBeNull();
    expect(row.lastSignInAt).toBe('2025-02-03T12:00:00.000Z');
    const wide = await read(adminCookie);
    expect(wide.statusCode).toBe(200);
    expect(find(employees(wide.json()), linked).lastSignInAt).toBe('2026-03-04T12:00:00.000Z');
  });

  it('FINDING R6 high: department or wrong-operator grants must not become estate access; refuse unusable read reach and unauthenticated requests', async () => {
    await readerGrant('department', centralDepartment);
    expect((await read()).statusCode).toBe(403);
    await readerGrant('operator', foreignOperator);
    expect((await read()).statusCode).toBe(403);
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, managerId));
    expect((await read()).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/employees' })).statusCode).toBe(401);
  });

  it('FINDING R7 high: a search must not bypass the directory fence; apply reach before matching and keep tenant results separate', async () => {
    const own = await read(managerCookie, '?q=unique%20mirror%20nickname');
    expect(own.statusCode).toBe(200);
    expect(employees(own.json()).map(row => row.id)).toEqual([mirrored]);
    const hidden = await read(managerCookie, '?q=foreign%20person');
    expect(hidden.statusCode).toBe(200);
    expect(employees(hidden.json())).toEqual([]);
    const outside = await read(foreignCookie);
    expect(outside.statusCode).toBe(200);
    const outsideRows = employees(outside.json());
    expect(outsideRows.some(row => row.id === foreignPerson)).toBe(true);
    expect(outsideRows.some(row => row.id === linked)).toBe(false);
    const wide = await read(adminCookie);
    expect(wide.statusCode).toBe(200);
    expect(find(employees(wide.json()), branchless).branch).toBeNull();
  });

  it('FINDING R8 critical: reading the mirror must never repair identities or change business data; leave employee, account, department and grants untouched', async () => {
    const snapshot = async () => createHash('sha256').update(JSON.stringify({
      employees: await ctx.db.select().from(employee).orderBy(employee.id),
      accounts: await ctx.db.select().from(account).orderBy(account.id),
      departments: await ctx.db.select().from(department).orderBy(department.id),
      assignments: await ctx.db.select().from(roleAssignment).orderBy(roleAssignment.id),
      identities: await ctx.db.select().from(appIdentity).orderBy(appIdentity.id),
      roles: await ctx.db.select().from(role).orderBy(role.id),
      rolePermissions: await ctx.db.select().from(rolePermission).orderBy(rolePermission.id),
    })).digest('hex');
    const before = await snapshot();
    expect((await read()).statusCode).toBe(200);
    expect((await read(adminCookie)).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(ctx.smsLog).toEqual([]);
  });
});
