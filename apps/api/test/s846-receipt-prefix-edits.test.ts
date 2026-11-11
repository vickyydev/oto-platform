import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { box, device, paymentAttempt, receiptSeries, sale, station } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, boxBySlot, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-846 — two consistency follow-ups to SCRUM-809's receipt prefix guard.
 *
 * ONE: the guard is for a prefix being TAKEN, not for a prefix being held. A
 * live till that has shared its prefix with an archived till since before the
 * guard existed must still be renamed, re-routed and given devices; only a
 * save that changes the prefix (or turns the station into a kind that numbers
 * receipts) is checked.
 *
 * TWO: a refused receipt number says which fault it was. Another station's
 * receipt under the same prefix is `RECEIPT_PREFIX_IN_USE` and advises a new
 * prefix; this station's own series colliding — two allocators in one series
 * — is `RECEIPT_NUMBER_TAKEN`, where a new prefix is not the cause.
 *
 * The "legacy" stations below are inserted straight into the table, as
 * SCRUM-809's own test does: the form can no longer create that pair, which is
 * the point of SCRUM-809. Never do that on staging.
 */
let ctx: TestContext;
let admin: string;
let operatorId: string;
let branchId: string;
let boxId: string;
let productId: string;

const ROUTING = { card: 'manual', qr: 'none' } as const;
const NAME = (name: string) => `ZZ TEST SCRUM-846 ${name}`;

const send = (method: 'POST' | 'GET' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });
const create = (name: string, prefix: string) => send('POST', `/branches/${branchId}/stations`, {
  name: NAME(name), kind: 'till', boxId, codePrefix: prefix,
  accessScope: 'all_staff', devices: [], paymentRouting: ROUTING,
});
const made = async (name: string, prefix: string) => {
  const response = await create(name, prefix);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().station.id as string;
};
const archived = async (id: string) => {
  expect((await send('DELETE', `/stations/${id}`)).statusCode).toBe(200);
};
/** A station as the live-only guard of before SCRUM-809 would have saved it. */
const legacy = async (name: string, prefix: string, kind: 'till' | 'display' = 'till') => {
  const id = newId();
  await ctx.db.insert(station).values({ id, operatorId, branchId, boxId, name: NAME(name), kind,
    codePrefix: prefix, accessScope: 'all_staff', paymentRouting: ROUTING });
  return id;
};
const patch = (id: string, payload: Record<string, unknown>) => send('PATCH', `/stations/${id}`, payload);
const prefixOf = async (id: string) =>
  (await ctx.db.select({ codePrefix: station.codePrefix }).from(station).where(eq(station.id, id)))[0]?.codePrefix;

const item = () => [{ id: newId(), productId, quantity: 1, modifiers: [] }];
/** An unpaid order on the station, waiting for its money. */
const cart = async (stationId: string) => {
  await takeStation(ctx.app, admin, stationId);
  const id = newId();
  const response = await send('POST', '/sales', {
    id, stationId, branchId, channel: 'fnb', pickupCode: '846', lines: [], items: item(), note: 'ZZ TEST SCRUM-846',
  });
  expect(response.statusCode, response.body).toBe(200);
  return id;
};
const pay = (saleId: string) => send('POST', `/sales/${saleId}/finalise`, { method: 'cash', cashReceivedSatang: 100 });
/** A zero-total comp: nothing to tender, so the commit itself closes it and numbers the receipt. */
const comp = async (stationId: string, id = newId()) => {
  await takeStation(ctx.app, admin, stationId);
  return send('POST', '/sales', {
    id, stationId, branchId, channel: 'fnb', pickupCode: '846', lines: [], items: item(), note: 'ZZ TEST SCRUM-846',
    manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' }],
    finalise: true,
  });
};
const seriesOf = (stationId: string, prefix: string) => ctx.db.select().from(receiptSeries)
  .where(and(eq(receiptSeries.stationId, stationId), eq(receiptSeries.series, prefix), eq(receiptSeries.kind, 'sale')));
