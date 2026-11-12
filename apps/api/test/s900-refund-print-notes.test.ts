import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, member, prepSlipPrint, product, station, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import { VOID_SLIPS_UNQUEUED_NOTE, refundPrepSlipNotes } from '../src/services/prep-slips';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-900 — A REFUND TELLS THE TILL WHEN A VOID SLIP COULD NOT GO TO THE
 * KITCHEN OR THE BAR.
 *
 * `queueRefundPrepSlips` has always worked out the sentences — "Void slip for
 * the bar not printed — no bar printer at Reception Till 1" — and the refund
 * threw them away, so the till never knew the bar had not been told. The
 * refund's answer now carries them as a sale's answer carries its printing
 * notes (`printing.notes`, empty when all is well), and a replay of the
 * refund — its Idempotency-Key again, or its action id again — says the same.
 *
 * Driven through the routes against Reception Till 1: the seed gives it a
 * kitchen printer and no bar printer, so it is given a bar role for the sale
 * and loses it again before the refund, as a station whose bar printer was
 * taken away would.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let tillId: string;
let tillName: string;
let receiptPrinterId: string;
let maliId: string;
const productByCode = new Map<string, string>();

const BAR_NOTE = () => `Void slip for the bar not printed — no bar printer at ${tillName}`;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  tillName = till!.name;
  const [receipt] = await ctx.db
    .select({ deviceId: stationDevice.deviceId })
    .from(stationDevice)
    .where(and(eq(stationDevice.stationId, tillId), eq(stationDevice.role, 'receipt')));
  receiptPrinterId = receipt!.deviceId;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  for (const row of await ctx.db.select().from(product).where(eq(product.operatorId, hkt!.operatorId))) {
    if (row.code) productByCode.set(row.code, row.id);
  }
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const giveBar = () => ctx.db.insert(stationDevice).values({ id: newId(), stationId: tillId, role: 'bar', deviceId: receiptPrinterId });
const takeBar = () => ctx.db.delete(stationDevice).where(and(eq(stationDevice.stationId, tillId), eq(stationDevice.role, 'bar')));

/** A hot dog for the kitchen and a juice for the bar, rung up at Reception Till 1 and closed in cash. */
async function kitchenAndBarSale(): Promise<string> {
  const saleId = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId: tillId,
      memberId: maliId,
      channel: 'fnb',
      pickupCode: '90',
      items: [
        { id: newId(), productId: productByCode.get('FB-HOTDOG')!, quantity: 1 },
        { id: newId(), productId: productByCode.get('FB-JUICE')!, quantity: 1 },
      ],
    },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const done = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(done.statusCode, done.body).toBe(200);
  const jobs = done.json().printing.jobs as Array<{ kind: string; status: string }>;
  expect(jobs.map((j) => [j.kind, j.status])).toEqual([
    ['receipt', 'queued'],
    ['kitchen_ticket', 'queued'],
    ['bar_ticket', 'queued'],
  ]);
  return saleId;
}

const refund = (saleId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: manager, ...headers }, payload: body });

describe('SCRUM-900 — the refund answer carries what the kitchen and the bar were not sent', () => {
  it('the bar printer taken off the till that printed the bar ticket: the refund says the void slip for the bar was not printed, and every replay says it again', async () => {
    await giveBar();
    const saleId = await kitchenAndBarSale();
    await takeBar();

    const actionId = newId();
    const key = `zz-s900-${newId()}`;
    const body = { mode: 'whole', reason: 'Guest left', actionId };
    const first = await refund(saleId, body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().printing).toEqual({ notes: [BAR_NOTE()] });
    expect(first.json().replay).toBe(false);
    // The kitchen's slip went; the bar's is on the record as not printed.
    const slips = await ctx.db.select().from(prepSlipPrint).where(eq(prepSlipPrint.saleId, saleId));
    expect(slips.map((s) => [s.station, s.variant, s.status]).sort()).toEqual([
      ['bar', 'void', 'no_printer'],
      ['kitchen', 'void', 'printed'],
    ]);

    // The same press again, under its key: the stored answer.
    const again = await refund(saleId, body, { 'idempotency-key': key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json().printing).toEqual({ notes: [BAR_NOTE()] });

    // The bar printer is back now — and a replay by the action id alone still
    // says what the first answer said, rather than working it out again.
    await giveBar();
    try {
      const byAction = await refund(saleId, { ...body, note: 'pressed again' });
      expect(byAction.statusCode, byAction.body).toBe(200);
      expect(byAction.json().replay).toBe(true);
      expect(byAction.json().refund.id).toBe(first.json().refund.id);
      expect(byAction.json().printing).toEqual({ notes: [BAR_NOTE()] });
    } finally {
      await takeBar();
    }
    // Nothing was written twice.
    expect(await ctx.db.select().from(prepSlipPrint).where(eq(prepSlipPrint.saleId, saleId))).toHaveLength(2);
  });

  it('every slip queued: the notes are empty, on the answer and on a replay', async () => {
    await giveBar();
    try {
      const saleId = await kitchenAndBarSale();
      const actionId = newId();
      const first = await refund(saleId, { mode: 'whole', reason: 'Guest left', actionId });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().printing).toEqual({ notes: [] });
      const byAction = await refund(saleId, { mode: 'whole', reason: 'Guest left again', actionId });
      expect(byAction.statusCode, byAction.body).toBe(200);
      expect(byAction.json().replay).toBe(true);
      expect(byAction.json().printing).toEqual({ notes: [] });
    } finally {
      await takeBar();
    }
  });

  it('a custom amount that leaves the sale open cancels no line: no slip was due, and the notes are empty, then and on a replay', async () => {
    await giveBar();
    let saleId: string;
    try {
      saleId = await kitchenAndBarSale();
    } finally {
      await takeBar();
    }
    const actionId = newId();
    const res = await refund(saleId, { mode: 'custom', amountSatang: 100, reason: 'Goodwill', actionId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refundStatus).toBe('partially_refunded');
    expect(res.json().printing).toEqual({ notes: [] });
    expect(await ctx.db.select().from(prepSlipPrint).where(eq(prepSlipPrint.saleId, saleId))).toEqual([]);
    const byAction = await refund(saleId, { mode: 'custom', amountSatang: 100, reason: 'Goodwill', actionId });
    expect(byAction.json()).toMatchObject({ replay: true, printing: { notes: [] } });
  });
});

describe('SCRUM-900 — what a replay reads', () => {
  it('slips that could not be queued at all are replayed in the same words the first answer used', async () => {
    const saleId = newId();
    const refundId = newId();
    await ctx.db.insert(auditLog).values({
      id: newId(), actorAccountId: null, action: 'sale.void_slips_failed', entityType: 'sale', entityId: saleId,
      after: { refundId, error: 'PREP_SLIPS_FAILED' },
    });
    expect(await refundPrepSlipNotes(ctx.db, { saleId, refundId })).toEqual([VOID_SLIPS_UNQUEUED_NOTE]);
    // Another refund of the same sale has notes of its own, and none here.
    expect(await refundPrepSlipNotes(ctx.db, { saleId, refundId: newId() })).toEqual([]);
  });
});
