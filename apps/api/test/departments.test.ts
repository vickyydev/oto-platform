import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, department, employee, role, roleAssignment } from '@oto/db';
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
let central: string;
let centralName: string;
let ownDepartment: string;
let sameNameDepartment: string;
let awayDepartment: string;
let operatorDepartment: string;
let foreignDepartment: string;
let malformedDepartment: string;
let emptyDepartment: string;

interface DepartmentRow {
  id: string;
  name: string;
  branch: { id: string; name: string } | null;
  memberCount: number;
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const parks = await ctx.db.select().from(branch);
  const home = parks.find(row => row.code === 'hkt-central')!;
  const away = parks.find(row => row.code === 'robinson-chalong')!;
  const foreign = parks.find(row => row.code === 'second-operator-1')!;
  central = home.id; centralName = home.name;
  ownDepartment = newId(); sameNameDepartment = newId(); awayDepartment = newId(); operatorDepartment = newId();
  foreignDepartment = newId(); malformedDepartment = newId(); emptyDepartment = newId();
  await ctx.db.insert(department).values([
    { id: ownDepartment, operatorId: home.operatorId, branchId: home.id, name: 'ZZ TEST Department directory home' },
    { id: sameNameDepartment, operatorId: home.operatorId, branchId: home.id, name: 'ZZ TEST Department directory home' },
    { id: awayDepartment, operatorId: home.operatorId, branchId: away.id, name: 'ZZ TEST Department directory away' },
    { id: operatorDepartment, operatorId: home.operatorId, name: 'ZZ TEST Department directory operator' },
    { id: foreignDepartment, operatorId: foreign.operatorId, branchId: foreign.id, name: 'ZZ TEST Department directory foreign' },
    { id: malformedDepartment, operatorId: home.operatorId, branchId: foreign.id, name: 'ZZ TEST Department directory malformed' },
    { id: emptyDepartment, operatorId: home.operatorId, branchId: home.id, name: 'ZZ TEST Department directory empty' },
  ]);
  const homeEmployee = newId();
  const awayEmployee = newId();
  await ctx.db.insert(employee).values([
    { id: homeEmployee, operatorId: home.operatorId, branchId: home.id, departmentId: ownDepartment, name: 'ZZ TEST Department active member' },
    { id: newId(), operatorId: home.operatorId, branchId: home.id, departmentId: ownDepartment, name: 'ZZ TEST Department archived member', archivedAt: new Date('2026-01-02T03:04:05Z') },
    { id: awayEmployee, operatorId: home.operatorId, branchId: away.id, departmentId: ownDepartment, name: 'ZZ TEST Department other park member' },
    { id: newId(), operatorId: home.operatorId, departmentId: ownDepartment, name: 'ZZ TEST Department branchless member' },
    { id: newId(), operatorId: foreign.operatorId, branchId: foreign.id, departmentId: ownDepartment, name: 'ZZ TEST Department foreign member' },
    { id: newId(), operatorId: home.operatorId, branchId: foreign.id, departmentId: ownDepartment, name: 'ZZ TEST Department corrupt park member' },
    { id: newId(), operatorId: home.operatorId, branchId: home.id, departmentId: operatorDepartment, name: 'ZZ TEST Operator department member' },
    { id: newId(), operatorId: home.operatorId, branchId: away.id, departmentId: awayDepartment, name: 'ZZ TEST Away department member' },
    { id: newId(), operatorId: foreign.operatorId, branchId: foreign.id, departmentId: foreignDepartment, name: 'ZZ TEST Foreign department member' },
  ]);
  const homeLogin = newId();
  const secondHomeLogin = newId();
  const awayLogin = newId();
  await ctx.db.insert(account).values([
    { id: homeLogin, operatorId: home.operatorId, employeeId: homeEmployee, phone: '+66999006151', status: 'active' },
    { id: secondHomeLogin, operatorId: home.operatorId, employeeId: homeEmployee, phone: '+66999006152', status: 'active' },
    { id: awayLogin, operatorId: home.operatorId, employeeId: awayEmployee, phone: '+66999006153', status: 'active' },
  ]);
  const [staffRole] = await ctx.db.select({ id: role.id }).from(role).where(eq(role.name, 'staff'));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: awayLogin, roleId: staffRole!.id, scopeType: 'branch', scopeId: central });
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });
const get = (query = '', cookie = admin) => ctx.app.inject({ method: 'GET', url: '/departments' + query, headers: { cookie } });
const rows = (response: Awaited<ReturnType<typeof get>>): DepartmentRow[] => response.json().departments;

