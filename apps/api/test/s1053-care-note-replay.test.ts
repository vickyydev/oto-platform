import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, station, syncChange } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1053 — A CHILD'S CHANGE SENT AGAIN UNDER ITS KEY IS THE FIRST WRITE.
 *
 * The till's drop-off gate now sends each change to a saved child under a
 * key it holds for that change (`gateWriteKey`): the family's care notes
 * from the customer display (SCRUM-1020) and staff's own changes alike. A
 * reply lost on the way back, and Done pressed again, re-sends the same key
 * and body. What that relies on, pinned against the real route and the
 * shared idempotency middleware:
 *
 *   - the same key and body is answered from the first write, marked as a
 *     replay: one change to the record, one audit row, one publication to the
 *     boxes;
 *   - the same key with another body is refused and writes nothing;
 *   - a new change under a new key is written as before.
 */

let ctx: TestContext;
let cookie: string;
let tillCookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  tillCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const tillId = (await ctx.db.select().from(station)).find((s) => s.name === 'Reception Till 1')!.id;
  await takeStation(ctx.app, tillCookie, tillId);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function familyOf(phone: string, nickname: string, childName: string) {
  const created = await ctx.app.inject({ method: 'POST', url: '/members', headers: { cookie, 'idempotency-key': newId() },
    payload: { phone, nickname } });
  expect(created.statusCode, created.body).toBe(200);
  const memberId = created.json().member.id as string;
  const kid = await ctx.app.inject({ method: 'POST', url: `/members/${memberId}/children`, headers: { cookie, 'idempotency-key': newId() },
    payload: { name: childName, ageYears: 5, allergies: 'ZZ TEST peanuts' } });
  expect(kid.statusCode, kid.body).toBe(200);
  return { memberId, childId: kid.json().child.id as string };
}

const patchChild = (childId: string, payload: Record<string, unknown>, key: string) =>
  ctx.app.inject({ method: 'PATCH', url: `/members/children/${childId}`, headers: { cookie: tillCookie, 'idempotency-key': key }, payload });

const auditOf = (childId: string) =>
  ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'child.update'), eq(auditLog.entityId, childId)));
const publishedOf = (childId: string) =>
  ctx.db.select().from(syncChange).where(and(eq(syncChange.entityType, 'child'), eq(syncChange.entityId, childId)));

describe('SCRUM-1053 — a child\'s change re-sent under its key', () => {
  it("the family's care note from the display: answered from the first write, audited and published once", async () => {
    const { memberId, childId } = await familyOf('0655551053', 'ZZ TEST Care Replay', 'ZZ TEST Nong Replay');
    const published = (await publishedOf(childId)).length;
    const key = `gate-child:${newId()}`;
    const body = { source: 'customer_display', memberId, allergies: 'ZZ TEST peanuts, sesame' };
    const first = await patchChild(childId, body, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['x-oto-replay']).toBeUndefined();

    const again = await patchChild(childId, body, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const rows = await auditOf(childId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe('customer_display');
    expect(await publishedOf(childId)).toHaveLength(published + 1);
    expect((await ctx.db.select().from(child).where(eq(child.id, childId)))[0]!.allergies).toBe('ZZ TEST peanuts, sesame');
  });

  it('the same key with another change is refused and writes nothing; a new change takes a new key', async () => {
    const { memberId, childId } = await familyOf('0655551054', 'ZZ TEST Care Mismatch', 'ZZ TEST Nong Mismatch');
    const key = `gate-child:${newId()}`;
    expect((await patchChild(childId, { source: 'customer_display', memberId, allergies: 'ZZ TEST eggs' }, key)).statusCode).toBe(200);
    const reused = await patchChild(childId, { source: 'customer_display', memberId, allergies: 'ZZ TEST eggs and milk' }, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(await auditOf(childId)).toHaveLength(1);
    const next = await patchChild(childId, { source: 'customer_display', memberId, allergies: 'ZZ TEST eggs and milk' }, `gate-child:${newId()}`);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.headers['x-oto-replay']).toBeUndefined();
    expect(await auditOf(childId)).toHaveLength(2);
  });

  it("staff's own change in the gate replays the same way", async () => {
    const { childId } = await familyOf('0655551055', 'ZZ TEST Staff Replay', 'ZZ TEST Nong Staff');
    const key = `gate-child:${newId()}`;
    const first = await patchChild(childId, { allergies: 'ZZ TEST peanuts, staff note' }, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await patchChild(childId, { allergies: 'ZZ TEST peanuts, staff note' }, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(await auditOf(childId)).toHaveLength(1);
  });
});
