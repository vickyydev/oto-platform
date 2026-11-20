import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, station, syncChange, syncQuarantine, visit } from '@oto/db';
import type { BoxAgent, BridgeTillCaller } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { ADMIN, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { linkedAgent } from './box-link';

/**
 * SCRUM-1060 — A SAVE RETRIED AFTER A LOST CONNECTION IS WRITTEN ONCE, THE
 * REMAINING PATHS (the platform's side).
 *
 *  (1) "Who's visiting today?" now holds its visit's id and key while it is
 *      open, so a Confirm pressed again after the visit's reply was lost
 *      sends the same visit again: `POST /visits` answers it from the first
 *      write — under the same key, and under the same id with another key —
 *      and opens one visit.
 *  (2) A change to a child that falls to the counter box's lane carries the
 *      action id it was sent online under: the box keeps it on its fact, and
 *      the platform writes the change once whichever lane brings it first —
 *      one audit row and one publication to the boxes. Driven through the
 *      real box agent and its signed outbox, as the counter's box runs.
 */
let ctx: TestContext;
let cookie: string;
let agent: BoxAgent;
let stationId: string;
let token: string;
const link = { cut: false };
let serial = 0;

const call = (method: 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown, key?: string) =>
  ctx.app.inject({ method, url, headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) }, payload: payload as never });

beforeAll(async () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: key } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  const [s] = await ctx.db.select().from(station).where(and(eq(station.boxId, box.id), eq(station.name, 'Reception Till 1')));
  stationId = s!.id;
  const picked = await call('PUT', '/me/session/station', { stationId });
  expect(picked.statusCode).toBe(200);
  token = picked.json().staffToken.token;
  agent = linkedAgent(ctx, box.id, 'zz-test-s1060-retry', link);
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
}, 180_000);
afterAll(async () => {
  agent?.stop();
  await ctx?.close();
  await teardownAll();
});

async function family() {
  const m = await call('POST', '/members', { phone: `065106${String(++serial).padStart(4, '0')}`, nickname: 'ZZ TEST retry family' }, newId());
  expect(m.statusCode, m.body).toBe(200);
  const memberId = m.json().member.id as string;
  const c = await call('POST', `/members/${memberId}/children`, { name: 'ZZ TEST retry child', ageYears: 5, allergies: 'ZZ TEST peanuts' }, newId());
  expect(c.statusCode, c.body).toBe(200);
  return { memberId, childId: c.json().child.id as string };
}

/** The counter box, holding the family in its cache and unlocked for this till. */
async function openBox(): Promise<BridgeTillCaller> {
  await agent.syncCache();
  return (await agent.bridge()!.unlock(stationId, { token, password: ADMIN.password })).caller;
}

/** A change the till sends the box while the link is down, under the action id it names. */
async function onBox(caller: BridgeTillCaller, actionId: string, payload: Record<string, unknown>) {
  link.cut = true;
  try {
    return await agent.bridge()!.intent(stationId, caller, { type: 'child.update', payload, lastSeenSequence: 0, actionId });
  } finally {
    link.cut = false;
  }
}

const flush = () => agent.outbox()!.flush();
const changesOf = (childId: string) =>
  ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'child.update'), eq(auditLog.entityId, childId)));
const publishedOf = async (childId: string) =>
  (await ctx.db.select().from(syncChange).where(and(eq(syncChange.entityType, 'child'), eq(syncChange.entityId, childId)))).length;
const patchChild = (childId: string, body: Record<string, unknown>, key: string) =>
  call('PATCH', `/members/children/${childId}`, body, key);

describe('SCRUM-1060 (1): the visit sent again is the visit already opened', () => {
  it('the same key and id answer from the first write; the same id under another key replays it; one visit, one audit row', async () => {
    const f = await family();
    const id = newId();
    const key = `visit:${id}`;
    const body = { id, memberId: f.memberId, childIds: [f.childId] };
    const first = await call('POST', '/visits', body, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['x-oto-replay']).toBeUndefined();
    const again = await call('POST', '/visits', body, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const byId = await call('POST', '/visits', body, newId());
    expect(byId.statusCode).toBe(200);
    expect(byId.headers['x-oto-replay']).toBe('true');
    expect(byId.json()).toEqual(first.json());
    expect(await ctx.db.select().from(visit).where(eq(visit.memberId, f.memberId))).toHaveLength(1);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'visit.create'), eq(auditLog.entityId, id)))).toHaveLength(1);
  });
});

