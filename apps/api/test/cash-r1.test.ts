import { hash } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  box,
  branch,
  cashMovement,
  cashSession,
  paymentAttempt,
  product,
  refund,
  role,
  roleAssignment,
  sale,
  station,
} from '@oto/db';
import { PAID_ONLINE_TENDER_CODE, WALLET_TENDER_CODE, newId, type CashDrawerView, type CashSessionView } from '@oto/shared';
import { branchBusinessDate } from '../src/services/cash';
import {
  BRANCH_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15a round 1 — cash sessions and the drawer (plan
 * docs/progress/plans/cash/PLAN.md §2.1-§2.2, §5), against a seeded database
 * through the routes.
 *
 *   - expectedCash: the float + cash taken at THIS station in the window −
 *     refund_out − paid_out − safe_drop + top_up; a booking-site card attempt
 *     (no station), a wallet tender, a paid-online tender, a card at this
 *     station and another station's cash are NOT counted (countsAsTillTakings);
 *   - a paid-out's approver and a safe drop's witness are a second person,
 *     verified by their own password and permissioned;
 *   - the count, variance and sign-off, a note when out of tolerance;
 *   - one open session per station; a station with no drawer refuses;
 *   - a refund's business_date and its refund_out on the drawer it was made at;
 *     no open drawer refuses a cash refund and writes nothing;
 *   - the float carries over from the drawer's last close;
 *   - routes: permission and tenancy refusals.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let foreign: string;
let operatorId: string;
let branchId: string;
let t1: string;
let t2: string;
let friesId: string;
let receptionId: string;
let managerId: string;

const RECEPTION_PERSON = { phone: RECEPTION.phone, password: RECEPTION.password };
const MANAGER_PERSON = { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password };

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  t1 = till!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, till!.boxId!));
  const [till2] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T2')));
  t2 = till2!.id;
  const [fries] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES'), isNull(product.archivedAt)));
  friesId = fries!.id;
  const accountOf = async (phone: string) =>
    (await ctx.db.select({ id: account.id }).from(account).where(and(eq(account.phone, phone), eq(account.operatorId, operatorId))))[0]!.id;
  receptionId = await accountOf(RECEPTION.phone);
  managerId = await accountOf(BRANCH_MANAGER.phone);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- helpers -----------------------------------------------------------------------

const drawer = async (stationId: string, cookie = reception): Promise<CashDrawerView> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/stations/${stationId}/cash`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CashDrawerView;
};
const open = (stationId: string, cookie = reception, actionId: string = newId()) =>
  ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/cash/sessions`, headers: { cookie }, payload: { actionId } });
const openOk = async (stationId: string): Promise<CashSessionView> => {
  const res = await open(stationId);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { session: CashSessionView }).session;
};
const move = (sessionId: string, payload: Record<string, unknown>, cookie = reception) =>
  ctx.app.inject({ method: 'POST', url: `/cash/sessions/${sessionId}/movements`, headers: { cookie }, payload: { actionId: newId(), ...payload } });
const close = (sessionId: string, payload: Record<string, unknown>, cookie = reception) =>
  ctx.app.inject({ method: 'POST', url: `/cash/sessions/${sessionId}/close`, headers: { cookie }, payload: { actionId: newId(), ...payload } });
const sessionOf = async (id: string, cookie = reception): Promise<CashSessionView> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/cash/sessions/${id}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CashSessionView;
};
/** Close whatever is open at a station, balanced, so the next test starts clean. */
const closeIfOpen = async (stationId: string) => {
  const d = await drawer(stationId);
  if (d.session?.status === 'open') {
    const res = await close(d.session.id, { countedSatang: d.session.expected.expectedSatang });
    expect(res.statusCode, res.body).toBe(200);
  }
};

/** A cash F&B sale at a station; answers the sale and the cash it took. */
async function cashSale(stationId: string): Promise<{ saleId: string; amountSatang: number }> {
  const saleId = newId();
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '7', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(made.statusCode, made.body).toBe(200);
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: { method: 'cash', kind: 'cash', tenderedSatang: row!.grossSatang, actionId: newId() },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  expect(paid.json().finalised).toBe(true);
  return { saleId, amountSatang: row!.grossSatang };
}

