import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantCovers, hasPermission, type EffectivePermission } from '../src/services/permissions';
import {
  anyBranchReach,
  branchReach,
  holdsGrantAt,
  reachCovers,
  seatReachOf,
} from '../src/services/access-control';
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

  it('an operator-only target is covered by an operator-scoped grant alone (SCRUM-606)', () => {
    const T = { operatorId: OP, operatorOnly: true } as const;
    expect(grantCovers(g('operator', OP), T)).toBe(true);
    expect(grantCovers(g('operator', null), T)).toBe(true);
    expect(grantCovers(g('operator', 'other'), T)).toBe(false);
    // Even when a branch id rides along, a grant at one park is not the operator.
    expect(grantCovers(g('branch', BR), { ...T, branchId: BR })).toBe(false);
    expect(grantCovers(g('department', 'd1'), { ...T, departmentId: 'd1' })).toBe(false);
    expect(grantCovers(g('record', 'r1'), { ...T, recordId: 'r1' })).toBe(false);
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

describe('seat reach — where a session may start (SCRUM-592)', () => {
  const OP = 'op-1';
  const READ = 'inbox:conversation:read' as EffectivePermission['permission'];
  const LIVE = ['b-central', 'b-chalong'];
  const DEPTS = [
    { id: 'd-reception-central', branchId: 'b-central' },
    { id: 'd-reception-chalong', branchId: 'b-chalong' },
    { id: 'd-birthdays', branchId: null },
    { id: 'd-closed', branchId: 'b-archived' },
  ];

  it('a department at a branch seats at that branch, and only that branch', () => {
    const effective = [g('department', 'd-reception-central', READ)];
    const reach = seatReachOf(effective, OP, DEPTS, LIVE);
    expect(reach).toEqual({ kind: 'branches', branchIds: ['b-central'] });
    expect(reachCovers(reach, 'b-chalong')).toBe(false);
  });

  it('a branchless department seats operator-wide, as an operator grant would', () => {
    expect(seatReachOf([g('department', 'd-birthdays', READ)], OP, DEPTS, LIVE)).toEqual({ kind: 'operator' });
  });

  it('mixed: a live concrete branch wins over a branchless department', () => {
    const effective = [g('department', 'd-birthdays', READ), g('branch', 'b-chalong', READ)];
    expect(seatReachOf(effective, OP, DEPTS, LIVE)).toEqual({ kind: 'branches', branchIds: ['b-chalong'] });
    const viaDept = [g('department', 'd-birthdays', READ), g('department', 'd-reception-central', READ)];
    expect(seatReachOf(viaDept, OP, DEPTS, LIVE)).toEqual({ kind: 'branches', branchIds: ['b-central'] });
  });

  it('mixed: a department and a branch grant union, without a third branch', () => {
    const effective = [g('department', 'd-reception-central', READ), g('branch', 'b-chalong', READ)];
    const reach = seatReachOf(effective, OP, DEPTS, [...LIVE, 'b-third']);
    expect(reach.kind).toBe('branches');
    expect(reachCovers(reach, 'b-central')).toBe(true);
    expect(reachCovers(reach, 'b-chalong')).toBe(true);
    expect(reachCovers(reach, 'b-third')).toBe(false);
  });

  it('an operator grant is still operator-wide', () => {
    expect(seatReachOf([g('operator', OP, READ)], OP, DEPTS, LIVE)).toEqual({ kind: 'operator' });
  });

  it('a branchless department falls back to operator-wide when the concrete branch is archived', () => {
    const effective = [g('department', 'd-birthdays', READ), g('department', 'd-closed', READ)];
    expect(seatReachOf(effective, OP, DEPTS, LIVE)).toEqual({ kind: 'operator' });
  });

  it('a department of another operator (not in the loaded list) seats nowhere', () => {
    expect(seatReachOf([g('department', 'd-elsewhere', READ)], OP, DEPTS, LIVE)).toEqual({
      kind: 'branches',
      branchIds: [],
    });
  });

  it('changes nothing the grant permits: grantCovers and anyBranchReach still read no branch', () => {
    const effective = [g('department', 'd-reception-central', READ), g('department', 'd-birthdays', READ)];
    expect(hasPermission(effective, READ, { operatorId: OP, branchId: 'b-central' })).toBe(false);
    expect(anyBranchReach(effective, OP)).toEqual({ kind: 'branches', branchIds: [] });
    expect(holdsGrantAt(effective, OP, 'b-central')).toBe(false);
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
