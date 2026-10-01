import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  branch,
  checkin,
  nanny,
  nannyShift,
  paymentAttempt,
  refund,
  sale,
  saleLine,
  station,
  ticketPackage,
  walletEntry,
} from '@oto/db';
import { newId } from '@oto/shared';
import { liveOccupancy } from '../src/services/occupancy';
import {
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-13 round 2 — the GATE's reproductions (focused gate, round 2). Each
 * `describe` is one invariant the gate attacked: R-90 (a booked check-in never
 * moves money), THE SHIFT RULE (refused server-side on every assignment path),
 * AUDIT TRUTH (each edited field one honest audit row, read back by the
 * history exactly) and THE OCCUPANCY TERM (a lone drop-off child counts).
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let chalongId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];
const HOUR = 3_600_000;

/** Nannies made for this file only, so the seeded rota cannot hide a defect. */
let onShiftId: string;
let endedId: string;
let neverId: string;
let elsewhereShiftId: string;
let chalongNannyId: string;

async function makeNanny(name: string, rosterBranch: string, shift?: { branch: string; from: number; to: number }) {
  const id = newId();
  await ctx.db.insert(nanny).values({ id, operatorId, branchId: rosterBranch, name });
  if (shift) {
    await ctx.db.insert(nannyShift).values({
      id: newId(),
      operatorId,
      nannyId: id,
      branchId: shift.branch,
      startsAt: new Date(Date.now() + shift.from),
      endsAt: new Date(Date.now() + shift.to),
    });
  }
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;

  onShiftId = await makeNanny('Gate OnShift', branchId, { branch: branchId, from: -HOUR, to: HOUR });
  endedId = await makeNanny('Gate Ended', branchId, { branch: branchId, from: -3 * HOUR, to: -60_000 });
  neverId = await makeNanny('Gate Never', branchId);
  elsewhereShiftId = await makeNanny('Gate Elsewhere', branchId, { branch: chalongId, from: -HOUR, to: HOUR });
  chalongNannyId = await makeNanny('Gate Chalong', chalongId, { branch: chalongId, from: -HOUR, to: HOUR });
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

async function leaveAsBooked(saleId: string, checkinIds: string[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/leave-as-booked',
    headers: { cookie: reception },
    payload: { saleId, scheduledFor: new Date(Date.now() + 30 * 60_000).toISOString(), entries: checkinIds.map((checkinId) => ({ checkinId })) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const patch = (id: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: `/checkin/checkins/${id}`, headers: { cookie: reception }, payload: body });

const assign = (id: string, nannyId: string) =>
  ctx.app.inject({ method: 'POST', url: `/checkin/checkins/${id}/nanny`, headers: { cookie: reception }, payload: { nannyId } });

async function stay(id: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
  return row!;
}

async function moneyRows() {
  const n = sql<number>`count(*)::int`;
  return {
    sale: Number((await ctx.db.select({ n }).from(sale))[0]!.n),
    saleLine: Number((await ctx.db.select({ n }).from(saleLine))[0]!.n),
    paymentAttempt: Number((await ctx.db.select({ n }).from(paymentAttempt))[0]!.n),
    refund: Number((await ctx.db.select({ n }).from(refund))[0]!.n),
    walletEntry: Number((await ctx.db.select({ n }).from(walletEntry))[0]!.n),
  };
}

// --- (1) R-90: a booked check-in never moves money -------------------------------------

describe('R-90 — booked check-in writes no money', () => {
  it('no sale, line, payment, refund or wallet row; the paid sale itself is untouched; a replay mints nothing', async () => {
    const reg = await register([childBody({ name: 'Rin', ageYears: 6 })]);
    const id = reg.children[0]!.id;
    const saleId = await paidSaleFor([{ checkinId: id, feeSatang: 22_500 }]);
    await leaveAsBooked(saleId, [id]);
    const [saleBefore] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const before = await moneyRows();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: id }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await moneyRows()).toEqual(before);
    const [saleAfter] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect({ ...saleAfter, updatedAt: null }).toEqual({ ...saleBefore, updatedAt: null });

    // A second press is refused in the counter's words and mints no second band.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: id }] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('already checked in');
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(1);
    expect(await moneyRows()).toEqual(before);
  });

  it('the PATCH cannot reach the sale link or the booked start', async () => {
    const reg = await register([childBody({ name: 'Ton', ageYears: 6 })]);
    const id = reg.children[0]!.id;
    for (const body of [{ saleId: newId() }, { scheduledFor: new Date().toISOString() }, { status: 'in_park' }]) {
      const res = await patch(id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await stay(id)).toMatchObject({ saleId: null, scheduledFor: null, status: 'registered' });
  });
});

// --- (2) THE SHIFT RULE ------------------------------------------------------------------

describe('the shift rule — refused server-side on every path', () => {
  const offShift = () => [
    ['shift ended a minute ago', endedId],
    ['never had a shift', neverId],
    ['on shift at another branch', elsewhereShiftId],
  ] as const;

  it('POST /checkins/:id/nanny refuses each off-shift nanny', async () => {
    for (const [why, nannyId] of offShift()) {
      const reg = await register([childBody({ name: `Assign ${why}`, ageYears: 3, service: 'nanny' })]);
      const res = await assign(reg.children[0]!.id, nannyId);
      expect(res.statusCode, `${why}: ${res.body}`).toBe(409);
      expect(res.json().error.code, why).toBe('NANNY_NOT_ON_SHIFT');
      expect((await stay(reg.children[0]!.id)).nannyId, why).toBeNull();
    }
    const other = await register([childBody({ name: 'Assign Chalong', ageYears: 3, service: 'nanny' })]);
    const foreign = await assign(other.children[0]!.id, chalongNannyId);
    expect(foreign.statusCode).toBe(409);
    // The on-shift control: the same path accepts her.
    const ok = await assign(other.children[0]!.id, onShiftId);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('PATCH refuses each off-shift nanny', async () => {
    for (const [why, nannyId] of offShift()) {
      const reg = await register([childBody({ name: `Edit ${why}`, ageYears: 3, service: 'nanny' })]);
      const res = await patch(reg.children[0]!.id, { nannyId });
      expect(res.statusCode, `${why}: ${res.body}`).toBe(409);
      expect(res.json().error.code, why).toBe('NANNY_NOT_ON_SHIFT');
    }
  });

  it('booked check-in refuses each off-shift nanny', async () => {
    for (const [why, nannyId] of offShift()) {
      const reg = await register([childBody({ name: `Booked ${why}`, ageYears: 3, service: 'nanny' })]);
      const id = reg.children[0]!.id;
      await leaveAsBooked(await paidSaleFor([{ checkinId: id, feeSatang: 33_000 }]), [id]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/checkin/check-in-booked',
        headers: { cookie: reception },
        payload: { entries: [{ checkinId: id, nannyId }] },
      });
      expect(res.statusCode, `${why}: ${res.body}`).toBe(409);
      expect(res.json().error.code, why).toBe('NANNY_NOT_ON_SHIFT');
      expect((await stay(id)).status, why).toBe('registered');
    }
  });

  it("the till's check-in-now refuses each off-shift nanny too", async () => {
    for (const [why, nannyId] of offShift()) {
      const reg = await register([childBody({ name: `Till ${why}`, ageYears: 3, service: 'nanny' })]);
      const id = reg.children[0]!.id;
      const saleId = await paidSaleFor([{ checkinId: id, feeSatang: 33_000 }]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/checkin/check-in-now',
        headers: { cookie: reception },
        payload: { saleId, entries: [{ checkinId: id, nannyId }] },
      });
      expect(res.statusCode, `${why}: ${res.body}`).toBe(409);
      expect((await stay(id)).nannyId, why).toBeNull();
    }
  });

  it("the board's roster shows a nanny on shift elsewhere as off shift here", async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/checkin/board?branchId=${branchId}`, headers: { cookie: reception } });
    const roster = res.json().nannies as { id: string; onShift: boolean }[];
    expect(roster.find((n) => n.id === elsewhereShiftId)!.onShift).toBe(false);
    expect(roster.find((n) => n.id === endedId)!.onShift).toBe(false);
    expect(roster.find((n) => n.id === onShiftId)!.onShift).toBe(true);
  });
});

// --- (3) AUDIT TRUTH ---------------------------------------------------------------------

describe('audit truth — one honest row per edit, read back exactly', () => {
  it('each PATCHable field, edited alone, lands one audit row with only that field and one history entry', async () => {
    const reg = await register([childBody({ name: 'Truth', ageYears: 6 })], { guardianName: 'Ying', guardianPhone: '0811119001' });
    const id = reg.children[0]!.id;
    const history = async () =>
      (await ctx.app.inject({ method: 'GET', url: `/checkin/checkins/${id}/history`, headers: { cookie: reception } })).json()
        .entries as { field: string; oldValue: string; newValue: string }[];
    const rows = async () =>
      ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.entityId, [id, reg.id]),
            inArray(auditLog.action, ['checkin.update', 'registration.update']),
          ),
        )
        .orderBy(auditLog.createdAt, auditLog.id);

    const steps: [Record<string, unknown>, string, string, string, string][] = [
      [{ childName: 'Truth Two' }, 'childName', 'Child name', 'Truth', 'Truth Two'],
      [{ childAgeYears: 7 }, 'childAgeYears', 'Age', '6', '7'],
      [{ bookedMinutes: 90 }, 'bookedMinutes', 'Booked play time', '—', '90 min'],
      [{ mayOrderFood: true }, 'mayOrderFood', 'May order food', 'No', 'Yes'],
      [{ foodRestrictions: 'Halal' }, 'foodRestrictions', 'Food restrictions', '—', 'Halal'],
      [{ allergies: 'Shellfish' }, 'allergies', 'Allergies / medical', '—', 'Shellfish'],
      [{ guardianName: 'Ying K.' }, 'guardianName', 'Parent name', 'Ying', 'Ying K.'],
      [{ contactChannel: 'telegram' }, 'contactChannel', 'Contact method', 'whatsapp', 'telegram'],
      [{ guardianPhone: '0811119002' }, 'guardianPhone', 'Phone', '+66811119001', '+66811119002'],
      [{ service: 'nanny' }, 'service', 'Service', 'Drop-Off', 'Nanny'],
    ];
    for (const [body, key, label, oldValue, newValue] of steps) {
      const rowsBefore = (await rows()).length;
      const histBefore = (await history()).length;
      const res = await patch(id, body);
      expect(res.statusCode, `${key}: ${res.body}`).toBe(200);
      expect(res.json().changed, key).toBe(1);
      const after = await rows();
      expect(after.length, key).toBe(rowsBefore + 1);
      const row = after.at(-1)!;
      const keysOf = (o: unknown) => Object.keys((o ?? {}) as object).filter((k) => !['event', 'checkinId'].includes(k));
      expect(keysOf(row.before), key).toEqual([key]);
      expect(keysOf(row.after), key).toEqual([key]);
      const h = await history();
      expect(h.length, key).toBe(histBefore + 1);
      expect(h.at(-1), key).toMatchObject({ field: label, oldValue, newValue });
    }

    // The nanny: one row carrying the id and the name, one history entry.
    const rowsBefore = (await rows()).length;
    const histBefore = (await history()).length;
    const res = await patch(id, { nannyId: onShiftId });
    expect(res.statusCode, res.body).toBe(200);
    expect((await rows()).length).toBe(rowsBefore + 1);
    const h = await history();
    expect(h.length).toBe(histBefore + 1);
    expect(h.at(-1)).toMatchObject({ field: 'Nanny', oldValue: '—', newValue: 'Gate OnShift' });
  });

  it("a booked child's check-in does not invent a booked-time change in the history", async () => {
    const reg = await register([childBody({ name: 'Booked Truth', ageYears: 6 })]);
    const id = reg.children[0]!.id;
    await leaveAsBooked(await paidSaleFor([{ checkinId: id, feeSatang: 22_500 }]), [id]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: id }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const entries = (
      await ctx.app.inject({ method: 'GET', url: `/checkin/checkins/${id}/history`, headers: { cookie: reception } })
    ).json().entries as { field: string; oldValue: string; newValue: string }[];
    // Booked at 120 by "Leave as booked"; the check-in kept 120 — that is one change, not two.
    const booked = entries.filter((e) => e.field === 'Booked play time');
    expect(booked).toEqual([expect.objectContaining({ oldValue: '—', newValue: '120 min' })]);
  });
});

// --- (4) THE OCCUPANCY TERM ----------------------------------------------------------------

describe('the occupancy drop-off term', () => {
  it('a booked drop-off child checked in from the board counts with no adult; registered children never count', async () => {
    const before = await liveOccupancy(ctx.db, { operatorId, branchId });
    const reg = await register([childBody({ name: 'Occ', ageYears: 6 })]);
    const id = reg.children[0]!.id;
    await leaveAsBooked(await paidSaleFor([{ checkinId: id, feeSatang: 22_500 }]), [id]);
    expect((await liveOccupancy(ctx.db, { operatorId, branchId })).kids).toBe(before.kids);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId: id }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const inside = await liveOccupancy(ctx.db, { operatorId, branchId });
    expect(inside.kids).toBe(before.kids + 1);
    expect(inside.adults).toBe(before.adults);
    await ctx.db.update(checkin).set({ status: 'out', checkedOutAt: new Date() }).where(eq(checkin.id, id));
    expect((await liveOccupancy(ctx.db, { operatorId, branchId })).kids).toBe(before.kids);
  });
});
