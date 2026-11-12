import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  band,
  bandEvent,
  boxCommand,
  branch,
  checkin,
  device,
  nanny,
  nannyShift,
  printJob,
  sale,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import { newId, salePrintDocumentOf } from '@oto/shared';
import { buildPrintDocument, salePrintSnapshotOf } from '../src/services/sale-printing';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-861 — DROP-OFF BANDS GO TO THEIR OWN PRINTER, and a change prints the
 * right band again.
 *
 * The owner's rule (8 and 12 November): "drop-off children and everyone else
 * use separate bracelets. There will be two printers, with one dedicated to
 * drop-off bracelets" — and the second printer is connected later, so until a
 * station has one, a drop-off band must still come out of the kids printer.
 * Driven through the routes the till calls, against the seeded Reception Till
 * 1 (a kids band printer and an adult band printer on its box, no drop-off
 * one), with a ZZ TEST drop-off band printer registered on the same box and
 * assigned or unassigned per case.
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let boxId: string;
let twoHoursId: string;
let oneHourId: string;
let kidsPrinterId: string;
let adultPrinterId: string;
let dropoffPrinterId: string;
let pimId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  boxId = till!.boxId!;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  const devices = await ctx.db.select().from(device).where(eq(device.boxId, boxId));
  kidsPrinterId = devices.find((d) => d.label === 'Band Printer (kids)')!.id;
  adultPrinterId = devices.find((d) => d.label === 'Band Printer (adults)')!.id;
  const [pim] = await ctx.db.select().from(nanny).where(and(eq(nanny.branchId, branchId), eq(nanny.name, 'Pim')));
  pimId = pim!.id;
  // The seeded shifts follow the park's opening hours; the suite runs at any
  // hour, so Pim — the nanny these cases assign — gets a shift covering now.
  await ctx.db.insert(nannyShift).values({ id: newId(), operatorId, nannyId: pimId, branchId,
    startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000) });
  // The second band printer, on the till's own box — registered, not yet assigned.
  dropoffPrinterId = newId();
  await ctx.db.insert(device).values({
    id: dropoffPrinterId, operatorId, branchId, boxId, kind: 'band_printer', label: 'ZZ TEST Drop-off Band Printer',
    transport: 'simulated', address: '192.168.88.212:9100', model: '4B-2082A', protocol: 'tspl2', reachability: 'reachable', paperStatus: 'ok',
  });
  await takeStation(ctx.app, cookie, stationId);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

beforeEach(async () => {
  await unassignDropoffPrinter();
  await ctx.db.update(device).set({ reachability: 'reachable' }).where(eq(device.id, dropoffPrinterId));
});

// --- Helpers --------------------------------------------------------------------

async function assignDropoffPrinter() {
  await ctx.db.insert(stationDevice).values({ id: newId(), stationId, role: 'dropoff_band', deviceId: dropoffPrinterId });
}

async function unassignDropoffPrinter() {
  await ctx.db.delete(stationDevice).where(and(eq(stationDevice.stationId, stationId), eq(stationDevice.role, 'dropoff_band')));
}

function childBody(over: Record<string, unknown> = {}) {
  return { checkinId: newId(), name: 'Mint', ageYears: 6, service: 'drop_off', allergies: 'Peanuts', foodRestrictions: null,
    foodProvision: { mode: 'none', paidSatang: 0 }, ...over };
}

async function register(children: Record<string, unknown>[]) {
  const res = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie }, payload: {
    id: newId(), branchId, stationId, guardianName: 'ZZ TEST Ploy', guardianPhone: '0812345678', contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: ALL_CONFIRMATIONS, children } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; children: Array<{ id: string }> };
}

