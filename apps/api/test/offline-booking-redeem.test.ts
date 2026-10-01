import { generateKeyPairSync } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  band,
  booking,
  bookingRedemption,
  branch,
  child,
  member,
  paymentAttempt,
  sale,
  station,
  syncQuarantine,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  BOOKING_REDEEMED_FACT,
  PAID_ONLINE_TENDER_CODE,
  bandShortCode,
  newId,
  type BridgeBookingRedeemAnswer,
} from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { quoteBooking } from '../src/services/booking-checkout';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-12 ROUND 5 — AN ONLINE BOOKING REDEEMED WITH THE INTERNET DOWN, END TO END.
 *
 * The platform and two counter boxes (`createBoxAgent`, the code a Pi runs),
 * joined by a link this file cuts. A paid booking is in both boxes' cached
 * `bookings` scope. With the link down, Reception Till 1's box redeems it from
 * its own copy — the sale from what the family paid, the paid-online tender,
 * bands minted and printed on the box — and so does Counter 2's box, which has
 * no way to know (OD-A9: single use across two boxes is not made safe offline).
 *
 * The link comes back. The first box's facts file the redemption exactly as
 * the counter's online redemption shapes it; the second box's are quarantined
 * with an alert naming both, never applied blind; and a replay of the events
 * applies nothing twice.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookieA: string;
let cookieB: string;
let tillId: string;
let counterId: string;
let branchId: string;
let operatorId: string;
let packageId: string;
let maliId: string;
let children: string[];
let agentA: BoxAgent;
let agentB: BoxAgent;
const link: CuttableLink = { cut: false };

let planted = 0;

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

const bridge = (stationId: string, rest: string) => `/box/v1/station/${stationId}/${rest}`;

async function onBox(
  stationId: string,
  cookie: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return call('POST', bridge(stationId, 'intents'), cookie, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `bk-${newId().slice(-12)}`,
  });
}

/** A paid booking for Mali: two kids and an adult, priced by the booking site's own quote. */
async function plantPaidBooking(): Promise<{ id: string; reference: string; totalSatang: number }> {
  const id = newId();
  const reference = `OTO-OFFL-${String(++planted).padStart(4, '0')}`;
  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId)).limit(1);
  const bookingDate = new Date().toISOString().slice(0, 10);
  const quote = await quoteBooking(ctx.db, br!, {
    tier: 'tourist',
    visitDate: bookingDate,
    lines: [{ packageId, kids: 2, adults: 1 }],
  });
  await ctx.db.insert(booking).values({
    id,
    operatorId,
    branchId,
    memberId: maliId,
    reference,
    bookingDate,
    businessDate: bookingDate,
    status: 'paid',
    paidAt: new Date(),
    totalSatang: quote.totalSatang,
    pricingSnapshot: quote as never,
    payload: {
      tier: 'tourist',
      rateMode: quote.rateMode,
      parentName: 'Mali',
      phone: '+66811111111',
      lines: quote.lines as unknown as Array<Record<string, unknown>>,
    },
  });
  return { id, reference, totalSatang: quote.totalSatang };
}

async function flushAll(agent: BoxAgent): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  cookieA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  const [counter] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  tillId = till!.id;
  counterId = counter!.id;
  branchId = till!.branchId;
  operatorId = till!.operatorId;
  expect((await call('PUT', '/me/session/station', cookieA, { stationId: tillId })).statusCode).toBe(200);
  expect((await call('PUT', '/me/session/station', cookieB, { stationId: counterId })).statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  children = (
    await ctx.db.select({ id: child.id }).from(child).where(eq(child.memberId, maliId)).orderBy(asc(child.name))
  ).map((c) => c.id);
  agentA = linkedAgent(ctx, box1.id, 'booking-box-a', link, { devices: true });
  agentB = linkedAgent(ctx, box2.id, 'booking-box-b', link, { devices: true });
  for (const agent of [agentA, agentB]) {
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    attachInProcessBox(agent);
  }
}, 180_000);

