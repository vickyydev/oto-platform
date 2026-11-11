import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { child } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-871 — THE GATE'S RETRY REPLAYS A CHILD INSTEAD OF INSERTING ONE.
 *
 * The till's "Children playing alone" gate now mints one child id per slot and
 * sends it on every press of Continue (`saveGateChildren`). What that relies
 * on, pinned here against the real route:
 *
 *   - the same id sent again answers with the child that exists, under
 *     `x-oto-replay`, and the profile holds one row — even when the retry's
 *     body differs (the counter corrected an allergy between presses), so the
 *     till must bring the replayed record up to date with a PATCH, which it
 *     does;
 *   - that PATCH lands on the one row;
 *   - the id offered under another member is refused, so a slot's id can
 *     never quietly move a child between profiles.
 */

let ctx: TestContext;
let cookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function memberOf(phone: string, nickname: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie, 'idempotency-key': newId() },
    payload: { phone, nickname },
  });
  expect(created.statusCode).toBe(200);
  return created.json().member.id as string;
}

const addChild = (memberId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/children`,
    headers: { cookie, 'idempotency-key': newId() },
    payload: body,
  });

describe('SCRUM-871 — a child id sent twice', () => {
  it('answers with the child that exists and keeps one row, whatever the second body says', async () => {
    const memberId = await memberOf('0655558711', 'ZZ TEST Gate Retry');
    const id = newId();
    const first = await addChild(memberId, { id, name: 'Bua', ageYears: 6, allergies: null });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-oto-replay']).toBeUndefined();
    expect(first.json().child).toMatchObject({ id, name: 'Bua', ageYears: 6, allergies: null });

    // The retry: the counter corrected the allergy before pressing Continue again.
    const again = await addChild(memberId, { id, name: 'Bua', ageYears: 6, allergies: 'Shellfish' });
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json().child).toMatchObject({ id, name: 'Bua', allergies: null });

    const rows = await ctx.db.select().from(child).where(eq(child.memberId, memberId));
    expect(rows).toHaveLength(1);

    // What the till then sends: the correction as a PATCH on the replayed record.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${id}`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { allergies: 'Shellfish' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().child).toMatchObject({ id, allergies: 'Shellfish' });
    expect(await ctx.db.select().from(child).where(eq(child.memberId, memberId))).toHaveLength(1);
  });

  it("is refused under another member: a slot's id never moves a child", async () => {
    const parent = await memberOf('0655558712', 'ZZ TEST Gate Parent');
    const other = await memberOf('0655558713', 'ZZ TEST Gate Other');
    const id = newId();
    expect((await addChild(parent, { id, name: 'Nok', ageYears: 9 })).statusCode).toBe(200);
    const moved = await addChild(other, { id, name: 'Nok', ageYears: 9 });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe('ID_IN_USE');
    expect(await ctx.db.select().from(child).where(eq(child.memberId, other))).toHaveLength(0);
  });
});
