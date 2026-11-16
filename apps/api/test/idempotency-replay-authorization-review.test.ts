import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken, newSessionToken, SESSION_COOKIE } from '../src/plugins/session';
import { createTestContext, teardownAll, type TestContext } from './helpers';

const permission = 'inbox:conversation:read';
const guarded = '/__test993/guarded-replay', ordinary = '/__test993/ordinary-replay';
let ctx: TestContext, f: Awaited<ReturnType<typeof fixture>>;
let operations = 0, guards = 0;
const authorize = async (req: FastifyRequest) => {
  guards++;
  const auth = await req.requirePermission(permission, { operatorOnly: true });
  expect(auth.accountId).toBe(f.accountId);
  expect(auth.operatorId).toBe(f.operatorId);
};
beforeAll(async () => {
  ctx = await createTestContext();
  ctx.app.post(guarded, { config: { auth: 'session', authorizeReplay: authorize } }, async req => {
    await authorize(req); operations++;
    return { marker: 'ZZ TEST resource answer', sequence: operations, accountId: req.requireAuth().accountId };
  });
  ctx.app.post(ordinary, { config: { auth: 'session' } }, () => {
    operations++; return { marker: 'ZZ TEST ordinary answer', sequence: operations };
  });
}, 180000);
beforeEach(async () => { operations = 0; guards = 0; f = await fixture(); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });
async function fixture() {
  const operatorId = newId(), accountId = newId(), roleId = newId(), sessionId = newId();
  await ctx.db.insert(s.operator).values({ id: operatorId, name: 'ZZ TEST replay authorization' });
  await ctx.db.insert(s.account).values({ id: accountId, operatorId, phone: '+66999999301', status: 'active', phoneVerifiedAt: new Date() });
  await ctx.db.insert(s.role).values({ id: roleId, operatorId, name: 'ZZ TEST current resource grant', isSystem: false });
  await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId, permission });
  await ctx.db.insert(s.roleAssignment).values({ id: newId(), accountId, roleId, scopeType: 'operator', scopeId: operatorId });
  const token = newSessionToken();
  await ctx.db.insert(s.session).values({ id: sessionId, accountId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) });
  return { operatorId, accountId, roleId, sessionId, cookie: `${SESSION_COOKIE}=${token}`, key: newId() };
}
const request = (url = guarded) => ctx.app.inject({ method: 'POST', url,
  headers: { cookie: f.cookie, 'idempotency-key': f.key }, payload: {} });

describe('SCRUM-993 generic replay authorization, without Inbox policy dependencies', () => {
  it('HIGH: unchanged authorization returns the byte-exact stored answer without repeating the operation', async () => {
    const first = await request(), replay = await request();
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(operations).toBe(1); expect(guards).toBe(2);
  });
  it('HIGH: revoked access is checked before any cached payload and does not destroy its safe later replay', async () => {
    const first = await request();
    expect(first.statusCode).toBe(200);
    await ctx.db.delete(s.rolePermission).where(and(eq(s.rolePermission.roleId, f.roleId), eq(s.rolePermission.permission, permission)));
    const denied = await request();
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['x-oto-replay']).toBeUndefined();
    expect(denied.body).not.toContain('ZZ TEST resource answer');
    expect(operations).toBe(1); expect(guards).toBe(2);
    await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: f.roleId, permission });
    const replay = await request();
    expect(replay.statusCode).toBe(200); expect(replay.body).toBe(first.body);
    expect(replay.headers['x-oto-replay']).toBe('true'); expect(operations).toBe(1);
  });
  it('HIGH: a locked current session is refused before the resource callback or cached answer', async () => {
    expect((await request()).statusCode).toBe(200);
    await ctx.db.update(s.session).set({ lockedAt: new Date() }).where(eq(s.session.id, f.sessionId));
    const denied = await request();
    expect(denied.statusCode).toBe(423);
    expect(denied.body).not.toContain('ZZ TEST resource answer');
    expect(guards).toBe(1); expect(operations).toBe(1);
  });
  it('routes without the optional callback retain their existing replay behavior', async () => {
    const first = await request(ordinary);
    await ctx.db.delete(s.rolePermission).where(eq(s.rolePermission.roleId, f.roleId));
    const replay = await request(ordinary);
    expect(replay.statusCode).toBe(200); expect(replay.body).toBe(first.body);
    expect(replay.headers['x-oto-replay']).toBe('true'); expect(operations).toBe(1); expect(guards).toBe(0);
  });
});
