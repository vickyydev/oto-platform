import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, checkin, saleLine, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-909 — a drop-off sale for two children, paid at the till with neither
 * "Check in now" nor "Leave as booked" pressed (SCRUM-740's "paid, not yet
 * linked"), then ONE child's line refunded BY ITEM from History (the family
 * changed its mind about one child).
 *
 * Found in the defect hunt (12 Nov): SCRUM-862's cancel read "paid at the
 * till" from the SALE's status (`paidAtTillStaysOf`: a paid or finalised sale
 * carrying the kids line), never from whether that child's own line was
 * refunded. So the refunded child still read as paid on the picker and the
 * board, the booking could not be cancelled ("refund or void that sale
 * instead" — it WAS refunded), and the board's Check in took the refunded
 * child into the park with a band and no payment.
 *
 * Now a stay counts as paid at the till only while its own kids line is on no
 * refund of that sale, linked or not (`tillSalesOfStays`), and a check-in on
 * a sale refuses a child whose line it refunded (`loadChoice`). The other
 * child of the same sale is still paid for, a whole refund behaves as before,
 * and the refunded child can be cancelled or rung up again and paid for. A
 * child left as booked is unfiled from the sale by the refund that paid them
 * back (`releaseRefundedStays`), so a family that stays after all is rung up
 * again like any unpaid child.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
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

async function register(name: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id: newId(),
      branchId,
      stationId,
      guardianName: 'ZZ TEST Guardian',
      guardianPhone: '0812345690',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [
        {
          checkinId: newId(),
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
  return res.json() as { id: string; children: Array<{ id: string }> };
}

/** One drop-off sale for these stays, rung up and paid in cash at the till. */
async function paidSale(stays: readonly string[]) {
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: {
      id: saleId,
      stationId,
      lines: stays.map((id) => ({
        id,
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 5_000 },
      })),
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: {},
  });
  expect(fin.statusCode, fin.body).toBe(200);
  return saleId;
}

/** History's refund BY ITEM of every line under one child's stay. */
async function refundChildLines(saleId: string, stayId: string) {
  const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
  const ofChild = lines.filter((l) => l.cartLineId === stayId && l.grossSatang > 0).map((l) => l.id);
  expect(ofChild.length, JSON.stringify(lines.map((l) => ({ kind: l.kind, cart: l.cartLineId, gross: l.grossSatang })))).toBeGreaterThan(0);
  const refunded = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/refunds`,
    headers: { cookie: manager, 'idempotency-key': newId() },
    payload: { mode: 'items', lineIds: ofChild, reason: 'ZZ TEST one child went home', actionId: newId() },
  });
  expect(refunded.statusCode, refunded.body).toBe(200);
  expect(refunded.json().refundStatus).toBe('partially_refunded');
}

/** Two children on one paid drop-off sale; child B's own lines then refunded by item. */
async function twoChildrenOneRefunded(names: [string, string]) {
  const a = await register(names[0]);
  const b = await register(names[1]);
  const stayA = a.children[0]!.id;
  const stayB = b.children[0]!.id;
  const saleId = await paidSale([stayA, stayB]);
  await refundChildLines(saleId, stayB);
  return { a, b, stayA, stayB, saleId };
}

/** What the till's Add drop-off picker reads for one child: the sale that paid for them, or null. */
async function pickerPaidAtTill(registrationId: string, stayId: string) {
  const list = await ctx.app.inject({
    method: 'GET',
    url: `/checkin/registrations?branchId=${branchId}&registrationId=${registrationId}`,
    headers: { cookie: reception },
  });
  expect(list.statusCode, list.body).toBe(200);
  const reg = (
    list.json().registrations as Array<{ id: string; children: Array<{ id: string; paidAtTill?: { saleId: string } | null }> }>
  ).find((r) => r.id === registrationId);
  return reg?.children.find((c) => c.id === stayId)?.paidAtTill ?? null;
}

const cancelBooking = (registrationId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/checkin/registrations/${registrationId}/cancel`,
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: { reason: 'ZZ TEST child went home' },
  });

const boardCheckIn = (stayId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-booked',
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: { entries: [{ checkinId: stayId }], consentAcknowledged: true },
  });

async function stayRow(stayId: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
  return row!;
}

describe('a drop-off child refunded by item from History', () => {
  it('no longer reads as paid at the till, and the booking can be cancelled', async () => {
    const { b, stayB } = await twoChildrenOneRefunded(['ZZ TEST Kid Stays', 'ZZ TEST Kid Goes Home']);

    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${b.id}/cancel`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { reason: 'ZZ TEST child went home' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/checkin/registrations?branchId=${branchId}`,
      headers: { cookie: reception },
    });
    expect(list.statusCode, list.body).toBe(200);
    const listedB = (list.json().registrations as Array<{ id: string; children: Array<{ id: string; paidAtTill?: unknown }> }>)
      .find((r) => r.id === b.id)
      ?.children.find((c) => c.id === stayB);
    expect(listedB?.paidAtTill ?? null, 'child B was refunded, yet the picker reads them as paid at the till').toBeNull();
  });

  it('the board does not check a refunded child into the park with no payment', async () => {
    const { stayB } = await twoChildrenOneRefunded(['ZZ TEST Kid Two Stays', 'ZZ TEST Kid Two Goes']);
    const checkIn = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { entries: [{ checkinId: stayB }], consentAcknowledged: true },
    });
    const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayB));
    expect(row!.status, `board answered ${checkIn.statusCode}: ${checkIn.body.slice(0, 300)}`).toBe('registered');
  });
});

