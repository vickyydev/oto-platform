import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { station } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-942 (FIRST PART) — A LOCKED TILL LEARNS WHERE THE FAMILY'S FORM STANDS.
 *
 * A till nobody touched locks while a family fills the drop-off form on its
 * paired display. A locked session may do no business — the station document
 * stays closed to it — but it may read its station's status, which carries no
 * personal data; that read now says whether the family's form is open
 * (`filling`) or their Done waits for the till (`done`). The lock screen says
 * so. Nothing about when the till locks changes.
 */

let ctx: TestContext;
let staffCookie: string;
let tillId: string;
let leaseId: string;
let display: string;
const visitorId = newId();

const status = () => ctx.app.inject({ method: 'GET', url: `/box/v1/station/${tillId}/status`, headers: { cookie: staffCookie } });
const sequence = async () => (await ctx.app.inject({ method: 'GET', url: '/display/session', headers: { authorization: display } }))
  .json().document.sequence as number;
const form = (requestId: string) => ({
  kind: 'consent', requestId, visitorId,
  slots: [{ id: 'slot-a', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
  guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: true, confirmations: [],
  guardianPhone: '+66898942001', contactChannel: 'whatsapp', contactConfirmed: true,
  staffReady: true, canContinue: true, completed: false,
});
const publish = async (prompt: Record<string, unknown> | null, step = 7, stage = 'input') => {
  const res = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/intents`, headers: { cookie: staffCookie },
    payload: { type: 'session.publish_display', leaseId, lastSeenSequence: await sequence(), actionId: newId(),
      payload: { stage, step, cart: null, totals: null, payment: null, member: null, prompt } } });
  expect(res.statusCode, res.body).toBe(200);
};

beforeAll(async () => {
  ctx = await createTestContext();
  const manager = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  staffCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [till] = await ctx.db.select({ id: station.id }).from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
  tillId = till!.id;
  expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staffCookie },
    payload: { stationId: tillId } })).statusCode).toBe(200);
  display = `Bearer ${randomBytes(32).toString('hex')}`;
  const requested = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization: display }, payload: {} });
  const claimed = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/displays/claim`, headers: { cookie: manager },
    payload: { pairingCode: requested.json().pairingCode, name: 'ZZ TEST counter display' } });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const lease = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/lease`, headers: { cookie: staffCookie },
    payload: { holder: 'ZZ TEST till', holderKind: 'till' } });
  expect(lease.statusCode, lease.body).toBe(200);
  leaseId = lease.json().lease.leaseId as string;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('GET /box/v1/station/:id/status — the family’s form', () => {
  it('says no form while the till is on another screen', async () => {
    await publish(null, 3, 'order');
    const res = await status();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().familyForm).toBeNull();
  });

  it('a locked till reads that the form is being filled, then that the family pressed Done, and nothing more', async () => {
    const requestId = newId();
    await publish(form(requestId));
    expect((await status()).json().familyForm).toBe('filling');

    expect((await ctx.app.inject({ method: 'POST', url: '/auth/lock', headers: { cookie: staffCookie } })).statusCode).toBe(200);
    const locked = await status();
    expect(locked.statusCode, locked.body).toBe(200);
    expect(locked.json().familyForm).toBe('filling');
    // The family's answers are still not the locked session's to read.
    expect((await ctx.app.inject({ method: 'GET', url: `/stations/${tillId}/session`, headers: { cookie: staffCookie } })).statusCode).toBe(423);

    const done = await ctx.app.inject({ method: 'POST', url: '/display/intents', headers: { authorization: display },
      payload: { type: 'display.consent', actionId: newId(), lastSeenSequence: await sequence(),
        payload: { action: 'done', requestId, visitorId } } });
    expect(done.statusCode, done.body).toBe(200);
    const after = await status();
    expect(after.statusCode).toBe(200);
    expect(after.json().familyForm).toBe('done');
    // No word of the family on the read: no name, no number.
    expect(after.body).not.toContain('ZZ TEST guardian');
    expect(after.body).not.toContain('898942001');
  });
});
