import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  branch,
  checkin,
  product,
  sale,
  saleLine,
  station,
  stockMovement,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { openAttempt, settleAttempt } from '../src/services/payments/attempt';
import { openQrAttempt, simulateGatewayEvent } from '../src/services/payments/gateway';
import { commitSale } from '../src/services/sale';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import {
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-494 (food) — gate reproductions, round 2. Each test states the behaviour the
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
let branchId: string;
let stationId: string;
let twoHoursId: string;
let operatorId: string;
const menu = new Map<string, { id: string; name: string; priceSatang: number }>();

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  operatorId = hkt!.operatorId;
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


async function receptionId(): Promise<string> {
  const [row] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
  return row!.id;
}

async function showQr(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  return openQrAttempt(
    ctx.db,
    ctx.app.env,
    ctx.app.log,
    { operatorId, branchId, requestId: `test-${newId()}` },
    {
      operatorId,
      branchId,
      saleId,
      stationId: row!.stationId,
      businessDate: row!.businessDate,
      amountSatang: row!.grossSatang,
      methodCode: 'promptpay',
      actionId: newId(),
      accountId: await receptionId(),
      description: 'Food gate',
    },
  );
}

async function release(kid: { checkinId: string; registrationId: string }) {
  const photoId = newId();
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/files',
    headers: { cookie },
    payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: kid.registrationId, filename: 'pickup.jpg' },
  });
  expect(up.statusCode, up.body).toBe(200);
  return ctx.app.inject({
    method: 'POST',
    url: `/checkin/pickups/stays/${kid.checkinId}/release`,
    headers: { cookie },
    payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
  });
}

describe('s494-food-gate-r2 — pickup refunds only what was not served', () => {
  it('a QR shown on an open order with a prepaid line, paid after the child was collected', async () => {
    const kid = await oneChildInPark('Gate R2 QR', [entitlement('FB-HOTDOG', 1)]);
    const open = newId();
    const a = await order({
      id: open,
      bandHolder: { checkinId: kid.checkinId },
      items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
    });
    expect(a.statusCode, a.body).toBe(200);
    const shown = await showQr(open);
    const released = await release(kid);
    expect(released.statusCode, released.body).toBe(200);
    const refunded = released.json().release.settlement?.refundedSatang ?? 0;
    const paid = await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: shown.attempt.id, event: 'paid', operatorId });
    const [after] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    const served = await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect({
      outcome: paid.webhookOutcome,
      status: after!.status,
      refunded,
      served,
      redeemedQty: stay!.foodProvision?.items?.[0]?.redeemedQty ?? 0,
      both: refunded > 0 && served > 0,
    }).toMatchObject({ both: false });
  });
});

describe('s494-food-gate-r2 — two counters racing', () => {
  it('a mixed order committing while another counter closes the free hot dog: one is served', async () => {
    const kid = await oneChildInPark('Gate R2 Mixed Race', [entitlement('FB-HOTDOG', 1)]);
    const mixed = newId();
    const [a, b] = await Promise.all([
      order({
        id: mixed,
        bandHolder: { checkinId: kid.checkinId },
        items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
      }),
      order({ id: newId(), finalise: true, bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] }),
    ]);
    const fa = a.statusCode === 200 ? (await finalise(mixed, { method: 'cash' })).statusCode : null;
    const served = await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id);
    expect({ a: a.statusCode, b: b.statusCode, fa, served }).toMatchObject({ served: 1 });
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('two mixed orders committing at once for one hot dog: one holds it, the other is told', async () => {
    const kid = await oneChildInPark('Gate R2 Two Mixed', [entitlement('FB-HOTDOG', 1)]);
    const ids = [newId(), newId()];
    const results = await Promise.all(
      ids.map((id) =>
        order({
          id,
          bandHolder: { checkinId: kid.checkinId },
          items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    for (const [i, r] of results.entries()) if (r.statusCode === 200) expect((await finalise(ids[i]!, { method: 'cash' })).statusCode).toBe(200);
    expect(await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id)).toBe(1);
  });

  it('a retried commit of the same open order does not count its own hold against itself', async () => {
    const kid = await oneChildInPark('Gate R2 Retry', [entitlement('FB-HOTDOG', 1)]);
    const id = newId();
    const payload = {
      id,
      stationId,
      channel: 'fnb',
      pickupCode: '42',
      bandHolder: { checkinId: kid.checkinId },
      items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
    };
    const first = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie, 'idempotency-key': newId() }, payload });
    expect(first.statusCode, first.body).toBe(200);
    const again = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie, 'idempotency-key': newId() }, payload });
    expect(again.statusCode, again.body).toBe(200);
    expect((await finalise(id, { method: 'cash' })).statusCode).toBe(200);
    expect(await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id)).toBe(1);
  });
});

