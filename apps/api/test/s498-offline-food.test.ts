import { generateKeyPairSync } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, band, checkin, product, sale, saleLine, station, ticketPackage } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { bandShortCode, newId, type BandStayView } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { boxCompletedSale } from '../src/services/band-food';
import { checkinCacheItem } from '../src/services/sync-checkin';
import { openAttempt, settleAttempt } from '../src/services/payments/attempt';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SCRUM-498 — THE FOOD COUNTER THROUGH ITS BOX WITH THE INTERNET DOWN, end to
 * end: the platform's check-in copy reaches the box, the box answers a band
 * scan as the platform does, serves a prepaid meal once, and the platform
 * files it served once when the link is back.
 */

const keys = generateKeyPairSync('ed25519');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let tillId: string;
let branchId: string;
let operatorId: string;
let boxId: string;
let twoHoursId: string;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };
const menu = new Map<string, { id: string; name: string; priceSatang: number }>();

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>) {
  return call('POST', `/box/v1/station/${tillId}/intents`, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `s498-${newId().slice(-12)}`,
  });
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
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
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  boxId = box1.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  branchId = till!.branchId;
  operatorId = till!.operatorId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const rows = await ctx.db.select().from(product).where(and(eq(product.operatorId, operatorId), isNull(product.archivedAt)));
  for (const row of rows) if (row.code) menu.set(row.code, { id: row.id, name: row.name, priceSatang: row.priceSatang });
  agent = linkedAgent(ctx, box1.id, 's498-food-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

const item = (code: string) => menu.get(code)!;

/** A child registered online with prepaid hot dogs, paid and checked in: in the park, banded. */
async function childInPark(name: string, hotDogs: number, allergies: string | null) {
  const checkinId = newId();
  const hotDog = item('FB-HOTDOG');
  const food = {
    mode: 'prepaid_items' as const,
    paidSatang: hotDog.priceSatang * hotDogs,
    items: [{ menuItemId: hotDog.id, menuItemName: hotDog.name, unitSatang: hotDog.priceSatang, qty: hotDogs, redeemedQty: 0 }],
  };
  const reg = await call('POST', '/checkin/registrations', {
    id: newId(),
    branchId,
    stationId: tillId,
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [{ checkinId, name, ageYears: 6, service: 'drop_off', allergies, foodRestrictions: 'No pork', foodProvision: food }],
  });
  expect(reg.statusCode, JSON.stringify(reg.body)).toBe(200);
  const saleId = newId();
  const commit = await call('POST', '/sales', {
    id: saleId,
    stationId: tillId,
    lines: [
      {
        id: checkinId,
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        foodProvision: { mode: food.mode, paidSatang: food.paidSatang },
      },
    ],
  });
  expect(commit.statusCode, JSON.stringify(commit.body)).toBe(200);
  expect((await call('POST', `/sales/${saleId}/finalise`, {})).statusCode).toBe(200);
  const now = await call('POST', '/checkin/check-in-now', { saleId, entries: [{ checkinId, nannyId: null }] });
  expect(now.statusCode, JSON.stringify(now.body)).toBe(200);
  const [row] = await ctx.db
    .select({ code: band.code })
    .from(checkin)
    .innerJoin(band, eq(band.id, checkin.bandId))
    .where(eq(checkin.id, checkinId));
  return { checkinId, bandCode: row!.code };
}

const prepaidLine = (checkinId: string) => ({
  id: newId(),
  productId: item('FB-HOTDOG').id,
  quantity: 1,
  prepaid: { checkinId },
  lineTotalSatang: 0,
});

/** A prepaid-only F&B order rung up and confirmed on the box, as the till sends it. */
async function serveOnBox(checkinId: string) {
  const cart = { channel: 'fnb', pickupCode: '42', bandHolder: { checkinId }, items: [prepaidLine(checkinId)] };
  const quote = await onBox('cart.quote', cart);
  if (quote.statusCode !== 200) return { quote, saleId: null };
  const saleId = newId();
  const paid = await onBox('sale.finalise', {
    saleId,
    actionId: `pay-${saleId.slice(-8)}`,
    staffName: 'Nok',
    cart: { ...cart, expectedTotalSatang: quote.body.result.quote.totals.grossSatang },
  });
  return { quote, paid, saleId };
}

async function redeemAuditsFor(checkinId: string, saleId: string) {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, checkinId)));
  return rows.filter((r) => (r.after as { saleId?: string }).saleId === saleId);
}

