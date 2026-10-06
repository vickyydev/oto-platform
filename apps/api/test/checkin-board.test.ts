import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, branch, checkin, child, confirmationItem, member, nanny, nannyShift, sale, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { filterBoard, type BoardFamily } from '../src/services/checkin';
import { liveOccupancy } from '../src/services/occupancy';
import {
  BRANCH_MANAGER,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-13 round 2 — THE BOARD (plan docs/progress/plans/checkin/PLAN.md §2.3),
 * driven through the routes the DropOff page calls where the prototype called
 * `getCheckIns`, `updateCheckIn`, `assignNanny`, `checkInFamilyBooked` and the
 * connection-check mutators, and the admin panels' config routes.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let chalongManager: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let pimId: string;
let jumId: string;
let aorId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const roster = await ctx.db.select().from(nanny).where(eq(nanny.branchId, branchId));
  pimId = roster.find((n) => n.name === 'Pim')!.id;
  jumId = roster.find((n) => n.name === 'Jum')!.id;
  aorId = roster.find((n) => n.name === 'Aor')!.id;
  // The seeded shifts follow the park's opening hours; the suite runs at any
  // hour, so Pim and Jum get a shift covering now, and Aor — off the rota in
  // the prototype — keeps none.
  const now = Date.now();
  for (const id of [pimId, jumId]) {
    await ctx.db.insert(nannyShift).values({
      id: newId(),
      operatorId,
      nannyId: id,
      branchId,
      startsAt: new Date(now - 3_600_000),
      endsAt: new Date(now + 3_600_000),
    });
  }
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------------

function childBody(over: Record<string, unknown> = {}) {
  return {
    checkinId: newId(),
    name: 'Mint',
    ageYears: 6,
    service: 'drop_off',
    allergies: null,
    foodRestrictions: null,
    foodProvision: { mode: 'none', paidSatang: 0 },
    ...over,
  };
}

async function register(children: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id: newId(),
      branchId,
      stationId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children,
      ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; children: { id: string }[] };
}

async function paidSaleFor(stays: { checkinId: string; feeSatang: number }[]): Promise<string> {
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId,
      lines: stays.map((s) => ({
        id: s.checkinId,
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: s.feeSatang },
      })),
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(fin.statusCode, fin.body).toBe(200);
  return saleId;
}

