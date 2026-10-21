import { and, eq, isNull } from 'drizzle-orm';
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
let foreignOperator: string;
let foreignBranch: string;
let overviewRole: string;

const read = (query = '') => ctx.app.inject({ method: 'GET', url: `/overview${query}`, headers: { cookie } });
const grant = async (scopeType: 'operator' | 'branch' | 'department', scopeId: string) => {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, accountId));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId, roleId: overviewRole, scopeType, scopeId });
};

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [person] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  accountId = person!.id;
  operatorId = person!.operatorId!;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreignOperator = newId();
  foreignBranch = newId();
  overviewRole = newId();
  await ctx.db.insert(operator).values({ id: foreignOperator, name: 'ZZ TEST Overview review foreign operator' });
  await ctx.db.insert(branch).values({
    id: foreignBranch, operatorId: foreignOperator, name: 'ZZ TEST Overview review foreign park', code: 'zz-overview-review',
  });
  await ctx.db.insert(role).values({ id: overviewRole, operatorId, name: 'ZZ TEST Overview only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: overviewRole, permission: 'console:overview:read' });
});

beforeEach(async () => { await grant('branch', central); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

/** SCRUM-610 house review: each finding describes the fix its passing pin requires. */
describe('SCRUM-610 Overview adversarial review', () => {
  it('FINDING R1 high: totals must follow the overview grant, never the session branch or source-screen grants; select only the held park', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.branches.map((b: { id: string }) => b.id)).toEqual([central]);
    expect(body.selectedBranchIds).toEqual([central]);
    expect(body.parks.map((b: { branchId: string }) => b.branchId)).toEqual([central]);
    expect(Object.keys(body.totals).sort()).toEqual([
      'bookingsToday', 'boxesOffline', 'guests', 'inParkNow', 'inboxUnanswered', 'openAlerts', 'revenueSatang',
    ]);
    for (const value of Object.values(body.totals)) expect(Number.isFinite(value)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(chalong);
    expect(JSON.stringify(body)).not.toContain(foreignBranch);
  });

  it('FINDING R2 high: a guessed foreign park must be indistinguishable from a missing one; fence by operator before reporting scope', async () => {
    const foreign = await read(`?branchId=${foreignBranch}`);
    const absent = await read(`?branchId=${newId()}`);
    expect(foreign.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(absent.json().error.code);
    expect(foreign.json().error.message).toBe(absent.json().error.message);
    expect((await read(`?branchId=${chalong}`)).statusCode).toBe(403);
  });

  it('FINDING R3 high: an operator-wide grant for another operator must not widen the current operator; reject empty reach', async () => {
    await grant('operator', foreignOperator);
    expect((await read()).statusCode).toBe(403);
  });

  it('FINDING R4 high: department grants cannot imply park-wide aggregate access; reject an unresolvable park reach', async () => {
    await grant('department', newId());
    expect((await read()).statusCode).toBe(403);
  });

  it('FINDING R5 medium: a malformed or repeated park filter must never silently fall back to every park; validate the query', async () => {
    expect((await read('?branchId=invalid')).statusCode).toBe(400);
    expect((await read(`?branchId=${central}&branchId=${chalong}`)).statusCode).toBe(400);
  });

  it('FINDING R6 high: archived parks must disappear even for an operator-wide holder; filter before building the picker and totals', async () => {
    await grant('operator', operatorId);
    const archived = newId();
    await ctx.db.insert(branch).values({
      id: archived, operatorId, code: 'zz-overview-archived', name: 'ZZ TEST Overview archived', archivedAt: new Date(),
    });
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(archived);
    expect((await read(`?branchId=${archived}`)).statusCode).toBe(404);
    const expected = await ctx.db.select({ id: branch.id }).from(branch)
      .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)));
    expect(response.json().branches).toHaveLength(expected.length);
  });
});