// --- Round 3: a close that cannot be refused sets aside what the pickup settled ---------

/** The order's lines by the till's line id. */
async function linesOfSale(saleId: string) {
  const rows = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
  return new Map(rows.map((r) => [r.cartLineId, r]));
}

/** Everything that says the prepaid hot dog on this sale was not served, and the rest was. */
async function expectSetAside(saleId: string, kid: { checkinId: string }, hotDogLineId: string, juiceLineId: string | null) {
  const [closed] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  expect(closed!.status).toBe('finalised');
  const lines = await linesOfSale(saleId);
  const hotDog = lines.get(hotDogLineId)!;
  expect(hotDog.quantity).toBe(0);
  expect(hotDog.grossSatang).toBe(0);
  expect(hotDog.payload).toMatchObject({
    prepaid: { checkinId: kid.checkinId, menuItemId: item('FB-HOTDOG').id, settledAtPickup: true, orderedQty: 1 },
  });
  if (juiceLineId) expect(lines.get(juiceLineId)!.quantity).toBe(1);
  // Not redeemed: the stay's count stands where the pickup read it.
  const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
  expect(stay!.status).toBe('out');
  expect(stay!.foodProvision?.items?.[0]?.redeemedQty ?? 0).toBe(0);
  const redeems = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, kid.checkinId)));
  expect(redeems.filter((r) => (r.after as { saleId?: string }).saleId === saleId)).toHaveLength(0);
  // No stock taken for it.
  expect(await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleLineId, hotDog.id))).toHaveLength(0);
  // No paper names it: not the prep ticket, not the receipt.
  const snapshot = await salePrintSnapshotOf(ctx.db, closed!);
  expect(snapshot.lines.some((l) => l.id === hotDog.id)).toBe(false);
  if (juiceLineId) expect(snapshot.lines.some((l) => l.id === lines.get(juiceLineId)!.id)).toBe(true);
  // The audit row names the line as settled at pickup.
  const [aside] = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'sale.prepaid_settled_at_pickup'), eq(auditLog.entityId, saleId)));
  expect(aside!.after).toMatchObject({
    served: false,
    lines: [
      {
        saleLineId: hotDog.id,
        checkinId: kid.checkinId,
        menuItemId: item('FB-HOTDOG').id,
        orderedQty: 1,
        servedQty: 0,
        settledAtPickup: true,
        stayStatus: 'out',
      },
    ],
  });
  expect(await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id)).toBe(0);
}

describe('s494-food-gate-r2 — a close that cannot be refused sets aside what the pickup settled', () => {
  it('a paid QR closes the order: the juice is served, the prepaid hot dog is not, and the refund stands', async () => {
    const kid = await oneChildInPark('Aside QR', [entitlement('FB-HOTDOG', 1)]);
    const open = newId();
    const hotDog = prepaidLine(kid.checkinId, 'FB-HOTDOG');
    const juice = { id: newId(), productId: item('FB-JUICE').id, quantity: 1 };
    const a = await order({ id: open, bandHolder: { checkinId: kid.checkinId }, items: [hotDog, juice] });
    expect(a.statusCode, a.body).toBe(200);
    const shown = await showQr(open);
    const released = await release(kid);
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().release.settlement?.refundedSatang ?? 0).toBe(item('FB-HOTDOG').priceSatang);
    const paid = await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: shown.attempt.id, event: 'paid', operatorId });
    expect(paid.webhookOutcome).toBe('settled');
    await expectSetAside(open, kid, hotDog.id, juice.id);
  });

  it('a counter confirming after a card was approved closes the order the same way, never refusing with money taken', async () => {
    const kid = await oneChildInPark('Aside Card', [entitlement('FB-HOTDOG', 1)]);
    const open = newId();
    const hotDog = prepaidLine(kid.checkinId, 'FB-HOTDOG');
    const juice = { id: newId(), productId: item('FB-JUICE').id, quantity: 1 };
    const a = await order({ id: open, bandHolder: { checkinId: kid.checkinId }, items: [hotDog, juice] });
    expect(a.statusCode, a.body).toBe(200);
    // The terminal approves the card for the whole order; the counter has not confirmed yet.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    const takenBy = await receptionId();
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
        payload: { takenByAccountId: takenBy },
      });
      await settleAttempt(tx, opened.id, { paidAt: new Date() });
    });
    const released = await release(kid);
    expect(released.statusCode, released.body).toBe(200);
    const fa = await finalise(open, {});
    expect(fa.statusCode, fa.body).toBe(200);
    await expectSetAside(open, kid, hotDog.id, juice.id);
  });

  it('a counter confirming with no money taken yet is still told, and nothing is recorded', async () => {
    const kid = await oneChildInPark('Aside Refused', [entitlement('FB-HOTDOG', 1)]);
    const open = newId();
    const a = await order({
      id: open,
      bandHolder: { checkinId: kid.checkinId },
      items: [prepaidLine(kid.checkinId, 'FB-HOTDOG'), { id: newId(), productId: item('FB-JUICE').id, quantity: 1 }],
    });
    expect(a.statusCode, a.body).toBe(200);
    expect((await release(kid)).statusCode).toBe(200);
    const fa = await finalise(open, { method: 'cash' });
    expect(fa.statusCode).toBe(409);
    expect(fa.json().error.code).toBe('PREPAID_STAY_CLOSED');
    const [still] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    expect(still!.status).toBe('tendering');
    const aside = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.prepaid_settled_at_pickup'), eq(auditLog.entityId, open)));
    expect(aside).toHaveLength(0);
  });

  it('a box replay of a prepaid line for a child released before it arrived is filed unserved', async () => {
    const kid = await oneChildInPark('Aside Replay', [entitlement('FB-HOTDOG', 1)]);
    expect((await release(kid)).statusCode).toBe(200);
    const saleId = newId();
    const hotDog = prepaidLine(kid.checkinId, 'FB-HOTDOG');
    const accountId = await receptionId();
    const result = await ctx.db.transaction((tx) =>
      commitSale(
        tx,
        { accountId, operatorId, branchId },
        { id: saleId, stationId, channel: 'fnb', pickupCode: '42', finalise: true, items: [hotDog] },
        new Date(),
        { printing: 'skip' },
      ),
    );
    expect(result.finalised).toBe(true);
    await expectSetAside(saleId, kid, hotDog.id, null);
  });
});

