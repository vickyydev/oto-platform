import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, branch, printJob, sale, saleExtension, saleExtensionBand, saleLine, station, ticketPackage } from '@oto/db';
import { bandShortCode, newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-797 — EXTRA HOUR, the owner's rule (9 November 2026): in History, scan
 * the kid's or the adult's wristband to open the order and add 1, 2 or 3 hours
 * to a 1 or 2-hour child ticket, on the same wristbands, at ฿300 per child per
 * hour — "3 kids x 2 h x 300 THB = 1,800 to pay". Driven through the real
 * routes; the seeded branch's VAT is 7 % inclusive with no service charge, so
 * the charge's gross is the sum itself.
 */

let ctx: TestContext;
let cookie: string;
let stationId: string;
let branchId: string;
let oneHourId: string;
let twoHoursId: string;
let fullDayId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const tills = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  fullDayId = packages.find((p) => p.name === 'Full Day Pass')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

type Ticket = { packageId: string; kids: number; adults: number };

/** A walk-in admission rung up and paid at the till, with its bands. */
async function admission(...tickets: Ticket[]) {
  await takeStation(ctx.app, cookie, stationId);
  const made = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie },
    payload: { stationId, id: newId(), lines: tickets.map((t) => ({ id: newId(), ...t })) } });
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().sale.id as string;
  const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
  expect(closed.statusCode, closed.body).toBe(200);
  const bands = await ctx.db.select().from(band).where(eq(band.saleId, id)).orderBy(asc(band.createdAt), asc(band.id));
  const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, id));
  return { id, bands, lines };
}

function read(sourceId: string) {
  return ctx.app.inject({ method: 'GET', url: `/sales/${sourceId}/extensions`, headers: { cookie } });
}