/** A second allocator for one series: the counter put back, as a restored box would have it. */
const rewind = (stationId: string, prefix: string) => ctx.db.update(receiptSeries).set({ nextSeq: 1 })
  .where(and(eq(receiptSeries.stationId, stationId), eq(receiptSeries.series, prefix), eq(receiptSeries.kind, 'sale')));

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const virtual = await boxBySlot(ctx.db, 'virtual-1');
  ({ id: boxId, branchId, operatorId } = virtual);
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, boxId));
  const category = await send('POST', '/menu/categories', {
    name: NAME('food'), taxableCategory: 'fnb', defaultPrepStation: 'kitchen',
  });
  expect(category.statusCode).toBe(200);
  const product = await send('POST', `/branches/${branchId}/menu/products`, {
    name: NAME('item'), kind: 'menu', categoryId: category.json().id,
    priceSatang: 100, priceWeekendSatang: 100, stockLinks: [], active: true,
  });
  expect(product.statusCode).toBe(200);
  productId = product.json().id;
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('a till keeps its receipt prefix when its other details are edited', () => {
  it('a live till sharing its prefix with an archived till can be renamed, re-routed and given a device', async () => {
    const old = await made('archived twin', 'Z846A');
    await archived(old);
    const live = await legacy('live twin', 'Z846A');

    const renamed = await patch(live, { name: NAME('live twin renamed') });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().station).toMatchObject({ name: NAME('live twin renamed'), codePrefix: 'Z846A' });

    const rerouted = await patch(live, { paymentRouting: { card: 'manual', qr: 'gateway' } });
    expect(rerouted.statusCode, rerouted.body).toBe(200);
    expect(rerouted.json().station.paymentRouting).toMatchObject({ qr: 'gateway' });

    const printer = newId();
    await ctx.db.insert(device).values({ id: printer, operatorId, branchId, boxId,
      kind: 'receipt_printer', label: NAME('printer'), transport: 'simulated' });
    const equipped = await patch(live, { devices: [{ role: 'receipt', deviceId: printer }] });
    expect(equipped.statusCode, equipped.body).toBe(200);
    expect(equipped.json().station.devices).toHaveLength(1);

    // The Console's form sends every field on save, the unchanged prefix among them.
    const whole = await patch(live, { name: NAME('live twin saved whole'), kind: 'till', codePrefix: 'Z846A',
      accessScope: 'all_staff', paymentRouting: ROUTING });
    expect(whole.statusCode, whole.body).toBe(200);
    expect(await prefixOf(live)).toBe('Z846A');
  });

  it('the same holds when the other till only issued receipts under the prefix and has since changed it', async () => {
    const issuer = await made('issuer', 'Z846B');
    await ctx.db.insert(receiptSeries).values({ id: newId(), operatorId, branchId, stationId: issuer,
      series: 'Z846B', kind: 'sale', nextSeq: 4, lastIssuedAt: new Date() });
    expect((await patch(issuer, { codePrefix: 'Z846BB' })).statusCode).toBe(200);
    const live = await legacy('series twin', 'Z846B');
    const renamed = await patch(live, { name: NAME('series twin renamed') });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().station.codePrefix).toBe('Z846B');
  });

  it('it still cannot be given ANOTHER taken prefix, and the refusal changes nothing', async () => {
    const twin = await made('twin for refusal', 'Z846C');
    await archived(twin);
    const other = await made('other owner', 'Z846D');
    await archived(other);
    const live = await legacy('refused change', 'Z846C');

    const refused = await patch(live, { name: NAME('refused change renamed'), codePrefix: 'Z846D' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'STATION_CODE_PREFIX_TAKEN',
      details: { field: 'codePrefix', stationId: other } });
    expect(refused.json().error.message).toContain(NAME('other owner'));
    const [row] = await ctx.db.select().from(station).where(eq(station.id, live));
    expect(row).toMatchObject({ name: NAME('refused change'), codePrefix: 'Z846C' });
  });

  it('changing it to a free prefix works, and going back to the shared one is then a change like any other', async () => {
    const twin = await made('twin left behind', 'Z846E');
    await archived(twin);
    const live = await legacy('moves away', 'Z846E');

    const moved = await patch(live, { codePrefix: 'Z846F' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().station.codePrefix).toBe('Z846F');

    const back = await patch(live, { codePrefix: 'Z846E' });
    expect(back.statusCode).toBe(409);
    expect(back.json().error).toMatchObject({ code: 'STATION_CODE_PREFIX_TAKEN', details: { stationId: twin } });
    expect(await prefixOf(live)).toBe('Z846F');
  });

  it('a station turned into a till is checked for the prefix it already carries', async () => {
    const twin = await made('twin of a display', 'Z846G');
    await archived(twin);
    // A display's prefix numbers nothing, so it was never reserved against.
    const display = await legacy('display', 'Z846G', 'display');
    expect((await patch(display, { name: NAME('display renamed') })).statusCode).toBe(200);

    const refused = await patch(display, { kind: 'till' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'STATION_CODE_PREFIX_TAKEN', details: { stationId: twin } });
    const [row] = await ctx.db.select().from(station).where(eq(station.id, display));
    expect(row?.kind).toBe('display');

    const allowed = await patch(display, { kind: 'till', codePrefix: 'Z846H' });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().station).toMatchObject({ kind: 'till', codePrefix: 'Z846H' });
  });
});

