import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  branch,
  checkin,
  child,
  member,
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
import { assignNanny } from '../src/services/checkin';
import {
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-13 round 2 — the RE-CHECK gate's own attacks, beyond the first gate's
 * reproductions (checkin-board-gate.test.ts): R-90 on the refusal paths, the
 * shift boundary to the second, the ratio that only warns, and the audit rows
 * of a no-op edit, a saved child's edit and a service change that frees a nanny.
 */

let ctx: TestContext;
let reception: string;
let receptionId: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let onShiftId: string;
let boundaryId: string;
let boundaryEndsAt: Date;
let endedId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];
const HOUR = 3_600_000;

async function makeNanny(name: string, shift?: { from: Date; to: Date }) {
  const id = newId();
  await ctx.db.insert(nanny).values({ id, operatorId, branchId, name });
  if (shift) {
    await ctx.db.insert(nannyShift).values({ id: newId(), operatorId, nannyId: id, branchId, startsAt: shift.from, endsAt: shift.to });
  }
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [acc] = await ctx.db.select().from(account).where(and(eq(account.phone, RECEPTION.phone), eq(account.operatorId, operatorId)));
  receptionId = acc!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const now = Date.now();
  onShiftId = await makeNanny('R2 OnShift', { from: new Date(now - HOUR), to: new Date(now + HOUR) });
  boundaryEndsAt = new Date(now - 10 * 60_000);
  boundaryId = await makeNanny('R2 Boundary', { from: new Date(now - 3 * HOUR), to: boundaryEndsAt });
  endedId = await makeNanny('R2 Ended', { from: new Date(now - 3 * HOUR), to: new Date(now - 60_000) });
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

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

async function paidSaleFor(checkinIds: string[]): Promise<string> {
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId,
      lines: checkinIds.map((id) => ({
        id,
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
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

const booked = (entries: { checkinId: string; nannyId?: string | null }[]) =>
  ctx.app.inject({ method: 'POST', url: '/checkin/check-in-booked', headers: { cookie: reception }, payload: { entries } });

const patch = (id: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: `/checkin/checkins/${id}`, headers: { cookie: reception }, payload: body });

const history = async (id: string) =>
  (await ctx.app.inject({ method: 'GET', url: `/checkin/checkins/${id}/history`, headers: { cookie: reception } })).json()
    .entries as { field: string; oldValue: string; newValue: string }[];

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

async function auditCount(entityIds: string[]) {
  return (await ctx.db.select().from(auditLog).where(inArray(auditLog.entityId, entityIds))).length;
}

// --- (1) R-90 on the refusal paths and across two sales ----------------------------------

describe('R-90 — the refusals and the two-sale family move no money either', () => {
  it('an unpaid child is refused in the counter words; nothing is written', async () => {
    const reg = await register([childBody({ name: 'Unpaid' })]);
    const before = await moneyRows();
    const res = await booked([{ checkinId: reg.children[0]!.id }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKIN_NOT_BOOKED');
    expect(res.json().error.message).toContain('check them in at the till, where the payment is taken');
    expect(await moneyRows()).toEqual(before);
  });

  it('a booked child whose sale was refunded is not checked in and gets no band', async () => {
    const reg = await register([childBody({ name: 'Refunded' })]);
    const id = reg.children[0]!.id;
    const saleId = await paidSaleFor([id]);
    await leaveAsBooked(saleId, [id]);
    await ctx.db.update(sale).set({ status: 'refunded', refundedAt: new Date() }).where(eq(sale.id, saleId));
    const before = await moneyRows();
    const res = await booked([{ checkinId: id }]);
    expect(res.statusCode).toBe(409);
    expect(await moneyRows()).toEqual(before);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(0);
    expect((await ctx.db.select().from(checkin).where(eq(checkin.id, id)))[0]!.status).toBe('registered');
  });

  it('two siblings paid on two sales: one band each on its own sale, no money row', async () => {
    const reg = await register([childBody({ name: 'Sib A' }), childBody({ name: 'Sib B' })]);
    const [a, b] = reg.children.map((c) => c.id) as [string, string];
    const saleA = await paidSaleFor([a]);
    const saleB = await paidSaleFor([b]);
    await leaveAsBooked(saleA, [a]);
    await leaveAsBooked(saleB, [b]);
    const before = await moneyRows();
    const res = await booked([{ checkinId: a }, { checkinId: b }]);
    expect(res.statusCode, res.body).toBe(200);
    expect(await moneyRows()).toEqual(before);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleA))).toHaveLength(1);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleB))).toHaveLength(1);
  });
});

// --- (2) The shift rule at its boundary; the ratio only warns ----------------------------

