import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, branch, checkin, paymentAttempt, sale, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { checkinCacheItem } from '../src/services/sync-checkin';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-740 — A CHILD PAID FOR AT THE TILL IS NEVER CHARGED A SECOND TIME.
 *
 * A child registered for drop-off and paid for at the till, but not yet
 * checked in, still waits on the board and in the till's Add drop-off picker.
 * A second sale used to take the money again, and only Check in refused
 * afterwards. SCRUM-730 closed the same for a family who paid online; these
 * walk the same reads and presses for a child paid for at the counter, both
 * after "Leave as booked" and after a payment whose choice was never made.
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;

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
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A walk-up family at the door with one drop-off child, registered as the till registers one. */
async function registeredChild(name = 'ZZ TEST Mint'): Promise<{ registrationId: string; stayId: string }> {
  const registrationId = newId();
  const stayId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id: registrationId,
      branchId,
      stationId,
      guardianName: 'ZZ TEST Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [
        {
          checkinId: stayId,
          name,
          ageYears: 6,
          service: 'drop_off',
          allergies: null,
          foodRestrictions: null,
          foodProvision: { mode: 'none', paidSatang: 0 },
        },
      ],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { registrationId, stayId };
}

/** The till's cart for a drop-off line: the line takes the stay's id. */
const ringUp = (stayId: string, saleId = newId()) =>
  ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId,
      lines: [
        {
          id: stayId,
          packageId: twoHoursId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 5_000 },
        },
      ],
    },
  });

/** Rung up and paid in cash: the money is taken, nothing chosen after it yet. */
async function paidAtTill(stayId: string): Promise<{ saleId: string; receiptNumber: string }> {
  const saleId = newId();
  const commit = await ringUp(stayId, saleId);
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: {},
  });
  expect(fin.statusCode, fin.body).toBe(200);
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  return { saleId, receiptNumber: row!.receiptNumber! };
}

const leaveAsBooked = (saleId: string, stayId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/checkin/leave-as-booked',
    headers: { cookie: reception },
    payload: { saleId, entries: [{ checkinId: stayId }] },
  });

const checkInBooked = (stayId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-booked',
    headers: { cookie: reception },
    payload: { entries: [{ checkinId: stayId }] },
  });

/** What the till's Add drop-off picker reads: a family's waiting children. */
async function waitingChild(registrationId: string, stayId: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/checkin/registrations?branchId=${branchId}`,
    headers: { cookie: reception },
  });
  expect(res.statusCode, res.body).toBe(200);
  const regs = res.json().registrations as Array<{ id: string; children: Array<Record<string, unknown>> }>;
  return regs.find((r) => r.id === registrationId)?.children.find((c) => c.id === stayId);
}

async function boardChild(registrationId: string, stayId: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/checkin/board?branchId=${branchId}`,
    headers: { cookie: reception },
  });
  expect(res.statusCode, res.body).toBe(200);
  const families = res.json().families as Array<{ registrationId: string; children: Array<Record<string, unknown>> }>;
  return families.find((f) => f.registrationId === registrationId)?.children.find((c) => c.id === stayId);
}

const refusalsFor = (stayId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'checkin'),
        eq(auditLog.entityId, stayId),
        eq(auditLog.action, 'checkin.second_charge_refused'),
      ),
    );

