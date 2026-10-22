import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, department, employee, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let foreignAdmin: string;
let operatorId: string;
let central: string;
let chalong: string;
let nativeId: string;
let mirroredId: string;
let awayId: string;
let branchlessId: string;
let foreignId: string;
let firstLogin: string;
let secondLogin: string;
let departmentId: string;
let signedInAt: string;
const externalId = 'zz-test-oto-employee-' + newId();

interface EmployeeRow {
  id: string;
  name: string;
  nickname: string | null;
  source: 'platform' | 'otoapp';
  externalId: string | null;
  archivedAt: string | null;
  branch: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  accounts: Array<{ id: string; phone: string; status: string; lastSignInAt: string | null }>;
  lastSignInAt: string | null;
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const parks = await ctx.db.select().from(branch);
  const home = parks.find(row => row.code === 'hkt-central')!;
  const outside = parks.find(row => row.code === 'second-operator-1')!;
  operatorId = home.operatorId;
  central = home.id;
  chalong = parks.find(row => row.code === 'robinson-chalong')!.id;
  departmentId = newId();
  await ctx.db.insert(department).values({ id: departmentId, operatorId, branchId: central, name: 'ZZ TEST Employee directory department' });
  nativeId = newId(); mirroredId = newId(); awayId = newId(); branchlessId = newId(); foreignId = newId();
  await ctx.db.insert(employee).values([
    { id: nativeId, operatorId, branchId: central, departmentId, name: 'ZZ TEST Native employee directory', nickname: 'ZZ TEST Directory nickname' },
    { id: mirroredId, operatorId, branchId: central, source: 'otoapp', externalId, name: 'ZZ TEST Mirrored employee directory', archivedAt: new Date('2026-01-02T03:04:05Z') },
    { id: awayId, operatorId, branchId: chalong, name: 'ZZ TEST Away employee directory' },
    { id: branchlessId, operatorId, name: 'ZZ TEST Branchless employee directory' },
    { id: foreignId, operatorId: outside.operatorId, branchId: outside.id, name: 'ZZ TEST Foreign employee directory' },
  ]);
  firstLogin = newId(); secondLogin = newId();
  const branchlessLogin = newId();
  await ctx.db.insert(account).values([
    { id: firstLogin, operatorId, employeeId: nativeId, phone: '+66999006141', status: 'active', passwordHash: await hash(RECEPTION.password) },
    { id: secondLogin, operatorId, employeeId: nativeId, phone: '+66999006142', status: 'active' },
    { id: branchlessLogin, operatorId, employeeId: branchlessId, phone: '+66999006143', status: 'active' },
  ]);
  const [staffRole] = await ctx.db.select({ id: role.id }).from(role).where(eq(role.name, 'staff'));
  const [managerAccount] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  const seatRole = newId();
  await ctx.db.insert(role).values({ id: seatRole, operatorId, name: 'ZZ TEST Employee directory away seat' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: seatRole, permission: 'app:pos:access' });
  await ctx.db.insert(roleAssignment).values([
    { id: newId(), accountId: firstLogin, roleId: staffRole!.id, scopeType: 'branch', scopeId: central },
    { id: newId(), accountId: branchlessLogin, roleId: staffRole!.id, scopeType: 'branch', scopeId: central },
    // A seat at the other park permits moving there; it adds no account-read reach.
    { id: newId(), accountId: managerAccount!.id, roleId: seatRole, scopeType: 'branch', scopeId: chalong },
  ]);
  const cookie = await signInAs(ctx.app, '+66999006141', RECEPTION.password);
  const signedOut = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie } });
  expect(signedOut.statusCode).toBe(200);
  const [entry] = await ctx.db.select({ createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.actorAccountId, firstLogin), eq(auditLog.action, 'auth.sign_in')));
  signedInAt = entry!.createdAt.toISOString();
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

