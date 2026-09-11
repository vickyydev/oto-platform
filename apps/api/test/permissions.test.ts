import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantCovers, hasPermission, type EffectivePermission } from '../src/services/permissions';
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