afterAll(async () => {
  for (const agent of [agentA, agentB]) {
    if (!agent) continue;
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx.close();
  await teardownAll();
});

describe('an online booking redeemed with the box offline (S2-12 round 5)', () => {
  let paid: { id: string; reference: string; totalSatang: number };
  let first: BridgeBookingRedeemAnswer;
  let second: BridgeBookingRedeemAnswer;

  it('each box redeems it from its own copy with the link down — the paid lines to the satang, bands with the children', async () => {
    paid = await plantPaidBooking();
    // Both boxes pull the booking while the link is up.
    await agentA.syncCache();
    await agentB.syncCache();
    await agentA.setOffline(true, { reason: 'offline booking redemption' });
    await agentB.setOffline(true, { reason: 'offline booking redemption' });
    link.cut = true;
    // The platform's own route refuses: the till works through its box.
    const refused = await call('POST', `/bookings/${paid.id}/redeem`, cookieA, { stationId: tillId });
    expect(refused.statusCode).toBe(503);

    const found = await onBox(tillId, cookieA, 'booking.lookup', { reference: paid.reference });
    expect(found.statusCode, JSON.stringify(found.body)).toBe(200);
    expect((found.body.result as { booking: { status: string } }).booking.status).toBe('paid');

    const atA = await onBox(tillId, cookieA, 'booking.redeem', {
      bookingId: paid.id,
      actionId: `redeem-a-${newId().slice(-8)}`,
      staffName: 'Nok',
      visitChildIds: children,
    });
    expect(atA.statusCode, JSON.stringify(atA.body)).toBe(200);
    first = atA.body.result as unknown as BridgeBookingRedeemAnswer;
    expect(first.sale.totals.grossSatang).toBe(paid.totalSatang);
    expect(first.bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid', 'kid']);
    expect(first.bands.filter((b) => b.kind === 'kid').every((b) => b.childName)).toBe(true);

    // Counter 2's box cannot know: it redeems the same booking (OD-A9).
    const atB = await onBox(counterId, cookieB, 'booking.redeem', {
      bookingId: paid.id,
      actionId: `redeem-b-${newId().slice(-8)}`,
      staffName: 'Ploy',
    });
    expect(atB.statusCode, JSON.stringify(atB.body)).toBe(200);
    second = atB.body.result as unknown as BridgeBookingRedeemAnswer;
    expect(second.sale.id).not.toBe(first.sale.id);

    // Nothing has reached the ledger.
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toEqual([]);
  });

  it('the link comes back: the first box files the redemption as the online path shapes it', async () => {
    link.cut = false;
    await agentA.setOffline(false);
    await flushAll(agentA);

    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('redeemed');
    const redemptions = await ctx.db
      .select()
      .from(bookingRedemption)
      .where(eq(bookingRedemption.bookingId, paid.id));
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.stationId).toBe(tillId);
    expect([...(redemptions[0]!.bandCodes as string[])].sort()).toEqual(
      first.bands.map((b) => b.shortCode).sort(),
    );

    const [filed] = await ctx.db.select().from(sale).where(eq(sale.id, first.sale.id));
    expect(filed!.bookingId).toBe(paid.id);
    expect(filed!.salesChannel).toBe('booking');
    expect(filed!.origin).toBe('box');
    expect(filed!.status).toBe('finalised');
    expect(filed!.grossSatang).toBe(paid.totalSatang);
    expect(filed!.receiptNumber).toBe(first.sale.receiptNumber);

    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, first.sale.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.methodCode).toBe(PAID_ONLINE_TENDER_CODE);
    expect(attempts[0]!.method).toBe('transfer');
    expect(attempts[0]!.amountSatang).toBe(paid.totalSatang);
    expect(attempts[0]!.payload).toMatchObject({ paidOnline: true, bookingId: paid.id, reference: paid.reference });
    // SCRUM-477: taken with the box's link down, and the attempt says so.
    expect(attempts[0]!.offline).toBe(true);

    // The bands on the family's wrists, recorded as the box minted them.
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, first.sale.id));
    expect(bands.map((b) => b.id).sort()).toEqual(first.bands.map((b) => b.id).sort());
    expect(bands.map((b) => bandShortCode(b.code)).sort()).toEqual(first.bands.map((b) => b.shortCode).sort());
    expect(bands.filter((b) => b.kind === 'kid').every((b) => b.childId)).toBe(true);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, paid.id), eq(auditLog.action, 'booking.redeem.offline')));
    expect(audits).toHaveLength(1);
    const refused = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.boxId, agentA.state.boxId!));
    expect(refused.filter((q) => q.status === 'open').map((q) => q.errorCode)).toEqual([]);
  });

  it('the second box’s redemption is caught at sync: quarantined with an alert naming both, never applied', async () => {
    await agentB.setOffline(false);
    await flushAll(agentB);

    const held = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agentB.state.boxId!), eq(syncQuarantine.status, 'open')));
    const ours = held.filter((q) => q.errorCode === 'SYNC_BOOKING_REDEEMED_TWICE');
    expect(ours.map((q) => q.type).sort()).toEqual([BOOKING_REDEEMED_FACT, 'sale.finalised'].sort());
    expect(ours.every((q) => q.reason === 'conflict')).toBe(true);

    // Never applied blind: no second sale, no second redemption.
    expect(await ctx.db.select().from(sale).where(eq(sale.id, second.sale.id))).toEqual([]);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    expect(
      await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id)),
    ).toHaveLength(1);

    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `booking.redeemed_twice:${paid.id}`));
    expect(raised, 'the double redemption raises an alert').toBeTruthy();
    expect(raised!.severity).toBe('critical');
    expect(raised!.summary).toContain(paid.reference);
    expect(raised!.summary).toContain(first.sale.receiptNumber!);
    expect(raised!.summary).toContain(second.sale.receiptNumber!);
    const detail = raised!.detail as { first: { saleId: string }; second: { saleId: string; boxId: string } };
    expect(detail.first.saleId).toBe(first.sale.id);
    expect(detail.second.saleId).toBe(second.sale.id);
    expect(detail.second.boxId).toBe(agentB.state.boxId);
  });

  it('a replay of the first box’s events applies once', async () => {
    expect(await agentA.outbox()!.replayLastBatch(2)).toBeGreaterThan(0);
    await flushAll(agentA);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    expect(
      await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id)),
    ).toHaveLength(1);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, first.sale.id))).toHaveLength(1);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, paid.id), eq(auditLog.action, 'booking.redeem')));
    expect(audits).toHaveLength(1);
    const refused = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agentA.state.boxId!), eq(syncQuarantine.status, 'open')));
    expect(refused).toEqual([]);

    // The same fact under a fresh envelope (a restored store would mint one): still once.
    const events = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, paid.id), eq(auditLog.action, 'booking.redeem.offline')));
    expect(events).toHaveLength(1);
    await agentA.outbox()!.queue({
      type: BOOKING_REDEEMED_FACT,
      stationId: tillId,
      actorKind: 'account',
      actorAccountId: filedActor(events[0]!),
      actionId: `replay-${newId().slice(-8)}`,
      payload: {
        redemptionId: newId(),
        bookingId: paid.id,
        saleId: first.sale.id,
        reference: paid.reference,
        redeemedAt: new Date().toISOString(),
        bandCodes: first.bands.map((b) => b.shortCode),
        receiptNumber: first.sale.receiptNumber,
      },
    });
    await flushAll(agentA);
    expect(
      await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id)),
    ).toHaveLength(1);
    expect(
      (
        await ctx.db
          .select()
          .from(syncQuarantine)
          .where(and(eq(syncQuarantine.boxId, agentA.state.boxId!), eq(syncQuarantine.status, 'open')))
      ).map((q) => q.errorCode),
    ).toEqual([]);
  });
});

