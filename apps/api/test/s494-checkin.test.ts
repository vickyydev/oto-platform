import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, branch, checkin, child, member, nanny, nannyShift, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { checkinCacheItem } from '../src/services/sync-checkin';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-494 (check-in) — THE TILL'S DROP-OFF / NANNY SWITCH REACHES THE
 * CHECK-IN. The prototype's `checkInFamilyWithPayment` takes each child's
 * `serviceType` from the paid input and checks the nanny against it; the
 * platform's "Check in now" takes the service the paid cart line carried
 * (`entries[].service`), writes it to the stay inside the same transaction,
 * and runs the on-shift nanny check against it.
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let pimId: string;
let offShiftId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
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
  const [pim] = await ctx.db.select().from(nanny).where(and(eq(nanny.branchId, branchId), eq(nanny.name, 'Pim')));
  pimId = pim!.id;
  // The seeded shifts follow opening hours; Pim gets one covering now.
  await ctx.db.insert(nannyShift).values({
    id: newId(),
    operatorId,
    nannyId: pimId,
    branchId,
    startsAt: new Date(Date.now() - 3_600_000),
    endsAt: new Date(Date.now() + 3_600_000),
  });
  // A nanny on the roster with no shift at all.
  offShiftId = newId();
  await ctx.db.insert(nanny).values({ id: offShiftId, operatorId, branchId, name: 'S494 Off Shift' });
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function register(name: string, ageYears: number, service: 'drop_off' | 'nanny') {
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
      children: [
        {
          checkinId: newId(),
          name,
          ageYears,
          service,
          allergies: null,
          foodRestrictions: null,
          foodProvision: { mode: 'none', paidSatang: 0 },
        },
      ],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().children[0].id as string;
}

/** A finalised sale with the stay on its own drop-off line, the fee as the switched line priced it. */
async function paidSaleFor(stayId: string, fee: { label: string; amountSatang: number }): Promise<string> {
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, lines: [{ id: stayId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: fee }] },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(fin.statusCode, fin.body).toBe(200);
  return saleId;
}

function checkInNow(
  saleId: string,
  entries: { checkinId: string; nannyId?: string | null; service?: string }[],
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie: reception, ...headers },
    payload: { saleId, entries },
  });
}

async function stay(id: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
  return row!;
}

it('s498 — the check-in cache carries the saved medical and dietary warnings of a child in the park only', async () => {
  const stayId = await register(`Cache Food ${newId().slice(0, 6)}`, 6, 'drop_off');
  const [owner] = await ctx.db.select({ id: member.id }).from(member).where(eq(member.operatorId, operatorId)).limit(1);
  expect(owner).toBeDefined();
  const childId = newId();
  await ctx.db.insert(child).values({ id: childId, memberId: owner!.id, name: 'Cache Child',
    allergies: 'Saved peanuts', medicalNotes: 'Inhaler in bag', dietary: 'No nuts' });
  await ctx.db.update(checkin).set({ childId, allergies: 'Peanuts today', foodRestrictions: null }).where(eq(checkin.id, stayId));
  const waiting = (await checkinCacheItem(ctx.db, operatorId, branchId)).families.flatMap((f) => f.children).find((c) => c.id === stayId);
  expect(waiting?.status).toBe('registered');
  expect(waiting).not.toHaveProperty('savedMedicalNotes');

  const saleId = await paidSaleFor(stayId, { label: 'Drop-off service', amountSatang: 22_500 });
  expect((await checkInNow(saleId, [{ checkinId: stayId, nannyId: null }])).statusCode).toBe(200);
  const cached = await checkinCacheItem(ctx.db, operatorId, branchId);
  const found = cached.families.flatMap((f) => f.children).find((c) => c.id === stayId);
  expect(found).toMatchObject({ status: 'in_park', allergies: 'Peanuts today', savedAllergies: 'Saved peanuts',
    savedMedicalNotes: 'Inhaler in bag', savedDietary: 'No nuts' });
});

async function checkInAudits(id: string) {
  return (
    await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, id), eq(auditLog.action, 'checkin.update')))
  ).map((a) => ({ before: a.before as Record<string, unknown>, after: a.after as Record<string, unknown> }));
}

