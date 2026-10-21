import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN,
  CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE, branchIdByCode,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: string;
let manager: string;
let second: string;
let target: string;
let central: string;
let chalong: string;
let operatorId: string;
let foreignAccountId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  second = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [person] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  target = person!.id;
  operatorId = person!.operatorId;
  const [foreign] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  foreignAccountId = foreign!.id;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

const preview = (cookie: string, query: Record<string, string>) => ctx.app.inject({
  method: 'GET', url: `/roles/preview?${new URLSearchParams(query)}`, headers: { cookie },
});

/** SCRUM-612 house review: boundary attacks stay as passing regression pins. */
describe('SCRUM-612 Roles and scopes adversarial review', () => {
  it('FINDING R1 high: catalogue and lookup must not disclose another operator; filter roles and account holders by the acting operator', async () => {
    const roleId = newId();
    const [foreign] = await ctx.db.select().from(account).where(eq(account.id, foreignAccountId));
    await ctx.db.insert(role).values({ id: roleId, operatorId: foreign!.operatorId, name: 'ZZ TEST foreign catalogue role' });
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'pos:refund:approve' });
    const catalogue = await ctx.app.inject({ method: 'GET', url: '/roles', headers: { cookie: admin } });
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.json().roles.some((r: { id: string }) => r.id === roleId)).toBe(false);
    expect(catalogue.json().roles.length).toBeGreaterThan(0);
    const holders = await ctx.app.inject({ method: 'GET', url: '/roles/holders?permission=pos%3Arefund%3Aapprove', headers: { cookie: admin } });
    expect(holders.statusCode).toBe(200);
    expect(holders.json().holders.some((r: { accountId: string }) => r.accountId === foreignAccountId)).toBe(false);
    const invalid = await ctx.app.inject({ method: 'GET', url: '/roles/holders?permission=not-a-permission', headers: { cookie: admin } });
    expect(invalid.statusCode).toBe(400);
    expect((await preview(admin, { accountId: foreignAccountId, operation: 'grant', roleName: 'staff', scopeType: 'branch', scopeId: central })).statusCode).toBe(404);
  });

  it('FINDING R2 critical: a preview must never grant access or emit a write audit; show the canonical new branch permission without persisting anything', async () => {
    const assignments = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target));
    const audits = await ctx.db.select({ id: auditLog.id }).from(auditLog);
    const result = await preview(admin, { accountId: target, operation: 'grant', roleName: 'branch_manager', scopeType: 'branch', scopeId: chalong });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.added).toContainEqual(expect.objectContaining({ permission: 'pos:refund:approve', scopeType: 'branch', scopeId: chalong }));
    expect(body.removed).toEqual([]);
    expect(await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target))).toEqual(assignments);
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog)).toHaveLength(audits.length);
    const denied = await preview(manager, { accountId: target, operation: 'grant', roleName: 'platform_admin', scopeType: 'operator' });
    expect(denied.statusCode).toBe(403);
  });

  it('FINDING R3 high: removing an overlapping assignment must not announce lost access; compare effective permission and scope rather than role rows', async () => {
    const [original] = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target));
    const overlappingRoleId = newId();
    await ctx.db.insert(role).values({ id: overlappingRoleId, operatorId, name: 'ZZ TEST overlapping reception role' });
    const permissions = await ctx.db.select().from(rolePermission).where(eq(rolePermission.roleId, original!.roleId));
    await ctx.db.insert(rolePermission).values(permissions.map(p => ({ id: newId(), roleId: overlappingRoleId, permission: p.permission })));
    const duplicateId = newId();
    await ctx.db.insert(roleAssignment).values({ id: duplicateId, accountId: target, roleId: overlappingRoleId, scopeType: original!.scopeType, scopeId: original!.scopeId });
    const result = await preview(admin, { accountId: target, operation: 'remove', assignmentId: duplicateId });
    expect(result.statusCode).toBe(200);
    expect(result.json().added).toEqual([]);
    expect(result.json().removed).toEqual([]);
    expect(result.json().unchanged.length).toBeGreaterThan(0);
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, duplicateId));
    const [last] = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, foreignAccountId));
    const refused = await preview(second, { accountId: foreignAccountId, operation: 'remove', assignmentId: last!.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    expect(await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.id, last!.id))).toHaveLength(1);
  });

  it('FINDING R4 critical: a colleague visible at one park must not expose assignments at another; filter each reverse-lookup assignment independently', async () => {
    const roleId = newId();
    await ctx.db.insert(role).values({ id: roleId, operatorId, name: 'ZZ TEST refund lookup role' });
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'pos:refund:approve' });
    const localId = newId();
    const otherId = newId();
    await ctx.db.insert(roleAssignment).values([
      { id: localId, accountId: target, roleId, scopeType: 'branch', scopeId: central },
      { id: otherId, accountId: target, roleId, scopeType: 'branch', scopeId: chalong },
    ]);
    const result = await ctx.app.inject({ method: 'GET', url: '/roles/holders?permission=pos%3Arefund%3Aapprove', headers: { cookie: manager } });
    expect(result.statusCode).toBe(200);
    const holder = result.json().holders.find((h: { accountId: string }) => h.accountId === target);
    expect(holder).toBeDefined();
    expect(holder.assignments.some((a: { id: string }) => a.id === localId)).toBe(true);
    expect(holder.assignments.some((a: { id: string }) => a.id === otherId)).toBe(false);
    expect(holder.assignments.every((a: { scopeType: string; scopeId: string }) => a.scopeType === 'branch' && a.scopeId === central)).toBe(true);
    await ctx.db.delete(roleAssignment).where(and(eq(roleAssignment.accountId, target), eq(roleAssignment.roleId, roleId)));
  });
});
