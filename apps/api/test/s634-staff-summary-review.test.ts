import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, branch, operator, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import {
  BRANCH_MANAGER, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE, branchIdByCode,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let cookie: string;
let accountId: string;
let operatorId: string;
let central: string;
let chalong: string;
let foreign: string;
let readRole: string;
let appRole: string;
const read = (query = '') => ctx.app.inject({ method: 'GET', url: `/staff/summary${query}`, headers: { cookie } });
async function grants(rows: Array<{ roleId: string; scopeId: string; scopeType?: 'branch' | 'operator' }>) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, accountId));
  if (rows.length) await ctx.db.insert(roleAssignment).values(rows.map(row => ({
    id: newId(), accountId, roleId: row.roleId, scopeType: row.scopeType ?? 'branch', scopeId: row.scopeId,
  })));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [person] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  accountId = person!.id; operatorId = person!.operatorId!;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const foreignOperator = newId(); foreign = newId(); readRole = newId(); appRole = newId();
  await ctx.db.insert(operator).values({ id: foreignOperator, name: 'ZZ TEST Staff summary foreign operator' });
  await ctx.db.insert(branch).values({ id: foreign, operatorId: foreignOperator, code: 'zz-staff-summary-foreign', name: 'ZZ TEST Staff summary foreign park' });
  await ctx.db.insert(role).values([
    { id: readRole, operatorId, name: 'ZZ TEST Staff summary account read' },
    { id: appRole, operatorId, name: 'ZZ TEST Staff summary app access' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: readRole, permission: 'admin:account:read' },
    { id: newId(), roleId: appRole, permission: 'app:oto_app:access' },
  ]);
}, 180_000);
beforeEach(async () => grants([{ roleId: readRole, scopeId: central }, { roleId: appRole, scopeId: central }]));
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-634 Staff summary adversarial review', () => {
  it('FINDING R1 high: both section permissions must target the selected park; expose only their intersected reachable park', async () => {
    const response = await read(`?branchId=${central}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.branches.map((b: { id: string }) => b.id)).toEqual([central]);
    expect(body.selectedBranchId).toBe(central);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(body).sort()).toEqual(['attendance', 'branches', 'date', 'generatedAt', 'leave', 'payroll', 'selectedBranchId', 'source', 'working']);
    expect(JSON.stringify(body)).not.toContain(chalong);
    expect(JSON.stringify(body)).not.toContain(foreign);
  });

  it('FINDING R2 high: app access alone cannot authorize staff headlines; refuse before opening an app session', async () => {
    await grants([{ roleId: appRole, scopeId: central }]);
    expect((await read(`?branchId=${central}`)).statusCode).toBe(403);
  });

  it('FINDING R3 high: account-read alone cannot authorize an acting-user app read; retain the app access check', async () => {
    await grants([{ roleId: readRole, scopeId: central }]);
    expect((await read(`?branchId=${central}`)).statusCode).toBe(403);
  });

  it('FINDING R4 high: grants held at different parks cannot combine into one summary permission', async () => {
    await grants([{ roleId: readRole, scopeId: central }, { roleId: appRole, scopeId: chalong }]);
    expect((await read(`?branchId=${central}`)).statusCode).toBe(403);
    expect((await read(`?branchId=${chalong}`)).statusCode).toBe(403);
  });

  it('FINDING R5 high: foreign and absent parks must share404 while an own unreachable park is403', async () => {
    const foreignResponse = await read(`?branchId=${foreign}`);
    const absentResponse = await read(`?branchId=${newId()}`);
    expect(foreignResponse.statusCode).toBe(404);
    expect(absentResponse.statusCode).toBe(404);
    expect(foreignResponse.json().error).toEqual(absentResponse.json().error);
    expect((await read(`?branchId=${chalong}`)).statusCode).toBe(403);
  });

  it('FINDING R6 high: archived parks cannot be read or offered even with both operator-wide grants', async () => {
    await grants([{ roleId: readRole, scopeId: operatorId, scopeType: 'operator' }, { roleId: appRole, scopeId: operatorId, scopeType: 'operator' }]);
    const archived = newId();
    await ctx.db.insert(branch).values({ id: archived, operatorId, code: 'zz-staff-summary-archived', name: 'ZZ TEST Staff summary archived', archivedAt: new Date() });
    const response = await read(`?branchId=${central}`);
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(archived);
    expect((await read(`?branchId=${archived}`)).statusCode).toBe(404);
  });

  it('FINDING R7 medium: malformed, repeated and extra target filters must be rejected before any upstream request', async () => {
    expect((await read('?branchId=invalid')).statusCode).toBe(400);
    expect((await read(`?branchId=${central}&branchId=${chalong}`)).statusCode).toBe(400);
    expect((await read(`?branchId=${central}&operatorId=${newId()}`)).statusCode).toBe(400);
  });

  it('FINDING R8 high: an unavailable app must never masquerade as zero staff, no issues or a blank payroll', async () => {
    const response = await read(`?branchId=${central}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toBe('not-configured');
    for (const key of ['working', 'attendance', 'leave']) expect(body[key]).toEqual({ status: 'unavailable', count: null, asOf: null });
    expect(body.payroll).toEqual({ status: 'unavailable', month: null, entities: [] });
    expect(JSON.stringify(body)).not.toMatch(/password|connect\.sid|sessionToken|bankAccount|salary/i);
  });
});