describe('a booking the counter redeemed online while a box redeemed it offline', () => {
  it('the box’s redemption is quarantined, and the alert says the first was at a counter online', async () => {
    const paid = await plantPaidBooking();
    await agentB.syncCache();
    await agentB.setOffline(true, { reason: 'offline while the counter is online' });
    link.cut = true;
    const atB = await onBox(counterId, cookieB, 'booking.redeem', {
      bookingId: paid.id,
      actionId: `redeem-b2-${newId().slice(-8)}`,
    });
    expect(atB.statusCode, JSON.stringify(atB.body)).toBe(200);
    const offline = atB.body.result as unknown as BridgeBookingRedeemAnswer;

    // Meanwhile Reception Till 1, online, redeems it at the platform.
    const online = await call('POST', `/bookings/${paid.id}/redeem`, cookieA, { stationId: tillId });
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);

    link.cut = false;
    await agentB.setOffline(false);
    await flushAll(agentB);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, offline.sale.id))).toEqual([]);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `booking.redeemed_twice:${paid.id}`));
    expect(raised!.summary).toContain('first at a counter online');
    const held = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agentB.state.boxId!), eq(syncQuarantine.status, 'open')));
    expect(
      held.filter((q) => {
        // The quarantine keeps the envelope whole; the fact's own payload is inside it.
        const raw = q.payload as { saleId?: string; payload?: { saleId?: string } };
        return q.errorCode === 'SYNC_BOOKING_REDEEMED_TWICE' && (raw.payload?.saleId ?? raw.saleId) === offline.sale.id;
      }),
    ).toHaveLength(2);
  });
});

