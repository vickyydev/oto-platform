import { hash } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  box,
  branch,
  cashMovement,
  cashSession,
  device,
  paymentAttempt,
  product,
  refund,
  role,
  roleAssignment,
  sale,
  station,
} from '@oto/db';
import {
  PAID_ONLINE_TENDER_CODE,
  PAID_ONLINE_TENDER_METHOD,
  WALLET_TENDER_CODE,
  WALLET_TENDER_METHOD,
  newId,
  type CashSessionView,
  type RefundAllocationEntry,
} from '@oto/shared';
import { recordTerminalResult } from '../src/services/payments/terminal';
import { withTx } from '../src/services/tx';
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
 * S2-15a round 1 — THE GATE's RE-CHECK reproductions.
 *
 *   (1) the platform-written tenders at a station (wallet credit, paid online)
 *       and a cash-method row carrying the wallet code never reach the drawer;
 *   (3) a second person with pos:cash:approve at ANOTHER park is refused; a
 *       paid-out with no approver and a drop with no witness are refused; a
 *       read-only `staff` account cannot open, move or close; two tills racing
 *       to open one drawer get one session;
 *   (4) a refund of a sale filed on an earlier trading day lands on today; a
 *       card refund whose terminal REFUSES the void is handed back in cash, so
 *       its refund_out must reach the drawer (PLAN §5 "Gateway/void fallbacks").
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let t1: string;
let t2: string;
let friesId: string;
let cardDeviceId: string;