describe('a child paid for at the till and left as booked', () => {
  it('is named paid at the till on the waiting list, the board and the box copy', async () => {
    const { registrationId, stayId } = await registeredChild();
    const paid = await paidAtTill(stayId);
    const left = await leaveAsBooked(paid.saleId, stayId);
    expect(left.statusCode, left.body).toBe(200);

    expect(await waitingChild(registrationId, stayId)).toMatchObject({
      status: 'registered',
      saleId: paid.saleId,
      paidOnline: null,
      paidAtTill: { saleId: paid.saleId, receiptNumber: paid.receiptNumber },
    });
    expect(await boardChild(registrationId, stayId)).toMatchObject({
      paidAtTill: { saleId: paid.saleId, receiptNumber: paid.receiptNumber },
    });
    const cached = await checkinCacheItem(ctx.db, operatorId, branchId);
    expect(cached.families.flatMap((f) => f.children).find((c) => c.id === stayId)).toMatchObject({
      paidAtTill: { saleId: paid.saleId, receiptNumber: paid.receiptNumber },
    });
  });

  it('cannot be rung up on a second sale: refused before the money, named, and on the trail', async () => {
    const { stayId } = await registeredChild('ZZ TEST Bua');
    const paid = await paidAtTill(stayId);
    expect((await leaveAsBooked(paid.saleId, stayId)).statusCode).toBe(200);

    const secondId = newId();
    const res = await ringUp(stayId, secondId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_PAID_AT_TILL');
    expect(res.json().error.message).toContain('ZZ TEST Bua');
    expect(res.json().error.message).toContain(paid.receiptNumber);
    expect(res.json().error.details).toMatchObject({ checkinId: stayId, saleId: paid.saleId });
    // Nothing of the second sale was written.
    expect(await ctx.db.select().from(sale).where(eq(sale.id, secondId))).toHaveLength(0);
    const [refused] = await refusalsFor(stayId);
    expect(refused).toMatchObject({ operatorId, actorAccountId: expect.any(String) });
    expect(refused!.after).toMatchObject({
      code: 'CHECKIN_PAID_AT_TILL',
      paidOnSaleId: paid.saleId,
      receiptNumber: paid.receiptNumber,
      refusedSaleId: secondId,
      stationId,
    });
  });

  it('checks in from the board on the sale that paid, with no payment', async () => {
    const { stayId } = await registeredChild();
    const paid = await paidAtTill(stayId);
    expect((await leaveAsBooked(paid.saleId, stayId)).statusCode).toBe(200);
    const checked = await checkInBooked(stayId);
    expect(checked.statusCode, checked.body).toBe(200);
    const [inPark] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    expect(inPark).toMatchObject({ status: 'in_park', saleId: paid.saleId });
    expect(await ctx.db.select().from(sale).where(eq(sale.id, paid.saleId))).toHaveLength(1);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, paid.saleId))).toHaveLength(1);
  });
});

