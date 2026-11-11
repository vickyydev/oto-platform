import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { station, stationEvent } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-870 — THE CLOUD STATION CLEARS THE DISPLAY WHEN THE TILL GIVES IT UP.
 *
 * The api's station is the box agent's `StationSessionManager` over the
 * `edge` schema, so a release there resets the screen exactly as a Pi does
 * (packages/box-agent/test/s870-release-resets-display.test.ts). This file
 * drives it the three ways a till reaches it on the platform lane: the
 * station routes, the station bridge, and the lease hint on sign-out — and
 * reads each result the way the paired display reads it.
 */

const IDLE = { stage: 'identify', step: null, cart: null, member: null, totals: null, payment: null, prompt: null, lease: null };

const identifyFrame = (requestId: string) => ({
  stage: 'identify', step: 1, cart: { supported: true, sale: { tier: 'tourist' } }, member: null, totals: null, payment: null,
  prompt: { kind: 'identify', requestId, phone: '', nickname: '', contactChannel: 'whatsapp', saleKey: 'sale-1' },
});

const thankYouFrame = () => ({
  stage: 'thankyou', step: 6,
  cart: {
    supported: true, nickname: 'ZZ TEST family',
    sale: { id: 'sale-870', tier: 'tourist', total: 1380,
      lines: [{ id: 'line-1', name: '1 Hour Play', lineTotal: 1380,
        breakdown: { rows: [{ key: 'kids', kind: 'kids', label: 'Children', unitPrice: 690, quantity: 2, subtotal: 1380 }],
          priced: true, lengthChosen: true } }],
      manualDiscounts: [], creditGrants: [], bracelets: { adults: 1, children: 2 } },
    voucherPrize: null, nothingToPay: false,
  },
  member: { id: 'member-1', nickname: 'ZZ TEST family', tier: 'tourist' },
  totals: { manualAmounts: {}, discountAmount: 0, total: 1380, taxBreakdown: { serviceChargeTotal: 0, categories: [] } },
  payment: { saleId: 'sale-870', amountSatang: 138000, qrPayload: null, qrImageUrl: null, expiresAt: null,
    status: 'paid', offline: false, online: true },
  prompt: null,
});

const fnbWelcomeFrame = () => ({
  stage: 'welcome', step: null, cart: { kind: 'fnb', supported: true, lines: [], orderNote: '', manualDiscounts: [], completion: null },
  member: null, totals: null, payment: null, prompt: null,
});