describe('s498 — a prepaid meal served through the box with the internet down', () => {
  it('reads the stay as online, serves the meal once on the box, and the platform files it served once', async () => {
    const kid = await childInPark('Mint', 1, 'Peanuts');
    const online = await call('GET', `/wallets/scan?key=${encodeURIComponent(kid.bandCode)}&branchId=${branchId}`);
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);
    const onlineStay = online.body.stay as BandStayView;
    expect(onlineStay).toMatchObject({ checkinId: kid.checkinId, allergiesMedical: 'Peanuts', foodRestrictions: 'No pork' });

    await agent.syncCache();
    await agent.setOffline(true, { reason: 's498 food' });
    link.cut = true;
    let saleId: string;
    try {
      const scanned = await onBox('checkin.band_food', { key: bandShortCode(kid.bandCode)! });
      expect(scanned.statusCode, JSON.stringify(scanned.body)).toBe(200);
      expect(scanned.body.result.stay, 'the box answers the scan as the platform does').toEqual(onlineStay);

      const first = await serveOnBox(kid.checkinId);
      expect(first.quote.statusCode, JSON.stringify(first.quote.body)).toBe(200);
      expect(first.quote.body.result.quote.totals.grossSatang).toBe(0);
      expect(first.paid!.statusCode, JSON.stringify(first.paid!.body)).toBe(200);
      saleId = first.saleId!;

      const again = await serveOnBox(kid.checkinId);
      expect(again.quote.statusCode).toBe(409);
      expect(again.quote.body.error).toMatchObject({
        code: 'PREPAID_USED_UP',
        message: `Mint's prepaid ${item('FB-HOTDOG').name} has already been served.`,
      });
      const after = await onBox('checkin.band_food', { key: kid.bandCode });
      expect(after.body.result.stay.foodProvision.items[0].redeemedQty).toBe(1);
    } finally {
      link.cut = false;
      await agent.setOffline(false);
    }
    await flushAll();

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('finalised');
    expect(row!.origin).toBe('box');
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const hotDog = lines.find((l) => l.kind === 'fnb_item')!;
    expect(hotDog.quantity).toBe(1);
    expect(hotDog.grossSatang).toBe(0);
    expect(hotDog.payload).toMatchObject({ prepaid: { checkinId: kid.checkinId }, holder: { checkinId: kid.checkinId } });
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty).toBe(1);
    expect(await redeemAuditsFor(kid.checkinId, saleId)).toHaveLength(1);
    expect(await boxCompletedSale(ctx.db, saleId)).toBe(true);

    // The copy built for this box says what it filed, so the box does not count the meal twice.
    const copy = await checkinCacheItem(ctx.db, operatorId, branchId, new Date(), boxId);
    const cached = copy.families.flatMap((f) => f.children).find((c) => c.id === kid.checkinId);
    expect(cached?.boxPrepaidServed).toEqual([{ menuItemId: item('FB-HOTDOG').id, qty: 1 }]);
    await agent.syncCache();
    await agent.setOffline(true, { reason: 's498 food again' });
    link.cut = true;
    try {
      const reread = await onBox('checkin.band_food', { key: kid.bandCode });
      expect(reread.body.result.stay.foodProvision.items[0].redeemedQty).toBe(1);
    } finally {
      link.cut = false;
      await agent.setOffline(false);
    }
    // A second delivery of the box's queue serves nothing twice.
    await flushAll();
    expect(await redeemAuditsFor(kid.checkinId, saleId)).toHaveLength(1);
  });

  it('a sale the box did not complete is confirmed online under the online rules: a used-up prepaid line is set aside', async () => {
    const kid = await childInPark('Ploy', 1, null);
    const open = newId();
    const hotDog = prepaidLine(kid.checkinId);
    const juice = { id: newId(), productId: item('FB-JUICE').id, quantity: 1 };
    const committed = await call('POST', '/sales', {
      id: open,
      stationId: tillId,
      channel: 'fnb',
      pickupCode: '42',
      bandHolder: { checkinId: kid.checkinId },
      items: [hotDog, juice],
    });
    expect(committed.statusCode, JSON.stringify(committed.body)).toBe(200);
    // Started on the box, never completed there: no box finalised it.
    await ctx.db.update(sale).set({ origin: 'box', boxId }).where(eq(sale.id, open));
    expect(await boxCompletedSale(ctx.db, open)).toBe(false);
    // Meanwhile the hot dog is served elsewhere: none is left for the child.
    const hot = item('FB-HOTDOG');
    await ctx.db
      .update(checkin)
      .set({
        foodProvision: {
          mode: 'prepaid_items',
          paidSatang: hot.priceSatang,
          items: [{ menuItemId: hot.id, menuItemName: hot.name, unitSatang: hot.priceSatang, qty: 1, redeemedQty: 1 }],
        },
      })
      .where(eq(checkin.id, kid.checkinId));
    // A card is approved for the whole order, then the counter confirms online.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    const [reception] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
    await ctx.db.transaction(async (tx) => {
      const opened = await openAttempt(tx, {
        saleId: open,
        operatorId,
        branchId,
        stationId: row!.stationId,
        businessDate: row!.businessDate,
        method: 'card',
        methodCode: 'card',
        amountSatang: row!.grossSatang,
        payload: { takenByAccountId: reception!.id },
      });
      await settleAttempt(tx, opened.id, { paidAt: new Date() });
    });
    const fin = await call('POST', `/sales/${open}/finalise`, {});
    expect(fin.statusCode, JSON.stringify(fin.body)).toBe(200);
    const line = (await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, open))).find((l) => l.cartLineId === hotDog.id)!;
    expect(line.quantity, 'set aside, not served short').toBe(0);
    expect(line.payload).toMatchObject({ prepaid: { usedUp: true, orderedQty: 1 } });
    const [aside] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.prepaid_used_up_set_aside'), eq(auditLog.entityId, open)));
    expect(aside).toBeDefined();
  });
});