describe('a child paid for at the till with no choice made after payment', () => {
  it('is named paid at the till although the stay names no sale yet', async () => {
    const { registrationId, stayId } = await registeredChild();
    const paid = await paidAtTill(stayId);
    expect(await waitingChild(registrationId, stayId)).toMatchObject({
      saleId: null,
      paidAtTill: { saleId: paid.saleId, receiptNumber: paid.receiptNumber },
    });
  });

  it('cannot be rung up again, and the board checks them in on the sale that paid', async () => {
    const { stayId } = await registeredChild();
    const paid = await paidAtTill(stayId);
    const res = await ringUp(stayId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_PAID_AT_TILL');

    const checked = await checkInBooked(stayId);
    expect(checked.statusCode, checked.body).toBe(200);
    const [inPark] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    expect(inPark).toMatchObject({ status: 'in_park', saleId: paid.saleId });
  });
});

describe('a sale rung up before another sale paid for the same child', () => {
  const finalise = (saleId: string, cookie = reception) =>
    ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      payload: {},
    });

  async function attemptsOn(saleId: string) {
    return ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
  }

  it('is refused at its cash confirm, named, left as it was, and on the trail', async () => {
    const { stayId } = await registeredChild('ZZ TEST Kaew');
    // Till 1 rings the family up and the screen is left open.
    const staleId = newId();
    expect((await ringUp(stayId, staleId)).statusCode).toBe(200);
    // Till 2 rings the same child up and takes the money.
    const paid = await paidAtTill(stayId);

    const res = await finalise(staleId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_PAID_AT_TILL');
    expect(res.json().error.message).toContain('ZZ TEST Kaew');
    expect(res.json().error.message).toContain(paid.receiptNumber);
    expect(res.json().error.message).toContain('Nothing was charged');
    expect(res.json().error.details).toMatchObject({ checkinId: stayId, saleId: paid.saleId });
    // No money recorded and nothing numbered: the stale sale is as it was.
    const [stale] = await ctx.db.select().from(sale).where(eq(sale.id, staleId));
    expect(stale).toMatchObject({ status: 'tendering', receiptNumber: null });
    expect(await attemptsOn(staleId)).toHaveLength(0);
    const [refused] = await refusalsFor(stayId);
    expect(refused).toMatchObject({ operatorId, branchId, actorAccountId: expect.any(String) });
    expect(refused!.after).toMatchObject({
      code: 'CHECKIN_PAID_AT_TILL',
      paidOnSaleId: paid.saleId,
      receiptNumber: paid.receiptNumber,
      refusedSaleId: staleId,
      stationId,
      at: 'tender',
    });
    // The board still checks the child in on the sale that paid.
    expect((await checkInBooked(stayId)).statusCode).toBe(200);
  });

  it('is refused before a card is asked for', async () => {
    const { stayId } = await registeredChild();
    const staleId = newId();
    expect((await ringUp(stayId, staleId)).statusCode).toBe(200);
    await paidAtTill(stayId);

    const card = await ctx.app.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { cookie: reception },
      payload: { saleId: staleId, tender: 'card' },
    });
    expect(card.statusCode, card.body).toBe(409);
    expect(card.json().error.code).toBe('CHECKIN_PAID_AT_TILL');
    expect(await attemptsOn(staleId)).toHaveLength(0);
    expect(await refusalsFor(stayId)).toHaveLength(1);
  });

  it('is refused when it was held and is resumed after the other sale paid', async () => {
    const till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    await takeStation(ctx.app, till, stationId);
    const { stayId } = await registeredChild();
    const heldId = newId();
    expect((await ringUp(stayId, heldId)).statusCode).toBe(200);
    const held = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${heldId}/hold`,
      headers: { cookie: till },
      payload: { kind: 'held', label: 'ZZ TEST Khun Ploy' },
    });
    expect(held.statusCode, held.body).toBe(200);
    await paidAtTill(stayId);
    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${heldId}/resume`,
      headers: { cookie: till },
      payload: {},
    });
    expect(resumed.statusCode, resumed.body).toBe(200);

    const res = await finalise(heldId, till);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_PAID_AT_TILL');
    expect(await attemptsOn(heldId)).toHaveLength(0);
  });
});

describe('what stays as it was', () => {
  it('a child rung up but not yet paid is still offered, and the same sale replays', async () => {
    const { registrationId, stayId } = await registeredChild();
    const saleId = newId();
    const first = await ringUp(stayId, saleId);
    expect(first.statusCode, first.body).toBe(200);
    expect(await waitingChild(registrationId, stayId)).toMatchObject({ saleId: null, paidAtTill: null });
    // The till's retry of the same sale is the same sale, not a second charge.
    const again = await ringUp(stayId, saleId);
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a waiting child on no sale is a line to charge, and the check-in follows the payment', async () => {
    const { stayId } = await registeredChild();
    const paid = await paidAtTill(stayId);
    const now = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-now',
      headers: { cookie: reception },
      payload: { saleId: paid.saleId, entries: [{ checkinId: stayId }] },
    });
    expect(now.statusCode, now.body).toBe(200);
    expect(await refusalsFor(stayId)).toHaveLength(0);
  });

  it('a voided sale holds nothing: the child is offered again and can be paid for', async () => {
    const { registrationId, stayId } = await registeredChild();
    const saleId = newId();
    expect((await ringUp(stayId, saleId)).statusCode).toBe(200);
    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/void`,
      headers: { cookie: reception },
      payload: { reason: 'ZZ TEST cancelled at the counter' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await waitingChild(registrationId, stayId)).toMatchObject({ paidAtTill: null });
    const paid = await paidAtTill(stayId);
    expect(paid.receiptNumber).toBeTruthy();
  });
});
