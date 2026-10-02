import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, band, branch, checkin, fileObject, product, sale, saleLine, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { bandHolderOfSale } from '../src/services/band-food';
import { commitSale, type ActorContext } from '../src/services/sale';
import {
  ADMIN,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-494 (food) — gate reproductions. Each test states the behaviour the
 * gate expects; a failing test is a finding.
 */

const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let chalongCookie: string;
let branchId: string;
let chalongId: string;
let stationId: string;
let chalongStationId: string;
let twoHoursId: string;
let operatorId: string;
let adminAccountId: string;
const menu = new Map<string, { id: string; name: string; priceSatang: number }>();

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  chalongCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [t3] = await ctx.db.select().from(station).where(eq(station.branchId, chalongId));
  chalongStationId = t3!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  operatorId = hkt!.operatorId;
  const [admin] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone)).limit(1);
  adminAccountId = admin!.id;
  const rows = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, hkt!.operatorId), isNull(product.archivedAt)));
  for (const row of rows) if (row.code) menu.set(row.code, { id: row.id, name: row.name, priceSatang: row.priceSatang });
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const item = (code: string) => menu.get(code)!;
const entitlement = (code: string, qty: number) => ({
  menuItemId: item(code).id,
  menuItemName: item(code).name,
  unitSatang: item(code).priceSatang,
  qty,
  redeemedQty: 0,
});

async function oneChildInPark(name: string, items: ReturnType<typeof entitlement>[], allergies: string | null = null) {
  const checkinId = newId();
  const food = items.length
    ? { mode: 'prepaid_items' as const, paidSatang: items.reduce((s, i) => s + i.unitSatang * i.qty, 0), items }
    : { mode: 'none' as const, paidSatang: 0 };
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie },
    payload: {
      id: newId(),
      branchId,
      stationId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name, ageYears: 6, service: 'drop_off', allergies, foodRestrictions: null, foodProvision: food }],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId,
      lines: [
        {
          id: checkinId,
          packageId: twoHoursId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: food.mode === 'none' ? null : { mode: food.mode, paidSatang: food.paidSatang },
        },
      ],
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  expect((await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload: {} })).statusCode).toBe(200);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie },
    payload: { saleId, entries: [{ checkinId, nannyId: null }] },
  });
  expect(now.statusCode, now.body).toBe(200);
  const [row] = await ctx.db
    .select({ code: band.code, registrationId: checkin.registrationId })
    .from(checkin)
    .innerJoin(band, eq(band.id, checkin.bandId))
    .where(eq(checkin.id, checkinId));
  return { checkinId, bandCode: row!.code, registrationId: row!.registrationId };
}

function order(payload: Record<string, unknown>, who = cookie, at = stationId) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: who, 'idempotency-key': newId() },
    payload: { stationId: at, channel: 'fnb', pickupCode: '42', ...payload },
  });
}

function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie, 'idempotency-key': newId() },
    payload,
  });
}

/** Prepaid units of an item that left the kitchen on finalised sales for one stay. */
async function servedOnFinalisedSales(checkinId: string, menuItemId: string): Promise<number> {
  const rows = await ctx.db
    .select({ quantity: saleLine.quantity, payload: saleLine.payload, status: sale.status })
    .from(saleLine)
    .innerJoin(sale, eq(sale.id, saleLine.saleId))
    .where(eq(saleLine.kind, 'fnb_item'));
  return rows
    .filter((r) => r.status === 'finalised')
    .filter((r) => {
      const p = (r.payload as { prepaid?: { checkinId: string; menuItemId: string } } | null)?.prepaid;
      return p?.checkinId === checkinId && p.menuItemId === menuItemId;
    })
    .reduce((s, r) => s + r.quantity, 0);
}

const prepaidLine = (checkinId: string, code: string, quantity = 1) => ({
  id: newId(),
  productId: item(code).id,
  quantity,
  prepaid: { checkinId },
  lineTotalSatang: 0,
});