async function checkInNow(saleId: string, entries: { checkinId: string; nannyId?: string }[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie: reception },
    payload: { saleId, entries },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function leaveAsBooked(saleId: string, checkinIds: string[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/leave-as-booked',
    headers: { cookie: reception },
    payload: { saleId, scheduledFor: new Date(Date.now() + 30 * 60_000).toISOString(), entries: checkinIds.map((checkinId) => ({ checkinId })) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function board(query = '') {
  const res = await ctx.app.inject({ method: 'GET', url: `/checkin/board?branchId=${branchId}${query}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    families: BoardFamily[];
    counts: { registered: number; in_park: number; out: number };
    unconfirmedFamilies: number;
    nannies: { id: string; name: string; onShift: boolean; load: number }[];
    nannyRatioSoftMax: number;
  };
}

async function patch(id: string, body: Record<string, unknown>, cookie = reception) {
  return ctx.app.inject({ method: 'PATCH', url: `/checkin/checkins/${id}`, headers: { cookie }, payload: body });
}

async function auditOf(entityType: string, entityId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
    .orderBy(auditLog.createdAt, auditLog.id);
}

async function stay(id: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
  return row!;
}

// --- The seeded families ------------------------------------------------------------

let inParkReg: { id: string; children: { id: string }[] };
let waitingReg: { id: string; children: { id: string }[] };
let bookedReg: { id: string; children: { id: string }[] };
let bookedSaleId: string;

describe('GET /checkin/board', () => {
  beforeAll(async () => {
    // One drop-off child in the park now.
    inParkReg = await register([childBody({ name: 'Somchai', ageYears: 6 })], { guardianName: 'Nok', guardianPhone: '0811110001' });
    await checkInNow(await paidSaleFor([{ checkinId: inParkReg.children[0]!.id, feeSatang: 22_500 }]), [{ checkinId: inParkReg.children[0]!.id }]);
    // A walk-in registered at the gate, not paid yet.
    waitingReg = await register([childBody({ name: 'Ann', ageYears: 7 })], { guardianName: 'Lek', guardianPhone: '0811110002' });
    // A family left as booked: a drop-off child and a nanny child.
    bookedReg = await register(
      [childBody({ name: 'Ben', ageYears: 6 }), childBody({ name: 'Bua', ageYears: 3, service: 'nanny' })],
      { guardianName: 'Dao', guardianPhone: '0811110003' },
    );
    bookedSaleId = await paidSaleFor(bookedReg.children.map((c) => ({ checkinId: c.id, feeSatang: 22_500 })));
    await leaveAsBooked(bookedSaleId, bookedReg.children.map((c) => c.id));
  });

  it('groups children by registration, under their family tab, with per-child counts', async () => {
    const b = await board();
    const fam = (id: string) => b.families.find((f) => f.registrationId === id)!;
    expect(fam(inParkReg.id)).toMatchObject({ tab: 'in_park', guardianName: 'Nok', guardianPhone: '+66811110001' });
    expect(fam(waitingReg.id).tab).toBe('registered');
    expect(fam(bookedReg.id).tab).toBe('registered');
    expect(fam(bookedReg.id).children.map((c) => c.childName).sort()).toEqual(['Ben', 'Bua']);
    expect(fam(bookedReg.id).children.every((c) => !!c.scheduledFor && !!c.saleId)).toBe(true);
    expect(b.counts.in_park).toBeGreaterThanOrEqual(1);
    expect(b.counts.registered).toBeGreaterThanOrEqual(3);
    // Every seeded family is unconfirmed: no connection check has been answered.
    expect(b.unconfirmedFamilies).toBeGreaterThanOrEqual(3);
    expect(b.nannies.find((n) => n.name === 'Aor')!.onShift).toBe(false);
    expect(b.nannies.find((n) => n.name === 'Pim')!.onShift).toBe(true);
  });

  it('filters by tab, service, search and the unconfirmed flag, and sorts upcoming by booked start', async () => {
    const inPark = await board('&tab=in_park');
    expect(inPark.families.every((f) => f.tab === 'in_park')).toBe(true);
    expect(inPark.families.some((f) => f.registrationId === inParkReg.id)).toBe(true);

    const nannies = await board('&service=nanny');
    expect(nannies.families.map((f) => f.registrationId)).toContain(bookedReg.id);
    expect(nannies.families.map((f) => f.registrationId)).not.toContain(waitingReg.id);

    const search = await board('&q=lek');
    expect(search.families.map((f) => f.registrationId)).toEqual([waitingReg.id]);
    const byChild = await board('&q=bua');
    expect(byChild.families.map((f) => f.registrationId)).toEqual([bookedReg.id]);

    const upcoming = await board('&tab=registered');
    const ids = upcoming.families.map((f) => f.registrationId);
    // The booked family (a start time) sorts before the walk-in with none.
    expect(ids.indexOf(bookedReg.id)).toBeLessThan(ids.indexOf(waitingReg.id));
  });

  it("the due filter keeps In Park families with a child inside 15 minutes or over (the till banner's ?due=1)", () => {
    const now = Date.parse('2026-10-01T10:00:00Z');
    const fam = (id: string, checkedInMinutesAgo: number, booked: number): BoardFamily => ({
      registrationId: id,
      branchId,
      memberId: null,
      guardianName: id,
      guardianPhone: null,
      contactChannel: 'whatsapp',
      consentRecordedAt: null,
      source: 'till',
      photoFileId: null,
      createdAt: new Date(now).toISOString(),
      contact: { status: 'confirmed', sentAt: null, confirmedAt: null },
      tab: 'in_park',
      children: [
        {
          id: `${id}-c`,
          registrationId: id,
          childId: null,
          childName: id,
          childAgeYears: 6,
          dateOfBirth: null,
          allergies: null,
          foodRestrictions: null,
          mayOrderFood: false,
          foodProvision: null,
          service: 'drop_off',
          status: 'in_park',
          scheduledFor: null,
          bookedMinutes: booked,
          nannyId: null,
          checkedInAt: new Date(now - checkedInMinutesAgo * 60_000).toISOString(),
          saleId: null,
          bandId: null,
          visitId: null,
          photoFileId: null,
          nannyName: null,
          checkedOutAt: null,
        },
      ],
    });
    const families = [fam('fresh', 10, 120), fam('soon', 110, 120), fam('over', 130, 120)];
    const due = filterBoard(families, { tab: 'in_park', due: true }, now);
    // Overdue first (least time left), then due soon; the fresh one is not due.
    expect(due.map((f) => f.registrationId)).toEqual(['over', 'soon']);
    expect(filterBoard(families, { tab: 'in_park' }, now).map((f) => f.registrationId)).toEqual(['over', 'soon', 'fresh']);
  });

  it("refuses another park's manager", async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/checkin/board?branchId=${branchId}`, headers: { cookie: chalongManager } });
    expect(res.statusCode).toBe(403);
  });
});

// --- The audited PATCH and its history -----------------------------------------------

describe('PATCH /checkin/checkins/:id', () => {
  it('audits every field with before and after, and the history view reads them back', async () => {
    const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
    const [saved] = await ctx.db.select().from(child).where(eq(child.memberId, mali!.id)).limit(1);
    const reg = await register([childBody({ childId: saved!.id, name: saved!.name, ageYears: 6 })], {
      memberId: mali!.id,
      guardianName: 'Mali',
      guardianPhone: '0811110010',
    });
    const id = reg.children[0]!.id;
    await checkInNow(await paidSaleFor([{ checkinId: id, feeSatang: 22_500 }]), [{ checkinId: id }]);

    const res = await patch(id, {
      childName: 'Mali Junior',
      childAgeYears: 4,
      service: 'nanny',
      bookedMinutes: 180,
      mayOrderFood: true,
      foodRestrictions: 'Vegetarian',
      allergies: 'Peanuts',
      nannyId: pimId,
      guardianName: 'Mali S.',
      guardianPhone: '0811110011',
      contactChannel: 'line',
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.changed).toBe(11);
    expect(body.checkin).toMatchObject({
      childName: 'Mali Junior',
      childAgeYears: 4,
      service: 'nanny',
      bookedMinutes: 180,
      mayOrderFood: true,
      foodRestrictions: 'Vegetarian',
      allergies: 'Peanuts',
      nannyId: pimId,
      nannyName: 'Pim',
    });
    // A new phone and channel sent a fresh connection check.
    expect(body.contact).toMatchObject({ status: 'pending' });

    const rows = await auditOf('checkin', id);
    const edit = rows.find((r) => (r.after as { event?: string }).event === 'edit')!;
    expect(edit.action).toBe('checkin.update');
    expect(edit.before).toMatchObject({
      childName: saved!.name,
      childAgeYears: 6,
      service: 'drop_off',
      bookedMinutes: 120,
      mayOrderFood: false,
      foodRestrictions: null,
      allergies: null,
      nannyId: null,
      nannyName: null,
    });
    expect(edit.after).toMatchObject({
      childName: 'Mali Junior',
      childAgeYears: 4,
      service: 'nanny',
      bookedMinutes: 180,
      mayOrderFood: true,
      foodRestrictions: 'Vegetarian',
      allergies: 'Peanuts',
      nannyId: pimId,
      nannyName: 'Pim',
    });
    const regRows = await auditOf('registration', reg.id);
    const regEdit = regRows.find((r) => r.action === 'registration.update')!;
    expect(regEdit.before).toMatchObject({ guardianName: 'Mali', guardianPhone: '+66811110010', contactChannel: 'whatsapp' });
    expect(regEdit.after).toMatchObject({ guardianName: 'Mali S.', guardianPhone: '+66811110011', contactChannel: 'line' });
    // The saved child follows the edit, and says so.
    const [childAfter] = await ctx.db.select().from(child).where(eq(child.id, saved!.id));
    expect(childAfter).toMatchObject({ name: 'Mali Junior', ageYears: 4, allergies: 'Peanuts', foodRestrictions: 'Vegetarian' });
    expect((await auditOf('child', saved!.id)).some((r) => r.action === 'child.update')).toBe(true);

    const history = await ctx.app.inject({ method: 'GET', url: `/checkin/checkins/${id}/history`, headers: { cookie: reception } });
    expect(history.statusCode, history.body).toBe(200);
    const entries = history.json().entries as { field: string; oldValue: string; newValue: string; changedBy: string }[];
    // The till's check-in is in the history too (booked play time — → 120 min); the edit is the latest entry per field.
    expect(entries.filter((e) => e.field === 'Booked play time').map((e) => e.newValue)).toEqual(['120 min', '180 min']);
    const of = (field: string) => entries.findLast((e) => e.field === field);
    expect(of('Child name')).toMatchObject({ oldValue: saved!.name, newValue: 'Mali Junior' });
    expect(of('Age')).toMatchObject({ oldValue: '6', newValue: '4' });
    expect(of('Service')).toMatchObject({ oldValue: 'Drop-Off', newValue: 'Nanny' });
    expect(of('Booked play time')).toMatchObject({ oldValue: '120 min', newValue: '180 min' });
    expect(of('May order food')).toMatchObject({ oldValue: 'No', newValue: 'Yes' });
    expect(of('Food restrictions')).toMatchObject({ oldValue: '—', newValue: 'Vegetarian' });
    expect(of('Allergies / medical')).toMatchObject({ oldValue: '—', newValue: 'Peanuts' });
    expect(of('Nanny')).toMatchObject({ oldValue: '—', newValue: 'Pim' });
    expect(of('Parent name')).toMatchObject({ oldValue: 'Mali', newValue: 'Mali S.' });
    expect(of('Phone')).toMatchObject({ oldValue: '+66811110010', newValue: '+66811110011' });
    expect(of('Contact method')).toMatchObject({ oldValue: 'whatsapp', newValue: 'line' });
    expect(entries.every((e) => e.changedBy.length > 0)).toBe(true);

    // Nothing changed is nothing written.
    const before = (await auditOf('checkin', id)).length;
    const same = await patch(id, { bookedMinutes: 180 });
    expect(same.json().changed).toBe(0);
    expect((await auditOf('checkin', id)).length).toBe(before);
  });

  it('leaving the nanny service releases her', async () => {
    const reg = await register([childBody({ name: 'Tan', ageYears: 3, service: 'nanny' })]);
    const id = reg.children[0]!.id;
    expect((await ctx.app.inject({ method: 'POST', url: `/checkin/checkins/${id}/nanny`, headers: { cookie: reception }, payload: { nannyId: jumId } })).statusCode).toBe(200);
    const res = await patch(id, { service: 'drop_off' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stay(id)).toMatchObject({ service: 'drop_off', nannyId: null });
  });
});

// --- Nanny on shift; the ratio is a warning ------------------------------------------

describe('POST /checkin/checkins/:id/nanny', () => {
  it('refuses a nanny who is not on shift, in the counter\'s words', async () => {
    const reg = await register([childBody({ name: 'Kit', ageYears: 2, service: 'nanny' })]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/checkins/${reg.children[0]!.id}/nanny`,
      headers: { cookie: reception },
      payload: { nannyId: aorId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'NANNY_NOT_ON_SHIFT' });
    expect(res.json().error.message).toContain('Aor is not on shift');
    expect((await stay(reg.children[0]!.id)).nannyId).toBeNull();
    // The PATCH holds the same rule.
    const viaEdit = await patch(reg.children[0]!.id, { nannyId: aorId });
    expect(viaEdit.statusCode).toBe(409);
    expect(viaEdit.json().error.code).toBe('NANNY_NOT_ON_SHIFT');
  });

  it('over the soft ratio is a warning, never a block', async () => {
    const setRatio = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/pricing?branchId=${branchId}`,
      headers: { cookie: manager },
      payload: {
        oneTimeFee: { weekday: 22_500, weekend: 22_500 },
        nannyHourly: { weekday: 33_000, weekend: 33_000 },
        extraHour: { weekday: 30_000, weekend: 30_000 },
        fullDayHours: 8,
        nannyRatioSoftMax: 1,
        prepaidFoodUnused: 'refund',
      },
    });
    expect(setRatio.statusCode, setRatio.body).toBe(200);
    try {
      const reg = await register([
        childBody({ name: 'Pea', ageYears: 2, service: 'nanny' }),
        childBody({ name: 'Pond', ageYears: 3, service: 'nanny' }),
      ]);
      const [a, b] = reg.children;
      // Jum may already cover a child from another test; the second of these is over 1 either way.
      await ctx.app.inject({ method: 'POST', url: `/checkin/checkins/${a!.id}/nanny`, headers: { cookie: reception }, payload: { nannyId: jumId } });
      const second = await ctx.app.inject({ method: 'POST', url: `/checkin/checkins/${b!.id}/nanny`, headers: { cookie: reception }, payload: { nannyId: jumId } });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().warnings[0]).toMatch(/Jum would be looking after \d+ children \(over the suggested 1\)/);
      expect((await stay(b!.id)).nannyId).toBe(jumId);
    } finally {
      await ctx.app.inject({
        method: 'PUT',
        url: `/checkin/config/pricing?branchId=${branchId}`,
        headers: { cookie: manager },
        payload: {
          oneTimeFee: { weekday: 22_500, weekend: 22_500 },
          nannyHourly: { weekday: 33_000, weekend: 33_000 },
          extraHour: { weekday: 30_000, weekend: 30_000 },
          fullDayHours: 8,
          nannyRatioSoftMax: 3,
          prepaidFoodUnused: 'refund',
        },
      });
    }
  });
});

// --- Booked check-in: never a sale ---------------------------------------------------

describe('POST /checkin/check-in-booked', () => {
  it('checks a booked family in with bands on the sale they paid on, and writes no sale', async () => {
    const reg = await register(
      [childBody({ name: 'Fon', ageYears: 6 }), childBody({ name: 'Fai', ageYears: 3, service: 'nanny' })],
      { guardianName: 'Joy' },
    );
    const saleId = await paidSaleFor(reg.children.map((c) => ({ checkinId: c.id, feeSatang: 22_500 })));
    await leaveAsBooked(saleId, reg.children.map((c) => c.id));
    const salesBefore = (await ctx.db.select({ id: sale.id }).from(sale)).length;

    // The nanny child needs an on-shift nanny before anyone goes in.
    const offShift = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: reg.children[0]!.id }, { checkinId: reg.children[1]!.id, nannyId: aorId }] },
    });
    expect(offShift.statusCode).toBe(409);
    expect(offShift.json().error.code).toBe('NANNY_NOT_ON_SHIFT');
    expect((await stay(reg.children[0]!.id)).status).toBe('registered');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: reg.children[0]!.id }, { checkinId: reg.children[1]!.id, nannyId: pimId }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().bands).toHaveLength(2);
    expect((await ctx.db.select({ id: sale.id }).from(sale)).length).toBe(salesBefore);
    const rows = await ctx.db.select().from(checkin).where(inArray(checkin.id, reg.children.map((c) => c.id)));
    expect(rows.every((r) => r.status === 'in_park' && r.saleId === saleId && !!r.bandId && r.scheduledFor === null)).toBe(true);
    expect(rows.find((r) => r.childName === 'Fai')!.nannyId).toBe(pimId);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(2);
    const audits = await auditOf('checkin', reg.children[0]!.id);
    expect(audits.some((a) => (a.after as { event?: string }).event === 'check_in_booked')).toBe(true);
  });

  it('refuses a child who was never paid for — that is the till\'s job', async () => {
    const reg = await register([childBody({ name: 'Nam', ageYears: 6 })]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: reg.children[0]!.id }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_NOT_BOOKED');
  });
});