describe('SCRUM-909 — only the refunded child stops being paid for', () => {
  it('the other child of the same sale is still paid at the till: not cancellable here, and the board checks them in', async () => {
    const { a, stayA, saleId } = await twoChildrenOneRefunded(['ZZ TEST Kid Three Stays', 'ZZ TEST Kid Three Goes']);
    expect(await pickerPaidAtTill(a.id, stayA)).toMatchObject({ saleId });

    const cancel = await cancelBooking(a.id);
    expect(cancel.statusCode, cancel.body).toBe(409);
    expect(cancel.json().error.code).toBe('CHECKIN_CANCEL_PAID');
    expect((await stayRow(stayA)).status).toBe('registered');

    const checkIn = await boardCheckIn(stayA);
    expect(checkIn.statusCode, checkIn.body).toBe(200);
    expect(await stayRow(stayA)).toMatchObject({ status: 'in_park', saleId });
  });

  it('a whole refund already behaves: neither child reads as paid, the board takes neither in, and both bookings cancel', async () => {
    const a = await register('ZZ TEST Kid Four A');
    const b = await register('ZZ TEST Kid Four B');
    const stayA = a.children[0]!.id;
    const stayB = b.children[0]!.id;
    const saleId = await paidSale([stayA, stayB]);
    const whole = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/refunds`,
      headers: { cookie: manager, 'idempotency-key': newId() },
      payload: { mode: 'whole', reason: 'ZZ TEST family went home', actionId: newId() },
    });
    expect(whole.statusCode, whole.body).toBe(200);
    expect(whole.json().refundStatus).toBe('refunded');

    expect(await pickerPaidAtTill(a.id, stayA)).toBeNull();
    expect(await pickerPaidAtTill(b.id, stayB)).toBeNull();
    const checkIn = await boardCheckIn(stayA);
    expect(checkIn.statusCode, checkIn.body).toBe(409);
    expect(checkIn.json().error.code).toBe('CHECKIN_NOT_BOOKED');
    expect((await stayRow(stayA)).status).toBe('registered');
    for (const reg of [a, b]) {
      const cancel = await cancelBooking(reg.id);
      expect(cancel.statusCode, cancel.body).toBe(200);
    }
    expect((await stayRow(stayA)).status).toBe('cancelled');
    expect((await stayRow(stayB)).status).toBe('cancelled');
  });

  it('the refunded child, staying after all, is rung up again and paid for, and then checked in on the new sale', async () => {
    const { b, stayB } = await twoChildrenOneRefunded(['ZZ TEST Kid Five Stays', 'ZZ TEST Kid Five Comes Back']);
    expect(await pickerPaidAtTill(b.id, stayB)).toBeNull();

    // The till charges them again: nothing refuses the second sale now.
    const again = await paidSale([stayB]);
    expect(await pickerPaidAtTill(b.id, stayB)).toMatchObject({ saleId: again });

    const checkIn = await boardCheckIn(stayB);
    expect(checkIn.statusCode, checkIn.body).toBe(200);
    expect(await stayRow(stayB)).toMatchObject({ status: 'in_park', saleId: again });
  });
});

describe('SCRUM-909 — a child left as booked, then refunded by item', () => {
  async function bookedThenRefunded(names: [string, string]) {
    const a = await register(names[0]);
    const b = await register(names[1]);
    const stayA = a.children[0]!.id;
    const stayB = b.children[0]!.id;
    const saleId = await paidSale([stayA, stayB]);
    const booked = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/leave-as-booked',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { saleId, entries: [{ checkinId: stayA }, { checkinId: stayB }] },
    });
    expect(booked.statusCode, booked.body).toBe(200);
    await refundChildLines(saleId, stayB);
    return { a, b, stayA, stayB, saleId };
  }

  const releaseRows = (stayId: string) =>
    ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, stayId), eq(auditLog.action, 'checkin.update')))
      .then((rows) => rows.filter((r) => (r.after as { event?: string } | null)?.event === 'refund_released'));

  it('the refund unfiles them from the sale: unpaid again, sent to the till, and the booking can be cancelled', async () => {
    const { b, stayB, saleId } = await bookedThenRefunded(['ZZ TEST Kid Six Stays', 'ZZ TEST Kid Six Goes']);
    expect(await stayRow(stayB)).toMatchObject({ status: 'registered', saleId: null, scheduledFor: null });
    const released = await releaseRows(stayB);
    expect(released).toHaveLength(1);
    expect(released[0]!.before).toMatchObject({ saleId });
    expect(released[0]!.after).toMatchObject({ saleId: null, scheduledFor: null, event: 'refund_released' });
    expect(await pickerPaidAtTill(b.id, stayB)).toBeNull();

    // The board no longer files them as booked: it sends the counter to the till.
    const checkIn = await boardCheckIn(stayB);
    expect(checkIn.statusCode, checkIn.body).toBe(409);
    expect(checkIn.json().error.code).toBe('CHECKIN_NOT_BOOKED');
    // The old sale's Check in now refuses them, naming the way forward.
    const onOldSale = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-now',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { saleId, entries: [{ checkinId: stayB }] },
    });
    expect(onOldSale.statusCode, onOldSale.body).toBe(409);
    expect(onOldSale.json().error.code).toBe('CHECKIN_LINE_REFUNDED');
    expect(onOldSale.json().error.message).toContain('ring them up again');
    expect((await stayRow(stayB)).status).toBe('registered');

    const cancel = await cancelBooking(b.id);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await stayRow(stayB)).status).toBe('cancelled');
  });

  it('one still filed on a refunded line (refunded before the unfiling) is refused, with the way out named', async () => {
    const { stayB, saleId } = await bookedThenRefunded(['ZZ TEST Kid Ten Stays', 'ZZ TEST Kid Ten Filed']);
    // As a stay refunded before this fix reads: still filed on the sale.
    await ctx.db.update(checkin).set({ saleId, scheduledFor: new Date() }).where(eq(checkin.id, stayB));
    expect(await pickerPaidAtTill((await stayRow(stayB)).registrationId, stayB)).toBeNull();

    const checkIn = await boardCheckIn(stayB);
    expect(checkIn.statusCode, checkIn.body).toBe(409);
    expect(checkIn.json().error.code).toBe('CHECKIN_LINE_REFUNDED');

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: {
        id: newId(),
        stationId,
        lines: [{ id: stayB, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 5_000 } }],
      },
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('CHECKIN_PAID_AT_TILL');
    expect(second.json().error.message).toContain('which was refunded');
    expect(second.json().error.message).toContain('Cancel their booking from the Drop-Off board, and register them again if they are staying.');
    expect(second.json().error.message).not.toContain('Ask a manager');
  });

  it('the family stays after all: rung up again on a new sale, paid, and checked in there', async () => {
    const { b, stayB } = await bookedThenRefunded(['ZZ TEST Kid Eight Stays', 'ZZ TEST Kid Eight Back']);
    const again = await paidSale([stayB]);
    expect(await pickerPaidAtTill(b.id, stayB)).toMatchObject({ saleId: again });
    const checkIn = await boardCheckIn(stayB);
    expect(checkIn.statusCode, checkIn.body).toBe(200);
    expect(await stayRow(stayB)).toMatchObject({ status: 'in_park', saleId: again });
  });

  it('the sibling left as booked on the same sale is still filed there and checked in from the board', async () => {
    const { stayA, saleId } = await bookedThenRefunded(['ZZ TEST Kid Seven Stays', 'ZZ TEST Kid Seven Goes']);
    expect(await releaseRows(stayA)).toHaveLength(0);
    expect(await stayRow(stayA)).toMatchObject({ status: 'registered', saleId });
    const checkIn = await boardCheckIn(stayA);
    expect(checkIn.statusCode, checkIn.body).toBe(200);
    expect(await stayRow(stayA)).toMatchObject({ status: 'in_park', saleId });
  });

  it('a whole refund unfiles every waiting child it paid back, and a replay unfiles nobody twice', async () => {
    const a = await register('ZZ TEST Kid Nine A');
    const b = await register('ZZ TEST Kid Nine B');
    const stayA = a.children[0]!.id;
    const stayB = b.children[0]!.id;
    const saleId = await paidSale([stayA, stayB]);
    const booked = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/leave-as-booked',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { saleId, entries: [{ checkinId: stayA }, { checkinId: stayB }] },
    });
    expect(booked.statusCode, booked.body).toBe(200);
    const actionId = newId();
    const whole = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/sales/${saleId}/refunds`,
        headers: { cookie: manager, 'idempotency-key': newId() },
        payload: { mode: 'whole', reason: 'ZZ TEST family went home', actionId },
      });
    const first = await whole();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().refundStatus).toBe('refunded');
    const replay = await whole();
    expect(replay.statusCode, replay.body).toBe(200);
    for (const id of [stayA, stayB]) {
      expect(await stayRow(id)).toMatchObject({ status: 'registered', saleId: null, scheduledFor: null });
      expect(await releaseRows(id)).toHaveLength(1);
      const checkIn = await boardCheckIn(id);
      expect(checkIn.statusCode, checkIn.body).toBe(409);
      expect(checkIn.json().error.code).toBe('CHECKIN_NOT_BOOKED');
    }
  });
});