describe('s494-food-gate — a prepaid meal is served once', () => {
  it('two open orders at two counters for the one prepaid hot dog: only one leaves the kitchen free', async () => {
    const kid = await oneChildInPark('Gate Two Orders', [entitlement('FB-HOTDOG', 1)]);
    // Counter 1: a mixed order, waiting on its tender.
    const first = newId();
    const a = await order({
      id: first,
      bandHolder: { checkinId: kid.checkinId },
      items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
    });
    expect(a.statusCode, a.body).toBe(200);
    // Counter 2: the same band, the same prepaid hot dog, closed at once.
    const b = await order({ id: newId(), finalise: true, bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] });
    const fa = await finalise(first, { method: 'cash' });
    // Whatever the platform refuses, at most one prepaid hot dog may be served.
    expect({ b: b.statusCode, fa: fa.statusCode, served: await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id) }).toMatchObject({
      served: 1,
    });
    // The open order holds the hot dog: the second counter is told so, in its words, and the first one closes.
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe('PREPAID_USED_UP');
    expect(b.json().error.message).toBe(
      `Gate Two Orders's prepaid ${item('FB-HOTDOG').name} is on another order that is still open — finish or cancel that order first.`,
    );
    expect(b.json().error.details).toMatchObject({ remaining: 0, heldOnOpenOrders: 1, openSaleIds: [first] });
    expect(fa.statusCode, fa.body).toBe(200);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty).toBe(1);
  });

  it('a voided open order lets the hot dog go to the next order', async () => {
    const kid = await oneChildInPark('Gate Voided', [entitlement('FB-HOTDOG', 1)]);
    const first = newId();
    const a = await order({
      id: first,
      bandHolder: { checkinId: kid.checkinId },
      items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
    });
    expect(a.statusCode, a.body).toBe(200);
    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${first}/void`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { reason: 'Guest left before paying' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const b = await order({ id: newId(), finalise: true, bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] });
    expect(b.statusCode, b.body).toBe(200);
    expect(await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id)).toBe(1);
  });

  it('two counters racing a ฿0 prepaid-only close for one hot dog: only one is served', async () => {
    const kid = await oneChildInPark('Gate Race', [entitlement('FB-HOTDOG', 1)]);
    const results = await Promise.all(
      [0, 1].map(() =>
        order({ id: newId(), finalise: true, bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    const served = await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id);
    expect({ codes, served }).toMatchObject({ served: 1 });
    expect(codes).toEqual([200, 409]);
    const refused = results.find((r) => r.statusCode === 409)!;
    expect(refused.json().error.code).toBe('PREPAID_USED_UP');
    expect(refused.json().error.message).toBe(`Gate Race's prepaid ${item('FB-HOTDOG').name} has already been served.`);
    const redeems = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, kid.checkinId)));
    expect(redeems).toHaveLength(1);
    expect(redeems[0]!.after).toMatchObject({ shortfall: false });
  });
});

