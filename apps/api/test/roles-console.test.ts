import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, employee, role, roleAssignment, rolePermission } from '@oto/db';
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
let chalong: string;
let operatorId: string;
let foreignOperatorId: string;
let localAccount: string;
let awayAccount: string;
let mixedAccount: string;
let ownRole: string;
let awayRole: string;
let mixedLocalAssignment: string;
let mixedAwayAssignment: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const parks = await ctx.db.select().from(branch);
  const home = parks.find((p) => p.code === 'hkt-central')!;
  central = home.id;
  operatorId = home.operatorId;
  chalong = parks.find((p) => p.code === 'robinson-chalong')!.id;
  foreignOperatorId = parks.find((p) => p.code === 'second-operator-1')!.operatorId;
  ownRole = newId();
  awayRole = newId();
  await ctx.db.insert(role).values([
    { id: ownRole, operatorId, name: 'ZZ TEST local refund reader', description: 'ZZ TEST local catalogue role' },
    { id: awayRole, operatorId: foreignOperatorId, name: 'ZZ TEST foreign secret role' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: ownRole, permission: 'pos:refund:approve' },
    { id: newId(), roleId: awayRole, permission: 'pos:refund:approve' },
  ]);
  async function person(name: string, phone: string, branchId: string) {
    const employeeId = newId();
    const id = newId();
    await ctx.db.insert(employee).values({ id: employeeId, operatorId, name, branchId });
    await ctx.db.insert(account).values({ id, operatorId, employeeId, phone, status: 'active' });
    return id;
  }
  localAccount = await person('ZZ TEST local role holder', '+66999000621', central);
  awayAccount = await person('ZZ TEST away role holder', '+66999000622', chalong);
  mixedAccount = await person('ZZ TEST mixed role holder', '+66999000623', central);
  mixedLocalAssignment = newId();
  mixedAwayAssignment = newId();
  await ctx.db.insert(roleAssignment).values([
    { id: newId(), accountId: localAccount, roleId: ownRole, scopeType: 'branch', scopeId: central },
    { id: newId(), accountId: awayAccount, roleId: ownRole, scopeType: 'branch', scopeId: chalong },
    { id: mixedLocalAssignment, accountId: mixedAccount, roleId: ownRole, scopeType: 'branch', scopeId: central },
    { id: mixedAwayAssignment, accountId: mixedAccount, roleId: ownRole, scopeType: 'branch', scopeId: chalong },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const get = (url: string, cookie = admin) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });
const preview = (change: Record<string, string>, cookie = admin) =>
  get(`/roles/preview?${new URLSearchParams(change)}`, cookie);

