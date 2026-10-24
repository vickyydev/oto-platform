import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, appIdentity, branch, department, employee, role, roleAssignment, rolePermission, session } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE,
  branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

interface DepartmentRow { id: string; name: string; branch: { id: string; name: string } | null; memberCount: number }
let ctx: TestContext;
let admin: string, manager: string, foreignAdmin: string, managerId: string;
let operatorId: string, foreignOperator: string, central: string, chalong: string, foreignPark: string, readRole: string;
let local: string, empty: string, remote: string, branchless: string, foreignDepartment: string, corruptDepartment: string;
let serial = 0;

const read = (cookie = manager, query = '') => ctx.app.inject({ method: 'GET', url: `/departments${query}`, headers: { cookie } });
const rows = (body: { departments: DepartmentRow[] }) => body.departments;
const find = (list: DepartmentRow[], id: string) => {
  const row = list.find(item => item.id === id);
  expect(row, `expected department ${id}`).toBeDefined(); return row!;
};
async function team(name: string, park: string | null, owner = operatorId) {
  const id = newId();
  await ctx.db.insert(department).values({ id, operatorId: owner, branchId: park, name: `ZZ TEST Departments review ${name}` });
  return id;
}
async function person(departmentId: string, park: string | null, options: Partial<typeof employee.$inferInsert> = {}) {
  const id = newId();
  await ctx.db.insert(employee).values({ id, operatorId, departmentId, branchId: park,
    name: `ZZ TEST Departments review member ${++serial}`, ...options });
  return id;
}
async function grants(scopeType: 'branch' | 'department' | 'operator', scopeIds: string[]) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, managerId));
  if (scopeIds.length) await ctx.db.insert(roleAssignment).values(scopeIds.map(scopeId => ({
    id: newId(), accountId: managerId, roleId: readRole, scopeType, scopeId,
  })));
}