// --- Last round: a prepaid line beyond what is left, at a close that cannot be refused ------

/** A box's replay of a prepaid-only order, closed as it arrives. */
async function replayFromBox(kid: { checkinId: string }, hotDog: ReturnType<typeof prepaidLine>) {
  const saleId = newId();
  const accountId = await receptionId();
  const result = await ctx.db.transaction((tx) =>
    commitSale(
      tx,
      { accountId, operatorId, branchId },
      { id: saleId, stationId, channel: 'fnb', pickupCode: '42', finalise: true, items: [hotDog] },
      new Date(),
      { printing: 'skip' },
    ),
  );
  expect(result.finalised).toBe(true);
  return saleId;
}

describe('s494-food-gate-r2 — a prepaid line beyond what is left for the child', () => {
  it('a counter confirming after a card was approved sets the line aside unserved, never serving it short', async () => {
    const kid = await oneChildInPark('Used Up Card', [entitlement('FB-HOTDOG', 1)]);
    const open = newId();
    const hotDog = prepaidLine(kid.checkinId, 'FB-HOTDOG');
    const juice = { id: newId(), productId: item('FB-JUICE').id, quantity: 1 };
    const a = await order({ id: open, bandHolder: { checkinId: kid.checkinId }, items: [hotDog, juice] });
    expect(a.statusCode, a.body).toBe(200);
    // The hot dog is handed over at the counter's box with the link down, and replayed.
    await replayFromBox(kid, prepaidLine(kid.checkinId, 'FB-HOTDOG'));
    // The terminal approves the card for the whole order; the counter has not confirmed yet.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    const takenBy = await receptionId();
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
        payload: { takenByAccountId: takenBy },
      });
      await settleAttempt(tx, opened.id, { paidAt: new Date() });
    });
    const fa = await finalise(open, {});
    expect(fa.statusCode, fa.body).toBe(200);

    const [closed] = await ctx.db.select().from(sale).where(eq(sale.id, open));
    expect(closed!.status).toBe('finalised');
    const lines = await linesOfSale(open);
    const line = lines.get(hotDog.id)!;
    expect(line.quantity).toBe(0);
    expect(line.grossSatang).toBe(0);
    expect(line.payload).toMatchObject({
      prepaid: { checkinId: kid.checkinId, menuItemId: item('FB-HOTDOG').id, usedUp: true, orderedQty: 1 },
    });
    expect(lines.get(juice.id)!.quantity).toBe(1);
    // The stay's count stands at the one the box served.
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty).toBe(1);
    const redeems = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, kid.checkinId)));
    expect(redeems.filter((r) => (r.after as { saleId?: string }).saleId === open)).toHaveLength(0);
    expect(await ctx.db.select().from(stockMovement).where(eq(stockMovement.saleLineId, line.id))).toHaveLength(0);
    const snapshot = await salePrintSnapshotOf(ctx.db, closed!);
    expect(snapshot.lines.some((l) => l.id === line.id)).toBe(false);
    expect(snapshot.lines.some((l) => l.id === lines.get(juice.id)!.id)).toBe(true);
    const [aside] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.prepaid_used_up_set_aside'), eq(auditLog.entityId, open)));
    expect(aside!.after).toMatchObject({
      served: false,
      lines: [
        {
          saleLineId: line.id,
          checkinId: kid.checkinId,
          menuItemId: item('FB-HOTDOG').id,
          orderedQty: 1,
          remaining: 0,
          servedQty: 0,
          usedUp: true,
          stayStatus: 'in_park',
        },
      ],
    });
    expect(await servedOnFinalisedSales(kid.checkinId, item('FB-HOTDOG').id)).toBe(1);
  });

  it('a box replay, where the food was handed over offline, keeps the served-with-shortfall record', async () => {
    const kid = await oneChildInPark('Used Up Replay', [entitlement('FB-HOTDOG', 1)]);
    const online = await order({ id: newId(), finalise: true, bandHolder: { checkinId: kid.checkinId }, items: [prepaidLine(kid.checkinId, 'FB-HOTDOG')] });
    expect(online.statusCode, online.body).toBe(200);
    const hotDog = prepaidLine(kid.checkinId, 'FB-HOTDOG');
    const replayed = await replayFromBox(kid, hotDog);

    const line = (await linesOfSale(replayed)).get(hotDog.id)!;
    expect(line.quantity, 'the line is filed as the box served it').toBe(1);
    expect((line.payload as { prepaid?: { usedUp?: boolean } }).prepaid?.usedUp).toBeUndefined();
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, kid.checkinId));
    expect(stay!.foodProvision?.items?.[0]?.redeemedQty, 'never past what was paid for').toBe(1);
    const redeems = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, kid.checkinId)));
    const mine = redeems.find((r) => (r.after as { saleId?: string }).saleId === replayed);
    expect(mine!.after).toMatchObject({ shortfall: true, redeemed: [{ saleLineId: line.id, qty: 1, applied: 0 }] });
    const aside = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.prepaid_used_up_set_aside'), eq(auditLog.entityId, replayed)));
    expect(aside).toHaveLength(0);
  });
});

