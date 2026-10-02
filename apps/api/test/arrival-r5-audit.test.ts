import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  booking,
  bookingRedemption,
  branch,
  member,
  sale,
  station,
  syncQuarantine,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  newId,
} from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { quoteBooking } from '../src/services/booking-checkout';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-12 CLOSING AUDIT — probes on the arrival path the round suites left open.
 *
 * (The harness below is the round-5 suite's own.)
 *
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

describe('S2-12 closing audit — a sale naming a booking with money of its own', () => {
  it('is quarantined whole: the cash is not erased, the booking is not redeemed, the counter can still redeem it', async () => {
    const paid = await plantPaidBooking();
    const saleId = newId();
    const actor = (
      await ctx.db.select({ id: auditLog.actorAccountId }).from(auditLog).where(eq(auditLog.action, 'auth.sign_in')).limit(1)
    )[0]?.id;
    // A box built before the bridge refused the marker (or one that was
    // tampered with) files an ordinary cash sale that names a paid booking.
    await agentA.outbox()!.queue({
      type: 'sale.finalised',
      stationId: tillId,
      actorKind: 'account',
      actorAccountId: actor ?? (await receptionId()),
      actionId: `forged-${newId().slice(-8)}`,
      payload: {
        saleId,
        cart: {
          memberId: maliId,
          tier: 'tourist',
          lines: [{ id: newId(), packageId, kids: 2, adults: 1 }],
          expectedTotalSatang: paid.totalSatang,
          bookingId: paid.id,
          bookingRedemptionId: newId(),
        },
        tenders: [
          {
            actionId: `cash-${newId().slice(-8)}`,
            methodCode: 'cash',
            kind: 'cash',
            provider: 'manual',
            amountSatang: paid.totalSatang,
            tenderedSatang: paid.totalSatang,
            changeSatang: 0,
            paidAt: new Date().toISOString(),
          },
        ],
        bands: [],
      },
    });
    await flushAll(agentA);

    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status, 'the booking is not redeemed by a cash sale').toBe('paid');
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toEqual([]);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    const held = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agentA.state.boxId!), eq(syncQuarantine.status, 'open')));
    expect(held.map((q) => q.errorCode)).toContain('SYNC_BOOKING_SALE_TENDER');

    // The family still redeems at the counter, once.
    const online = await call('POST', `/bookings/${paid.id}/redeem`, cookieA, { stationId: tillId });
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);
  });
});

async function receptionId(): Promise<string> {
  const me = await call('GET', '/me', cookieA);
  return ((me.body.account as { id?: string } | undefined)?.id ?? (me.body.id as string)) as string;
}
