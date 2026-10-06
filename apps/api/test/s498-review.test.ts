import { generateKeyPairSync } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, checkin, product, sale, saleLine, station, ticketPackage } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { boxCompletedSale } from '../src/services/band-food';
import { checkinCacheItem } from '../src/services/sync-checkin';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SCRUM-498 review — a prepaid meal served on the box offline, then the link
 * back: the pickup never settles that meal as unused, the platform and the box
 * agree on what is left, the online counter serves only what remains, and the
 * copy a box receives carries only its own filed count and only in-park
 * children's saved notes.
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
    actionId: `s498r-${newId().slice(-12)}`,
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
  agent = linkedAgent(ctx, box1.id, 's498-review-box', link, { devices: true });
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

async function serveOnBox(checkinId: string) {
  const cart = { channel: 'fnb', pickupCode: '42', bandHolder: { checkinId }, items: [prepaidLine(checkinId)] };
  const quote = await onBox('cart.quote', cart);
  if (quote.statusCode !== 200) return { quote, paid: null, saleId: null };
  const saleId = newId();
  const paid = await onBox('sale.finalise', {
    saleId,
    actionId: `pay-${saleId.slice(-8)}`,
    staffName: 'Nok',
    cart: { ...cart, expectedTotalSatang: quote.body.result.quote.totals.grossSatang },
  });
  return { quote, paid, saleId };
}

async function serveOnline(checkinId: string) {
  const saleId = newId();
  const committed = await call('POST', '/sales', {
    id: saleId,
    stationId: tillId,
    channel: 'fnb',
    pickupCode: '51',
    bandHolder: { checkinId },
    items: [prepaidLine(checkinId)],
  });
  if (committed.statusCode !== 200) return { committed, finalised: null, saleId };
  const finalised = await call('POST', `/sales/${saleId}/finalise`, {});
  return { committed, finalised, saleId };
}

async function offline<T>(run: () => Promise<T>): Promise<T> {
  await agent.syncCache();
  await agent.setOffline(true, { reason: 's498 review' });
  link.cut = true;
  try {
    return await run();
  } finally {
    link.cut = false;
    await agent.setOffline(false);
  }
}

describe('s498 review — the box, the platform and the pickup agree on prepaid meals', () => {
  it('a meal served offline is never settled as unused at pickup, and online and the box serve only what is left', async () => {
    const kid = await childInPark('Fah', 2, 'Sesame');
    const hot = item('FB-HOTDOG');

    const served = await offline(async () => {
      const first = await serveOnBox(kid.checkinId);
      expect(first.paid?.statusCode, JSON.stringify(first.paid?.body)).toBe(200);
      const ctxBox = await onBox('release.context', { checkinId: kid.checkinId });
      expect(ctxBox.statusCode, JSON.stringify(ctxBox.body)).toBe(200);
      expect(ctxBox.body.result.reconciliation.totalUnusedSatang, 'one of two left on the box').toBe(hot.priceSatang);
      return first.saleId!;
    });

    await flushAll();
    await flushAll();
    expect(await boxCompletedSale(ctx.db, served)).toBe(true);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty).toBe(1);
    const redeems = (
      await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, kid.checkinId)))
    ).filter((r) => (r.after as { saleId?: string }).saleId === served);
    expect(redeems, 'replayed twice, redeemed once').toHaveLength(1);

    const pickup = await call('GET', `/checkin/pickups/stays/${kid.checkinId}`);
    expect(pickup.statusCode, JSON.stringify(pickup.body)).toBe(200);
    expect(pickup.body.reconciliation.totalUnusedSatang, 'the served meal is not refunded online').toBe(hot.priceSatang);

    // The second paid meal is served online; a third is refused there.
    const second = await serveOnline(kid.checkinId);
    expect(second.committed.statusCode, JSON.stringify(second.committed.body)).toBe(200);
    expect(second.finalised?.statusCode, JSON.stringify(second.finalised?.body)).toBe(200);
    const third = await serveOnline(kid.checkinId);
    expect(third.committed.statusCode).toBe(409);
    expect(third.committed.body.error.code).toBe('PREPAID_USED_UP');

    // The box, refreshed, agrees: two served, none left, nothing double counted.
    await offline(async () => {
      const scanned = await onBox('checkin.band_food', { key: kid.bandCode });
      expect(scanned.statusCode, JSON.stringify(scanned.body)).toBe(200);
      expect(scanned.body.result.stay.allergiesMedical).toBe('Sesame');
      expect(scanned.body.result.stay.foodProvision.items[0]).toMatchObject({ qty: 2, redeemedQty: 2 });
      const refused = await serveOnBox(kid.checkinId);
      expect(refused.quote.statusCode).toBe(409);
      expect(refused.quote.body.error).toMatchObject({
        code: 'PREPAID_USED_UP',
        message: `Fah's prepaid ${hot.name} has already been served.`,
      });
      const ctxBox = await onBox('release.context', { checkinId: kid.checkinId });
      expect(ctxBox.body.result.reconciliation.totalUnusedSatang).toBe(0);
    });

    const pickupAfter = await call('GET', `/checkin/pickups/stays/${kid.checkinId}`);
    expect(pickupAfter.body.reconciliation.totalUnusedSatang).toBe(0);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, served));
    expect(lines.find((l) => l.kind === 'fnb_item')).toMatchObject({ quantity: 1, grossSatang: 0 });
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, served));
    expect(row!.status).toBe('finalised');
  });

  it('the copy carries a box only its own filed meals, and saved notes only for children in the park', async () => {
    const kid = await childInPark('Kaew', 2, 'Milk');
    await offline(async () => {
      const first = await serveOnBox(kid.checkinId);
      expect(first.paid?.statusCode, JSON.stringify(first.paid?.body)).toBe(200);
    });
    await flushAll();

    const mine = await checkinCacheItem(ctx.db, operatorId, branchId, new Date(), boxId);
    const mineChild = mine.families.flatMap((f) => f.children).find((c) => c.id === kid.checkinId);
    expect(mineChild?.boxPrepaidServed).toEqual([{ menuItemId: item('FB-HOTDOG').id, qty: 1 }]);

    const other = await boxBySlot(ctx.db, 'virtual-2').catch(() => null);
    if (other && other.id !== boxId) {
      const theirs = await checkinCacheItem(ctx.db, operatorId, branchId, new Date(), other.id);
      const theirChild = theirs.families.flatMap((f) => f.children).find((c) => c.id === kid.checkinId);
      expect(theirChild?.boxPrepaidServed, 'another box served nothing of this').toEqual([]);
    }
    for (const family of mine.families) expect(family.branchId).toBe(branchId);

    // Released: the saved notes and the filed count no longer ride on the copy.
    await ctx.db.update(checkin).set({ status: 'out', checkedOutAt: new Date() }).where(eq(checkin.id, kid.checkinId));
    const later = await checkinCacheItem(ctx.db, operatorId, branchId, new Date(), boxId);
    const gone = later.families.flatMap((f) => f.children).find((c) => c.id === kid.checkinId);
    if (gone) {
      expect(gone.savedAllergies).toBeUndefined();
      expect(gone.savedMedicalNotes).toBeUndefined();
      expect(gone.savedDietary).toBeUndefined();
      expect(gone.boxPrepaidServed).toBeUndefined();
    }
  });
});
