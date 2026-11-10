import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { box, paymentAttempt, receiptSeries, sale, station } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, boxBySlot, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-809 adversarial review. HIGH: archived/renamed tills still own the
 * receipt series they used. Prescribed fix: check both saved station prefixes
 * and issued series, inside the assignment transaction, scoped to the park.
 * HIGH: a legacy collision must name the prefix and roll back its cash tender.
 * Prescribed fix: translate the receipt constraint at finalisation, not the
 * generic database error handler; never advance another station's counter.
 */
let ctx: TestContext;
let admin: string;
let operatorId: string;
let branchId: string;
let boxId: string;
let productId: string;

const send = (method: 'POST' | 'GET' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });
const create = (name: string, prefix: string, park = branchId, boxOnPark = boxId) => send('POST', `/branches/${park}/stations`, {
  name: `ZZ TEST SCRUM-809 ${name}`, kind: 'till', boxId: boxOnPark, codePrefix: prefix,
  accessScope: 'all_staff', devices: [], paymentRouting: { card: 'manual', qr: 'none' },
});
const made = async (name: string, prefix: string) => {
  const response = await create(name, prefix);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().station.id as string;
};
const archived = async (id: string) => {
  expect((await send('DELETE', `/stations/${id}`)).statusCode).toBe(200);
};
const cart = async (stationId: string) => {
  await takeStation(ctx.app, admin, stationId);
  const id = newId();
  const response = await send('POST', '/sales', {
    id, stationId, branchId, channel: 'fnb', pickupCode: '809', lines: [],
    items: [{ id: newId(), productId, quantity: 1, modifiers: [] }], note: 'ZZ TEST SCRUM-809',
  });
  expect(response.statusCode, response.body).toBe(200);
  return id;
};

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const virtual = await boxBySlot(ctx.db, 'virtual-1');
  ({ id: boxId, branchId, operatorId } = virtual);
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, boxId));
  const category = await send('POST', '/menu/categories', {
    name: 'ZZ TEST SCRUM-809 food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen',
  });
  expect(category.statusCode).toBe(200);
  const product = await send('POST', `/branches/${branchId}/menu/products`, {
    name: 'ZZ TEST SCRUM-809 item', kind: 'menu', categoryId: category.json().id,
    priceSatang: 100, priceWeekendSatang: 100, stockLinks: [], active: true,
  });
  expect(product.statusCode).toBe(200);
  productId = product.json().id;
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('receipt prefixes stay with the station that used them', () => {
  it('resolved HIGH: an archived till refuses a new till and names the earlier till', async () => {
    const old = await made('archived owner', 'Z809A');
    await archived(old);
    const response = await create('refused replacement', 'Z809A');
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'STATION_CODE_PREFIX_TAKEN',
      details: { field: 'codePrefix', stationId: old } });
    expect(response.json().error.message).toContain('ZZ TEST SCRUM-809 archived owner');
    expect(response.json().error.message).toContain('archiving');
    const rows = await ctx.db.select({ id: station.id }).from(station)
      .where(eq(station.name, 'ZZ TEST SCRUM-809 refused replacement'));
    expect(rows).toHaveLength(0);
  });

  it('resolved HIGH: PATCH cannot bypass the same refusal, but a till can keep its own prefix', async () => {
    const old = await made('patch owner', 'Z809B');
    await archived(old);
    const current = await made('editable', 'Z809C');
    const response = await send('PATCH', `/stations/${current}`, { codePrefix: 'Z809B' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('ZZ TEST SCRUM-809 patch owner');
    const keep = await send('PATCH', `/stations/${current}`, { name: 'ZZ TEST SCRUM-809 renamed' });
    expect(keep.statusCode).toBe(200);
    expect(keep.json().station.codePrefix).toBe('Z809C');
  });

  it('passing pin: another park can use the same letters without exposing the earlier till', async () => {
    const old = await made('other park owner', 'Z809D');
    await archived(old);
    const park = await send('POST', '/branches', { name: 'ZZ TEST SCRUM-809 park', code: 'zz-s809', timezone: 'Asia/Bangkok' });
    expect(park.statusCode).toBe(200);
    const otherBranchId = park.json().id as string;
    const otherBox = await send('POST', `/branches/${otherBranchId}/boxes`, {
      name: 'ZZ TEST SCRUM-809 box', slot: 'counter-1', role: 'counter',
    });
    expect(otherBox.statusCode).toBe(200);
    const response = await create('another park', 'Z809D', otherBranchId, otherBox.json().box.id);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('resolved HIGH: issued history still blocks reuse after the earlier till changes its prefix', async () => {
    const old = await made('historic owner', 'Z809E');
    await ctx.db.insert(receiptSeries).values({ id: newId(), operatorId, branchId, stationId: old,
      series: 'Z809E', kind: 'sale', nextSeq: 12, lastIssuedAt: new Date() });
    expect((await send('PATCH', `/stations/${old}`, { codePrefix: 'Z809F' })).statusCode).toBe(200);
    const response = await create('historic replacement', 'Z809E');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('ZZ TEST SCRUM-809 historic owner');
    // The original station's allocator is retained, not moved to a new till.
    expect((await send('PATCH', `/stations/${old}`, { codePrefix: 'Z809E' })).statusCode).toBe(200);
    const [series] = await ctx.db.select().from(receiptSeries).where(eq(receiptSeries.stationId, old));
    expect(series?.nextSeq).toBe(12);
  });

  it('resolved HIGH: two concurrent assignments have one winner and a named refusal', async () => {
    const results = await Promise.all([create('race one', 'Z809G'), create('race two', 'Z809G')]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results.find(r => r.statusCode === 200)!.json().station;
    const refusal = results.find(r => r.statusCode === 409)!.json().error;
    expect(refusal.code).toBe('STATION_CODE_PREFIX_TAKEN');
    expect(refusal.message).toContain(winner.name);
  });

  it('resolved HIGH: a legacy collision names the prefix and rolls back tender and counter; correcting the prefix lets the same sale close', async () => {
    const old = await made('paid owner', 'Z809H');
    const first = await cart(old);
    expect((await send('POST', `/sales/${first}/finalise`, { method: 'cash', cashReceivedSatang: 100 })).statusCode).toBe(200);
    await archived(old);
    // Simulate a station already saved by the old live-only guard. Never use
    // this fixture bypass on staging: the form refusal is the staging proof.
    const replacement = newId();
    await ctx.db.insert(station).values({ id: replacement, operatorId, branchId, boxId,
      name: 'ZZ TEST SCRUM-809 legacy duplicate', kind: 'till', codePrefix: 'Z809H', accessScope: 'all_staff',
      paymentRouting: { card: 'manual', qr: 'none' } });
    const id = await cart(replacement);
    const response = await send('POST', `/sales/${id}/finalise`, { method: 'cash', cashReceivedSatang: 100 });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('RECEIPT_PREFIX_IN_USE');
    expect(response.json().error.message).toContain('Receipt prefix Z809H');
    expect(response.json().error.message).not.toContain('That value is already taken');
    expect(await ctx.db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.saleId, id))).toHaveLength(0);
    const [unchanged] = await ctx.db.select().from(sale).where(eq(sale.id, id));
    expect(unchanged).toMatchObject({ status: 'tendering', receiptNumber: null });
    expect(await ctx.db.select().from(receiptSeries).where(and(eq(receiptSeries.stationId, replacement), eq(receiptSeries.series, 'Z809H')))).toHaveLength(0);
    expect((await send('PATCH', `/stations/${replacement}`, { codePrefix: 'Z809I' })).statusCode).toBe(200);
    const paid = await send('POST', `/sales/${id}/finalise`, { method: 'cash', cashReceivedSatang: 100 });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().sale.receiptNumber).toBe('Z809I-000001');
    const [earlier] = await ctx.db.select().from(sale).where(eq(sale.id, first));
    expect(earlier?.receiptNumber).toBe('Z809H-000001');
  });
});