beforeAll(async () => {
  // This is the seeded core directory, not the later OTO App department mirror.
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [reader] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  managerId = reader!.id; operatorId = reader!.operatorId;
  const [outside] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  foreignOperator = outside!.operatorId;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE); chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [outsidePark] = await ctx.db.select().from(branch).where(eq(branch.operatorId, foreignOperator));
  foreignPark = outsidePark!.id;
  readRole = newId();
  await ctx.db.insert(role).values({ id: readRole, operatorId, name: 'ZZ TEST Departments review read only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: readRole, permission: 'admin:account:read' });
  local = await team('local', central); empty = await team('empty', central); remote = await team('remote', chalong);
  branchless = await team('operator-wide', null);
  foreignDepartment = await team('foreign', foreignPark, foreignOperator);
  corruptDepartment = await team('foreign park reference', foreignPark);
  const member = await person(local, central);
  await person(local, central, { archivedAt: new Date('2025-01-01T00:00:00.000Z') });
  await person(local, central, { source: 'otoapp', externalId: 'zz-test-department-count/source' });
  await person(local, chalong); await person(local, null);
  await person(local, foreignPark, { operatorId: foreignOperator });
  await person(local, foreignPark);
  await person(remote, central);
  await person(branchless, central); await person(branchless, chalong); await person(branchless, null);
  await person(branchless, foreignPark);
  await person(foreignDepartment, foreignPark, { operatorId: foreignOperator });
  await person(foreignDepartment, central);
  await person(corruptDepartment, central);
  // More than one login for one employee must never multiply membership.
  await ctx.db.insert(account).values([
    { id: newId(), operatorId, employeeId: member, phone: '+66999615001', status: 'active' },
    { id: newId(), operatorId, employeeId: member, phone: '+66999615002', status: 'inactive' },
  ]);
}, 180_000);
beforeEach(async () => {
  await grants('branch', [central]);
  await ctx.db.update(session).set({ branchId: central }).where(eq(session.accountId, managerId));
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

/** SCRUM-615 house review: meaningful passing pins name the fix each boundary requires. */
describe('SCRUM-615 Departments adversarial review', () => {
  it('FINDING R1 high: a visible member must not make its remote or operator-wide department visible; filter department reach independently', async () => {
    const response = await read(); expect(response.statusCode).toBe(200);
    const list = rows(response.json());
    expect(find(list, local).branch?.id).toBe(central); expect(find(list, empty).memberCount).toBe(0);
    for (const hidden of [remote, branchless, foreignDepartment, corruptDepartment]) expect(list.some(item => item.id === hidden)).toBe(false);
  });

  it('FINDING R2 high: an unreadable employee or duplicate login must not inflate counts; count each visible employee including archived copies', async () => {
    const scoped = await read(); expect(scoped.statusCode).toBe(200);
    expect(find(rows(scoped.json()), local).memberCount).toBe(3);
    const wide = await read(admin); expect(wide.statusCode).toBe(200);
    expect(find(rows(wide.json()), local).memberCount).toBe(5);
    expect(find(rows(wide.json()), remote).memberCount).toBe(1);
    expect(find(rows(wide.json()), branchless)).toMatchObject({ branch: null, memberCount: 3 });
  });

  it('FINDING R3 critical: corrupt department or employee park references must not expose foreign names or counts even operator-wide; fence every join', async () => {
    const response = await read(admin); expect(response.statusCode).toBe(200);
    const list = rows(response.json());
    expect(find(list, local).memberCount).toBe(5);
    for (const hidden of [foreignDepartment, corruptDepartment, foreignPark, 'ZZ TEST Departments review foreign']) {
      expect(JSON.stringify(response.json())).not.toContain(hidden);
    }
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['archivedAt', 'branch', 'externalId', 'id', 'memberCount', 'name', 'source']);
      expect(Number.isInteger(item.memberCount) && item.memberCount >= 0).toBe(true);
    }
  });

  it('FINDING R4 high: the session seat must not discard another granted park; read the union of grants after the existing seat gate', async () => {
    await grants('branch', [central, chalong]);
    const first = await read(); expect(first.statusCode).toBe(200);
    const firstList = rows(first.json());
    expect(find(firstList, local).memberCount).toBe(4); expect(find(firstList, remote).memberCount).toBe(1);
    expect(firstList.some(item => item.id === branchless)).toBe(false);
    await ctx.db.update(session).set({ branchId: chalong }).where(eq(session.accountId, managerId));
    const second = await read(); expect(second.statusCode).toBe(200);
    expect(rows(second.json())).toEqual(firstList);
  });

  it('FINDING R5 high: a department grant, foreign grant or unreadable seat must not bypass account authorization; retain the existing route gate', async () => {
    try {
      await ctx.db.update(session).set({ branchId: chalong }).where(eq(session.accountId, managerId));
      expect((await read()).statusCode).toBe(403);
    } finally {
      await ctx.db.update(session).set({ branchId: central }).where(eq(session.accountId, managerId));
    }
    await grants('department', [local]); expect((await read()).statusCode).toBe(403);
    await grants('operator', [foreignOperator]); expect((await read()).statusCode).toBe(403);
    await grants('branch', []); expect((await read()).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/departments' })).statusCode).toBe(401);
  });

  it('FINDING R6 high: search must not widen the directory or rewrite counts; filter names within reach and reject repeated query values', async () => {
    const localSearch = await read(manager, '?q=Departments%20review%20local'); expect(localSearch.statusCode).toBe(200);
    expect(rows(localSearch.json()).map(item => item.id)).toEqual([local]);
    expect(rows(localSearch.json())[0]!.memberCount).toBe(3);
    const hiddenSearch = await read(manager, '?q=Departments%20review%20foreign'); expect(hiddenSearch.statusCode).toBe(200);
    expect(rows(hiddenSearch.json())).toEqual([]);
    expect((await read(manager, '?q=local&q=foreign')).statusCode).toBe(400);
  });

  it('FINDING R7 critical: another operator must not see local membership through a corrupt employee link; scope both department and employee rows', async () => {
    const response = await read(foreignAdmin); expect(response.statusCode).toBe(200);
    expect(find(rows(response.json()), foreignDepartment).memberCount).toBe(1);
    for (const hidden of [local, empty, remote, branchless, corruptDepartment]) expect(rows(response.json()).some(item => item.id === hidden)).toBe(false);
  });

  it('FINDING R8 critical: a directory read must not reconcile the later mirror or change teams and identities; keep business rows unchanged', async () => {
    const fingerprint = async () => createHash('sha256').update(JSON.stringify({
      departments: await ctx.db.select().from(department).orderBy(department.id),
      employees: await ctx.db.select().from(employee).orderBy(employee.id),
      accounts: await ctx.db.select().from(account).orderBy(account.id),
      assignments: await ctx.db.select().from(roleAssignment).orderBy(roleAssignment.id),
      identities: await ctx.db.select().from(appIdentity).orderBy(appIdentity.id),
    })).digest('hex');
    const before = await fingerprint();
    expect((await read()).statusCode).toBe(200); expect((await read(admin)).statusCode).toBe(200);
    expect(await fingerprint()).toBe(before); expect(ctx.smsLog).toEqual([]);
  });
});
