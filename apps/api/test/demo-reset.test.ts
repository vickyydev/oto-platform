import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, member, operator, ticketPackage, visit } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-01c — "Reset demo data" on the staging profile. What is being proved is
 * the promise made to the client: play with it, make a mess, put it back —
 * without losing the logins or the prices.
 */

const CONFIRM = 'RESET DEMO DATA';

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;

/** A play session: a walk-up member, a visit, and a band off the printer. */
let walkIns = 0;
async function makeMess(): Promise<{ memberId: string; visitId: string }> {
  walkIns += 1;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie: receptionCookie },
    payload: { phone: `065555000${walkIns}`, nickname: `Walk-in ${walkIns}` },
  });
  expect(created.statusCode).toBe(200);

  const mali = await ctx.app.inject({
    method: 'GET',
    url: '/members/lookup?phone=0811111111',
    headers: { cookie: receptionCookie },
  });
  const visitRes = await ctx.app.inject({
    method: 'POST',
    url: '/visits',
    headers: { cookie: receptionCookie },
    payload: {
      memberId: mali.json().member.id,
      childIds: mali.json().member.children.map((c: { id: string }) => c.id),
    },
  });
  expect(visitRes.statusCode).toBe(200);

  // No route mints a band yet (S2-04), so the row is written directly — the
  // reset has to clear the tables the rest of the sprint fills, not only the
  // ones with an endpoint today.
  const [op] = await ctx.db.select().from(operator).where(eq(operator.name, 'OTO'));
  await ctx.db.insert(band).values({ id: newId(), operatorId: op!.id, code: 'BAND-TEST-1' });

  return { memberId: created.json().member.id as string, visitId: visitRes.json().id as string };
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true' } });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('demo reset — refusals', () => {
  it('refuses a reception account on a deployment where the control is on', async () => {
    await makeMess();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ops/demo-reset',
      headers: { cookie: receptionCookie },
      payload: { confirm: CONFIRM },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.select().from(visit)).not.toHaveLength(0);
  });

  it('refuses a platform admin who mistypes the confirmation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ops/demo-reset',
      headers: { cookie: adminCookie },
      payload: { confirm: 'reset demo data' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/RESET DEMO DATA/);
    expect(await ctx.db.select().from(visit)).not.toHaveLength(0);
  });

  it('refuses everyone on a deployment that did not opt in', async () => {
    const off = await createTestContext();
    try {
      const cookie = await signInAs(off.app, ADMIN.phone, ADMIN.password);
      const status = await off.app.inject({
        method: 'GET',
        url: '/ops/demo-reset',
        headers: { cookie },
      });
      expect(status.json().available).toBe(false);

      const res = await off.app.inject({
        method: 'POST',
        url: '/ops/demo-reset',
        headers: { cookie },
        payload: { confirm: CONFIRM },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/this deployment/);
      expect(await off.db.select().from(member)).not.toHaveLength(0);
    } finally {
      await off.close();
    }
  });
});

describe('demo reset — the happy path', () => {
  it('offers the control to a platform admin on staging', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/ops/demo-reset',
      headers: { cookie: adminCookie },
    });
    expect(res.json()).toEqual({ available: true, confirmationPhrase: CONFIRM });
  });

  it('is invisible to reception even on staging', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/ops/demo-reset',
      headers: { cookie: receptionCookie },
    });
    expect(res.json().available).toBe(false);
  });

  it('clears the facts, keeps the accounts, the catalogue and the seeded families', async () => {
    const { memberId } = await makeMess();
    const packagesBefore = (await ctx.db.select().from(ticketPackage)).length;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ops/demo-reset',
      headers: { cookie: adminCookie },
      payload: { confirm: CONFIRM },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted.visit).toBeGreaterThan(0);
    expect(res.json().deleted.band).toBeGreaterThan(0);

    // The facts are gone.
    expect(await ctx.db.select().from(visit)).toHaveLength(0);
    expect(await ctx.db.select().from(band)).toHaveLength(0);
    expect(await ctx.db.select().from(member).where(eq(member.id, memberId))).toHaveLength(0);

    // The configuration is not.
    expect(await ctx.db.select().from(ticketPackage)).toHaveLength(packagesBefore);
    await expect(signInAs(ctx.app, RECEPTION.phone, RECEPTION.password)).resolves.toBeTruthy();

    // And QA still finds Mali where QA expects her.
    const mali = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie: receptionCookie },
    });
    expect(mali.json().member.nickname).toBe('Mali');
    expect(mali.json().member.children).toHaveLength(2);
  });

  it('records the reset and takes the audit rows of what it deleted', async () => {
    const rows = await ctx.db.select().from(auditLog);
    const reset = rows.filter((r) => r.action === 'ops.demo_reset');
    expect(reset).toHaveLength(1);
    expect((reset[0]!.after as { deleted: Record<string, number> }).deleted.visit).toBeGreaterThan(0);

    expect(rows.filter((r) => r.entityType === 'visit')).toHaveLength(0);
    expect(rows.filter((r) => r.entityType === 'member')).toHaveLength(0);
    // Who signed in is access history, not a fact of the play session.
    expect(rows.filter((r) => r.entityType === 'session').length).toBeGreaterThan(0);
  });
});
