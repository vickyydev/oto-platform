import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, memberTierVerification, station, syncQuarantine, visit, visitChild } from '@oto/db';
import type { BoxAgent, BridgeTillCaller } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, SECOND_OPERATOR_ADMIN, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { linkedAgent } from './box-link';

/** High: a lost online answer must not create another visit or tier decision.
 * Prescribed fix: mint before lane selection, scope replay, and serialize on the entity.
 * Passing pins drive both the HTTP routes and the real agent's signed outbox. */
let ctx: TestContext;
let cookie: string;
let reception: string;
let foreign: string;
let agent: BoxAgent;
let stationId: string;
let token: string;
const link = { cut: false };
let serial = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, who = cookie) =>
  ctx.app.inject({ method, url, headers: { cookie: who }, ...(payload === undefined ? {} : { payload: payload as never }) });
const intent = (type: string, payload: Record<string, unknown>) => ({ type, payload, lastSeenSequence: 0, actionId: `s728:${newId()}` });

beforeAll(async () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: key } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  const [s] = await ctx.db.select().from(station).where(and(eq(station.boxId, box.id), eq(station.name, 'Reception Till 1')));
  stationId = s!.id;
  const picked = await call('PUT', '/me/session/station', { stationId });
  expect(picked.statusCode).toBe(200);
  token = picked.json().staffToken.token;
  agent = linkedAgent(ctx, box.id, 'zz-test-s728-replay', link);
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
}, 180_000);
afterAll(async () => {
  agent?.stop();
  await ctx?.close();
  await teardownAll();
});

async function family() {
  const m = await call('POST', '/members', { phone: `065728${String(++serial).padStart(4, '0')}`, nickname: 'ZZ TEST outage family' });
  expect(m.statusCode).toBe(200);
  const memberId = m.json().member.id as string;
  const kids: string[] = [];
  for (const name of ['ZZ TEST first child', 'ZZ TEST second child']) {
    const c = await call('POST', `/members/${memberId}/children`, { name, ageYears: 4 });
    expect(c.statusCode).toBe(200);
    kids.push(c.json().child.id as string);
  }
  return { memberId, childIds: kids };
}
async function prepareBox(): Promise<BridgeTillCaller> {
  await agent.syncCache();
  const opened = await agent.bridge()!.unlock(stationId, { token, password: ADMIN.password });
  return opened.caller;
}
async function queue(caller: BridgeTillCaller, type: string, payload: Record<string, unknown>) {
  link.cut = true;
  try { return await agent.bridge()!.intent(stationId, caller, intent(type, payload)); }
  finally { link.cut = false; }
}
async function flush() { await agent.outbox()!.flush(); }

describe('SCRUM-728 durable action replay review', () => {
  it('High: lost add-children answer replays onto the original visit, without restamping or a second audit', async () => {
    const f = await family();
    const opened = await call('POST', '/visits', { memberId: f.memberId, childIds: [f.childIds[0]] });
    expect(opened.statusCode).toBe(200);
    const visitId = opened.json().id as string;
    const caller = await prepareBox();
    const operationId = newId();
    const online = await call('POST', `/visits/${visitId}/children`, { operationId, childIds: f.childIds });
    expect(online.statusCode).toBe(200);
    const [before] = await ctx.db.select().from(child).where(eq(child.id, f.childIds[1]!));
    // Even closing after the accepted act must not turn its replay into a new act.
    await ctx.db.update(visit).set({ status: 'closed' }).where(eq(visit.id, visitId));
    const offline = await queue(caller, 'visit.children_add', { ...f, visitId, operationId });
    expect(offline.result?.id).toBe(visitId);
    await flush();
    const repeated = await call('POST', `/visits/${visitId}/children`, { operationId, childIds: f.childIds });
    expect(repeated.statusCode).toBe(200);
    expect(await ctx.db.select().from(visit).where(eq(visit.memberId, f.memberId))).toHaveLength(1);
    expect(await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, visitId))).toHaveLength(2);
    const [after] = await ctx.db.select().from(child).where(eq(child.id, f.childIds[1]!));
    expect(after!.lastConfirmedAt).toEqual(before!.lastConfirmedAt);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, visitId), eq(auditLog.action, 'visit.children_add')))).toHaveLength(1);
    expect((await call('POST', `/visits/${visitId}/children`, { operationId: newId(), childIds: f.childIds })).statusCode).toBe(409);
  });

  it('High: a box-only append converges once; a foreign child or action id cannot cross a family', async () => {
    const a = await family();
    const b = await family();
    const opened = await call('POST', '/visits', { memberId: a.memberId, childIds: [] });
    const visitId = opened.json().id as string;
    const caller = await prepareBox();
    await expect(queue(caller, 'visit.children_add', { ...a, childIds: b.childIds, visitId, operationId: newId() })).rejects.toMatchObject({ code: 'VALIDATION' });
    const operationId = newId();
    await queue(caller, 'visit.children_add', { ...a, visitId, operationId });
    await flush();
    expect(await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, visitId))).toHaveLength(2);
    const other = await call('POST', '/visits', { memberId: b.memberId, childIds: [] });
    const collision = await call('POST', `/visits/${other.json().id}/children`, { operationId, childIds: b.childIds });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error.code).toBe('ID_IN_USE');
    expect((await call('POST', `/visits/${visitId}/children`, { operationId, childIds: a.childIds }, foreign)).statusCode).toBe(404);
  });

  it('High: online tier grant and revocation survive lost answers and repeated signed facts exactly once', async () => {
    const f = await family();
    let caller = await prepareBox();
    const verificationId = newId();
    const body = { verificationId, toTier: 'expat', evidenceType: 'Passport' };
    const grants = await Promise.all([call('POST', `/members/${f.memberId}/tier-verification`, body), call('POST', `/members/${f.memberId}/tier-verification`, body)]);
    expect(grants.map((r) => r.statusCode)).toEqual([200, 200]);
    await queue(caller, 'member.tier_change', { ...body, memberId: f.memberId, direction: 'upgrade' });
    await flush();
    caller = await prepareBox();
    const revokeId = newId();
    const revoke = { verificationId: revokeId, reason: 'ZZ TEST decision withdrawn' };
    expect((await call('DELETE', `/members/${f.memberId}/tier-verification`, revoke)).statusCode).toBe(200);
    await queue(caller, 'member.tier_change', { ...revoke, memberId: f.memberId, direction: 'downgrade' });
    await flush();
    expect((await call('DELETE', `/members/${f.memberId}/tier-verification`, revoke)).statusCode).toBe(200);
    const records = await ctx.db.select().from(memberTierVerification).where(eq(memberTierVerification.memberId, f.memberId));
    expect(records.map((r) => r.id).sort()).toEqual([verificationId, revokeId].sort());
    for (const id of [verificationId, revokeId]) expect(await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, id))).toHaveLength(1);
    expect((await call('DELETE', `/members/${f.memberId}/tier-verification`, { reason: revoke.reason })).statusCode).toBe(409);
    expect((await call('DELETE', `/members/${f.memberId}/tier-verification`, revoke, reception)).statusCode).toBe(403);
    const other = await family();
    const collision = await call('POST', `/members/${other.memberId}/tier-verification`, body);
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error.code).toBe('ID_IN_USE');
    expect((await call('POST', `/members/${f.memberId}/tier-verification`, { ...body, verificationId: revokeId })).statusCode).toBe(409);
    expect((await call('POST', `/members/${f.memberId}/tier-verification`, body, foreign)).statusCode).toBe(404);
    expect(await ctx.db.select().from(syncQuarantine)).toHaveLength(0);
  });
});