/**
 * SCRUM-477 — THE QUIET QUARANTINES SPEAK. A box redemption the platform
 * cannot file for a reason other than a second redemption used to be held in
 * quarantine and nobody told: the booking cancelled online after the box took
 * its copy, or the paid sum moved. Both now raise an alert like the double
 * redemption does, because either way a family holds bands the ledger has no
 * sale for.
 */
describe('a box redemption the platform cannot file (SCRUM-477)', () => {
  async function redeemedOfflineOnB(): Promise<{ paid: { id: string; reference: string; totalSatang: number }; offline: BridgeBookingRedeemAnswer }> {
    const paid = await plantPaidBooking();
    await agentB.syncCache();
    await agentB.setOffline(true, { reason: 'offline while the platform’s copy moves' });
    link.cut = true;
    const atB = await onBox(counterId, cookieB, 'booking.redeem', {
      bookingId: paid.id,
      actionId: `redeem-b-held-${newId().slice(-8)}`,
      staffName: 'Ploy',
    });
    expect(atB.statusCode, JSON.stringify(atB.body)).toBe(200);
    return { paid, offline: atB.body.result as unknown as BridgeBookingRedeemAnswer };
  }

  async function linkBack(): Promise<void> {
    link.cut = false;
    await agentB.setOffline(false);
    await flushAll(agentB);
  }

  async function heldCodes(): Promise<string[]> {
    const held = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agentB.state.boxId!), eq(syncQuarantine.status, 'open')));
    return held.map((q) => q.errorCode ?? '');
  }

  it('a booking cancelled online after the box took its copy: quarantined as not paid, with a critical alert naming the sale', async () => {
    const { paid, offline } = await redeemedOfflineOnB();
    // Meanwhile, online, the booking is cancelled.
    await ctx.db.update(booking).set({ status: 'cancelled' }).where(eq(booking.id, paid.id));
    await linkBack();

    expect(await ctx.db.select().from(sale).where(eq(sale.id, offline.sale.id))).toEqual([]);
    expect(await heldCodes()).toContain('SYNC_BOOKING_NOT_PAID');
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `booking.redemption_quarantined:${paid.id}`));
    expect(raised, 'the quarantine raises an alert').toBeTruthy();
    expect(raised!.severity).toBe('critical');
    expect(raised!.category).toBe('booking.redemption_quarantined');
    expect(raised!.summary).toContain(paid.reference);
    expect(raised!.summary).toContain('cancelled');
    expect(raised!.summary).toContain(offline.sale.receiptNumber!);
    const detail = raised!.detail as { code: string; status: string; second: { saleId: string; boxId: string } };
    expect(detail.code).toBe('SYNC_BOOKING_NOT_PAID');
    expect(detail.status).toBe('cancelled');
    expect(detail.second.saleId).toBe(offline.sale.id);
    expect(detail.second.boxId).toBe(agentB.state.boxId);
  });

  it('a booking whose paid sum moved online: quarantined as drifted, with the same alert', async () => {
    const { paid, offline } = await redeemedOfflineOnB();
    await ctx.db.update(booking).set({ totalSatang: paid.totalSatang + 100 }).where(eq(booking.id, paid.id));
    await linkBack();

    expect(await ctx.db.select().from(sale).where(eq(sale.id, offline.sale.id))).toEqual([]);
    expect(await heldCodes()).toContain('BOOKING_TOTAL_DRIFT');
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `booking.redemption_quarantined:${paid.id}`));
    expect(raised).toBeTruthy();
    expect(raised!.severity).toBe('critical');
    expect(raised!.summary).toContain(paid.reference);
    expect((raised!.detail as { code: string }).code).toBe('BOOKING_TOTAL_DRIFT');
  });
});

function filedActor(row: typeof auditLog.$inferSelect): string {
  return row.actorAccountId!;
}