describe('s494-checkin: the cart line service switch reaches "Check in now"', () => {
  it('a drop-off child switched to Nanny on the till is checked in as a nanny child, with the nanny, audited', async () => {
    const id = await register('Switch Up', 6, 'drop_off');
    const saleId = await paidSaleFor(id, { label: 'Nanny (2h)', amountSatang: 66_000 });

    const res = await checkInNow(saleId, [{ checkinId: id, nannyId: pimId, service: 'nanny' }]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().children[0]).toMatchObject({ status: 'in_park', service: 'nanny', nannyId: pimId });

    const row = await stay(id);
    expect(row).toMatchObject({ status: 'in_park', service: 'nanny', nannyId: pimId, saleId });
    const audits = await checkInAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toMatchObject({ status: 'registered', service: 'drop_off', nannyId: null });
    expect(audits[0]!.after).toMatchObject({ status: 'in_park', service: 'nanny', nannyId: pimId, event: 'check_in_now' });
  });

  it('a switch to Nanny with no nanny named is refused before anything is written', async () => {
    const id = await register('No Nanny', 6, 'drop_off');
    const saleId = await paidSaleFor(id, { label: 'Nanny (2h)', amountSatang: 66_000 });

    const res = await checkInNow(saleId, [{ checkinId: id, service: 'nanny' }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'NANNY_REQUIRED', message: 'Assign a nanny to No Nanny before checking them in.' });
    expect(await stay(id)).toMatchObject({ status: 'registered', service: 'drop_off', nannyId: null, bandId: null });
    expect(await checkInAudits(id)).toHaveLength(0);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(0);
  });

  it('a switch to Nanny runs the on-shift check against the named nanny', async () => {
    const id = await register('Off Shift', 6, 'drop_off');
    const saleId = await paidSaleFor(id, { label: 'Nanny (2h)', amountSatang: 66_000 });

    const res = await checkInNow(saleId, [{ checkinId: id, nannyId: offShiftId, service: 'nanny' }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NANNY_NOT_ON_SHIFT');
    expect(await stay(id)).toMatchObject({ status: 'registered', service: 'drop_off', nannyId: null });
  });

  it('a nanny child switched to Drop-Off is checked in without a nanny and her nanny is released', async () => {
    const id = await register('Switch Down', 3, 'nanny');
    // The nanny assigned at the board before the till's switch.
    const assigned = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/checkins/${id}/nanny`,
      headers: { cookie: reception },
      payload: { nannyId: pimId },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const saleId = await paidSaleFor(id, { label: 'Drop-off service', amountSatang: 22_500 });

    const res = await checkInNow(saleId, [{ checkinId: id, nannyId: null, service: 'drop_off' }]);
    expect(res.statusCode, res.body).toBe(200);
    expect(await stay(id)).toMatchObject({ status: 'in_park', service: 'drop_off', nannyId: null });
    const audits = await checkInAudits(id);
    const checkIn = audits.find((a) => a.after.event === 'check_in_now')!;
    expect(checkIn.before).toMatchObject({ service: 'nanny', nannyId: pimId });
    expect(checkIn.after).toMatchObject({ service: 'drop_off', nannyId: null });
  });

  it('an entry with no service keeps the stay its own service', async () => {
    const id = await register('Unchanged', 6, 'drop_off');
    const saleId = await paidSaleFor(id, { label: 'Drop-off service', amountSatang: 22_500 });
    const res = await checkInNow(saleId, [{ checkinId: id }]);
    expect(res.statusCode, res.body).toBe(200);
    expect(await stay(id)).toMatchObject({ status: 'in_park', service: 'drop_off', nannyId: null });
  });

  it('a replay under the same idempotency key answers the same check-in and writes nothing twice', async () => {
    const id = await register('Replay', 6, 'drop_off');
    const saleId = await paidSaleFor(id, { label: 'Nanny (2h)', amountSatang: 66_000 });
    const key = `s494-${newId()}`;
    const entries = [{ checkinId: id, nannyId: pimId, service: 'nanny' }];
    const first = await checkInNow(saleId, entries, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    const again = await checkInNow(saleId, entries, { 'idempotency-key': key });
    expect(again.statusCode).toBe(200);
    expect(again.json().bands).toEqual(first.json().bands);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(1);
    expect((await checkInAudits(id)).filter((a) => a.after.event === 'check_in_now')).toHaveLength(1);
  });

  it('refuses a service the platform does not know', async () => {
    const id = await register('Bad Service', 6, 'drop_off');
    const saleId = await paidSaleFor(id, { label: 'Drop-off service', amountSatang: 22_500 });
    const res = await checkInNow(saleId, [{ checkinId: id, service: 'babysitter' }]);
    expect(res.statusCode).toBe(400);
    expect(await stay(id)).toMatchObject({ status: 'registered', service: 'drop_off' });
  });
});