// --- Round 3: what registration stores for prepaid items ---------------------------------

function register(name: string, food: Record<string, unknown>) {
  const checkinId = newId();
  return {
    checkinId,
    res: ctx.app.inject({
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
        children: [{ checkinId, name, ageYears: 6, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: food }],
      },
    }),
  };
}

describe('s494-food-gate-r2 — registration stores prepaid items as the menu prices them', () => {
  it('every prepaid item starts unserved, whatever the gate sent', async () => {
    const { checkinId, res } = register('Reg Unserved', {
      mode: 'prepaid_items',
      paidSatang: item('FB-HOTDOG').priceSatang * 2,
      items: [{ ...entitlement('FB-HOTDOG', 2), redeemedQty: 2 }],
    });
    const r = await res;
    expect(r.statusCode, r.body).toBe(200);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay!.foodProvision?.items?.[0]).toMatchObject({ qty: 2, redeemedQty: 0 });
  });

  it('refuses a unit that is not today’s menu price, in the counter’s words', async () => {
    const wrong = item('FB-HOTDOG').priceSatang - 100;
    const { res } = register('Reg Price', {
      mode: 'prepaid_items',
      paidSatang: wrong,
      items: [{ ...entitlement('FB-HOTDOG', 1), unitSatang: wrong }],
    });
    const r = await res;
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('PREPAID_ITEM_PRICE');
    expect(r.json().error.message).toBe(
      `${item('FB-HOTDOG').name} is ฿${item('FB-HOTDOG').priceSatang / 100} on today's menu — choose Reg Price's prepaid food again.`,
    );
  });

  it('refuses a paid amount that is not the items’ sum', async () => {
    const price = item('FB-HOTDOG').priceSatang;
    const { res } = register('Reg Sum', {
      mode: 'prepaid_items',
      paidSatang: price + 100,
      items: [entitlement('FB-HOTDOG', 1)],
    });
    const r = await res;
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('PREPAID_PAID_MISMATCH');
    expect(r.json().error.message).toBe(
      `Reg Sum's prepaid food comes to ฿${price / 100}, not ฿${(price + 100) / 100} — choose the prepaid food again.`,
    );
  });

  it('refuses an item that is not on this park’s menu', async () => {
    const { res } = register('Reg Menu', {
      mode: 'prepaid_items',
      paidSatang: 5_000,
      items: [{ menuItemId: newId(), menuItemName: 'Mystery Meal', unitSatang: 5_000, qty: 1, redeemedQty: 0 }],
    });
    const r = await res;
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('PREPAID_ITEM_NOT_ON_MENU');
    expect(r.json().error.message).toBe(
      "Mystery Meal is not on this park's menu, so it cannot be prepaid for Reg Menu — choose the prepaid food again.",
    );
  });
});