/** A finalised ticket sale: each named stay on its own drop-off line, plus the ordinary tickets asked for. */
async function paidSaleFor(stays: { checkinId: string; feeSatang: number; label?: string }[], extra: { kids?: number; adults?: number; packageId?: string } = {}) {
  const saleId = newId();
  const packageId = extra.packageId ?? twoHoursId;
  const lines: Record<string, unknown>[] = stays.map((s) => ({ id: s.checkinId, packageId, kids: 1, adults: 0,
    serviceFee: { label: s.label ?? 'Drop-off service', amountSatang: s.feeSatang } }));
  if (extra.kids || extra.adults) lines.push({ id: newId(), packageId, kids: extra.kids ?? 0, adults: extra.adults ?? 0, serviceFee: null });
  const commit = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload: { id: saleId, stationId, lines } });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload: {} });
  expect(fin.statusCode, fin.body).toBe(200);
  return { saleId, printing: fin.json().printing as { jobs: Array<{ id: string; kind: string; role: string | null; deviceId: string | null; status: string; subjectId: string | null }>; notes: string[] } };
}

async function checkInNow(saleId: string, entries: { checkinId: string; nannyId?: string | null }[]) {
  const res = await ctx.app.inject({ method: 'POST', url: '/checkin/check-in-now', headers: { cookie }, payload: { saleId, entries } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { bands: Array<{ id: string; checkinId: string }>; printJobs: Array<{ id: string; kind: string; role: string | null; deviceId: string | null; status: string; subjectId: string | null }> };
}

async function jobsOfBand(bandId: string) {
  return ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'band'), eq(printJob.subjectId, bandId))).orderBy(asc(printJob.queuedAt), asc(printJob.id));
}

async function commandOfJob(jobId: string) {
  const rows = await ctx.db.select().from(boxCommand).where(sql`${boxCommand.payload}->>'printJobId' = ${jobId}`);
  expect(rows).toHaveLength(1);
  return rows[0]!.payload as Record<string, unknown>;
}

async function bandOfStay(checkinId: string) {
  const [row] = await ctx.db.select({ bandId: checkin.bandId }).from(checkin).where(eq(checkin.id, checkinId));
  return row!.bandId!;
}

async function documentOf(jobId: string) {
  const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, jobId));
  const view = await buildPrintDocument(ctx.db, { boxId: row!.boxId, operatorId, branchId } as never, jobId);
  return view.job as { kind: string; data: Record<string, unknown> };
}

// --- Where a band prints ----------------------------------------------------------

