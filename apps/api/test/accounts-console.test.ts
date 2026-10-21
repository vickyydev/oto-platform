import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, idempotencyKey, roleAssignment, verificationCode } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN, BRANCH_MANAGER, CHALONG_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: string;
let manager: string;
let otherManager: string;
let otherOperator: string;
let reception: string;
let central: string;
let chalong: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  otherManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  otherOperator = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const parks = await ctx.db.select().from(branch);
  central = parks.find((b) => b.code === 'hkt-central')!.id;
  chalong = parks.find((b) => b.code === 'robinson-chalong')!.id;
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const auditFor = (entityId: string) => ctx.db.select().from(auditLog).where(eq(auditLog.entityId, entityId));

describe('SCRUM-611 Accounts API contract and local captured-SMS proof', () => {
  it('describes every lifted Accounts success response in the API contract', () => {
    const doc = ctx.app.swagger();
    for (const [path, verb] of [
      ['/accounts/', 'get'], ['/accounts/', 'post'], ['/accounts/{id}', 'patch'],
      ['/accounts/{id}/temp-password', 'post'], ['/accounts/{id}/sessions', 'get'],
      ['/accounts/{id}/sessions/revoke', 'post'],
    ] as const) {
      const response = doc.paths?.[path]?.[verb]?.responses?.['200'];
      expect(Boolean(response && 'content' in response && response.content), `${verb} ${path} must describe its answer`).toBe(true);
    }
  });

  it('invites reception once, captures its SMS locally, then issues a temporary password and deactivates it with audit', async () => {
    const id = newId();
    const inviteKey = newId();
    const secretKey = newId();
    const phone = '+66999000611';
    const body = { id, phone, employeeName: 'ZZ TEST Admin Accounts reception', roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: central }] };
    const sentBefore = ctx.smsLog.length;
    const invited = await ctx.app.inject({ method: 'POST', url: '/accounts', headers: { cookie: admin, 'idempotency-key': inviteKey }, payload: body });
    expect(invited.statusCode).toBe(200);
    expect(invited.json()).toMatchObject({ id, status: 'invited', codeSent: true });
    expect(ctx.smsLog.length - sentBefore).toBe(1);
    expect(/\d{6}/.test(ctx.smsLog.at(-1) ?? '')).toBe(true);
    const replayed = await ctx.app.inject({ method: 'POST', url: '/accounts', headers: { cookie: admin, 'idempotency-key': inviteKey }, payload: body });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.headers['x-oto-replay']).toBe('true');
    expect(replayed.json().id).toBe(id);
    expect(ctx.smsLog.length - sentBefore).toBe(1);
    const changed = await ctx.app.inject({ method: 'POST', url: '/accounts', headers: { cookie: admin, 'idempotency-key': inviteKey }, payload: { ...body, employeeName: 'ZZ TEST changed replay' } });
    expect(changed.statusCode).toBe(409);
    expect(await ctx.db.select({ id: account.id }).from(account).where(eq(account.id, id))).toHaveLength(1);
    expect(await ctx.db.select({ id: roleAssignment.id }).from(roleAssignment).where(eq(roleAssignment.accountId, id))).toHaveLength(1);
    expect(await ctx.db.select({ id: verificationCode.id }).from(verificationCode).where(eq(verificationCode.accountId, id))).toHaveLength(1);
    expect((await auditFor(id)).filter((r) => r.action === 'account.create')).toHaveLength(1);

    const issued = await ctx.app.inject({ method: 'POST', url: `/accounts/${id}/temp-password`, headers: { cookie: admin, 'idempotency-key': secretKey } });
    expect(issued.statusCode).toBe(200);
    const temp: unknown = issued.json().temporaryPassword;
    expect(typeof temp === 'string' && temp.length > 0).toBe(true);
    if (typeof temp !== 'string') throw new Error('Temporary password response did not contain a password');
    expect(await ctx.db.select({ key: idempotencyKey.key }).from(idempotencyKey).where(eq(idempotencyKey.key, secretKey))).toHaveLength(0);
    const login = await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { phone, password: temp } });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const targetCookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
    const mustChange = await ctx.app.inject({ method: 'GET', url: '/members/lookup?phone=0811111111', headers: { cookie: targetCookie } });
    expect(mustChange.statusCode).toBe(403);
    expect(mustChange.json().error.code).toBe('MUST_CHANGE_PASSWORD');
    const sessions = await ctx.app.inject({ method: 'GET', url: `/accounts/${id}/sessions`, headers: { cookie: admin } });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions.length).toBe(1);
    expect(typeof sessions.json().sessions[0].createdAt).toBe('string');
    expect(Number.isFinite(Date.parse(sessions.json().sessions[0].expiresAt))).toBe(true);

    const off = await ctx.app.inject({ method: 'PATCH', url: `/accounts/${id}`, headers: { cookie: admin, 'idempotency-key': newId() }, payload: { status: 'inactive' } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: targetCookie } })).statusCode).toBe(401);
    const [saved] = await ctx.db.select({ status: account.status, mustChange: account.mustChangePassword }).from(account).where(eq(account.id, id));
    expect(saved).toEqual({ status: 'inactive', mustChange: true });
    const audit = await auditFor(id);
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(['account.create', 'account.temp_password', 'account.update']));
    expect(JSON.stringify(audit).includes(temp)).toBe(false);
    expect(ctx.smsLog.length - sentBefore).toBe(1);
  });

  it('preserves branch and operator refusals without sending a setup message', async () => {
    const sentBefore = ctx.smsLog.length;
    const [target] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
    for (const [cookie, status] of [[otherManager, 403], [otherOperator, 404]] as const) {
      for (const [method, suffix, payload] of [
        ['GET', '/sessions', undefined], ['POST', '/temp-password', undefined],
        ['POST', '/sessions/revoke', undefined], ['PATCH', '', { status: 'inactive' }],
      ] as const) {
        const refused = await ctx.app.inject({ method, url: `/accounts/${target!.id}${suffix}`, headers: { cookie, 'idempotency-key': newId() }, payload });
        expect(refused.statusCode, `${method} ${suffix}`).toBe(status);
      }
    }
    const tooWide = await ctx.app.inject({ method: 'POST', url: '/accounts', headers: { cookie: manager, 'idempotency-key': newId() }, payload: {
      phone: '+66999000612', employeeName: 'ZZ TEST refused other branch', roles: [{ roleName: 'reception', scopeType: 'branch', scopeId: chalong }],
    } });
    expect(tooWide.statusCode).toBe(403);
    const notAllowed = await ctx.app.inject({ method: 'POST', url: '/accounts', headers: { cookie: reception, 'idempotency-key': newId() }, payload: {
      phone: '+66999000613', employeeName: 'ZZ TEST refused invite', roles: [],
    } });
    expect(notAllowed.statusCode).toBe(403);
    expect(ctx.smsLog.length).toBe(sentBefore);
    expect(await ctx.db.select({ id: account.id }).from(account).where(and(eq(account.phone, '+66999000612')))).toHaveLength(0);
  });
});
