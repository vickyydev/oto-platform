import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  boxCommand,
  branch,
  child,
  member,
  prepSlipPrint,
  printJob,
  product,
  saleLine,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import { newId, type PrepSlipDocument } from '@oto/shared';
import { buildPrintDocument } from '../src/services/sale-printing';
import {
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-861 — A REFUND SENDS THE KITCHEN AND THE BAR A VOID SLIP AND AN
 * UPDATED-ITEMS SLIP (the owner, 8 and 12 November).
 *
 * Every order here is rung up at Reception Till 1, which the seed gives a
 * kitchen printer and NO bar printer. The first test refunds an order whose
 * bar ticket was skipped for want of one — the bar never had the order, so it
 * hears nothing — and then gives the till a bar role, as the park does, so
 * every test after it has both stations on paper.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let branchId: string;
let operatorId: string;
let t1: typeof station.$inferSelect;
let maliId: string;
let maliAllergy: string;
let twoHoursId: string;
const productByCode = new Map<string, string>();

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  t1 = till!;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  const kids = await ctx.db.select().from(child).where(eq(child.memberId, maliId));
  maliAllergy = kids.find((c) => c.allergies)!.allergies!;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  for (const row of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (row.code) productByCode.set(row.code, row.id);
  }
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers -----------------------------------------------------------------

type Item = { code: string; quantity: number; note?: string };

/** An F&B order of these items, rung up and closed in cash: its kitchen and bar tickets are queued. */
async function fnbSale(items: Item[], extra: { pickupCode?: string; note?: string } = {}) {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId: t1.id,
      memberId: maliId,
      channel: 'fnb',
      pickupCode: extra.pickupCode ?? '42',
      ...(extra.note ? { note: extra.note } : {}),
      items: items.map((i) => ({
        id: newId(),
        productId: productByCode.get(i.code)!,
        quantity: i.quantity,
        ...(i.note ? { note: i.note } : {}),
      })),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const done = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: {},
  });
  expect(done.statusCode, done.body).toBe(200);
  const jobs = done.json().printing.jobs as { id: string; kind: string; status: string }[];
  return { saleId, jobs };
}

async function refundAs(cookie: string, saleId: string, body: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie }, payload: body });
}

const lineOf = async (saleId: string, label: string) => {
  const rows = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId)).orderBy(asc(saleLine.lineNo));
  return rows.find((l) => l.label === label)!;
};

const ORDER = { kitchen: 0, bar: 2 } as const;
/** A sale's slips, refund by refund as they were made, the kitchen's before the bar's, void before updated. */
const slipsOf = async (saleId: string) =>
  (await ctx.db.select().from(prepSlipPrint).where(eq(prepSlipPrint.saleId, saleId)).orderBy(asc(prepSlipPrint.createdAt))).sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      ORDER[a.station] + (a.variant === 'void' ? 0 : 1) - (ORDER[b.station] + (b.variant === 'void' ? 0 : 1)),
  );

const documentOf = async (printJobId: string) =>
  (await buildPrintDocument(ctx.db, { boxId: t1.boxId!, operatorId }, printJobId)).job.data as PrepSlipDocument;

const shape = (rows: (typeof prepSlipPrint.$inferSelect)[]) => rows.map((r) => [r.station, r.variant, r.status]);

// --- The tests -----------------------------------------------------------------