const get = (query = '', cookie = admin) => ctx.app.inject({ method: 'GET', url: '/employees' + query, headers: { cookie } });
const rows = (response: Awaited<ReturnType<typeof get>>): EmployeeRow[] => response.json().employees;

describe('SCRUM-614 read-only employee directory', () => {
  it('shows native and mirrored source, existing department and every linked login honestly', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    const native = rows(response).find(row => row.id === nativeId)!;
    expect(native).toMatchObject({ id: nativeId, source: 'platform', externalId: null, archivedAt: null,
      branch: { id: central }, department: { id: departmentId, name: 'ZZ TEST Employee directory department' } });
    expect(native.accounts.map(row => row.id).sort()).toEqual([firstLogin, secondLogin].sort());
    expect(native.accounts.find(row => row.id === firstLogin)).toMatchObject({ phone: '+66999006141', status: 'active', lastSignInAt: signedInAt });
    expect(native.accounts.find(row => row.id === secondLogin)?.lastSignInAt).toBeNull();
    expect(native.lastSignInAt).toBe(signedInAt);
    expect(rows(response).find(row => row.id === mirroredId)).toMatchObject({ source: 'otoapp', externalId,
      archivedAt: '2026-01-02T03:04:05.000Z', department: null, accounts: [], lastSignInAt: null });
  });

  it('preserves the seated-branch route gate and filters authorized reads by employee reach', async () => {
    const moved = await ctx.app.inject({ method: 'PUT', url: '/me/session/branch', headers: { cookie: manager }, payload: { branchId: chalong } });
    expect(moved.statusCode).toBe(200);
    expect((await get('', manager)).statusCode).toBe(403);
    const reset = await ctx.app.inject({ method: 'PUT', url: '/me/session/branch', headers: { cookie: manager }, payload: { branchId: central } });
    expect(reset.statusCode).toBe(200);
    const response = await get('', manager);
    expect(response.statusCode).toBe(200);
    const ids = rows(response).map(row => row.id);
    expect(ids).toContain(nativeId); expect(ids).toContain(mirroredId);
    expect(ids).not.toContain(awayId); expect(ids).not.toContain(branchlessId); expect(ids).not.toContain(foreignId);
  });

  it('keeps operator reach inside its tenant and includes its branchless employee', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    const ids = rows(response).map(row => row.id);
    expect(ids).toContain(awayId); expect(ids).toContain(branchlessId); expect(ids).not.toContain(foreignId);
    const foreign = await get('', foreignAdmin);
    expect(foreign.statusCode).toBe(200);
    expect(rows(foreign).map(row => row.id)).toContain(foreignId);
    expect(rows(foreign).some(row => [nativeId, mirroredId, awayId, branchlessId].includes(row.id))).toBe(false);
  });

  it('searches names, nicknames and visible linked login phones without changing employee data', async () => {
    const before = await ctx.db.select().from(employee);
    const accountsBefore = await ctx.db.select().from(account);
    const auditsBefore = await ctx.db.select({ id: auditLog.id }).from(auditLog);
    for (const query of ['ZZ TEST Native employee directory', 'ZZ TEST Directory nickname', '+66999006142']) {
      const response = await get('?q=' + encodeURIComponent(query));
      expect(response.statusCode).toBe(200);
      expect(rows(response).map(row => row.id)).toEqual([nativeId]);
    }
    const absent = await get('?q=' + encodeURIComponent('ZZ TEST No such employee directory'));
    expect(absent.statusCode).toBe(200); expect(rows(absent)).toEqual([]);
    expect(await ctx.db.select().from(employee)).toEqual(before);
    expect(await ctx.db.select().from(account)).toEqual(accountsBefore);
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog)).toEqual(auditsBefore);
  });

  it('requires authentication and the existing account-read permission', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/employees' });
    expect(anonymous.statusCode).toBe(401);
    expect((await get('', reception)).statusCode).toBe(403);
  });
});