// --- Occupancy: the drop-off term (OD-A1) ----------------------------------------------

describe('occupancy — the drop-off term', () => {
  it('counts a drop-off child with no adult while their check-in is in the park, and not after', async () => {
    const before = await liveOccupancy(ctx.db, { operatorId, branchId });
    const reg = await register([childBody({ name: 'Solo', ageYears: 6 })]);
    const id = reg.children[0]!.id;
    await checkInNow(await paidSaleFor([{ checkinId: id, feeSatang: 22_500 }]), [{ checkinId: id }]);
    const inside = await liveOccupancy(ctx.db, { operatorId, branchId });
    expect(inside.kids).toBe(before.kids + 1);
    expect(inside.adults).toBe(before.adults);
    // Collected (round 3 writes the release; the stay's status is what counts).
    await ctx.db.update(checkin).set({ status: 'out', checkedOutAt: new Date() }).where(eq(checkin.id, id));
    const after = await liveOccupancy(ctx.db, { operatorId, branchId });
    expect(after.kids).toBe(before.kids);
  });

  it('the Today count reads the stays', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/checkin/today?branchId=${branchId}`, headers: { cookie: reception } });
    expect(res.statusCode, res.body).toBe(200);
    const inPark = await ctx.db.select({ id: checkin.id }).from(checkin).where(and(eq(checkin.branchId, branchId), eq(checkin.status, 'in_park')));
    expect(res.json().inPark).toBe(inPark.length);
  });
});

// --- The contact-channel chip (R-95) --------------------------------------------------

describe('the contact-channel test', () => {
  it('sends, confirms, and fails, each an audit row the board reads back', async () => {
    const reg = await register([childBody({ name: 'Chip', ageYears: 6 })], { guardianName: 'Wan' });
    const famOf = async () => (await board()).families.find((f) => f.registrationId === reg.id)!;
    expect((await famOf()).contact).toMatchObject({ status: 'pending' });

    const sent = await ctx.app.inject({ method: 'POST', url: `/checkin/registrations/${reg.id}/contact-test`, headers: { cookie: reception } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await famOf()).contact).toMatchObject({ status: 'pending' });

    const ok = await ctx.app.inject({ method: 'POST', url: `/checkin/registrations/${reg.id}/contact-status`, headers: { cookie: reception }, payload: { status: 'confirmed' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await famOf()).contact).toMatchObject({ status: 'confirmed' });
    expect((await board('&unconfirmed=1')).families.map((f) => f.registrationId)).not.toContain(reg.id);

    const failed = await ctx.app.inject({ method: 'POST', url: `/checkin/registrations/${reg.id}/contact-status`, headers: { cookie: reception }, payload: { status: 'failed' } });
    expect(failed.statusCode).toBe(200);
    expect((await famOf()).contact).toMatchObject({ status: 'failed' });
    const rows = (await auditOf('registration', reg.id)).filter((r) => r.action === 'registration.contact');
    expect(rows.map((r) => (r.after as { status: string }).status)).toEqual(['pending', 'pending', 'confirmed', 'failed']);
  });
});

// --- The admin panels' config, audited -------------------------------------------------

describe('supervision config CRUD', () => {
  it('saves the policy, the confirmations and the pricing, each audited, and refuses reception', async () => {
    const refused = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/policy?branchId=${branchId}`,
      headers: { cookie: reception },
      payload: { bands: [], siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true } },
    });
    expect(refused.statusCode).toBe(403);

    const gap = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/policy?branchId=${branchId}`,
      headers: { cookie: manager },
      payload: {
        bands: [
          { id: 'b1', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
          { id: 'b3', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
        ],
        siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
      },
    });
    expect(gap.statusCode).toBe(400);
    expect(gap.json().error.message).toContain('Gap between ages 4 and 9');

    const policy = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/policy?branchId=${branchId}`,
      headers: { cookie: manager },
      payload: {
        bands: [
          { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
          { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
          { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
        ],
        siblingWaiver: { enabled: true, guardianMinAge: 10, waivableRequirement: 'drop_off', staffOnly: true },
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().policy.siblingWaiver.guardianMinAge).toBe(10);
    const policyAudit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'supervision_policy.update'), eq(auditLog.branchId, branchId)));
    expect(policyAudit.at(-1)!.before).toMatchObject({ siblingWaiver: { guardianMinAge: 9 } });
    expect(policyAudit.at(-1)!.after).toMatchObject({ siblingWaiver: { guardianMinAge: 10 } });

    const confirmations = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/confirmations?branchId=${branchId}`,
      headers: { cookie: manager },
      payload: {
        items: [
          { id: 'confirm-15min', text: 'I will remain within 10 minutes of the venue', required: true, order: 0 },
          { id: 'confirm-evac', text: 'I acknowledge the emergency evacuation point', required: true, order: 1 },
          { id: 'confirm-photo', text: 'I agree to the pickup photo', required: false, order: 2 },
        ],
      },
    });
    expect(confirmations.statusCode, confirmations.body).toBe(200);
    expect(confirmations.json().policy.confirmations.map((c: { id: string }) => c.id)).toEqual(['confirm-15min', 'confirm-evac', 'confirm-photo']);
    const items = await ctx.db.select().from(confirmationItem).where(eq(confirmationItem.branchId, branchId));
    expect(items.find((i) => i.code === 'confirm-no-refund')!.archivedAt).not.toBeNull();
    const itemActions = (
      await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'confirmation_item'), eq(auditLog.branchId, branchId)))
    ).map((a) => a.action);
    expect(itemActions).toEqual(expect.arrayContaining(['confirmation_item.update', 'confirmation_item.archive', 'confirmation_item.create']));

    const pricing = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/pricing?branchId=${branchId}`,
      headers: { cookie: manager },
      payload: {
        oneTimeFee: { weekday: 25_000, weekend: 30_000 },
        nannyHourly: { weekday: 33_000, weekend: 35_000 },
        extraHour: { weekday: 30_000, weekend: 30_000 },
        fullDayHours: 8,
        nannyRatioSoftMax: 3,
        prepaidFoodUnused: 'forfeit',
      },
    });
    expect(pricing.statusCode, pricing.body).toBe(200);
    expect(pricing.json().pricing).toMatchObject({ oneTimeFee: { weekday: 25_000, weekend: 30_000 }, prepaidFoodUnused: 'forfeit' });
    const priceAudit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'drop_off_pricing.update'), eq(auditLog.branchId, branchId)));
    expect(priceAudit.at(-1)!.before).toMatchObject({ oneTimeFee: { weekday: 22_500 } });
    expect(priceAudit.at(-1)!.after).toMatchObject({ oneTimeFee: { weekday: 25_000 }, prepaidFoodUnused: 'forfeit' });

    // Another park's manager cannot write this park's config.
    const foreign = await ctx.app.inject({
      method: 'PUT',
      url: `/checkin/config/pricing?branchId=${branchId}`,
      headers: { cookie: chalongManager },
      payload: pricing.json().pricing && {
        oneTimeFee: { weekday: 1, weekend: 1 },
        nannyHourly: { weekday: 1, weekend: 1 },
        extraHour: { weekday: 1, weekend: 1 },
        fullDayHours: 8,
        nannyRatioSoftMax: 3,
        prepaidFoodUnused: 'refund',
      },
    });
    expect(foreign.statusCode).toBe(403);
  });
});