describe('s494-food-gate — pickup refunds only what was not served', () => {
  it('a prepaid line still open at pickup is not both refunded and served', async () => {
    const kid = await oneChildInPark('Gate Pickup', [entitlement('FB-HOTDOG', 1)]);
    const open = newId();
    const a = await order({
      id: open,
      bandHolder: { checkinId: kid.checkinId },
      items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
    });
    expect(a.statusCode, a.body).toBe(200);
    const photoId = newId();
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie },
      payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: kid.registrationId, filename: 'pickup.jpg' },
    });
    expect(up.statusCode, up.body).toBe(200);
    expect(await ctx.db.select().from(fileObject).where(eq(fileObject.id, photoId))).toHaveLength(1);
    const released = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${kid.checkinId}/release`,
      headers: { cookie },
      payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
    });
    expect(released.statusCode, released.body).toBe(200);
    const refunded = released.json().release.settlement?.refundedSatang ?? 0;
    const fa = await finalise(open, { method: 'cash' });
    const served = await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id);
    // The hot dog is either refunded at pickup or served — never both.
    expect({ refunded, finalise: fa.statusCode, served, both: refunded > 0 && served > 0 }).toMatchObject({ both: false });
    // Refunded at pickup, so the counter's confirm is refused in its words, and nothing was taken.
    expect(refunded).toBeGreaterThan(0);
    expect(fa.statusCode).toBe(409);
    expect(fa.json().error.code).toBe('PREPAID_STAY_CLOSED');
    expect(fa.json().error.message).toBe(
      'Gate Pickup has already been collected, so their prepaid food cannot be served on this order — cancel it and ring the order up again.',
    );
    const [still] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    expect(still!.status).toBe('tendering');
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty ?? 0).toBe(0);
  });
});

describe('s494-food-gate — an offline replay only serves from this park’s stays', () => {
  const replayActor = (): ActorContext => ({ accountId: adminAccountId, operatorId, branchId: chalongId });

  it('a replayed Chalong sale naming a Floresta stay is filed at ฿0, serves nothing and prints no holder', async () => {
    const kid = await oneChildInPark('Gate Replay', [entitlement('FB-HOTDOG', 1)], 'Sesame');
    const saleId = newId();
    const lineId = newId();
    // A menu item on Chalong's own menu: the box served it there.
    const [hotDogRow] = await ctx.db.select().from(product).where(eq(product.id, item('FB-HOTDOG').id));
    const [chalongItem] = await ctx.db
      .insert(product)
      .values({
        id: newId(),
        operatorId,
        branchId: chalongId,
        categoryId: hotDogRow!.categoryId,
        kind: 'menu',
        name: 'Gate Chalong Hot Dog',
        priceSatang: 9_000,
      })
      .returning();
    const result = await ctx.db.transaction((tx) =>
      commitSale(
        tx,
        replayActor(),
        {
          id: saleId,
          stationId: chalongStationId,
          channel: 'fnb',
          pickupCode: '42',
          finalise: true,
          bandHolder: { checkinId: kid.checkinId },
          items: [{ id: lineId, productId: chalongItem!.id, quantity: 1, prepaid: { checkinId: kid.checkinId } }],
        },
        new Date(),
        { printing: 'skip' },
      ),
    );
    expect(result.finalised).toBe(true);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const hotDog = lines.find((l) => l.cartLineId === lineId)!;
    expect(hotDog.payload).toMatchObject({ prepaid: { checkinId: kid.checkinId, unmatched: true } });
    expect((hotDog.payload as { holder?: unknown }).holder).toBeUndefined();
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty ?? 0).toBe(0);
    const [unmatched] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.prepaid_unmatched'), eq(auditLog.entityId, saleId)));
    expect(unmatched!.after).toMatchObject({ lines: [{ checkinId: kid.checkinId, qty: 1 }] });
    expect(await bandHolderOfSale(ctx.db, { operatorId, branchId: chalongId }, lines)).toBeNull();
  });

  it('the prep ticket never reads a stay of another park, even when a line names one', async () => {
    const kid = await oneChildInPark('Gate Print', [], 'Kiwi');
    const lines = [{ kind: 'fnb_item', payload: { holder: { checkinId: kid.checkinId } } }];
    expect(await bandHolderOfSale(ctx.db, { operatorId, branchId: chalongId }, lines)).toBeNull();
    expect(await bandHolderOfSale(ctx.db, { operatorId: newId(), branchId }, lines)).toBeNull();
    expect(await bandHolderOfSale(ctx.db, { operatorId, branchId }, lines)).toMatchObject({ name: 'Gate Print', allergiesMedical: 'Kiwi' });
  });
});

describe('s494-food-gate — no other park’s or released child’s stay leaks', () => {
  it('another park’s counter never reads the stay, and cannot name it as a band holder', async () => {
    const kid = await oneChildInPark('Gate Leak', [entitlement('FB-HOTDOG', 1)], 'Peanuts');
    const fromChalong = await ctx.app.inject({
      method: 'GET',
      url: `/wallets/scan?key=${encodeURIComponent(kid.bandCode)}&branchId=${chalongId}`,
      headers: { cookie: chalongCookie },
    });
    expect(fromChalong.statusCode).toBe(404);
    expect(fromChalong.body).not.toContain('Peanuts');
    const askFloresta = await ctx.app.inject({
      method: 'GET',
      url: `/wallets/scan?key=${encodeURIComponent(kid.bandCode)}&branchId=${branchId}`,
      headers: { cookie: chalongCookie },
    });
    expect(askFloresta.statusCode).toBe(403);
    expect(askFloresta.body).not.toContain('Peanuts');
    const noKey = await ctx.app.inject({
      method: 'GET',
      url: `/wallets/scan?key=${encodeURIComponent(kid.bandCode)}`,
      headers: { cookie: chalongCookie },
    });
    expect(noKey.body).not.toContain('Peanuts');
    const named = await order(
      { id: newId(), bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] },
      adminCookie,
      chalongStationId,
    );
    expect(named.statusCode).toBe(409);
    expect(named.json().error.code).toBe('BAND_OTHER_PARK');
  });

  it('a released child’s band reads no stay and serves nothing', async () => {
    const kid = await oneChildInPark('Gate Released', [entitlement('FB-HOTDOG', 1)], 'Shellfish');
    const photoId = newId();
    await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie },
      payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: kid.registrationId, filename: 'pickup.jpg' },
    });
    const released = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${kid.checkinId}/release`,
      headers: { cookie },
      payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
    });
    expect(released.statusCode, released.body).toBe(200);
    const scanned = await ctx.app.inject({
      method: 'GET',
      url: `/wallets/scan?key=${encodeURIComponent(kid.bandCode)}&branchId=${branchId}`,
      headers: { cookie },
    });
    expect(scanned.body).not.toContain('Shellfish');
    const named = await order({ id: newId(), bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] });
    expect(named.statusCode).toBe(409);
    expect(named.json().error.code).toBe('BAND_NOT_IN_PARK');
  });
});