describe('where a band prints', () => {
  it('with no drop-off band printer assigned: every kids band — dropped-off, nanny, ordinary — goes to the kids band printer, the adult band to the adult printer, as before', async () => {
    const reg = await register([childBody({ name: 'Mint' }), childBody({ name: 'Kai', ageYears: 3, service: 'nanny' })]);
    const [mint, kai] = reg.children.map((c) => c.id) as [string, string];
    const { saleId, printing } = await paidSaleFor([{ checkinId: mint, feeSatang: 22_500 }, { checkinId: kai, feeSatang: 66_000, label: 'Nanny (2h)' }], { kids: 1, adults: 1 });
    // The sale printed the ordinary child's and the adult's bands; the supervised children's wait for the check-in.
    const atSale = printing.jobs.filter((j) => j.kind.endsWith('wristband'));
    expect(atSale.map((j) => [j.kind, j.role, j.deviceId, j.status]).sort()).toEqual([
      ['adult_wristband', 'adult_band', adultPrinterId, 'queued'],
      ['kids_wristband', 'kids_band', kidsPrinterId, 'queued'],
    ]);
    const { printJobs } = await checkInNow(saleId, [{ checkinId: mint }, { checkinId: kai, nannyId: pimId }]);
    expect(printJobs.map((j) => [j.kind, j.role, j.deviceId, j.status])).toEqual([
      ['kids_wristband', 'kids_band', kidsPrinterId, 'queued'],
      ['kids_wristband', 'kids_band', kidsPrinterId, 'queued'],
    ]);
    // The fallback is the kids printer with the same paper: the DROP-OFF badge is on it.
    const mintBand = await bandOfStay(mint);
    const mintJob = printJobs.find((j) => j.subjectId === mintBand)!;
    const doc = await documentOf(mintJob.id);
    expect(doc.kind).toBe('kids_wristband');
    expect(doc.data).toMatchObject({ holderName: 'Mint', supervisionMode: 'DROP-OFF', allergy: 'Peanuts' });
    expect(await commandOfJob(mintJob.id)).toMatchObject({ kind: 'kids_wristband', role: 'kids_band', deviceId: kidsPrinterId, stationId, document: 'platform', subjectType: 'band', saleId });
  });

  it('with a drop-off band printer assigned: the dropped-off child’s band goes to it; the nanny child’s and the ordinary child’s stay on the kids printer, the adult’s on the adult printer', async () => {
    await assignDropoffPrinter();
    const reg = await register([childBody({ name: 'Mint' }), childBody({ name: 'Kai', ageYears: 3, service: 'nanny' })]);
    const [mint, kai] = reg.children.map((c) => c.id) as [string, string];
    const { saleId, printing } = await paidSaleFor([{ checkinId: mint, feeSatang: 22_500 }, { checkinId: kai, feeSatang: 66_000, label: 'Nanny (2h)' }], { kids: 1, adults: 1 });
    const atSale = printing.jobs.filter((j) => j.kind.endsWith('wristband'));
    expect(atSale.map((j) => [j.kind, j.role, j.deviceId]).sort()).toEqual([
      ['adult_wristband', 'adult_band', adultPrinterId],
      ['kids_wristband', 'kids_band', kidsPrinterId],
    ]);
    const { printJobs } = await checkInNow(saleId, [{ checkinId: mint }, { checkinId: kai, nannyId: pimId }]);
    const mintBand = await bandOfStay(mint);
    const kaiBand = await bandOfStay(kai);
    const mintJob = printJobs.find((j) => j.subjectId === mintBand)!;
    const kaiJob = printJobs.find((j) => j.subjectId === kaiBand)!;
    expect([mintJob.kind, mintJob.role, mintJob.deviceId, mintJob.status]).toEqual(['kids_wristband', 'dropoff_band', dropoffPrinterId, 'queued']);
    expect([kaiJob.kind, kaiJob.role, kaiJob.deviceId, kaiJob.status]).toEqual(['kids_wristband', 'kids_band', kidsPrinterId, 'queued']);

    // The box's command: the shape it has always had, with the role and the
    // printer as values — nothing new for a box from before this role to parse.
    const payload = await commandOfJob(mintJob.id);
    expect(Object.keys(payload).sort()).toEqual(['copies', 'deviceId', 'document', 'kind', 'printJobId', 'role', 'saleId', 'stationId', 'subjectType']);
    expect(payload).toMatchObject({ kind: 'kids_wristband', role: 'dropoff_band', deviceId: dropoffPrinterId, stationId, document: 'platform', subjectType: 'band', saleId });

    // The paper is the same whether or not the printer is assigned: the
    // document is built when it prints, and the role is routing, not layout.
    const assigned = await documentOf(mintJob.id);
    await unassignDropoffPrinter();
    const unassigned = await documentOf(mintJob.id);
    expect(assigned).toEqual(unassigned);
    expect(assigned.data).toMatchObject({ holderName: 'Mint', supervisionMode: 'DROP-OFF' });
  });

  it('a drop-off band printer that is assigned but not answering still takes the job — queued for the box to retry, as for any printer, never redirected', async () => {
    await assignDropoffPrinter();
    await ctx.db.update(device).set({ reachability: 'unreachable' }).where(eq(device.id, dropoffPrinterId));
    const reg = await register([childBody({ name: 'Mint' })]);
    const mint = reg.children[0]!.id;
    const { saleId } = await paidSaleFor([{ checkinId: mint, feeSatang: 22_500 }]);
    const { printJobs } = await checkInNow(saleId, [{ checkinId: mint }]);
    expect(printJobs.map((j) => [j.role, j.deviceId, j.status])).toEqual([['dropoff_band', dropoffPrinterId, 'queued']]);
  });
});

// --- Reprints pick the right printer for the band as it is now ---------------------