describe('a refused receipt number says which clash it is', () => {
  it('payment: the station’s own series colliding keeps the receipt-number wording and rolls everything back', async () => {
    const till = await made('own series', 'Z846J');
    const first = await cart(till);
    expect((await pay(first)).statusCode).toBe(200);
    await rewind(till, 'Z846J');

    const second = await cart(till);
    const refused = await pay(second);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'RECEIPT_NUMBER_TAKEN',
      message: 'That receipt number is already used at this station' });
    expect(refused.json().error.message).not.toContain('prefix');
    expect(await ctx.db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.saleId, second))).toHaveLength(0);
    const [unpaid] = await ctx.db.select().from(sale).where(eq(sale.id, second));
    expect(unpaid).toMatchObject({ status: 'tendering', receiptNumber: null });
    // The counter the refused press advanced went back with it.
    expect((await seriesOf(till, 'Z846J'))[0]?.nextSeq).toBe(1);

    // Once the series is past the number on paper, the same order closes.
    await ctx.db.update(receiptSeries).set({ nextSeq: 2 })
      .where(and(eq(receiptSeries.stationId, till), eq(receiptSeries.series, 'Z846J')));
    const paid = await pay(second);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().sale.receiptNumber).toBe('Z846J-000002');
  });

  it('payment: its own series colliding is not blamed on the prefix even when an archived till holds that prefix', async () => {
    const idle = await made('idle twin', 'Z846K');
    await archived(idle);
    const live = await legacy('selling twin', 'Z846K');
    const first = await cart(live);
    const paid = await pay(first);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().sale.receiptNumber).toBe('Z846K-000001');
    await rewind(live, 'Z846K');

    const refused = await pay(await cart(live));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('RECEIPT_NUMBER_TAKEN');
  });

  it('payment: another station’s receipt under the same prefix is the prefix clash', async () => {
    const old = await made('paid owner', 'Z846L');
    expect((await pay(await cart(old))).statusCode).toBe(200);
    await archived(old);
    const live = await legacy('legacy duplicate', 'Z846L');

    const id = await cart(live);
    const refused = await pay(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('RECEIPT_PREFIX_IN_USE');
    expect(refused.json().error.message).toContain('Receipt prefix Z846L');
    expect(refused.json().error.message).toContain('choose a different prefix');
    expect(await ctx.db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.saleId, id))).toHaveLength(0);
    expect(await seriesOf(live, 'Z846L')).toHaveLength(0);
  });

  it('a sale closed at the commit: its own series colliding answers the original code and words', async () => {
    const till = await made('comp own series', 'Z846M');
    const first = await comp(till);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().sale.receiptNumber).toBe('Z846M-000001');
    await rewind(till, 'Z846M');

    const id = newId();
    const refused = await comp(till, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'RECEIPT_NUMBER_TAKEN',
      message: 'That receipt number is already used at this station' });
    expect(await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.id, id))).toHaveLength(0);
    expect((await seriesOf(till, 'Z846M'))[0]?.nextSeq).toBe(1);
  });

  it('a sale closed at the commit: another station’s receipt under the same prefix is the prefix clash', async () => {
    const old = await made('comp paid owner', 'Z846N');
    expect((await comp(old)).statusCode).toBe(200);
    await archived(old);
    const live = await legacy('comp legacy duplicate', 'Z846N');

    const id = newId();
    const refused = await comp(live, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('RECEIPT_PREFIX_IN_USE');
    expect(refused.json().error.message).toContain('Receipt prefix Z846N');
    expect(await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.id, id))).toHaveLength(0);
    expect(await seriesOf(live, 'Z846N')).toHaveLength(0);

    // The repair the refusal names: a prefix of its own, and the same sale closes.
    expect((await patch(live, { codePrefix: 'Z846P' })).statusCode).toBe(200);
    const closed = await comp(live, id);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().sale.receiptNumber).toBe('Z846P-000001');
  });
});
