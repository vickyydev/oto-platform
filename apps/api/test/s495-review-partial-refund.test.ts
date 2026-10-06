import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, branch, refund, sale, saleExtension, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-495 review, fix round: Add time after a part refund of the admission.
 * A part refund leaves the bracelets active and Add time open; a pending
 * extension still blocks every admission refund; part refunds that add up to
 * the whole close Add time and bracelet repair, as a single whole refund does.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let stationId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const tills = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function admission(adults = 2) {
  await takeStation(ctx.app, cookie, stationId);
  const made = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie },
    payload: { stationId, id: newId(), lines: [{ id: newId(), packageId: twoHoursId, kids: 0, adults }] } });
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().sale.id as string;
  const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
  expect(closed.statusCode, closed.body).toBe(200);
  const bands = await ctx.db.select({ id: band.id }).from(band).where(eq(band.saleId, id));
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, id));
  return { id, bands, gross: row!.grossSatang };
}

function extend(sourceId: string, selection: Record<string, unknown>, actionId = newId()) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${sourceId}/extensions`, headers: { cookie },
    payload: { actionId, stationId, optionId: 'ext-30', selection } });
}

function finalise(chargeId: string) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
}

function partRefund(saleId: string, amountSatang: number, actionId = newId()) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: adminCookie },
    payload: { actionId, mode: 'custom', amountSatang, reason: 'Review refund' } });
}

describe('Add time after a part refund', () => {
  it('a pending extension still refuses a further part refund and writes nothing; finishing it reopens refunds', async () => {
    const source = await admission();
    expect((await partRefund(source.id, 1000)).statusCode).toBe(200);
    const made = await extend(source.id, { mode: 'count', braceletCount: 2 });
    expect(made.statusCode, made.body).toBe(200);
    const before = await ctx.db.select({ id: refund.id }).from(refund).where(eq(refund.saleId, source.id));
    const blocked = await partRefund(source.id, 500);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('EXTENSION_PENDING');
    expect(await ctx.db.select({ id: refund.id }).from(refund).where(eq(refund.saleId, source.id))).toHaveLength(before.length);
    const done = await finalise(made.json().sale.id);
    expect(done.json().finalised).toBe(true);
    expect((await partRefund(source.id, 500)).statusCode).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, source.id));
    expect(row!.status).toBe('finalised');
    expect(row!.refundedSatang).toBe(1500);
  });

  it('a replayed part refund counts once and leaves Add time open', async () => {
    const source = await admission();
    const actionId = newId();
    const first = await partRefund(source.id, 700, actionId);
    const again = await partRefund(source.id, 700, actionId);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, source.id));
    expect(row!.refundedSatang).toBe(700);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${source.id}/extensions`, headers: { cookie } });
    expect(read.json().eligibleBands).toHaveLength(source.bands.length);
  });

  it('part refunds that add up to the whole end Add time and bracelet repair like a whole refund', async () => {
    const source = await admission();
    expect((await partRefund(source.id, 1000)).statusCode).toBe(200);
    const made = await extend(source.id, { mode: 'bands', bandIds: [source.bands[0]!.id] });
    expect(made.statusCode, made.body).toBe(200);
    const extensionId = made.json().extension.id as string;
    expect((await finalise(made.json().sale.id)).json().finalised).toBe(true);
    const rest = await partRefund(source.id, source.gross - 1000);
    expect(rest.statusCode, rest.body).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, source.id));
    expect(row!.status).toBe('refunded');
    const active = await ctx.db.select({ id: band.id }).from(band).where(and(eq(band.saleId, source.id), eq(band.status, 'active')));
    expect(active).toHaveLength(0);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${source.id}/extensions`, headers: { cookie } });
    expect(read.json().options).toEqual([]);
    expect(read.json().eligibleBands).toEqual([]);
    const create = await extend(source.id, { mode: 'count', braceletCount: 1 });
    expect(create.json().error.code).toBe('EXTENSION_SOURCE_UNAVAILABLE');
    const repair = await ctx.app.inject({ method: 'POST', url: `/sales/${source.id}/extensions/${extensionId}/bands`, headers: { cookie },
      payload: { actionId: newId(), stationId, bandIds: [source.bands[1]!.id] } });
    expect(repair.statusCode).toBe(409);
    expect(await ctx.db.select({ id: saleExtension.id }).from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id))).toHaveLength(1);
    const reselects = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, extensionId), eq(auditLog.action, 'sale.extension.reselect')));
    expect(reselects).toHaveLength(0);
  });

  it('a part refund racing an extension create leaves a consistent admission', async () => {
    const source = await admission();
    const [refunded, made] = await Promise.all([partRefund(source.id, 800), extend(source.id, { mode: 'count', braceletCount: 1 })]);
    expect(made.statusCode, made.body).toBe(200);
    // Either the refund ran first (and the extension followed), or the
    // extension was pending first and the refund was refused untouched.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, source.id));
    if (refunded.statusCode === 200) expect(row!.refundedSatang).toBe(800);
    else {
      expect(refunded.json().error.code).toBe('EXTENSION_PENDING');
      expect(row!.refundedSatang).toBe(0);
    }
    expect((await finalise(made.json().sale.id)).json().finalised).toBe(true);
    const [extension] = await ctx.db.select().from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id));
    expect(extension!.status).toBe('applied');
  });
});