describe("SCRUM-1060 (2): a child's change counted once on both lanes", () => {
  it('written online, its answer lost, then kept by the box under the same action id: one audit row, one publication', async () => {
    const { childId } = await family();
    const published = await publishedOf(childId);
    const actionId = newId();
    const online = await patchChild(childId, { allergies: 'ZZ TEST peanuts, sesame', actionId }, `visit-child:${actionId}`);
    expect(online.statusCode, online.body).toBe(200);
    const caller = await openBox();
    const kept = await onBox(caller, actionId, { childId, allergies: 'ZZ TEST peanuts, sesame' });
    expect((kept.result?.child as { allergies: string }).allergies).toBe('ZZ TEST peanuts, sesame');
    await flush();
    const rows = await changesOf(childId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actionId).toBe(actionId);
    expect(rows[0]!.sourceEventId).toBeNull();
    expect(await publishedOf(childId)).toBe(published + 1);
    expect(await ctx.db.select().from(syncQuarantine)).toHaveLength(0);
  });

  it('kept by the box first, then sent online under a new key: answered with the child as it stands, nothing written again', async () => {
    const { childId } = await family();
    const published = await publishedOf(childId);
    const actionId = newId();
    const caller = await openBox();
    await onBox(caller, actionId, { childId, allergies: 'ZZ TEST eggs' });
    await flush();
    expect(await changesOf(childId)).toHaveLength(1);
    const online = await patchChild(childId, { allergies: 'ZZ TEST eggs', actionId }, `gate-child:${newId()}`);
    expect(online.statusCode, online.body).toBe(200);
    expect(online.headers['x-oto-replay']).toBe('true');
    expect(online.json().child.allergies).toBe('ZZ TEST eggs');
    const rows = await changesOf(childId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceEventId).not.toBeNull();
    expect(await publishedOf(childId)).toBe(published + 1);
  });

  it('the box kept the same change twice (its answer was lost): applied once', async () => {
    const { childId } = await family();
    const published = await publishedOf(childId);
    const actionId = newId();
    const caller = await openBox();
    await onBox(caller, actionId, { childId, allergies: 'ZZ TEST milk' });
    await onBox(caller, actionId, { childId, allergies: 'ZZ TEST milk' });
    await flush();
    expect(await changesOf(childId)).toHaveLength(1);
    expect(await publishedOf(childId)).toBe(published + 1);
    expect(await ctx.db.select().from(syncQuarantine)).toHaveLength(0);
  });

  it('another change, or a change with no action id, is written as before; an action id names one child only', async () => {
    const a = await family();
    const b = await family();
    const actionId = newId();
    expect((await patchChild(a.childId, { allergies: 'ZZ TEST kiwi', actionId }, newId())).statusCode).toBe(200);
    const caller = await openBox();
    await onBox(caller, newId(), { childId: a.childId, allergies: 'ZZ TEST kiwi, mango' });
    await flush();
    expect((await patchChild(a.childId, { allergies: 'ZZ TEST kiwi, mango, oats' }, newId())).statusCode).toBe(200);
    expect(await changesOf(a.childId)).toHaveLength(3);
    expect((await ctx.db.select().from(child).where(eq(child.id, a.childId)))[0]!.allergies).toBe('ZZ TEST kiwi, mango, oats');
    // The same action id on another child's change is that child's own change.
    const other = await patchChild(b.childId, { allergies: 'ZZ TEST pears', actionId }, newId());
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-oto-replay']).toBeUndefined();
    expect(await changesOf(b.childId)).toHaveLength(1);
  });

  it('an action id longer than the box keeps is refused', async () => {
    const { childId } = await family();
    const long = await patchChild(childId, { allergies: 'ZZ TEST plums', actionId: 'x'.repeat(65) }, newId());
    expect(long.statusCode).toBe(400);
    expect(await changesOf(childId)).toHaveLength(0);
  });
});

