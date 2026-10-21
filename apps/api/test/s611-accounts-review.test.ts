import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, idempotencyKey, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: string;
let reader: string;
let target: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [person] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  target = person!.id;
  reader = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [assignment] = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target));
  const roleId = newId();
  await ctx.db.insert(role).values({ id: roleId, operatorId: person!.operatorId, name: 'ZZ TEST Accounts read only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'admin:account:read' });
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, target));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: target, roleId, scopeType: 'branch', scopeId: assignment!.scopeId });
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

/** SCRUM-611 house review: prescribed fixes are expressed as passing boundary pins. */
describe('SCRUM-611 lifted Accounts adversarial review', () => {
  it('FINDING R1 high: list and session answers must expose only their approved public fields; whitelist the wire response', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/accounts', headers: { cookie: admin } });
    expect(list.statusCode).toBe(200);
    const row = list.json().accounts.find((a: { id: string }) => a.id === target);
    expect(Object.keys(row).sort()).toEqual(['employee', 'id', 'mustChangePassword', 'phone', 'status']);
    expect(Object.keys(row.employee).sort()).toEqual(['id', 'name']);
    const sessions = await ctx.app.inject({ method: 'GET', url: `/accounts/${target}/sessions`, headers: { cookie: admin } });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions.length).toBeGreaterThan(0);
    for (const s of sessions.json().sessions) {
      expect(Object.keys(s).sort()).toEqual(['branchId', 'createdAt', 'expiresAt', 'id', 'lastSeenAt', 'lockedAt', 'stationId']);
      expect(Number.isFinite(Date.parse(s.createdAt))).toBe(true);
    }
  });

  it('FINDING R2 critical: a read grant must never authorize account takeover; refuse writes without changing the target or audit', async () => {
    const [before] = await ctx.db.select().from(account).where(eq(account.id, target));
    const prior = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, target));
    for (const [method, suffix, payload] of [
      ['POST', '/temp-password', undefined], ['POST', '/sessions/revoke', undefined], ['PATCH', '', { status: 'inactive' }],
    ] as const) {
      const response = await ctx.app.inject({ method, url: `/accounts/${target}${suffix}`, headers: { cookie: reader, 'idempotency-key': newId() }, payload });
      expect(response.statusCode).toBe(403);
    }
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target));
    expect(after?.status).toBe(before?.status);
    expect(after?.passwordHash === before?.passwordHash).toBe(true);
    const next = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, target));
    expect(next).toHaveLength(prior.length);
  });

  it('FINDING R3 critical: temporary passwords must never enter the replay store or audit; keep the secret-response exemption', async () => {
    const key = newId();
    const issue = () => ctx.app.inject({ method: 'POST', url: `/accounts/${target}/temp-password`, headers: { cookie: admin, 'idempotency-key': key } });
    const first = await issue();
    const second = await issue();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a: unknown = first.json().temporaryPassword;
    const b: unknown = second.json().temporaryPassword;
    expect(typeof a === 'string' && a.length >= 8).toBe(true);
    expect(typeof b === 'string' && b.length >= 8).toBe(true);
    expect(a !== b).toBe(true);
    expect(await ctx.db.select({ key: idempotencyKey.key }).from(idempotencyKey).where(eq(idempotencyKey.key, key))).toHaveLength(0);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, target), eq(auditLog.action, 'account.temp_password')));
    expect(audits).toHaveLength(2);
    const text = JSON.stringify(audits);
    expect(typeof a === 'string' && text.includes(a)).toBe(false);
    expect(typeof b === 'string' && text.includes(b)).toBe(false);
  });
});
