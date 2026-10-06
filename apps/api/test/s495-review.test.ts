import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, branch, paymentAttempt, refund, sale, saleExtension, saleExtensionBand, station, ticketPackage } from '@oto/db';
import { newId, PAYMENT_ATTEMPT_TAKEN_STATUSES } from '@oto/shared';
import {
  ADMIN,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-495 review: the Add time routes against another operator and another
 * park, cloud bracelet reselection on a paid extension, and one charge per
 * extension under concurrent finalise and replayed refunds.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let stationId: string;
let twoHoursId: string;
let chalongStationId: string | null = null;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const tills = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const [chalong] = await ctx.db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
  const chalongTills = chalong
    ? await ctx.db.select().from(station).where(and(eq(station.branchId, chalong.id), eq(station.kind, 'till')))
    : [];
  chalongStationId = chalongTills[0]?.id ?? null;
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
  return { id, bands };
}

function extend(sourceId: string, selection: Record<string, unknown>, who = cookie, at = stationId, actionId = newId()) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${sourceId}/extensions`, headers: { cookie: who },
    payload: { actionId, stationId: at, optionId: 'ext-30', selection } });
}

describe('tenancy and park scope on the Add time routes', () => {
  it('another operator reads nothing and writes nothing', async () => {
    const source = await admission();
    const made = await extend(source.id, { mode: 'count', braceletCount: 1 });
    expect(made.statusCode).toBe(200);
    const extensionId = made.json().extension.id as string;
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${source.id}/extensions`, headers: { cookie: foreign } });
    expect(read.statusCode).toBe(404);
    const create = await extend(source.id, { mode: 'count', braceletCount: 1 }, foreign);
    expect(create.statusCode).toBeGreaterThanOrEqual(400);
    const repair = await ctx.app.inject({ method: 'POST', url: `/sales/${source.id}/extensions/${extensionId}/bands`, headers: { cookie: foreign },
      payload: { actionId: newId(), stationId, bandIds: [source.bands[0]!.id] } });
    expect(repair.statusCode).toBeGreaterThanOrEqual(400);
    expect(await ctx.db.select({ id: saleExtension.id }).from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id))).toHaveLength(1);
  });

  it('an account scoped to another park of the same operator is refused on the sale’s own park', async () => {
    const source = await admission();
    const other = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${source.id}/extensions`, headers: { cookie: other } });
    expect(read.statusCode).toBe(403);
    if (chalongStationId) {
      await takeStation(ctx.app, other, chalongStationId);
      const create = await extend(source.id, { mode: 'count', braceletCount: 1 }, other, chalongStationId);
      expect(create.statusCode).toBe(403);
    }
    expect(await ctx.db.select({ id: saleExtension.id }).from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id))).toHaveLength(0);
  });
});

describe('Add time money', () => {
  it('two concurrent finalise presses collect the charge once and apply it once', async () => {
    const source = await admission();
    const made = await extend(source.id, { mode: 'bands', bandIds: [source.bands[0]!.id] });
    expect(made.statusCode).toBe(200);
    const chargeId = made.json().sale.id as string;
    const extensionId = made.json().extension.id as string;
    const presses = await Promise.all([0, 1].map(() => ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`,
      headers: { cookie }, payload: { actionId: newId() } })));
    expect(presses.some((res) => res.statusCode === 200 && res.json().finalised === true)).toBe(true);
    const taken = await ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.saleId, chargeId), inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES])));
    const [charge] = await ctx.db.select().from(sale).where(eq(sale.id, chargeId));
    expect(taken.reduce((sum, row) => sum + row.amountSatang, 0)).toBe(charge!.grossSatang);
    const applies = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'sale.extension.apply'), eq(auditLog.entityId, extensionId)));
    expect(applies).toHaveLength(1);
  });

  it('a whole refund of the charge replayed with its action writes one refund and one cancellation', async () => {
    const source = await admission();
    const made = await extend(source.id, { mode: 'count', braceletCount: 2 });
    const chargeId = made.json().sale.id as string;
    const extensionId = made.json().extension.id as string;
    expect((await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId() } })).json().finalised).toBe(true);
    const body = { actionId: newId(), mode: 'whole', reason: 'Review refund' };
    const first = await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/refunds`, headers: { cookie: adminCookie }, payload: body });
    expect(first.statusCode, first.body).toBe(200);
    const again = await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/refunds`, headers: { cookie: adminCookie }, payload: body });
    expect(again.statusCode).toBe(200);
    expect(await ctx.db.select({ id: refund.id }).from(refund).where(eq(refund.saleId, chargeId))).toHaveLength(1);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'sale.extension.cancel'), eq(auditLog.entityId, extensionId)))).toHaveLength(1);
    const [row] = await ctx.db.select().from(saleExtension).where(eq(saleExtension.id, extensionId));
    expect(row!.status).toBe('voided');
    // A voided extension no longer blocks the admission's own refund or new time.
    const next = await extend(source.id, { mode: 'count', braceletCount: 1 });
    expect(next.statusCode).toBe(200);
  });

  it('a paid extension whose bracelet was replaced at the till is moved once, money and minutes frozen', async () => {
    const source = await admission();
    const made = await extend(source.id, { mode: 'bands', bandIds: [source.bands[0]!.id] });
    const chargeId = made.json().sale.id as string;
    const extensionId = made.json().extension.id as string;
    expect((await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId() } })).json().finalised).toBe(true);
    await ctx.db.update(band).set({ status: 'replaced' }).where(eq(band.id, source.bands[0]!.id));
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${source.id}/extensions`, headers: { cookie } });
    expect(read.json().extensions[0].needsReselection).toBe(true);
    const path = `/sales/${source.id}/extensions/${extensionId}/bands`;
    const repair = { actionId: newId(), stationId, bandIds: [source.bands[1]!.id] };
    // The inactive bracelet itself cannot be chosen again.
    expect((await ctx.app.inject({ method: 'POST', url: path, headers: { cookie }, payload: { ...repair, actionId: newId(), bandIds: [source.bands[0]!.id] } })).statusCode).toBe(409);
    const fixed = await ctx.app.inject({ method: 'POST', url: path, headers: { cookie }, payload: repair });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: path, headers: { cookie }, payload: repair })).json().replay).toBe(true);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'sale.extension.reselect'), eq(auditLog.entityId, extensionId)));
    expect(audits).toHaveLength(1);
    const [entry] = await ctx.db.select().from(saleExtensionBand).where(eq(saleExtensionBand.extensionId, extensionId));
    expect(entry!.bandId).toBe(source.bands[1]!.id);
    expect(entry!.minutesAdded).toBe(30);
    const [row] = await ctx.db.select().from(saleExtension).where(eq(saleExtension.id, extensionId));
    expect(row!.amountSatang).toBe(6000);
    expect(row!.selection).toEqual({ mode: 'bands', bandIds: [source.bands[0]!.id] });
    const after = await ctx.app.inject({ method: 'GET', url: `/sales/${source.id}/extensions`, headers: { cookie } });
    expect(after.json().extensions[0].needsReselection).toBe(false);
    expect(await ctx.db.select({ id: paymentAttempt.id }).from(paymentAttempt).where(eq(paymentAttempt.saleId, chargeId))).toHaveLength(1);
  });

  it('a charge with recorded money is held, not refused, by the close paths and finishes after reselection', async () => {
    const source = await admission();
    const made = await extend(source.id, { mode: 'bands', bandIds: [source.bands[0]!.id] });
    const chargeId = made.json().sale.id as string;
    const extensionId = made.json().extension.id as string;
    const half = await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId(), amountSatang: 3000 } });
    expect(half.json().finalised).toBe(false);
    await ctx.db.update(band).set({ status: 'replaced' }).where(eq(band.id, source.bands[0]!.id));
    const refused = await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(refused.json().error.code).toBe('EXTENSION_BAND_UNAVAILABLE');
    const fixed = await ctx.app.inject({ method: 'POST', url: `/sales/${source.id}/extensions/${extensionId}/bands`, headers: { cookie },
      payload: { actionId: newId(), stationId, bandIds: [source.bands[1]!.id] } });
    expect(fixed.statusCode, fixed.body).toBe(200);
    const done = await ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(done.json().finalised).toBe(true);
    const taken = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, chargeId));
    expect(taken.reduce((sum, row) => sum + row.amountSatang, 0)).toBe(6000);
    const [row] = await ctx.db.select().from(saleExtension).where(eq(saleExtension.id, extensionId));
    expect(row!.status).toBe('applied');
  });
});
