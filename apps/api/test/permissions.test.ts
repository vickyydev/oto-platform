import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantCovers, hasPermission, type EffectivePermission } from '../src/services/permissions';
import { branchReach } from '../src/services/access-control';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const g = (
  scopeType: EffectivePermission['scopeType'],
  scopeId: string | null,
  permission = 'pos:member:read' as EffectivePermission['permission'],
): EffectivePermission => ({ permission, scopeType, scopeId, roleName: 'x' });

describe('permission resolver — scope combinations (SCRUM-13)', () => {
  const OP = 'op-1';
  const BR = 'br-1';

  it('operator scope covers everything in that operator', () => {
    expect(grantCovers(g('operator', OP), { operatorId: OP })).toBe(true);
    expect(grantCovers(g('operator', OP), { operatorId: OP, branchId: BR })).toBe(true);
    expect(grantCovers(g('operator', 'other'), { operatorId: OP })).toBe(false);
  });

  it('platform-wide (operator scope, null id) covers every operator', () => {
    expect(grantCovers(g('operator', null), { operatorId: OP })).toBe(true);
    expect(grantCovers(g('operator', null), { operatorId: 'anything' })).toBe(true);
  });

  it('branch scope covers only that branch', () => {
    expect(grantCovers(g('branch', BR), { operatorId: OP, branchId: BR })).toBe(true);
    expect(grantCovers(g('branch', BR), { operatorId: OP, branchId: 'other' })).toBe(false);
    expect(grantCovers(g('branch', BR), { operatorId: OP })).toBe(false); // no branch target
  });

  it('department and record scopes match their ids', () => {
    expect(grantCovers(g('department', 'd1'), { operatorId: OP, departmentId: 'd1' })).toBe(true);
    expect(grantCovers(g('department', 'd1'), { operatorId: OP, departmentId: 'd2' })).toBe(false);
    expect(grantCovers(g('record', 'r1'), { operatorId: OP, recordId: 'r1' })).toBe(true);
    expect(grantCovers(g('record', 'r1'), { operatorId: OP })).toBe(false);
  });

  it('effective permissions are a union — any covering grant allows', () => {
    const effective = [g('branch', 'b-other'), g('operator', OP)];
    expect(hasPermission(effective, 'pos:member:read', { operatorId: OP, branchId: BR })).toBe(true);
    expect(hasPermission(effective, 'pos:member:create', { operatorId: OP })).toBe(false); // wrong permission
  });
});

/**
 * SCRUM-249 — the question a LIST route asks, which is the inverse of the one
 * `grantCovers` answers: not "may I act on this branch" but "which branches go
 * in the answer".
 */
describe('branch reach — what a list route may return (SCRUM-249)', () => {
  const OP = 'op-1';
  const READ = 'admin:account:read' as EffectivePermission['permission'];
  const OTHER = 'admin:audit:read' as EffectivePermission['permission'];

  it('an operator-wide grant reaches every branch, including ones not open yet', () => {
    expect(branchReach([g('operator', OP, READ)], READ, OP)).toEqual({ kind: 'operator' });
  });

  it('a platform-wide grant reaches every branch of every operator', () => {
    expect(branchReach([g('operator', null, READ)], READ, OP)).toEqual({ kind: 'operator' });
    expect(branchReach([g('operator', null, READ)], READ, 'another-op')).toEqual({ kind: 'operator' });
  });

  it("another operator's operator-scoped grant reaches nothing here", () => {
    expect(branchReach([g('operator', 'op-2', READ)], READ, OP)).toEqual({
      kind: 'branches',
      branchIds: [],
    });
  });

  it('branch grants reach exactly their branches, de-duplicated', () => {
    const effective = [g('branch', 'b1', READ), g('branch', 'b2', READ), g('branch', 'b1', READ)];
    const reach = branchReach(effective, READ, OP);
    expect(reach.kind).toBe('branches');
    expect(reach.kind === 'branches' && [...reach.branchIds].sort()).toEqual(['b1', 'b2']);
  });

  it('reads only the permission asked for', () => {
    expect(branchReach([g('operator', OP, OTHER)], READ, OP)).toEqual({
      kind: 'branches',
      branchIds: [],
    });
  });

  it('holding it nowhere is a real answer, not an unfiltered one', () => {
    expect(branchReach([], READ, OP)).toEqual({ kind: 'branches', branchIds: [] });
  });

  it('department and record grants name no branch, the same answer grantCovers gives them', () => {
    expect(grantCovers(g('department', 'd1', READ), { operatorId: OP, branchId: 'b1' })).toBe(false);
    const effective = [g('department', 'd1', READ), g('record', 'r1', READ)];
    expect(branchReach(effective, READ, OP)).toEqual({ kind: 'branches', branchIds: [] });
  });

  it('one operator-wide grant wins over any number of branch ones', () => {
    const effective = [g('branch', 'b1', READ), g('operator', OP, READ), g('branch', 'b2', READ)];
    expect(branchReach(effective, READ, OP)).toEqual({ kind: 'operator' });
  });
});

describe('permission guard — integration (SCRUM-13)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
    await teardownAll();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/members/lookup?phone=0811111111' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('allows a branch-scoped reception grant on its branch target', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.nickname).toBe('Mali');
  });

  it('denies reception a permission outside its bundle (branch create)', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      payload: { name: 'X', code: 'x-branch' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /me/permissions returns effective permissions with scopes', async () => {
    const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({ method: 'GET', url: '/me/permissions', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const perms = res.json().permissions as Array<{ permission: string; scopeType: string }>;
    expect(perms.length).toBeGreaterThan(10);
    expect(perms.some((p) => p.scopeType === 'operator')).toBe(true);
  });
});