describe('SCRUM-615 read-only department directory', () => {
  it('shows existing own departments, their valid park or operator scope and zero counts', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(rows(response).find(row => row.id === ownDepartment)).toEqual({ id: ownDepartment,
      name: 'ZZ TEST Department directory home', branch: { id: central, name: centralName }, memberCount: 4 });
    expect(rows(response).find(row => row.id === operatorDepartment)).toMatchObject({ branch: null, memberCount: 1 });
    expect(rows(response).find(row => row.id === emptyDepartment)?.memberCount).toBe(0);
    expect(rows(response).find(row => row.id === sameNameDepartment)?.memberCount).toBe(0);
    const duplicateNames = rows(response).filter(row => [ownDepartment, sameNameDepartment].includes(row.id)).map(row => row.id);
    expect(duplicateNames).toEqual([ownDepartment, sameNameDepartment].sort());
  });

  it('filters departments and member counts independently by canonical employee branch reach', async () => {
    const response = await get('', manager);
    expect(response.statusCode).toBe(200);
    expect(rows(response).find(row => row.id === ownDepartment)?.memberCount).toBe(2);
    expect(rows(response).map(row => row.id)).toContain(emptyDepartment);
    expect(rows(response).some(row => [awayDepartment, operatorDepartment, foreignDepartment, malformedDepartment].includes(row.id))).toBe(false);
    // An archived row still counts; two logins do not duplicate an employee,
    // and an account's local grant does not pull its away employee into reach.
  });

  it('never exposes a foreign or malformed department, branch name or foreign member count', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(rows(response).some(row => [foreignDepartment, malformedDepartment].includes(row.id))).toBe(false);
    expect(rows(response).find(row => row.id === ownDepartment)?.memberCount).toBe(4);
    const foreign = await get('', foreignAdmin);
    expect(foreign.statusCode).toBe(200);
    expect(rows(foreign).find(row => row.id === foreignDepartment)?.memberCount).toBe(1);
    expect(rows(foreign).some(row => [ownDepartment, operatorDepartment, malformedDepartment].includes(row.id))).toBe(false);
  });

  it('searches visible department and park names, with a genuine empty result', async () => {
    const named = await get('?q=' + encodeURIComponent('ZZ TEST Department directory home'));
    expect(named.statusCode).toBe(200);
    expect(rows(named).map(row => row.id)).toEqual([ownDepartment, sameNameDepartment].sort());
    const park = await get('?q=' + encodeURIComponent(centralName), manager);
    expect(park.statusCode).toBe(200);
    expect(rows(park).map(row => row.id)).toContain(ownDepartment);
    expect(rows(park).every(row => row.branch?.id === central)).toBe(true);
    const empty = await get('?q=' + encodeURIComponent('ZZ TEST Department directory malformed'));
    expect(empty.statusCode).toBe(200); expect(rows(empty)).toEqual([]);
    const absent = await get('?q=' + encodeURIComponent('ZZ TEST No such department'));
    expect(absent.statusCode).toBe(200); expect(rows(absent)).toEqual([]);
  });

  it('validates query input and keeps the authentication and account-read permission gate', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/departments' })).statusCode).toBe(401);
    expect((await get('', reception)).statusCode).toBe(403);
    expect((await get('?q=one&q=two')).statusCode).toBe(400);
  });

  it('reads department membership without changing core records or auditing a mutation', async () => {
    const before = await ctx.db.select().from(department);
    const employeesBefore = await ctx.db.select().from(employee);
    const auditIds = await ctx.db.select({ id: auditLog.id }).from(auditLog);
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(await ctx.db.select().from(department)).toEqual(before);
    expect(await ctx.db.select().from(employee)).toEqual(employeesBefore);
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog)).toEqual(auditIds);
  });
});