describe('a reprint picks each band’s printer by what the band is now', () => {
  it('History’s "Child bracelet" reprint: the dropped-off child’s copy on the drop-off printer, the ordinary child’s on the kids printer; after the stay becomes a nanny stay, the copy follows', async () => {
    const reg = await register([childBody({ name: 'Mint' })]);
    const mint = reg.children[0]!.id;
    const { saleId } = await paidSaleFor([{ checkinId: mint, feeSatang: 22_500 }], { kids: 1 });
    await checkInNow(saleId, [{ checkinId: mint }]);
    const mintBand = await bandOfStay(mint);
    await assignDropoffPrinter();

    const reprint = async () => {
      const res = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/reprints`, headers: { cookie }, payload: { kind: 'kids_bands', reason: 'ZZ TEST band tore' } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().jobs as Array<{ id: string; kind: string; role: string | null; deviceId: string | null; subjectId: string | null; reprintOf: string | null; reprintReason: string | null }>;
    };
    const first = await reprint();
    expect(first).toHaveLength(2);
    const mintCopy = first.find((j) => j.subjectId === mintBand)!;
    const otherCopy = first.find((j) => j.subjectId !== mintBand)!;
    expect([mintCopy.role, mintCopy.deviceId, mintCopy.reprintReason]).toEqual(['dropoff_band', dropoffPrinterId, 'ZZ TEST band tore']);
    expect([otherCopy.role, otherCopy.deviceId]).toEqual(['kids_band', kidsPrinterId]);
    expect(mintCopy.reprintOf).not.toBeNull();

    // The stay is moved to the nanny service: the band is a nanny child's now, and its next copy says so.
    const moved = await ctx.app.inject({ method: 'PATCH', url: `/checkin/checkins/${mint}`, headers: { cookie }, payload: { service: 'nanny', nannyId: pimId } });
    expect(moved.statusCode, moved.body).toBe(200);
    const second = await reprint();
    const mintAgain = second.find((j) => j.subjectId === mintBand)!;
    expect([mintAgain.role, mintAgain.deviceId]).toEqual(['kids_band', kidsPrinterId]);
    expect((await documentOf(mintAgain.id)).data).toMatchObject({ supervisionMode: 'NANNY', assignedNannyName: 'Pim' });
  });
});

// --- An Add time prints the extended bands again ----------------------------------

describe('an Add time prints the extended bands again, with the new leave time', () => {
  async function admission(packageId: string, kids: number, adults: number) {
    const id = newId();
    const made = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload: { stationId, id, lines: [{ id: newId(), packageId, kids, adults }] } });
    expect(made.statusCode, made.body).toBe(200);
    const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(closed.statusCode, closed.body).toBe(200);
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, id)).orderBy(asc(band.createdAt), asc(band.id));
    return { id, bands };
  }

  async function extend(sourceId: string, optionId: string, bandIds: string[]) {
    const made = await ctx.app.inject({ method: 'POST', url: `/sales/${sourceId}/extensions`, headers: { cookie },
      payload: { actionId: newId(), stationId, optionId, selection: { mode: 'bands', bandIds } } });
    expect(made.statusCode, made.body).toBe(200);
    return made.json() as { sale: { id: string }; extension: { id: string } };
  }

  async function bandDocument(saleId: string, bandId: string, kind: 'kids_wristband' | 'adult_wristband') {
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const snapshot = await salePrintSnapshotOf(ctx.db, saleRow!);
    return salePrintDocumentOf(snapshot, { kind, subjectType: 'band', subjectId: bandId }, false)!.data as { duration?: string };
  }

  /** "16:05" → "17:05": the leave time an hour later, as the band's words have it. */
  function plusMinutes(validUntil: string, minutes: number): string {
    const [h, m] = validUntil.split(':').map(Number) as [number, number];
    const total = (h * 60 + m + minutes) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  it('the kid’s and the adult’s bands print again at the till that took the money, each on its own printer, reading an hour later', async () => {
    const source = await admission(oneHourId, 1, 1);
    const kid = source.bands.find((b) => b.kind === 'kid')!;
    const adult = source.bands.find((b) => b.kind === 'adult')!;
    const before = await bandDocument(source.id, kid.id, 'kids_wristband');
    const validUntil = before.duration!.match(/valid until (\d\d:\d\d)$/)![1]!;
    const label = before.duration!.replace(/ · valid until .*$/, '');

    const made = await extend(source.id, 'ext-60', [kid.id, adult.id]);
    // Not paid yet: nothing printed again, nothing moved.
    expect(await jobsOfBand(kid.id)).toHaveLength(1);
    expect((await bandDocument(source.id, kid.id, 'kids_wristband')).duration).toBe(before.duration);

    const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${made.sale.id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(closed.statusCode, closed.body).toBe(200);
    const answer = closed.json() as { printing: { jobs: Array<{ id: string; kind: string; role: string | null; deviceId: string | null; subjectType: string | null; subjectId: string | null; reprintOf: string | null; reprintReason: string | null; status: string }>; notes: string[] } };
    const copies = answer.printing.jobs.filter((j) => j.subjectType === 'band');
    expect(copies.map((j) => [j.kind, j.role, j.deviceId, j.subjectId, j.status, j.reprintReason]).sort()).toEqual([
      ['adult_wristband', 'adult_band', adultPrinterId, adult.id, 'queued', 'Extra time added (+60 min)'],
      ['kids_wristband', 'kids_band', kidsPrinterId, kid.id, 'queued', 'Extra time added (+60 min)'],
    ]);
    expect(answer.printing.notes).toEqual([]);
    // Each copy names the band's original print, and the band says it was printed again.
    const kidCopy = copies.find((j) => j.subjectId === kid.id)!;
    expect(kidCopy.reprintOf).toBe(kid.printedJobId);
    const events = await ctx.db.select().from(bandEvent).where(and(eq(bandEvent.bandId, kid.id), eq(bandEvent.kind, 'reprinted')));
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ printJobId: kidCopy.id, reason: 'Extra time added (+60 min)' });
    // The receipt of the charge comes before the bands on the box's queue.
    const receipt = answer.printing.jobs.find((j) => j.kind === 'receipt')!;
    const [receiptRow] = await ctx.db.select().from(printJob).where(eq(printJob.id, receipt.id));
    const [kidRow] = await ctx.db.select().from(printJob).where(eq(printJob.id, kidCopy.id));
    expect(kidRow!.queuedAt.getTime()).toBeGreaterThan(receiptRow!.queuedAt.getTime());

    // The paper the copy prints: the added hour, and the leave time an hour later.
    const after = await documentOf(kidCopy.id);
    expect(after.data.duration).toBe(`${label} + 1 hour · valid until ${plusMinutes(validUntil, 60)}`);
    const adultAfter = await documentOf(copies.find((j) => j.subjectId === adult.id)!.id);
    expect(adultAfter.data.duration).toMatch(/\+ 1 hour · valid until /);
    // A replayed finalise prints nothing again.
    const again = await ctx.app.inject({ method: 'POST', url: `/sales/${made.sale.id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(again.statusCode).toBe(200);
    expect(await jobsOfBand(kid.id)).toHaveLength(2);
  });

  it('a second hour later reads both, and a dropped-off child’s copy goes to the drop-off printer', async () => {
    await assignDropoffPrinter();
    const reg = await register([childBody({ name: 'Mint' })]);
    const mint = reg.children[0]!.id;
    const { saleId } = await paidSaleFor([{ checkinId: mint, feeSatang: 22_500 }], { adults: 1, packageId: oneHourId });
    await checkInNow(saleId, [{ checkinId: mint }]);
    const mintBand = await bandOfStay(mint);
    const before = await bandDocument(saleId, mintBand, 'kids_wristband');
    const validUntil = before.duration!.match(/valid until (\d\d:\d\d)$/)![1]!;

    const first = await extend(saleId, 'ext-60', [mintBand]);
    expect((await ctx.app.inject({ method: 'POST', url: `/sales/${first.sale.id}/finalise`, headers: { cookie }, payload: { actionId: newId() } })).statusCode).toBe(200);
    const second = await extend(saleId, 'ext-120', [mintBand]);
    const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${second.sale.id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(closed.statusCode, closed.body).toBe(200);

    const jobs = await jobsOfBand(mintBand);
    expect(jobs.map((j) => [j.role, j.deviceId, j.reprintReason])).toEqual([
      ['dropoff_band', dropoffPrinterId, null],
      ['dropoff_band', dropoffPrinterId, 'Extra time added (+60 min)'],
      ['dropoff_band', dropoffPrinterId, 'Extra time added (+120 min)'],
    ]);
    const latest = await documentOf(jobs[2]!.id);
    expect(latest.data).toMatchObject({ holderName: 'Mint', supervisionMode: 'DROP-OFF' });
    expect(latest.data.duration).toMatch(new RegExp(` \\+ 3 hours · valid until ${plusMinutes(validUntil, 180)}$`));
  });

  it('a selected band replaced and reselected before the charge is paid: the replacement gets the copy, the replaced band none', async () => {
    const source = await admission(oneHourId, 2, 1);
    const [first, second] = source.bands.filter((b) => b.kind === 'kid');
    const adult = source.bands.find((b) => b.kind === 'adult')!;
    const made = await extend(source.id, 'ext-60', [first!.id, adult.id]);
    // The first child's band is replaced at the till before the charge is
    // paid, and staff choose the replacement bracelet ("Choose the
    // replacement bracelets"): the ledger row moves, the selection does not.
    await ctx.db.update(band).set({ status: 'replaced' }).where(eq(band.id, first!.id));
    const repaired = await ctx.app.inject({ method: 'POST', url: `/sales/${source.id}/extensions/${made.extension.id}/bands`, headers: { cookie },
      payload: { actionId: newId(), stationId, bandIds: [second!.id, adult.id] } });
    expect(repaired.statusCode, repaired.body).toBe(200);

    const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${made.sale.id}/finalise`, headers: { cookie }, payload: { actionId: newId() } });
    expect(closed.statusCode, closed.body).toBe(200);
    const answer = closed.json() as { finalised: boolean; printing: { jobs: Array<{ kind: string; role: string | null; deviceId: string | null; subjectType: string | null; subjectId: string | null; reprintOf: string | null; reprintReason: string | null }>; notes: string[] } };
    expect(answer.finalised).toBe(true);
    const copies = answer.printing.jobs.filter((j) => j.subjectType === 'band');
    expect(copies.map((j) => [j.kind, j.role, j.deviceId, j.subjectId, j.reprintOf, j.reprintReason]).sort()).toEqual([
      ['adult_wristband', 'adult_band', adultPrinterId, adult.id, adult.printedJobId, 'Extra time added (+60 min)'],
      ['kids_wristband', 'kids_band', kidsPrinterId, second!.id, second!.printedJobId, 'Extra time added (+60 min)'],
    ]);
    expect(answer.printing.notes).toEqual([]);
    // The replaced band keeps only its first print; the replacement reads the added hour.
    expect(await jobsOfBand(first!.id)).toHaveLength(1);
    const secondJobs = await jobsOfBand(second!.id);
    expect(secondJobs).toHaveLength(2);
    expect((await documentOf(secondJobs[1]!.id)).data.duration).toMatch(/\+ 1 hour · valid until /);
  });

  it('a voided extension charge prints nothing again, and the band goes back to its old time', async () => {
    const source = await admission(oneHourId, 1, 1);
    const kid = source.bands.find((b) => b.kind === 'kid')!;
    const before = await bandDocument(source.id, kid.id, 'kids_wristband');
    const made = await extend(source.id, 'ext-60', [kid.id]);
    const voided = await ctx.app.inject({ method: 'POST', url: `/sales/${made.sale.id}/void`, headers: { cookie }, payload: { reason: 'ZZ TEST changed their mind' } });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await jobsOfBand(kid.id)).toHaveLength(1);
    expect((await bandDocument(source.id, kid.id, 'kids_wristband')).duration).toBe(before.duration);
  });
});