describe('SCRUM-1060 (2), review: the same action id is the same change, or it is refused', () => {
  const quarantinedFor = async (childId: string) =>
    (await ctx.db.select().from(syncQuarantine)).filter(
      // The quarantined row keeps the box's whole signed envelope.
      (row) => row.type === 'child.updated' && (row.payload as { payload?: { childId?: string } }).payload?.childId === childId,
    );

  it('online, a different allergy note under an action id already written is refused 409 ID_IN_USE; nothing written', async () => {
    const { childId } = await family();
    const published = await publishedOf(childId);
    const actionId = newId();
    expect((await patchChild(childId, { allergies: 'ZZ TEST cashews', actionId }, `visit-child:${actionId}`)).statusCode).toBe(200);
    const other = await patchChild(childId, { allergies: 'ZZ TEST cashews, shellfish', actionId }, `gate-child:${newId()}`);
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().error.code).toBe('ID_IN_USE');
    expect(other.headers['x-oto-replay']).toBeUndefined();
    expect((await ctx.db.select().from(child).where(eq(child.id, childId)))[0]!.allergies).toBe('ZZ TEST cashews');
    expect(await changesOf(childId)).toHaveLength(1);
    expect(await publishedOf(childId)).toBe(published + 1);
    // The same change under that id, text spaced differently, is still the change written.
    const same = await patchChild(childId, { allergies: ' ZZ TEST cashews ', actionId }, `gate-child:${newId()}`);
    expect(same.statusCode, same.body).toBe(200);
    expect(same.headers['x-oto-replay']).toBe('true');
    expect(await changesOf(childId)).toHaveLength(1);
  });

  it("from the box, a different allergy note under an action id already written is poison in quarantine; nothing written", async () => {
    const { childId } = await family();
    const published = await publishedOf(childId);
    const actionId = newId();
    expect((await patchChild(childId, { allergies: 'ZZ TEST lentils', actionId }, `visit-child:${actionId}`)).statusCode).toBe(200);
    const caller = await openBox();
    await onBox(caller, actionId, { childId, allergies: 'ZZ TEST lentils, soy' });
    const flushed = await flush();
    expect(flushed).toMatchObject({ applied: 0, quarantined: 1 });
    const held = await quarantinedFor(childId);
    expect(held).toHaveLength(1);
    expect(held[0]!.reason).toBe('poison');
    expect(held[0]!.errorCode).toBe('ID_IN_USE');
    expect((await ctx.db.select().from(child).where(eq(child.id, childId)))[0]!.allergies).toBe('ZZ TEST lentils');
    expect(await changesOf(childId)).toHaveLength(1);
    expect(await publishedOf(childId)).toBe(published + 1);
  });

  it("two tills: till 1's change written online (answer lost), till 2 changes the child, till 1's box fact comes late: skipped, till 2's value stands", async () => {
    const { childId } = await family();
    const published = await publishedOf(childId);
    const actionId = newId();
    expect((await patchChild(childId, { allergies: 'ZZ TEST till one', actionId }, `visit-child:${actionId}`)).statusCode).toBe(200);
    const tillTwo = newId();
    expect((await patchChild(childId, { allergies: 'ZZ TEST till two', actionId: tillTwo }, `gate-child:${tillTwo}`)).statusCode).toBe(200);
    const caller = await openBox();
    await onBox(caller, actionId, { childId, allergies: 'ZZ TEST till one' });
    await flush();
    expect((await ctx.db.select().from(child).where(eq(child.id, childId)))[0]!.allergies).toBe('ZZ TEST till two');
    expect(await changesOf(childId)).toHaveLength(2);
    expect(await publishedOf(childId)).toBe(published + 2);
    expect(await quarantinedFor(childId)).toHaveLength(0);
  });

  it("the box's twin of a change written online leaves the child as the online write alone left it, its last-confirmed time included", async () => {
    const { childId } = await family();
    const actionId = newId();
    expect((await patchChild(childId, { allergies: 'ZZ TEST barley', actionId }, `visit-child:${actionId}`)).statusCode).toBe(200);
    const [online] = await ctx.db.select().from(child).where(eq(child.id, childId));
    const caller = await openBox();
    await onBox(caller, actionId, { childId, allergies: 'ZZ TEST barley' });
    await flush();
    const [afterTwin] = await ctx.db.select().from(child).where(eq(child.id, childId));
    expect(afterTwin!.allergies).toBe(online!.allergies);
    expect(afterTwin!.lastConfirmedAt).toEqual(online!.lastConfirmedAt);
    expect(afterTwin!.updatedAt).toEqual(online!.updatedAt);
    expect(await quarantinedFor(childId)).toHaveLength(0);
  });
});