function extend(sourceId: string, optionId: string, bandIds: string[], actionId = newId()) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${sourceId}/extensions`, headers: { cookie },
    payload: { actionId, stationId, optionId, selection: { mode: 'bands', bandIds } } });
}

function finalise(chargeId: string) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${chargeId}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
}

async function chargeLine(chargeId: string) {
  const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, chargeId));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

describe('the amount is hours × children × ฿300', () => {
  it('offers 1, 2 or 3 hours priced per child from the order, and no 30 minutes', async () => {
    const source = await admission({ packageId: oneHourId, kids: 3, adults: 1 });
    const answer = await read(source.id);
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toMatchObject({ children: 3, perChildHourSatang: 30000, refusal: null });
    expect(answer.json().options).toEqual([
      { id: 'ext-60', label: '+1 hour', hours: 1, minutes: 60, unitSatang: 30000 },
      { id: 'ext-120', label: '+2 hours', hours: 2, minutes: 120, unitSatang: 60000 },
      { id: 'ext-180', label: '+3 hours', hours: 3, minutes: 180, unitSatang: 90000 },
    ]);
    // An older till still asking for the retired option is told to choose again.
    const retired = await extend(source.id, 'ext-30', source.bands.map((b) => b.id));
    expect(retired.statusCode).toBe(400);
    expect(await ctx.db.select().from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id))).toEqual([]);
  });

  it('one child for one hour is ฿300', async () => {
    const source = await admission({ packageId: oneHourId, kids: 1, adults: 1 });
    const made = await extend(source.id, 'ext-60', source.bands.map((b) => b.id));
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().extension).toMatchObject({ amountSatang: 30000, minutesAdded: 60, label: '+1 hour' });
    expect(made.json().sale.totals.grossSatang).toBe(30000);
    const line = await chargeLine(made.json().sale.id as string);
    expect(line).toMatchObject({ kind: 'addon', componentKey: 'time_extension', label: 'Extra hour x 1', quantity: 1,
      unitSatang: 30000, baseSatang: 30000, grossSatang: 30000, taxableCategory: 'tickets', revenueCategory: 'tickets',
      ticketPackageId: null, productId: null });
    expect(line.payload).toMatchObject({ hours: 1, children: 1, perChildHourSatang: 30000, perChildSatang: 30000, minutesAdded: 60 });
  });

  it('three children on a 1-hour ticket staying two hours longer pay ฿1,800 (the owner’s example)', async () => {
    const source = await admission({ packageId: oneHourId, kids: 3, adults: 1 });
    const made = await extend(source.id, 'ext-120', source.bands.map((b) => b.id));
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().extension).toMatchObject({ amountSatang: 180000, minutesAdded: 120, label: '+2 hours', braceletCount: 4 });
    const line = await chargeLine(made.json().sale.id as string);
    expect(line).toMatchObject({ label: 'Extra hour x 2', quantity: 3, unitSatang: 60000, baseSatang: 180000, grossSatang: 180000 });
    expect(line.payload).toMatchObject({ hours: 2, children: 3, perChildHourSatang: 30000, perChildSatang: 60000 });
    const [charge] = await ctx.db.select().from(sale).where(eq(sale.id, made.json().sale.id as string));
    expect(charge).toMatchObject({ subtotalSatang: 180000, grossSatang: 180000 });
  });

  it('every child on the order is charged, and the read names each child’s bracelet so the till keeps it ticked', async () => {
    const source = await admission({ packageId: twoHoursId, kids: 2, adults: 1 }, { packageId: fullDayId, kids: 1, adults: 0 });
    const answer = await read(source.id);
    expect(answer.json().children).toBe(2);
    const twoHourKids = new Set(source.bands.filter((b) => b.kind === 'kid' && b.saleLineId
      && source.lines.find((l) => l.id === b.saleLineId)?.stayHours === 2).map((b) => b.id));
    expect(twoHourKids.size).toBe(2);
    // The two children on 2 Hours Play are charged; the adult's band and the Full Day child's are not.
    const charged = (answer.json().eligibleBands as Array<{ id: string; kind: string; charged: boolean }>)
      .map((b) => [b.kind, b.charged, twoHourKids.has(b.id)]);
    expect(charged.sort()).toEqual([['adult', false, false], ['kid', false, false], ['kid', true, true], ['kid', true, true]]);
    // The platform still takes the order's children as the money, whichever bracelets carry the time.
    const made = await extend(source.id, 'ext-180', [...twoHourKids].slice(0, 1));
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().extension).toMatchObject({ amountSatang: 180000, braceletCount: 1 });
    expect(await chargeLine(made.json().sale.id as string)).toMatchObject({ label: 'Extra hour x 3', quantity: 2, unitSatang: 90000 });
  });

  it('counts only the children on 1- or 2-hour tickets when the order also holds a Full Day pass', async () => {
    const source = await admission({ packageId: oneHourId, kids: 2, adults: 1 }, { packageId: fullDayId, kids: 1, adults: 0 });
    expect((await read(source.id)).json()).toMatchObject({ children: 2, refusal: null });
    const made = await extend(source.id, 'ext-60', source.bands.map((b) => b.id));
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().extension.amountSatang).toBe(60000);
  });
});

describe('refused before any charge, in the platform’s words', () => {
  it('a Full Day pass', async () => {
    const source = await admission({ packageId: fullDayId, kids: 2, adults: 1 });
    const answer = await read(source.id);
    expect(answer.json().options).toEqual([]);
    expect(answer.json().children).toBe(0);
    expect(answer.json().refusal).toEqual({ code: 'EXTENSION_TICKET_NOT_ELIGIBLE',
      message: 'An extra hour is added only to a 1 or 2-hour child ticket. A Full Day pass cannot take extra hours.' });
    // The bracelets stay listed, so an earlier addition on them can still be repaired.
    expect(answer.json().eligibleBands).toHaveLength(3);
    const made = await extend(source.id, 'ext-60', source.bands.map((b) => b.id));
    expect(made.statusCode).toBe(409);
    expect(made.json().error).toMatchObject({ code: 'EXTENSION_TICKET_NOT_ELIGIBLE', message: answer.json().refusal.message });
    expect(await ctx.db.select().from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id))).toEqual([]);
  });

  it('an order with no child', async () => {
    const source = await admission({ packageId: twoHoursId, kids: 0, adults: 2 });
    const answer = await read(source.id);
    expect(answer.json().options).toEqual([]);
    expect(answer.json().refusal).toEqual({ code: 'EXTENSION_NO_CHILDREN',
      message: 'This order has no child ticket. An extra hour is charged per child on a 1 or 2-hour child ticket.' });
    const made = await extend(source.id, 'ext-60', source.bands.map((b) => b.id));
    expect(made.statusCode).toBe(409);
    expect(made.json().error.code).toBe('EXTENSION_NO_CHILDREN');
    expect(await ctx.db.select().from(saleExtension).where(eq(saleExtension.sourceSaleId, source.id))).toEqual([]);
  });
});

describe('the same wristbands keep working', () => {
  it('the kid’s and the adult’s bands stay the admission’s, carry the added hour, and still open the order', async () => {
    const source = await admission({ packageId: oneHourId, kids: 1, adults: 1 });
    const kid = source.bands.find((b) => b.kind === 'kid')!;
    const adult = source.bands.find((b) => b.kind === 'adult')!;
    const made = await extend(source.id, 'ext-60', [kid.id, adult.id]);
    expect(made.statusCode, made.body).toBe(200);
    const chargeId = made.json().sale.id as string;
    expect((await finalise(chargeId)).json().finalised).toBe(true);

    // No band is minted for the charge, and the admission's are untouched.
    expect(await ctx.db.select().from(band).where(eq(band.saleId, chargeId))).toEqual([]);
    const after = await ctx.db.select().from(band).where(eq(band.saleId, source.id));
    expect(after.map((b) => [b.id, b.code, b.status]).sort()).toEqual(source.bands.map((b) => [b.id, b.code, 'active']).sort());
    const carried = await ctx.db.select().from(saleExtensionBand).where(eq(saleExtensionBand.extensionId, made.json().extension.id as string));
    expect(carried.map((row) => row.bandId).sort()).toEqual([kid.id, adult.id].sort());
    expect(carried.every((row) => row.minutesAdded === 60 && row.appliedAt !== null && row.revokedAt === null)).toBe(true);
    const paper = await ctx.db.select({ kind: printJob.kind }).from(printJob).where(eq(printJob.subjectId, chargeId));
    expect(paper.every((job) => job.kind === 'receipt')).toBe(true);

    // History's band box: either band, scanned or typed, still opens the order.
    for (const code of [kid.code, adult.code, bandShortCode(kid.code)!, bandShortCode(adult.code)!]) {
      const found = await ctx.app.inject({ method: 'GET', headers: { cookie },
        url: `/sales/lookup?band=${encodeURIComponent(code)}&branchId=${branchId}&limit=50` });
      expect(found.statusCode, found.body).toBe(200);
      expect((found.json() as { sales: Array<{ id: string }> }).sales.map((s) => s.id)).toContain(source.id);
    }
    expect((await read(source.id)).json().options).toHaveLength(3);
  });

  it('one extension can follow another: 1 hour now, 1 more later', async () => {
    const source = await admission({ packageId: twoHoursId, kids: 2, adults: 1 });
    const all = source.bands.map((b) => b.id);
    const first = await extend(source.id, 'ext-60', all);
    expect(first.statusCode, first.body).toBe(200);
    expect((await finalise(first.json().sale.id as string)).json().finalised).toBe(true);
    const second = await extend(source.id, 'ext-60', all);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().sale.id).not.toBe(first.json().sale.id);
    expect(second.json().extension.amountSatang).toBe(60000);
    expect((await finalise(second.json().sale.id as string)).json().finalised).toBe(true);
    const answer = await read(source.id);
    expect(answer.json().extensions.map((row: { status: string; amountSatang: number }) => [row.status, row.amountSatang]))
      .toEqual([['applied', 60000], ['applied', 60000]]);
    const kid = source.bands.find((b) => b.kind === 'kid')!;
    const rows = await ctx.db.select().from(saleExtensionBand).where(eq(saleExtensionBand.bandId, kid.id));
    expect(rows.map((row) => row.minutesAdded)).toEqual([60, 60]);
    expect(answer.json().options).toHaveLength(3);
  });
});