describe('SCRUM-861 — a refund sends the kitchen and the bar a void slip and an updated slip', () => {
  it('a station whose ticket was skipped for want of a printer never had the order: nothing is sent to it', async () => {
    const { saleId, jobs } = await fnbSale([{ code: 'FB-JUICE', quantity: 1 }]);
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([
      ['receipt', 'queued'],
      ['bar_ticket', 'skipped'],
    ]);
    const res = await refundAs(manager, saleId, { mode: 'whole', reason: 'Guest left' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refundStatus).toBe('refunded');
    expect(await slipsOf(saleId)).toEqual([]);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.void_slips')))).toEqual([]);

    // From here the park gives Reception Till 1 a bar role too (the receipt printer wears it).
    const [receipt] = await ctx.db
      .select({ deviceId: stationDevice.deviceId })
      .from(stationDevice)
      .where(and(eq(stationDevice.stationId, t1.id), eq(stationDevice.role, 'receipt')));
    await ctx.db.insert(stationDevice).values({ id: newId(), stationId: t1.id, role: 'bar', deviceId: receipt!.deviceId });
  });

  it('the whole sale refunded: each station gets a VOID slip of its own lines and nothing else, on the printer its ticket went to', async () => {
    const { saleId, jobs } = await fnbSale(
      [
        { code: 'FB-HOTDOG', quantity: 1, note: 'no onions' },
        { code: 'FB-FRIES', quantity: 1 },
        { code: 'FB-JUICE', quantity: 2 },
        { code: 'FB-WATER', quantity: 1 },
      ],
      { pickupCode: '57', note: 'Birthday table' },
    );
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([
      ['receipt', 'queued'],
      ['kitchen_ticket', 'queued'],
      ['bar_ticket', 'queued'],
    ]);

    const actionId = newId();
    const res = await refundAs(manager, saleId, { mode: 'whole', reason: 'Guest left', actionId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refundStatus).toBe('refunded');
    const refundNumber = res.json().refund.number as string;

    const rows = await slipsOf(saleId);
    expect(shape(rows)).toEqual([
      ['kitchen', 'void', 'printed'],
      ['bar', 'void', 'printed'],
    ]);
    expect(rows.every((r) => r.source === 'refund' && r.refundId === res.json().refund.id && r.printedAt !== null)).toBe(true);

    // One job each, written as a sale's prep ticket is: the station the ticket
    // printed on, the station's printer of that role, queued for the box.
    const slipJobs = await ctx.db.select().from(printJob).where(inArray(printJob.id, rows.map((r) => r.printJobId!)));
    const kitchenJob = slipJobs.find((j) => j.id === rows[0]!.printJobId)!;
    const barJob = slipJobs.find((j) => j.id === rows[1]!.printJobId)!;
    expect(kitchenJob).toMatchObject({ kind: 'kitchen_ticket', role: 'kitchen', status: 'queued', stationId: t1.id, subjectType: 'prep_slip', subjectId: rows[0]!.id, reprintOf: null });
    expect(barJob).toMatchObject({ kind: 'bar_ticket', role: 'bar', status: 'queued', stationId: t1.id, subjectType: 'prep_slip', subjectId: rows[1]!.id });
    expect(kitchenJob.deviceId).not.toBe(barJob.deviceId);
    // The box has not polled: the jobs wait in its queue with their commands,
    // exactly as a ticket's do while the box is offline. A slip's command
    // names no sale: a box that printed the sale offline refuses a late first
    // print of the sale's paper, and a void slip is not that.
    const commands = (await ctx.db.select().from(boxCommand).where(eq(boxCommand.boxId, t1.boxId!))).filter((c) =>
      rows.some((r) => (c.payload as { printJobId?: string }).printJobId === r.printJobId),
    );
    expect(commands).toHaveLength(2);
    for (const c of commands) {
      expect(c.payload).toMatchObject({ document: 'platform', subjectType: 'prep_slip' });
      expect((c.payload as { saleId?: string }).saleId).toBeUndefined();
    }

    // What the box is handed: the kitchen's own lines on the kitchen's slip,
    // the bar's on the bar's, each headed VOID with the order's number, the
    // time, who voided it, and the holder and allergy line the ticket carried.
    const kitchen = await documentOf(rows[0]!.printJobId!);
    expect(kitchen).toMatchObject({
      title: 'VOID — Kitchen',
      variant: 'void',
      orderRef: '57',
      details: [expect.stringMatching(/^Voided by .+/), `Refund ${refundNumber}`],
      lines: [
        { qty: 1, name: 'Hot Dog', note: 'no onions' },
        { qty: 1, name: 'French Fries' },
      ],
      orderNote: 'Birthday table',
    });
    expect(kitchen.time).toMatch(/^\d{2}:\d{2}$/);
    expect(kitchen.allergiesMedical).toContain(maliAllergy);
    expect(kitchen).not.toHaveProperty('heading');
    const bar = await documentOf(rows[1]!.printJobId!);
    expect(bar).toMatchObject({
      title: 'VOID — Bar',
      variant: 'void',
      orderRef: '57',
      lines: [
        { qty: 2, name: 'Fresh Orange Juice' },
        { qty: 1, name: 'Bottled Water' },
      ],
    });

    // Audited beside the refund, the way a sale's printing is.
    const audited = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.void_slips')));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.after).toMatchObject({
      refundId: res.json().refund.id,
      slips: [
        { station: 'kitchen', variant: 'void', status: 'printed', printJobId: rows[0]!.printJobId },
        { station: 'bar', variant: 'void', status: 'printed', printJobId: rows[1]!.printJobId },
      ],
    });

    // The same press again is the same refund, and prints nothing twice.
    const again = await refundAs(manager, saleId, { mode: 'whole', reason: 'Guest left', actionId });
    expect(again.statusCode).toBe(200);
    expect(again.json().replay).toBe(true);
    expect(await slipsOf(saleId)).toHaveLength(2);
    expect(await ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'prep_slip'), inArray(printJob.subjectId, rows.map((r) => r.id))))).toHaveLength(2);
  });

  it('chosen lines: the station loses them on a VOID slip and gets an UPDATED slip of the rest; the other station hears nothing', async () => {
    const { saleId } = await fnbSale(
      [
        { code: 'FB-HOTDOG', quantity: 1 },
        { code: 'FB-FRIES', quantity: 2, note: 'extra ketchup' },
        { code: 'FB-JUICE', quantity: 1 },
      ],
      { pickupCode: '58' },
    );
    const hotdog = await lineOf(saleId, 'Hot Dog');
    const fries = await lineOf(saleId, 'French Fries');
    const juice = await lineOf(saleId, 'Fresh Orange Juice');

    const first = await refundAs(manager, saleId, { mode: 'items', lineIds: [hotdog.id], reason: 'Wrong item' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().refundStatus).toBe('partially_refunded');
    let rows = await slipsOf(saleId);
    expect(shape(rows)).toEqual([
      ['kitchen', 'void', 'printed'],
      ['kitchen', 'updated', 'printed'],
    ]);
    expect(await documentOf(rows[0]!.printJobId!)).toMatchObject({
      title: 'VOID — Kitchen',
      variant: 'void',
      orderRef: '58',
      lines: [{ qty: 1, name: 'Hot Dog' }],
    });
    const updated = await documentOf(rows[1]!.printJobId!);
    expect(updated).toMatchObject({
      title: 'UPDATED — Kitchen',
      variant: 'updated',
      orderRef: '58',
      details: [`Still to make after refund ${first.json().refund.number}`, expect.stringMatching(/^Updated by .+/)],
      lines: [{ qty: 2, name: 'French Fries', note: 'extra ketchup' }],
    });
    expect(updated.allergiesMedical).toContain(maliAllergy);

    // The fries go too: the kitchen has nothing left, so a VOID slip alone.
    const second = await refundAs(manager, saleId, { mode: 'items', lineIds: [fries.id], reason: 'Cold' });
    expect(second.statusCode, second.body).toBe(200);
    rows = await slipsOf(saleId);
    expect(shape(rows).slice(2)).toEqual([['kitchen', 'void', 'printed']]);
    expect(await documentOf(rows[2]!.printJobId!)).toMatchObject({ variant: 'void', lines: [{ qty: 2, name: 'French Fries', note: 'extra ketchup' }] });

    // The juice empties the sale: the bar's VOID slip, and the kitchen — with
    // nothing standing — hears nothing more.
    const third = await refundAs(manager, saleId, { mode: 'items', lineIds: [juice.id], reason: 'Guest left' });
    expect(third.statusCode, third.body).toBe(200);
    expect(third.json().refundStatus).toBe('refunded');
    rows = await slipsOf(saleId);
    expect(shape(rows).slice(3)).toEqual([['bar', 'void', 'printed']]);
    expect(await documentOf(rows[3]!.printJobId!)).toMatchObject({ title: 'VOID — Bar', lines: [{ qty: 1, name: 'Fresh Orange Juice' }] });
  });

  it('a custom amount that leaves the sale open names no line and sends nothing; one that empties it voids every standing line', async () => {
    const { saleId } = await fnbSale([
      { code: 'FB-HOTDOG', quantity: 1 },
      { code: 'FB-JUICE', quantity: 1 },
    ]);
    const part = await refundAs(manager, saleId, { mode: 'custom', amountSatang: 1_000, reason: 'Service recovery' });
    expect(part.statusCode, part.body).toBe(200);
    expect(part.json().refundStatus).toBe('partially_refunded');
    expect(await slipsOf(saleId)).toEqual([]);

    const rest = await refundAs(manager, saleId, { mode: 'custom', amountSatang: 1_000_000, reason: 'Guest unwell' });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json().refundStatus).toBe('refunded');
    const rows = await slipsOf(saleId);
    expect(shape(rows)).toEqual([
      ['kitchen', 'void', 'printed'],
      ['bar', 'void', 'printed'],
    ]);
    expect(await documentOf(rows[0]!.printJobId!)).toMatchObject({ lines: [{ qty: 1, name: 'Hot Dog' }] });
    expect(await documentOf(rows[1]!.printJobId!)).toMatchObject({ lines: [{ qty: 1, name: 'Fresh Orange Juice' }] });
  });

  it('a sale with no kitchen or bar lines sends nothing', async () => {
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId: t1.id, memberId: maliId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const done = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
    expect(done.statusCode, done.body).toBe(200);
    const refund = await refundAs(manager, saleId, { mode: 'whole', reason: 'Guest left' });
    expect(refund.statusCode, refund.body).toBe(200);
    expect(await slipsOf(saleId)).toEqual([]);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.void_slips')))).toEqual([]);
  });

  it('a station no longer on a box: the slip is recorded "no printer", nothing is queued, and the refund stands', async () => {
    const { saleId } = await fnbSale([{ code: 'FB-HOTDOG', quantity: 1 }]);
    await ctx.db.update(station).set({ boxId: null }).where(eq(station.id, t1.id));
    try {
      const res = await refundAs(manager, saleId, { mode: 'whole', reason: 'Guest left' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().refundStatus).toBe('refunded');
      const rows = await slipsOf(saleId);
      expect(rows.map((r) => [r.station, r.variant, r.status, r.printJobId, r.printedAt])).toEqual([['kitchen', 'void', 'no_printer', null, null]]);
      expect((rows[0]!.document as PrepSlipDocument).title).toBe('VOID — Kitchen');
      const [audited] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.void_slips')));
      expect(audited?.after).toMatchObject({ slips: [{ station: 'kitchen', variant: 'void', status: 'no_printer' }], notes: [expect.stringContaining('not printed')] });
    } finally {
      await ctx.db.update(station).set({ boxId: t1.boxId }).where(eq(station.id, t1.id));
    }
  });
});