describe('SCRUM-870: a release resets the paired display on the cloud station', () => {
  let ctx: TestContext;
  let staff: string;
  let manager: string;
  let tillId: string;
  let authorization: string;

  const screenOf = (document: Record<string, unknown>) => ({
    stage: document.stage, step: document.step ?? null, cart: document.cart ?? null, member: document.member ?? null,
    totals: document.totals ?? null, payment: document.payment ?? null, prompt: document.prompt ?? null, lease: document.lease ?? null,
  });
  const displayRead = async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/display/session', headers: { authorization } });
    expect(res.statusCode).toBe(200);
    return res.json().document as Record<string, unknown>;
  };
  const displaySend = (type: string, payload: Record<string, unknown>, lastSeenSequence: number) => ctx.app.inject({
    method: 'POST', url: '/display/intents', headers: { authorization }, payload: { type, payload, lastSeenSequence, actionId: newId() },
  });
  const staffRead = async (cookie = staff) => {
    const res = await ctx.app.inject({ method: 'GET', url: `/stations/${tillId}/session`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json().document as Record<string, unknown>;
  };
  const claim = async (holder: string, cookie = staff) => {
    const res = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/lease`, headers: { cookie }, payload: { holder } });
    expect(res.statusCode, res.body).toBe(200);
    return { leaseId: res.json().lease.leaseId as string, sequence: res.json().document.sequence as number };
  };
  const publish = async (leaseId: string, lastSeenSequence: number, payload: Record<string, unknown>, cookie = staff) => {
    const res = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/intents`, headers: { cookie },
      payload: { type: 'session.publish_display', leaseId, lastSeenSequence, actionId: newId(), payload } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().document as Record<string, unknown>;
  };
  const release = async (leaseId: string, cookie = staff) => {
    const res = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/lease/release`, headers: { cookie }, payload: { leaseId } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { released: boolean };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    staff = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const [row] = await ctx.db.select({ id: station.id }).from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
    tillId = row!.id;
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staff },
      payload: { stationId: tillId } })).statusCode).toBe(200);
    authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const requested = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
    expect(requested.statusCode).toBe(200);
    const claimed = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/displays/claim`,
      headers: { cookie: manager }, payload: { pairingCode: requested.json().pairingCode, name: 'ZZ TEST display' } });
    expect(claimed.statusCode).toBe(200);
  });
  afterAll(async () => { await ctx.close(); await teardownAll(); });

  it('the till’s release returns the display to its welcome screen, and the leftover prompt cannot be answered', async () => {
    const held = await claim('ipad-till');
    const asked = await publish(held.leaseId, held.sequence, identifyFrame('request-1'));
    expect((await displayRead()).prompt).toMatchObject({ kind: 'identify', requestId: 'request-1' });

    expect(await release(held.leaseId)).toEqual({ released: true });
    const idle = await displayRead();
    expect(screenOf(idle)).toEqual(IDLE);
    expect(idle.sequence).toBe((asked.sequence as number) + 1);
    expect(screenOf(await staffRead())).toEqual(IDLE);

    // The next family, answering the prompt the screen showed a moment ago.
    const refused = await displaySend('display.identify',
      { requestId: 'request-1', phone: '0812345678', nickname: 'Guest', contactChannel: 'whatsapp' }, idle.sequence as number);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('DISPLAY_INTENT_REFUSED');
    expect(refused.json().error.details.reason).toBe('wrong_stage');
    expect(screenOf(await displayRead())).toEqual(IDLE);

    // The tape says the release cleared the screen.
    const [line] = await ctx.db.select().from(stationEvent)
      .where(and(eq(stationEvent.stationId, tillId), eq(stationEvent.leaseId, held.leaseId), eq(stationEvent.outcome, 'released')))
      .orderBy(desc(stationEvent.occurredAt)).limit(1);
    expect(line).toMatchObject({ kind: 'lease', source: 'box', sequence: idle.sequence, payload: { screen: 'reset' } });
  });

  it('through the station bridge, the previous family’s thank-you goes with the lease', async () => {
    const leased = await ctx.app.inject({ method: 'POST', url: `/box/v1/station/${tillId}/lease`, headers: { cookie: staff },
      payload: { holder: 'bridge-till' } });
    expect(leased.statusCode, leased.body).toBe(200);
    const leaseId = leased.json().lease.leaseId as string;
    const shown = await ctx.app.inject({ method: 'POST', url: `/box/v1/station/${tillId}/intents`, headers: { cookie: staff },
      payload: { type: 'session.publish_display', leaseId, lastSeenSequence: leased.json().document.sequence, actionId: newId(),
        payload: thankYouFrame() } });
    expect(shown.statusCode, shown.body).toBe(200);
    const before = await displayRead();
    expect(before.stage).toBe('thankyou');
    expect(JSON.stringify(before)).toContain('ZZ TEST family');

    const gone = await ctx.app.inject({ method: 'POST', url: `/box/v1/station/${tillId}/lease/release`, headers: { cookie: staff },
      payload: { leaseId } });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json()).toEqual({ released: true });
    const after = await displayRead();
    expect(screenOf(after)).toEqual(IDLE);
    expect(JSON.stringify(after)).not.toContain('ZZ TEST family');
  });

  it('the F&B station takes the cleared screen, and the till’s first screen comes back after it', async () => {
    const fnb = await claim('fnb-tab');
    const welcome = await publish(fnb.leaseId, fnb.sequence, fnbWelcomeFrame());
    expect(welcome.stage).toBe('welcome');
    expect((await displayRead()).cart).toMatchObject({ kind: 'fnb', supported: true });
    expect(await release(fnb.leaseId)).toEqual({ released: true });
    expect(screenOf(await displayRead())).toEqual(IDLE);

    const again = await claim('ipad-till');
    const asked = await publish(again.leaseId, again.sequence, identifyFrame('request-2'));
    expect(asked.stage).toBe('identify');
    const shown = await displayRead();
    expect(shown.prompt).toMatchObject({ kind: 'identify', requestId: 'request-2' });
    expect((shown.prompt as { answer?: unknown }).answer).toBeUndefined();
    expect(await release(again.leaseId)).toEqual({ released: true });
  });

  it('a release that finds the lease moved on leaves the new holder’s screen alone', async () => {
    const first = await claim('ipad-till');
    await publish(first.leaseId, first.sequence, identifyFrame('request-3'));
    // A manager takes the station and shows the next sale; the displaced tab's late release changes nothing.
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: manager },
      payload: { stationId: tillId } })).statusCode).toBe(200);
    const taken = await ctx.app.inject({ method: 'POST', url: `/stations/${tillId}/lease`, headers: { cookie: manager },
      payload: { holder: 'manager-tab', takeover: true } });
    expect(taken.statusCode, taken.body).toBe(200);
    const shown = await publish(taken.json().lease.leaseId as string, taken.json().document.sequence as number, thankYouFrame(), manager);
    expect(await release(first.leaseId)).toEqual({ released: false });
    const kept = await displayRead();
    expect(kept.stage).toBe('thankyou');
    expect(kept.sequence).toBe(shown.sequence);
    expect(await release(taken.json().lease.leaseId as string, manager)).toEqual({ released: true });
    expect(screenOf(await displayRead())).toEqual(IDLE);
  });

  it('sign-out with the lease hint clears the display too', async () => {
    const held = await claim('ipad-till');
    await publish(held.leaseId, held.sequence, identifyFrame('request-4'));
    expect((await displayRead()).prompt).toMatchObject({ requestId: 'request-4' });
    const ended = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: staff },
      payload: { stationLeaseId: held.leaseId } });
    expect(ended.statusCode).toBe(200);
    expect(screenOf(await displayRead())).toEqual(IDLE);
  });
});