beforeAll(async () => {
  ctx = await createTestContext();
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
  const devices = await ctx.db.select().from(device).where(eq(device.branchId, branchId));
  cardDeviceId = devices.find((d) => d.label === 'EDC 1')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const openAt = (stationId: string, cookie = reception) =>
  ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/cash/sessions`, headers: { cookie }, payload: { actionId: newId() } });
const openOk = async (stationId: string): Promise<CashSessionView> => {
  const res = await openAt(stationId);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { session: CashSessionView }).session;
};
const openSessionAt = async (stationId: string): Promise<CashSessionView> => {
  const [open] = await ctx.db
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.stationId, stationId), eq(cashSession.status, 'open')));
  return open ? sessionOf(open.id) : openOk(stationId);
};
const move = (sessionId: string, payload: Record<string, unknown>, cookie = reception) =>
  ctx.app.inject({ method: 'POST', url: `/cash/sessions/${sessionId}/movements`, headers: { cookie }, payload: { actionId: newId(), ...payload } });
const sessionOf = async (id: string): Promise<CashSessionView> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/cash/sessions/${id}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CashSessionView;
};
const refundAs = (saleId: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: manager }, payload: { reason: 'Recheck', ...body } });

/** An F&B sale at a station; `card` pays it with an approved card attempt on EDC 1 instead of cash. */
async function fnbSale(
  stationId: string,
  card = false,
  fileOn?: string,
): Promise<{ saleId: string; amountSatang: number; attemptId: string | null }> {
  const saleId = newId();
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '9', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(made.statusCode, made.body).toBe(200);
  // Filed on an earlier trading day (before the finalise freezes the row).
  if (fileOn) await ctx.db.update(sale).set({ businessDate: fileOn }).where(eq(sale.id, saleId));
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  let attemptId: string | null = null;
  if (card) {
    attemptId = newId();
    await ctx.db.insert(paymentAttempt).values({
      id: attemptId,
      operatorId,
      branchId,
      saleId,
      stationId,
      deviceId: cardDeviceId,
      businessDate: row!.businessDate,
      method: 'card',
      methodCode: 'card',
      provider: 'simulator',
      status: 'approved',
      amountSatang: row!.grossSatang,
      tranRef: `TR${attemptId.slice(-8)}`,
      approvalCode: 'A1B2C3',
      last4: '4242',
      paidAt: new Date(),
      payload: { tender: 'card' },
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
  return { saleId, amountSatang: row!.grossSatang, attemptId };
}

async function rawAttempt(fields: { stationId: string; method: string; methodCode: string; amountSatang: number }) {
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

async function accountWithRole(phone: string, roleName: string, scope: { type: 'branch' | 'operator'; id: string }) {
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId,
    phone,
    passwordHash: await hash('pass12345'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  const [r] = await ctx.db.select().from(role).where(and(eq(role.name, roleName), isNull(role.operatorId)));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId: r!.id, scopeType: scope.type, scopeId: scope.id });
  return id;
}

describe('recheck (1): platform-written tenders at a station never reach the drawer', () => {
  it('wallet credit, paid online, and a cash row carrying the wallet code are left out', async () => {
    const s = await openSessionAt(t1);
    const before = (await sessionOf(s.id)).expected;
    await rawAttempt({ stationId: t1, method: WALLET_TENDER_METHOD, methodCode: WALLET_TENDER_CODE, amountSatang: 1_101 });
    await rawAttempt({ stationId: t1, method: PAID_ONLINE_TENDER_METHOD, methodCode: PAID_ONLINE_TENDER_CODE, amountSatang: 1_202 });
    await rawAttempt({ stationId: t1, method: 'cash', methodCode: WALLET_TENDER_CODE, amountSatang: 1_303 });
    await rawAttempt({ stationId: t1, method: 'cash', methodCode: PAID_ONLINE_TENDER_CODE, amountSatang: 1_404 });
    await rawAttempt({ stationId: t1, method: 'qr', methodCode: 'promptpay', amountSatang: 1_505 });
    const after = (await sessionOf(s.id)).expected;
    expect(after.cashInSatang).toBe(before.cashInSatang);
    expect(after.expectedSatang).toBe(before.expectedSatang);
  });
});

describe('recheck (3): the people and the permissions, on the server', () => {
  it('refuses a missing approver or witness, and a second person whose pos:cash:approve is at another park', async () => {
    const s = await openSessionAt(t1);
    // Refused at the schema, in the counter's words (400), before the service's own 403 net.
    const noApprover = await move(s.id, { kind: 'paid_out', amountSatang: 100, reason: 'Ice' });
    expect(noApprover.statusCode, noApprover.body).toBe(400);
    expect(noApprover.body).toContain('A paid-out needs a manager to approve it');
    const noWitness = await move(s.id, { kind: 'safe_drop', amountSatang: 100, reason: 'Drop' });
    expect(noWitness.statusCode, noWitness.body).toBe(400);

    const elsewhere = { phone: CHALONG_MANAGER.phone, password: CHALONG_MANAGER.password };
    const approver = await move(s.id, { kind: 'paid_out', amountSatang: 100, reason: 'Ice', approver: elsewhere });
    expect(approver.statusCode, approver.body).toBe(403);
    expect(approver.json().error.code).toBe('CASH_APPROVER_NOT_ALLOWED');
    const witness = await move(s.id, { kind: 'safe_drop', amountSatang: 100, reason: 'Drop', witness: elsewhere });
    expect(witness.statusCode, witness.body).toBe(403);
    expect(witness.json().error.code).toBe('CASH_WITNESS_NOT_ALLOWED');

    // The manager signing their own paid-out is the actor as approver.
    const own = await move(s.id, { kind: 'paid_out', amountSatang: 100, reason: 'Ice', approver: { phone: BRANCH_MANAGER.phone, password: BRANCH_MANAGER.password } }, manager);
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error.code).toBe('CASH_APPROVER_IS_ACTOR');
    expect(await ctx.db.select().from(cashMovement).where(and(eq(cashMovement.sessionId, s.id), eq(cashMovement.kind, 'paid_out')))).toHaveLength(0);
  });

  it('a read-only staff account cannot read, open, move or close a drawer', async () => {
    const phone = '+66900000077';
    await accountWithRole(phone, 'staff', { type: 'branch', id: branchId });
    const staff = await signInAs(ctx.app, phone, 'pass12345');
    const s = await openSessionAt(t1);
    expect((await ctx.app.inject({ method: 'GET', url: `/stations/${t1}/cash`, headers: { cookie: staff } })).statusCode).toBe(403);
    expect((await openAt(t2, staff)).statusCode).toBe(403);
    expect((await move(s.id, { kind: 'top_up', amountSatang: 100, reason: 'Coins' }, staff)).statusCode).toBe(403);
    const close = await ctx.app.inject({ method: 'POST', url: `/cash/sessions/${s.id}/close`, headers: { cookie: staff }, payload: { countedSatang: 0, note: 'x' } });
    expect(close.statusCode).toBe(403);
  });

  it('an action id replayed with the same body is the same movement; with another amount it is refused', async () => {
    const s = await openSessionAt(t1);
    const actionId = newId();
    const first = await move(s.id, { kind: 'top_up', amountSatang: 2_000, reason: 'Coins', actionId });
    expect(first.statusCode, first.body).toBe(200);
    const again = await move(s.id, { kind: 'top_up', amountSatang: 2_000, reason: 'Coins', actionId });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().movement.id).toBe(first.json().movement.id);
    const changed = await move(s.id, { kind: 'top_up', amountSatang: 9_000, reason: 'Coins', actionId });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('ACTION_ID_REUSED');
    expect(changed.json().error.message).toContain('already recorded as');
    expect(await ctx.db.select().from(cashMovement).where(eq(cashMovement.actionId, actionId))).toHaveLength(1);
  });

  it('two tills racing to open one drawer get exactly one session', async () => {
    const [open] = await ctx.db.select().from(cashSession).where(and(eq(cashSession.stationId, t2), eq(cashSession.status, 'open')));
    expect(open).toBeUndefined();
    const results = await Promise.all([openAt(t2), openAt(t2), openAt(t2)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, results.map((r) => r.body).join('\n')).toEqual([200, 409, 409]);
    expect(await ctx.db.select().from(cashSession).where(and(eq(cashSession.stationId, t2), eq(cashSession.status, 'open')))).toHaveLength(1);
  });
});

describe('recheck (4): refunds land on the day and the drawer the money leaves', () => {
  it('a sale filed on an earlier trading day is refunded on today’s', async () => {
    const s = await openSessionAt(t1);
    const sold = await fnbSale(t1, false, '2026-09-01');
    const [filed] = await ctx.db.select().from(sale).where(eq(sale.id, sold.saleId));
    expect(filed!.businessDate).toBe('2026-09-01');
    const r = await refundAs(sold.saleId, { mode: 'custom', amountSatang: 700 });
    expect(r.statusCode, r.body).toBe(200);
    const [row] = await ctx.db.select().from(refund).where(eq(refund.id, r.json().refund.id));
    expect(row!.businessDate).not.toBe('2026-09-01');
    const [out] = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, row!.id));
    expect(out).toMatchObject({ sessionId: s.id, kind: 'refund_out', amountSatang: 700, businessDate: row!.businessDate });
  });

  it('a card void the terminal refuses is handed back in cash: its refund_out reaches the drawer', async () => {
    const s = await openSessionAt(t1);
    const sold = await fnbSale(t1, true);
    const before = (await sessionOf(s.id)).expected.expectedSatang;
    const r = await refundAs(sold.saleId, { mode: 'whole' });
    expect(r.statusCode, r.body).toBe(200);
    const [slice] = r.json().refund.tenderAllocation as RefundAllocationEntry[];
    expect(slice).toMatchObject({ route: 'terminal_void', status: 'pending' });

    const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, sold.attemptId!));
    const [dev] = await ctx.db.select().from(device).where(eq(device.id, cardDeviceId));
    await withTx(ctx.db, { requestId: 'recheck' }, 'terminal.result', (tx) =>
      recordTerminalResult(
        tx,
        { requestId: 'recheck' },
        { attempt: attempt!, device: dev! },
        { outcome: 'declined', responseCode: '205', responseText: 'Transaction already settle' },
        slice!.actionId!,
      ),
    );
    const [row] = await ctx.db.select().from(refund).where(eq(refund.id, r.json().refund.id));
    expect(row!.tenderAllocation).toEqual([expect.objectContaining({ status: 'failed', fallback: 'cash' })]);

    // The guest was handed the money from this drawer; the drawer must say so.
    const outs = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, row!.id));
    expect(outs).toHaveLength(1);
    expect((await sessionOf(s.id)).expected.expectedSatang).toBe(before - sold.amountSatang);
  });
});
