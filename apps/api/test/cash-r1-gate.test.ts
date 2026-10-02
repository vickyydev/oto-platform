import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
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
import { newId, type CashSessionView } from '@oto/shared';
import { resetDemoData } from '../src/services/demo-reset';
import {
  ADMIN,
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15a round 1 — THE GATE's reproductions (focused gate, round 1).
 *
 *   1. what counts as till cash: a scripted shift at T1 with every attempt
 *      that must NOT reach the drawer (another station, declined, before the
 *      open, booking-site, card/QR) beside the ones that must;
 *   2. the count: expected = the hand-summed ledger, satang-exact, including a
 *      gateway refund that falls back to cash; variance and sign-off stored;
 *   3. the people: a safe drop's witness without pos:cash:approve is refused
 *      (`pos:cash:approve` — "Countersign a paid-out, a safe drop or a close
 *      variance", packages/shared/src/permissions.ts);
 *   4. refunds: replayed refund writes one refund_out;
 *   5. the surface: the demo reset still clears a day that refunded in cash.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let t1: string;
let t2: string;
let friesId: string;

const MANAGER_PERSON = { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password };

beforeAll(async () => {
  ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
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
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const openOk = async (stationId: string): Promise<CashSessionView> => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/stations/${stationId}/cash/sessions`,
    headers: { cookie: reception },
    payload: { actionId: newId() },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { session: CashSessionView }).session;
};
const move = (sessionId: string, payload: Record<string, unknown>, cookie = reception) =>
  ctx.app.inject({ method: 'POST', url: `/cash/sessions/${sessionId}/movements`, headers: { cookie }, payload: { actionId: newId(), ...payload } });
const sessionOf = async (id: string): Promise<CashSessionView> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/cash/sessions/${id}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CashSessionView;
};

/** An F&B sale at a station. With `qrInvoice`, paid by a gateway QR attempt instead of cash. */
async function fnbSale(stationId: string, qrInvoice?: string): Promise<{ saleId: string; amountSatang: number }> {
  const saleId = newId();
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '9', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(made.statusCode, made.body).toBe(200);
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  if (qrInvoice) {
    await ctx.db.insert(paymentAttempt).values({
      id: newId(),
      operatorId,
      branchId,
      saleId,
      stationId,
      businessDate: row!.businessDate,
      method: 'qr',
      methodCode: 'promptpay',
      provider: 'simulator',
      status: 'approved',
      amountSatang: row!.grossSatang,
      invoiceNo: qrInvoice,
      paidAt: new Date(),
    });
    const paid = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
    expect(paid.statusCode, paid.body).toBe(200);
  } else {
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { method: 'cash', kind: 'cash', tenderedSatang: row!.grossSatang, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
  }
  return { saleId, amountSatang: row!.grossSatang };
}

async function rawAttempt(fields: { stationId: string | null; method: string; status: string; amountSatang: number; paidAt: Date; offline?: boolean }) {
  await ctx.db.insert(paymentAttempt).values({
    id: newId(),
    operatorId,
    branchId,
    stationId: fields.stationId,
    businessDate: '2026-10-02',
    method: fields.method as never,
    methodCode: fields.method,
    provider: 'manual',
    status: fields.status as never,
    amountSatang: fields.amountSatang,
    paidAt: fields.paidAt,
    ...(fields.offline ? { offline: true } : {}),
  });
}

const refundAs = (saleId: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: manager }, payload: { reason: 'Gate', ...body } });

describe('gate (1)+(2)+(4): a scripted shift, hand-summed, satang-exact', () => {
  it('counts only this station’s taken cash in the window; refund_out incl. a gateway fallback; closes at zero variance', async () => {
    const s = await openOk(t1);
    const float = s.openingFloatSatang;

    // IN: two cash sales at T1 and an offline cash sale taken at T1 during the shift.
    const a = await fnbSale(t1);
    const b = await fnbSale(t1);
    await rawAttempt({ stationId: t1, method: 'cash', status: 'approved', amountSatang: 7_700, paidAt: new Date(), offline: true });

    // NOT IN: before the open (yesterday's business), declined, another station, booking site, card at T1.
    await rawAttempt({ stationId: t1, method: 'cash', status: 'approved', amountSatang: 1_111, paidAt: new Date(Date.parse(s.openedAt) - 3_600_000) });
    await rawAttempt({ stationId: t1, method: 'cash', status: 'declined', amountSatang: 2_222, paidAt: new Date() });
    await rawAttempt({ stationId: t1, method: 'cash', status: 'cancelled', amountSatang: 2_323, paidAt: new Date() });
    await rawAttempt({ stationId: t2, method: 'cash', status: 'approved', amountSatang: 3_333, paidAt: new Date() });
    await rawAttempt({ stationId: null, method: 'cash', status: 'approved', amountSatang: 4_444, paidAt: new Date() });
    await rawAttempt({ stationId: null, method: 'qr', status: 'approved', amountSatang: 5_555, paidAt: new Date() });
    await rawAttempt({ stationId: t1, method: 'card', status: 'approved', amountSatang: 6_666, paidAt: new Date() });

    // OUT: a cash refund, replayed with the same action id (one refund_out).
    const actionId = newId();
    const r1 = await refundAs(a.saleId, { mode: 'custom', amountSatang: 1_000, actionId });
    expect(r1.statusCode, r1.body).toBe(200);
    const r1again = await refundAs(a.saleId, { mode: 'custom', amountSatang: 1_000, actionId });
    expect(r1again.statusCode, r1again.body).toBe(200);
    expect(r1again.json().replay).toBe(true);
    const r1Out = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, r1.json().refund.id));
    expect(r1Out).toHaveLength(1);
    expect(r1Out[0]).toMatchObject({ sessionId: s.id, amountSatang: 1_000 });

    // OUT: a gateway QR refund the gateway refuses (an invoice it never issued) — handed back in cash.
    const q = await fnbSale(t1, `GATE${Date.now().toString().slice(-10)}`);
    const r2 = await refundAs(q.saleId, { mode: 'custom', amountSatang: 2_500 });
    expect(r2.statusCode, r2.body).toBe(200);
    const [r2row] = await ctx.db.select().from(refund).where(eq(refund.saleId, q.saleId));
    expect(r2row!.tenderAllocation).toEqual([expect.objectContaining({ route: 'gateway_refund', status: 'failed', fallback: 'cash' })]);
    const r2Out = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, r2row!.id));
    expect(r2Out).toHaveLength(1);
    expect(r2Out[0]).toMatchObject({ sessionId: s.id, kind: 'refund_out', amountSatang: 2_500 });

    // Manual movements.
    expect((await move(s.id, { kind: 'paid_out', amountSatang: 3_050, reason: 'Ice', approver: MANAGER_PERSON })).statusCode).toBe(200);
    expect((await move(s.id, { kind: 'safe_drop', amountSatang: 200_025, reason: 'Midday', witness: MANAGER_PERSON })).statusCode).toBe(200);
    expect((await move(s.id, { kind: 'top_up', amountSatang: 1_234, reason: 'Coins' })).statusCode).toBe(200);

    const handSum = float + a.amountSatang + b.amountSatang + 7_700 - 1_000 - 2_500 - 3_050 - 200_025 + 1_234;
    const view = await sessionOf(s.id);
    expect(view.expected.cashInSatang).toBe(a.amountSatang + b.amountSatang + 7_700);
    expect(view.expected.refundOutSatang).toBe(3_500);
    expect(view.expected.expectedSatang).toBe(handSum);

    // Close at the hand sum: zero variance, stored and signed off.
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/cash/sessions/${s.id}/close`,
      headers: { cookie: reception },
      payload: { countedSatang: handSum, actionId: newId() },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const [row] = await ctx.db.select().from(cashSession).where(eq(cashSession.id, s.id));
    expect(row).toMatchObject({ status: 'closed', expectedSatang: handSum, countedSatang: handSum, varianceSatang: 0 });
    expect(row!.signedOffByAccountId).toBeTruthy();
    expect(row!.signedOffAt).toBeTruthy();
  });

  it('an out-of-tolerance close without a note is refused, by a satang beyond ฿1', async () => {
    const s = await openOk(t1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/cash/sessions/${s.id}/close`,
      headers: { cookie: reception },
      payload: { countedSatang: s.expected.expectedSatang + 101, actionId: newId() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CASH_VARIANCE_NOTE_REQUIRED');
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/cash/sessions/${s.id}/close`,
      headers: { cookie: reception },
      payload: { countedSatang: s.expected.expectedSatang - 100, actionId: newId() },
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('gate (3): the safe drop’s witness needs pos:cash:approve', () => {
  it('refuses a second receptionist (pos:cash:movement, no pos:cash:approve) as witness', async () => {
    const phone = '+66900000088';
    const id = newId();
    await ctx.db.insert(account).values({
      id,
      operatorId,
      phone,
      passwordHash: await hash('recep1234'),
      phoneVerifiedAt: new Date(),
      status: 'active',
    });
    const [rec] = await ctx.db.select().from(role).where(and(eq(role.name, 'reception'), isNull(role.operatorId)));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId: rec!.id, scopeType: 'branch', scopeId: branchId });

    const s = await openOk(t1);
    const drop = await move(s.id, { kind: 'safe_drop', amountSatang: 1_000, reason: 'Drop', witness: { phone, password: 'recep1234' } });
    expect(drop.statusCode, drop.body).toBe(403);
    expect(drop.json().error.code).toBe('CASH_WITNESS_NOT_ALLOWED');
  });
});

describe('gate (5): the demo reset still clears a day with a cash refund', () => {
  it('POST /ops/demo-reset succeeds after a refund_out was written', async () => {
    const open = await ctx.db.select().from(cashSession).where(and(eq(cashSession.stationId, t1), eq(cashSession.status, 'open')));
    if (open.length === 0) await openOk(t1);
    const sold = await fnbSale(t1);
    const r = await refundAs(sold.saleId, { mode: 'custom', amountSatang: 500 });
    expect(r.statusCode, r.body).toBe(200);
    expect(await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, r.json().refund.id))).toHaveLength(1);

    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/ops/demo-reset',
      headers: { cookie: admin },
      payload: { confirm: 'RESET DEMO DATA' },
    });
    // The reason, read straight from the service (the route answers a bare 500).
    await expect(ctx.db.transaction((tx) => resetDemoData(tx))).resolves.toBeTruthy();
    expect(reset.statusCode, reset.body).toBe(200);
    // The drawers' day went with it, and the ledger's door is shut again.
    expect(await ctx.db.select().from(cashMovement)).toHaveLength(0);
    expect(await ctx.db.select().from(cashSession)).toHaveLength(0);
    expect(await ctx.db.select().from(refund)).toHaveLength(0);
  });
});