/** A taken payment attempt written straight into the ledger, as another writer would. */
async function attempt(fields: { stationId: string | null; method: string; methodCode: string | null; amountSatang: number }) {
  await ctx.db.insert(paymentAttempt).values({
    id: newId(),
    operatorId,
    branchId,
    stationId: fields.stationId,
    businessDate: '2026-10-02',
    method: fields.method as never,
    methodCode: fields.methodCode,
    provider: 'manual',
    status: 'approved',
    amountSatang: fields.amountSatang,
    paidAt: new Date(),
  });
}

const refundCash = (saleId: string, amountSatang: number, cookie = manager) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/refunds`,
    headers: { cookie },
    payload: { mode: 'custom', amountSatang, reason: 'Cold fries', actionId: newId() },
  });

// --- expectedCash ------------------------------------------------------------------

describe('expectedCash — the drawer counts only cash taken at its own station', () => {
  it('float + cash in − refund out − paid-out − safe drop + top-up; nothing else', async () => {
    const s = await openOk(t1);
    expect(s.openingFloatSatang).toBe(600_000);
    expect(s.floatSourceLabel).toBe('standard opening float (no prior close)');
    expect(s.expected).toMatchObject({ floatSatang: 600_000, cashInSatang: 0, expectedSatang: 600_000 });

    const one = await cashSale(t1);
    const two = await cashSale(t1);
    // Not this drawer's: a booking-site card attempt (no station), a booking-site
    // cash attempt (no station), a wallet tender, a paid-online tender and a card
    // at this station, and cash at another station.
    await attempt({ stationId: null, method: 'card', methodCode: 'card', amountSatang: 11_100 });
    await attempt({ stationId: null, method: 'cash', methodCode: 'cash', amountSatang: 22_200 });
    await attempt({ stationId: t1, method: 'wallet', methodCode: WALLET_TENDER_CODE, amountSatang: 33_300 });
    await attempt({ stationId: t1, method: 'transfer', methodCode: PAID_ONLINE_TENDER_CODE, amountSatang: 44_400 });
    await attempt({ stationId: t1, method: 'card', methodCode: 'card', amountSatang: 55_500 });
    await attempt({ stationId: t2, method: 'cash', methodCode: 'cash', amountSatang: 66_600 });

    const refunded = await refundCash(one.saleId, 1_000);
    expect(refunded.statusCode, refunded.body).toBe(200);

    const paidOut = await move(s.id, { kind: 'paid_out', amountSatang: 2_000, reason: 'Ice delivery', approver: MANAGER_PERSON });
    expect(paidOut.statusCode, paidOut.body).toBe(200);
    expect(paidOut.json().movement).toMatchObject({ kind: 'paid_out', approver: { accountId: managerId } });
    const drop = await move(s.id, { kind: 'safe_drop', amountSatang: 100_000, reason: 'Midday drop', witness: MANAGER_PERSON });
    expect(drop.statusCode, drop.body).toBe(200);
    const topUp = await move(s.id, { kind: 'top_up', amountSatang: 5_000, reason: 'Coins from the safe' });
    expect(topUp.statusCode, topUp.body).toBe(200);

    const view = await sessionOf(s.id);
    const cashIn = one.amountSatang + two.amountSatang;
    expect(view.expected).toEqual({
      floatSatang: 600_000,
      cashInSatang: cashIn,
      refundOutSatang: 1_000,
      paidOutSatang: 2_000,
      safeDropSatang: 100_000,
      topUpSatang: 5_000,
      expectedSatang: 600_000 + cashIn - 1_000 - 2_000 - 100_000 + 5_000,
    });
    expect(view.movements.map((m) => m.kind)).toEqual(['float', 'refund_out', 'paid_out', 'safe_drop', 'top_up']);

    // The drawer at another station does not see this one's cash, nor this one its.
    const other = await openOk(t2);
    expect(other.expected.cashInSatang).toBe(0);
    await closeIfOpen(t2);
    await closeIfOpen(t1);
  });
});

// --- the second person -------------------------------------------------------------

describe('the second person — distinct, verified, permissioned', () => {
  it('refuses the actor as their own approver or witness, a wrong password, and an approver without pos:cash:approve', async () => {
    const s = await openOk(t1);
    // The manager cannot approve their own paid-out.
    const self = await move(s.id, { kind: 'paid_out', amountSatang: 1_000, reason: 'Ice', approver: MANAGER_PERSON }, manager);
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toMatchObject({ code: 'CASH_APPROVER_IS_ACTOR', message: 'A paid-out needs a second person to approve it — not you' });
    const selfWitness = await move(s.id, { kind: 'safe_drop', amountSatang: 1_000, reason: 'Drop', witness: RECEPTION_PERSON });
    expect(selfWitness.json().error.code).toBe('CASH_WITNESS_IS_ACTOR');
    // Reception has no pos:cash:approve.
    const noRight = await move(s.id, { kind: 'paid_out', amountSatang: 1_000, reason: 'Ice', approver: RECEPTION_PERSON }, manager);
    expect(noRight.statusCode).toBe(403);
    expect(noRight.json().error.code).toBe('CASH_APPROVER_NOT_ALLOWED');
    // A wrong password is a refusal of the second person, never the till's session (403, not 401).
    const wrong = await move(s.id, { kind: 'paid_out', amountSatang: 1_000, reason: 'Ice', approver: { phone: BRANCH_MANAGER.phone, password: 'nope' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('CASH_SECOND_PERSON_REFUSED');
    // Nobody named: the body is refused before anything is read.
    const missing = await move(s.id, { kind: 'paid_out', amountSatang: 1_000, reason: 'Ice' });
    expect(missing.statusCode).toBe(400);
    // A witness with no cash permission at all.
    const staffPhone = '+66900000077';
    const staffId = newId();
    await ctx.db.insert(account).values({
      id: staffId,
      operatorId,
      phone: staffPhone,
      passwordHash: await hash('staff1234'),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    const [staffRole] = await ctx.db.select().from(role).where(and(eq(role.name, 'staff'), isNull(role.operatorId)));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: staffId, roleId: staffRole!.id, scopeType: 'branch', scopeId: branchId });
    const staffWitness = await move(s.id, { kind: 'safe_drop', amountSatang: 1_000, reason: 'Drop', witness: { phone: staffPhone, password: 'staff1234' } });
    expect(staffWitness.statusCode).toBe(403);
    expect(staffWitness.json().error.code).toBe('CASH_WITNESS_NOT_ALLOWED');
    // A reception colleague: pos:cash:movement but no pos:cash:approve — two
    // receptionists cannot witness each other's drop.
    const colleaguePhone = '+66900000087';
    const colleagueId = newId();
    await ctx.db.insert(account).values({
      id: colleagueId,
      operatorId,
      phone: colleaguePhone,
      passwordHash: await hash('colleague1234'),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    const [receptionRole] = await ctx.db.select().from(role).where(and(eq(role.name, 'reception'), isNull(role.operatorId)));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: colleagueId, roleId: receptionRole!.id, scopeType: 'branch', scopeId: branchId });
    const colleagueWitness = await move(s.id, { kind: 'safe_drop', amountSatang: 1_000, reason: 'Drop', witness: { phone: colleaguePhone, password: 'colleague1234' } });
    expect(colleagueWitness.statusCode).toBe(403);
    expect(colleagueWitness.json().error).toMatchObject({ code: 'CASH_WITNESS_NOT_ALLOWED', message: 'That person cannot witness a safe drop at this park' });
    // More than the drawer holds cannot go out.
    const tooMuch = await move(s.id, { kind: 'paid_out', amountSatang: 10_000_000, reason: 'Rent', approver: MANAGER_PERSON });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error.code).toBe('CASH_DRAWER_SHORT');
    // None of the refusals wrote a movement.
    const rows = await ctx.db.select().from(cashMovement).where(eq(cashMovement.sessionId, s.id));
    expect(rows.map((r) => r.kind)).toEqual(['float']);
    // A staff account has no session_open: the drawer is not theirs to read.
    const staffCookie = await signInAs(ctx.app, staffPhone, 'staff1234');
    const read = await ctx.app.inject({ method: 'GET', url: `/stations/${t1}/cash`, headers: { cookie: staffCookie } });
    expect(read.statusCode).toBe(403);
    await closeIfOpen(t1);
  });

  it('a movement is action-keyed: the same press answers the movement already written', async () => {
    const s = await openOk(t1);
    const actionId = newId();
    const first = await move(s.id, { kind: 'top_up', amountSatang: 1_000, reason: 'Coins', actionId });
    const again = await move(s.id, { kind: 'top_up', amountSatang: 1_000, reason: 'Coins', actionId });
    expect(first.statusCode, first.body).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, movement: { id: first.json().movement.id } });
    expect((await ctx.db.select().from(cashMovement).where(and(eq(cashMovement.sessionId, s.id), eq(cashMovement.kind, 'top_up'))))).toHaveLength(1);
    await closeIfOpen(t1);
  });
});

// --- open, count, close -----------------------------------------------------------

describe('one drawer, one open session; the count, variance and sign-off', () => {
  it('one open session per station; the same press replays; a station with no drawer refuses', async () => {
    const actionId = newId();
    const first = await open(t1, reception, actionId);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await open(t1, reception, actionId);
    expect(replay.json()).toMatchObject({ replayed: true, session: { id: first.json().session.id } });
    const second = await open(t1);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'CASH_SESSION_ALREADY_OPEN',
      message: 'This drawer is already open — count it and close it before opening it again',
    });
    await closeIfOpen(t1);

    await ctx.db.update(station).set({ paymentRouting: { cash: 'none' } }).where(eq(station.id, t2));
    const none = await open(t2);
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('CASH_NO_DRAWER');
    expect((await drawer(t2)).station.hasDrawer).toBe(false);
    await ctx.db.update(station).set({ paymentRouting: null }).where(eq(station.id, t2));
  });

  it('stores expected and variance, held against the closer; out of tolerance needs a note', async () => {
    const s = await openOk(t1);
    const sold = await cashSale(t1);
    const expected = s.openingFloatSatang + sold.amountSatang;
    // ฿5 short, no note: refused in the counter's words.
    const short = await close(s.id, { countedSatang: expected - 500 }, manager);
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatchObject({
      code: 'CASH_VARIANCE_NOTE_REQUIRED',
      message: 'The count is ฿5 short — add a note saying why before closing',
    });
    // You cannot leave more in the drawer than you counted.
    const greedy = await close(s.id, { countedSatang: expected, floatLeftSatang: expected + 1 }, manager);
    expect(greedy.statusCode).toBe(400);
    // With a note it closes: expected and variance stored, signed off by the closer.
    const done = await close(s.id, { countedSatang: expected - 500, floatLeftSatang: 250_000, note: 'Gave change twice' }, manager);
    expect(done.statusCode, done.body).toBe(200);
    const view = (done.json() as { session: CashSessionView }).session;
    expect(view).toMatchObject({
      status: 'closed',
      countedSatang: expected - 500,
      varianceSatang: -500,
      toleranceSatang: 100,
      floatLeftSatang: 250_000,
      notes: 'Gave change twice',
      closedBy: { accountId: managerId },
      signedOffBy: { accountId: managerId },
    });
    expect(view.expected.expectedSatang).toBe(expected);
    const [row] = await ctx.db.select().from(cashSession).where(eq(cashSession.id, s.id));
    expect(row).toMatchObject({ expectedSatang: expected, varianceSatang: -500, signedOffByAccountId: managerId });
    // Closing twice is refused; the same press replays.
    const again = await close(s.id, { countedSatang: expected });
    expect(again.json().error.code).toBe('CASH_SESSION_CLOSED');
    // Within ฿1, no note needed — and the float carried over.
    const next = await openOk(t1);
    expect(next.openingFloatSatang).toBe(250_000);
    expect(next.floatSource?.sessionId).toBe(s.id);
    expect(next.floatSourceLabel).toBe(`carried from ${row!.businessDate} close`);
    const balanced = await close(next.id, { countedSatang: 250_000 + 100 });
    expect(balanced.statusCode, balanced.body).toBe(200);
    expect(balanced.json().session).toMatchObject({ varianceSatang: 100, notes: null, signedOffBy: { accountId: receptionId } });
    // The audit trail: open, close and each movement.
    const actions = (
      await ctx.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, s.id))
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['cash_session.open', 'cash_session.close']));
  });

  it('the business date is the branch trading day, never the UTC slice', async () => {
    const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    // 21:30 UTC on the 1st is 04:30 on the 2nd in Bangkok: still the 1st's trading day.
    expect(branchBusinessDate(br!, new Date('2026-10-01T21:30:00Z'))).toBe('2026-10-01');
    expect(branchBusinessDate(br!, new Date('2026-10-01T22:30:00Z'))).toBe('2026-10-02');
  });
});

// --- refunds ------------------------------------------------------------------------

describe('a cash refund leaves the drawer it was made at, on the day it leaves', () => {
  it('stamps refund.business_date with today’s trading day and writes refund_out on that drawer', async () => {
    await closeIfOpen(t1);
    await closeIfOpen(t2);
    const s1 = await openOk(t1);
    const s2 = await openOk(t2);
    const sold = await cashSale(t1);
    // The sale is filed on an earlier trading day; the refund is not. A
    // finalised sale is frozen by trigger, so the back-dating steps round it
    // for this one throwaway row.
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(sale).set({ businessDate: '2020-01-01' }).where(eq(sale.id, sold.saleId));
    });
    const res = await refundCash(sold.saleId, 1_500);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await ctx.db.select().from(refund).where(eq(refund.saleId, sold.saleId));
    const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    expect(row!.businessDate).toBe(branchBusinessDate(br!, row!.createdAt));
    expect(row!.businessDate).not.toBe('2020-01-01');
    expect(row!.stationId).toBe(t1);
    const out = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, row!.id));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'refund_out', amountSatang: 1_500, sessionId: s1.id, stationId: t1, businessDate: row!.businessDate });
    expect((await sessionOf(s2.id)).expected.refundOutSatang).toBe(0);
    await closeIfOpen(t1);
    await closeIfOpen(t2);
  });

  it('no open drawer at that counter: a cash refund is refused in plain words and nothing is written', async () => {
    await closeIfOpen(t1);
    const s = await openOk(t1);
    const sold = await cashSale(t1);
    await closeIfOpen(t1);
    expect(s.id).toBeTruthy();
    const before = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(refund);
    const res = await refundCash(sold.saleId, 1_000);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'CASH_SESSION_NOT_OPEN',
      message: 'Open the cash drawer at this counter before handing a refund back in cash',
    });
    const after = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(refund);
    expect(after[0]!.n).toBe(before[0]!.n);
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, sold.saleId));
    expect(saleRow!.refundedSatang).toBe(0);
  });
});

// --- routes: tenancy -----------------------------------------------------------------

describe('routes — another operator’s drawer does not exist', () => {
  it('answers 404 for a station or session of another operator', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/stations/${t1}/cash`, headers: { cookie: foreign } });
    expect(res.statusCode).toBe(404);
    const s = await openOk(t1);
    const read = await ctx.app.inject({ method: 'GET', url: `/cash/sessions/${s.id}`, headers: { cookie: foreign } });
    expect(read.statusCode).toBe(404);
    const shut = await close(s.id, { countedSatang: 0 }, foreign);
    expect(shut.statusCode).toBe(404);
    await closeIfOpen(t1);
  });
});