describe('the shift rule — to the second, and the ratio never refuses', () => {
  it('a shift that ended a minute ago refuses; a second before it ended accepts', async () => {
    const reg = await register([childBody({ name: 'Boundary', ageYears: 3, service: 'nanny' })]);
    const id = reg.children[0]!.id;
    const actor = { accountId: receptionId, operatorId };
    await expect(
      ctx.db.transaction((tx) => assignNanny(tx, actor, id, boundaryId, new Date(boundaryEndsAt.getTime() + 60_000))),
    ).rejects.toMatchObject({ code: 'NANNY_NOT_ON_SHIFT' });
    await expect(
      ctx.db.transaction((tx) => assignNanny(tx, actor, id, boundaryId, boundaryEndsAt)),
    ).rejects.toMatchObject({ code: 'NANNY_NOT_ON_SHIFT' });
    const ok = await ctx.db.transaction((tx) => assignNanny(tx, actor, id, boundaryId, new Date(boundaryEndsAt.getTime() - 1000)));
    expect(ok.checkin.nannyId).toBe(boundaryId);
  });

  it('PATCH moving a drop-off child to nanny with an ended nanny is refused and changes nothing', async () => {
    const reg = await register([childBody({ name: 'Switch', ageYears: 7 })]);
    const id = reg.children[0]!.id;
    const rows = await auditCount([id]);
    const res = await patch(id, { service: 'nanny', nannyId: endedId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NANNY_NOT_ON_SHIFT');
    const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
    expect(row).toMatchObject({ service: 'drop_off', nannyId: null });
    expect(await auditCount([id])).toBe(rows);
  });

  it('over the soft ratio the assignment stands with a warning', async () => {
    const board = (await ctx.app.inject({ method: 'GET', url: `/checkin/board?branchId=${branchId}`, headers: { cookie: reception } })).json();
    const softMax = board.nannyRatioSoftMax as number;
    const load = (board.nannies as { id: string; load: number }[]).find((n) => n.id === onShiftId)!.load;
    let last: { statusCode: number; json: () => { warnings: string[]; checkin: { nannyId: string } } } | null = null;
    for (let i = load; i < softMax + 1; i++) {
      const reg = await register([childBody({ name: `Ratio ${i}`, ageYears: 3, service: 'nanny' })]);
      last = await ctx.app.inject({
        method: 'POST',
        url: `/checkin/checkins/${reg.children[0]!.id}/nanny`,
        headers: { cookie: reception },
        payload: { nannyId: onShiftId },
      });
      expect(last.statusCode).toBe(200);
    }
    expect(last!.json().checkin.nannyId).toBe(onShiftId);
    expect(last!.json().warnings.join(' ')).toContain('over the suggested');
  });
});

// --- (3) Audit truth: no-op, saved child, freeing a nanny ----------------------------------

describe('audit truth — the rows nobody asked about', () => {
  it('a PATCH that changes nothing writes no row and no history entry', async () => {
    const reg = await register([childBody({ name: 'Same', ageYears: 6 })]);
    const id = reg.children[0]!.id;
    const rows = await auditCount([id, reg.id]);
    const res = await patch(id, { childName: ' Same ', childAgeYears: 6, guardianPhone: '081-234-5678', contactChannel: 'whatsapp' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toBe(0);
    expect(await auditCount([id, reg.id])).toBe(rows);
    expect(await history(id)).toEqual([]);
  });

  it("a saved child's allergy edit: one stay row, one child row, one history entry", async () => {
    const [saved] = await ctx.db
      .select({ childId: child.id, memberId: member.id, name: child.name, ageYears: child.ageYears, allergies: child.allergies })
      .from(child)
      .innerJoin(member, eq(member.id, child.memberId))
      .where(and(eq(member.operatorId, operatorId), sql`${child.archivedAt} is null`))
      .limit(1);
    const reg = await register(
      [childBody({ childId: saved!.childId, name: saved!.name, ageYears: saved!.ageYears ?? 6, allergies: saved!.allergies })],
      { memberId: saved!.memberId },
    );
    const id = reg.children[0]!.id;
    const stayRows = await auditCount([id]);
    const childRows = await auditCount([saved!.childId]);
    const res = await patch(id, { allergies: 'Gate R2 sesame' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await auditCount([id])).toBe(stayRows + 1);
    expect(await auditCount([saved!.childId])).toBe(childRows + 1);
    const [childRow] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saved!.childId), eq(auditLog.action, 'child.update')))
      .orderBy(sql`${auditLog.createdAt} desc`)
      .limit(1);
    expect(childRow!.before).toEqual({ allergies: saved!.allergies });
    expect(childRow!.after).toMatchObject({ allergies: 'Gate R2 sesame' });
    const h = await history(id);
    expect(h.filter((e) => e.field === 'Allergies / medical')).toHaveLength(1);
    expect(h.at(-1)).toMatchObject({ field: 'Allergies / medical', newValue: 'Gate R2 sesame' });
  });

  it('leaving the nanny service frees her: one row, Service and Nanny in the history', async () => {
    const reg = await register([childBody({ name: 'Free Her', ageYears: 3, service: 'nanny' })]);
    const id = reg.children[0]!.id;
    expect((await patch(id, { nannyId: onShiftId })).statusCode).toBe(200);
    const rows = await auditCount([id]);
    const res = await patch(id, { service: 'drop_off' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await auditCount([id])).toBe(rows + 1);
    const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
    expect(row).toMatchObject({ service: 'drop_off', nannyId: null });
    const tail = (await history(id)).slice(-2).map((e) => [e.field, e.oldValue, e.newValue]);
    expect(tail).toEqual([
      ['Service', 'Nanny', 'Drop-Off'],
      ['Nanny', 'R2 OnShift', '—'],
    ]);
  });

  it('no jsonb change log column exists on the check-in tables', async () => {
    const result = await ctx.db.execute(
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'pos' and table_name in ('checkin','registration') and column_name ilike '%log%'`,
    );
    expect((result as unknown as { rows: unknown[] }).rows).toEqual([]);
  });
});