describe('SCRUM-612 Roles and scopes console reads', () => {
  it('catalogues system and own operator roles with words, never another operator role', async () => {
    const response = await get('/roles');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.roles.some((r: { name: string; system: boolean }) => r.name === 'reception' && r.system)).toBe(true);
    expect(body.roles.find((r: { id: string }) => r.id === ownRole)).toMatchObject({
      name: 'ZZ TEST local refund reader', system: false,
      permissions: [{ permission: 'pos:refund:approve', words: expect.any(String) }],
    });
    expect(body.roles.some((r: { id: string }) => r.id === awayRole)).toBe(false);
    expect(body.permissions.find((p: { permission: string }) => p.permission === 'admin:role:read').words.length).toBeGreaterThan(5);
    const foreign = await get('/roles', foreignAdmin);
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().roles.some((r: { id: string }) => r.id === ownRole)).toBe(false);
    expect(foreign.json().roles.some((r: { id: string }) => r.id === awayRole)).toBe(true);
  });

  it('looks up holders only inside the caller operator and readable scopes', async () => {
    const response = await get('/roles/holders?permission=pos%3Arefund%3Aapprove', manager);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.holders.some((h: { accountId: string }) => h.accountId === localAccount)).toBe(true);
    expect(body.holders.some((h: { accountId: string }) => h.accountId === awayAccount)).toBe(false);
    for (const holder of body.holders) {
      for (const assignment of holder.assignments) {
        expect(assignment.scopeType).toBe('branch');
        expect(assignment.scopeId).toBe(central);
        expect(assignment.scopeName).toEqual(expect.any(String));
      }
    }
    const mixed = body.holders.find((h: { accountId: string }) => h.accountId === mixedAccount);
    if (mixed) expect(mixed.assignments.map((a: { id: string }) => a.id)).toEqual([mixedLocalAssignment]);
    const foreign = await get('/roles/holders?permission=pos%3Arefund%3Aapprove', foreignAdmin);
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().holders.some((h: { accountId: string }) => [localAccount, awayAccount, mixedAccount].includes(h.accountId))).toBe(false);
  });

  it('previews grant and removal without writing roles or audit and matches the saved effective answer', async () => {
    const target = newId();
    const employeeId = newId();
    await ctx.db.insert(employee).values({ id: employeeId, operatorId, branchId: central, name: 'ZZ TEST preview target' });
    await ctx.db.insert(account).values({ id: target, operatorId, employeeId, phone: '+66999000624', status: 'active' });
    const rowsBefore = await ctx.db.select({ id: roleAssignment.id }).from(roleAssignment);
    const auditsBefore = await ctx.db.select({ id: auditLog.id }).from(auditLog);
    const change = { accountId: target, operation: 'grant', roleName: 'ZZ TEST local refund reader', scopeType: 'branch', scopeId: central };
    const response = await preview(change, manager);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accountId: target, operation: 'grant', before: [], removed: [], unchanged: [],
      added: [{ permission: 'pos:refund:approve', words: expect.any(String), scopeType: 'branch', scopeId: central }],
    });
    expect(await ctx.db.select({ id: roleAssignment.id }).from(roleAssignment)).toEqual(rowsBefore);
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog)).toEqual(auditsBefore);
    const assignmentId = newId();
    const saved = await ctx.app.inject({ method: 'POST', url: `/accounts/${target}/role-assignments`,
      headers: { cookie: manager, 'idempotency-key': newId() },
      payload: { id: assignmentId, roleName: change.roleName, scopeType: 'branch', scopeId: central },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ id: assignmentId });
    const effective = await get(`/accounts/${target}/permissions`, manager);
    expect(effective.statusCode).toBe(200);
    expect(effective.json().effective.map(({ roleName: _roleName, ...p }: { roleName: string }) => p))
      .toEqual(response.json().after.map(({ words: _words, ...p }: { words: string }) => p));
    const removal = await preview({ accountId: target, operation: 'remove', assignmentId }, manager);
    expect(removal.statusCode).toBe(200);
    expect(removal.json().removed).toEqual(response.json().added);
    expect(removal.json().after).toEqual([]);
    const removed = await ctx.app.inject({ method: 'DELETE', url: `/accounts/${target}/role-assignments/${assignmentId}`,
      headers: { cookie: manager, 'idempotency-key': newId() },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
  });

  it('does not claim access is removed when a different role preserves the same permission and scope', async () => {
    const duplicateRole = newId();
    const duplicateAssignment = newId();
    await ctx.db.insert(role).values({ id: duplicateRole, operatorId, name: 'ZZ TEST redundant refund role' });
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId: duplicateRole, permission: 'pos:refund:approve' });
    await ctx.db.insert(roleAssignment).values({ id: duplicateAssignment, accountId: localAccount, roleId: duplicateRole, scopeType: 'branch', scopeId: central });
    const response = await preview({ accountId: localAccount, operation: 'remove', assignmentId: duplicateAssignment });
    expect(response.statusCode).toBe(200);
    expect(response.json().removed).toEqual([]);
    expect(response.json().unchanged).toEqual([{ permission: 'pos:refund:approve', words: expect.any(String), scopeType: 'branch', scopeId: central }]);
  });

  it('compares validated UUID scopes in their stored canonical case', async () => {
    const response = await preview({ accountId: mixedAccount.toUpperCase(), operation: 'grant',
      roleName: 'ZZ TEST local refund reader', scopeType: 'branch', scopeId: central.toUpperCase() });
    expect(response.statusCode).toBe(200);
    expect(response.json().accountId).toBe(mixedAccount);
    expect(response.json().added).toEqual([]);
    expect(response.json().after).toEqual(response.json().before);
  });

  it('does not claim a narrow grant adds access already covered by an operator-wide grant', async () => {
    const wide = newId();
    await ctx.db.insert(roleAssignment).values({ id: wide, accountId: localAccount, roleId: ownRole, scopeType: 'operator', scopeId: operatorId });
    const response = await preview({ accountId: localAccount, operation: 'grant', roleName: 'ZZ TEST local refund reader', scopeType: 'branch', scopeId: chalong });
    expect(response.statusCode).toBe(200);
    expect(response.json().added).toEqual([]);
    expect(response.json().removed).toEqual([]);
    expect(response.json().after).toEqual([{ permission: 'pos:refund:approve', words: expect.any(String), scopeType: 'operator', scopeId: operatorId }]);
  });

  it('refuses target, role and scope crossings just as the actual write does', async () => {
    const base = { accountId: awayAccount, operation: 'grant', roleName: 'reception', scopeType: 'branch', scopeId: central };
    const outside = await preview(base, manager);
    expect(outside.statusCode).toBe(403);
    const foreign = await preview({ ...base, accountId: localAccount }, foreignAdmin);
    expect(foreign.statusCode).toBe(404);
    const foreignRole = await preview({ ...base, accountId: localAccount, roleName: 'ZZ TEST foreign secret role' });
    expect(foreignRole.statusCode).toBe(400);
    expect(foreignRole.json().error.code).toBe('UNKNOWN_ROLE');
    const unsupported = await preview({ ...base, accountId: localAccount, scopeType: 'record', scopeId: newId() });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe('SCOPE_NOT_SUPPORTED');
    const protectedRemoval = await preview({ accountId: mixedAccount, operation: 'remove', assignmentId: mixedAwayAssignment }, manager);
    expect(protectedRemoval.statusCode).toBe(403);
  });

  it('refuses preview removal of the last active operator administrator', async () => {
    const [caller] = await ctx.db.select().from(account).where(and(eq(account.phone, SECOND_OPERATOR_ADMIN.phone), eq(account.operatorId, foreignOperatorId)));
    const assignments = await ctx.db.select({ ra: roleAssignment }).from(roleAssignment)
      .innerJoin(rolePermission, eq(rolePermission.roleId, roleAssignment.roleId))
      .where(and(eq(roleAssignment.accountId, caller!.id), eq(rolePermission.permission, 'admin:role:assign')));
    const response = await preview({ accountId: caller!.id, operation: 'remove', assignmentId: assignments[0]!.ra.id }, foreignAdmin);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_OPERATOR_ADMIN');
  });

  it('refuses malformed, repeated and unknown inputs and unprivileged or anonymous readers', async () => {
    for (const url of ['/roles/holders?permission=unknown:thing:read', '/roles/holders?permission=admin:role:read&permission=admin:role:assign',
      '/roles/preview?accountId=invalid&operation=remove&assignmentId=invalid',
      `/roles/preview?accountId=${localAccount}&operation=grant&roleName=reception&scopeType=branch`,
    ]) expect((await get(url)).statusCode, url).toBe(400);
    for (const url of ['/roles', '/roles/holders?permission=pos:refund:approve', `/roles/preview?accountId=${localAccount}&operation=remove&assignmentId=${mixedLocalAssignment}`]) {
      expect((await get(url, reception)).statusCode, url).toBe(403);
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('describes all consumed role reads and existing assignment successes in OpenAPI', () => {
    const doc = ctx.app.swagger();
    for (const [path, verb] of [
      ['/roles/', 'get'], ['/roles/holders', 'get'], ['/roles/preview', 'get'],
      ['/accounts/{id}/permissions', 'get'], ['/accounts/{id}/role-assignments', 'post'],
      ['/accounts/{id}/role-assignments/{assignmentId}', 'delete'],
    ] as const) {
      const response = doc.paths?.[path]?.[verb]?.responses?.['200'];
      expect(Boolean(response && 'content' in response && response.content), `${verb} ${path} must describe its answer`).toBe(true);
    }
  });
});
