import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QrPayment, RefundInput } from '@oto/payments-2c2p';
import { account, box, branch, cashMovement, cashSession, device, paymentAttempt, product, refund, sale, station } from '@oto/db';
import { newId, type CashSessionView, type RefundAllocationEntry } from '@oto/shared';
import { recordTerminalResult } from '../src/services/payments/terminal';
import { refundSale, settleGatewayRefunds, type RefundActor } from '../src/services/refunds';
import { withTx } from '../src/services/tx';
import {
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15a round 1 — THE GATE's FINAL CHECK, its own reproductions.
 *
 *   (a) a gateway QR refund whose answer comes back LATER as a refusal is
 *       handed back in cash: one refund_out on the paying drawer, and the
 *       refusal delivered again (in sequence and racing) writes nothing more;
 *   (b) the terminal's refusal of a card void delivered twice, and racing,
 *       writes exactly one refund_out;
 *   in both, expected cash equals the hand sum.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let managerAccountId: string;
let operatorId: string;
let branchId: string;
let t1: string;
let friesId: string;
let cardDeviceId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [mgr] = await ctx.db
    .select()
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, BRANCH_MANAGER.phone)));
  managerAccountId = mgr!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  t1 = till!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, till!.boxId!));
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

const sessionOf = async (id: string): Promise<CashSessionView> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/cash/sessions/${id}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CashSessionView;
};
const openSessionAt = async (stationId: string): Promise<CashSessionView> => {
  const [open] = await ctx.db
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.stationId, stationId), eq(cashSession.status, 'open')));
  if (open) return sessionOf(open.id);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/stations/${stationId}/cash/sessions`,
    headers: { cookie: reception },
    payload: { actionId: newId() },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { session: CashSessionView }).session;
};

/** An F&B sale at T1 paid by a non-cash attempt (`card` on EDC 1, or a gateway `qr` with an invoice). */
async function nonCashSale(kind: 'card' | 'qr'): Promise<{ saleId: string; amountSatang: number; attemptId: string }> {
  const saleId = newId();
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId: t1, channel: 'fnb', pickupCode: '9', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
  });
  expect(made.statusCode, made.body).toBe(200);
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  const attemptId = newId();
  await ctx.db.insert(paymentAttempt).values({
    id: attemptId,
    operatorId,
    branchId,
    saleId,
    stationId: t1,
    businessDate: row!.businessDate,
    status: 'approved',
    amountSatang: row!.grossSatang,
    paidAt: new Date(),
    ...(kind === 'card'
      ? {
          deviceId: cardDeviceId,
          method: 'card' as const,
          methodCode: 'card',
          provider: 'simulator',
          tranRef: `TR${attemptId.slice(-8)}`,
          approvalCode: 'A1B2C3',
          last4: '4242',
          payload: { tender: 'card' },
        }
      : {
          method: 'qr' as const,
          methodCode: 'promptpay',
          provider: 'simulator',
          invoiceNo: `FIN${attemptId.slice(-10).toUpperCase()}`,
        }),
  });
  const paid = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(paid.statusCode, paid.body).toBe(200);
  return { saleId, amountSatang: row!.grossSatang, attemptId };
}

/** A gateway that refuses every refund, counting how often it was asked. */
function refusingGateway(): { qr: QrPayment; calls: RefundInput[] } {
  const calls: RefundInput[] = [];
  const qr = {
    provider: 'simulator',
    refund: async (input: RefundInput) => {
      calls.push(input);
      return { state: 'failed', respCode: '99', respDesc: 'Refused by the acquirer', providerRefundRef: null };
    },
  } as unknown as QrPayment;
  return { qr, calls };
}

describe('final (a): a gateway refund refused LATER is handed back in cash, once', () => {
  it('the refusal arriving after the commit writes one refund_out on the paying drawer; re-delivered and racing, nothing more', async () => {
    const s = await openSessionAt(t1);
    const sold = await nonCashSale('qr');
    const before = (await sessionOf(s.id)).expected;

    // The refund commits with its gateway slice pending — the gateway is not called inside it.
    const actor: RefundActor = {
      accountId: managerAccountId,
      operatorId,
      stationId: t1,
      requestId: 'final-a',
      assertBranchAllowed: async () => {},
      assertCanApprove: async () => {},
    };
    const made = await withTx(ctx.db, { requestId: 'final-a' }, 'sale.refund', (tx) =>
      refundSale(tx, actor, sold.saleId, { mode: 'custom', amountSatang: 1_750, reason: 'Final' }),
    );
    const refundId = made.refund.id;
    expect(made.refund.tenderAllocation).toEqual([expect.objectContaining({ route: 'gateway_refund', status: 'pending' })]);
    expect(await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, refundId))).toHaveLength(0);
    expect((await sessionOf(s.id)).expected.expectedSatang).toBe(before.expectedSatang);

    // LATER: the gateway refuses.
    const gw = refusingGateway();
    await settleGatewayRefunds(ctx.db, { requestId: 'final-a-1' }, refundId, gw.qr);
    expect(gw.calls.length).toBeGreaterThan(0);
    const [row] = await ctx.db.select().from(refund).where(eq(refund.id, refundId));
    expect(row!.tenderAllocation).toEqual([expect.objectContaining({ status: 'failed', fallback: 'cash' })]);
    const outs = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, refundId));
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ sessionId: s.id, stationId: t1, kind: 'refund_out', amountSatang: 1_750, actorAccountId: managerAccountId });

    // The same answer delivered again, in sequence and then racing: nothing more.
    await settleGatewayRefunds(ctx.db, { requestId: 'final-a-2' }, refundId, refusingGateway().qr);
    await Promise.all([
      settleGatewayRefunds(ctx.db, { requestId: 'final-a-3' }, refundId, refusingGateway().qr),
      settleGatewayRefunds(ctx.db, { requestId: 'final-a-4' }, refundId, refusingGateway().qr),
    ]);
    expect(await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, refundId))).toHaveLength(1);

    // Hand sum: nothing came in for the QR sale; 1,750 satang went out.
    const after = (await sessionOf(s.id)).expected;
    expect(after.cashInSatang).toBe(before.cashInSatang);
    expect(after.refundOutSatang).toBe(before.refundOutSatang + 1_750);
    expect(after.expectedSatang).toBe(before.expectedSatang - 1_750);
  });

  it('two refusals of one pending gateway slice racing each other write one refund_out', async () => {
    const s = await openSessionAt(t1);
    const sold = await nonCashSale('qr');
    const before = (await sessionOf(s.id)).expected.expectedSatang;
    const actor: RefundActor = {
      accountId: managerAccountId,
      operatorId,
      stationId: t1,
      requestId: 'final-a-race',
      assertBranchAllowed: async () => {},
      assertCanApprove: async () => {},
    };
    const made = await withTx(ctx.db, { requestId: 'final-a-race' }, 'sale.refund', (tx) =>
      refundSale(tx, actor, sold.saleId, { mode: 'whole', reason: 'Final' }),
    );
    await Promise.all([
      settleGatewayRefunds(ctx.db, { requestId: 'race-1' }, made.refund.id, refusingGateway().qr),
      settleGatewayRefunds(ctx.db, { requestId: 'race-2' }, made.refund.id, refusingGateway().qr),
    ]);
    const outs = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, made.refund.id));
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ sessionId: s.id, amountSatang: sold.amountSatang });
    expect((await sessionOf(s.id)).expected.expectedSatang).toBe(before - sold.amountSatang);
  });
});

describe('final (b): the terminal’s refused void delivered twice writes one refund_out', () => {
  it('in sequence and racing, one refund_out on the paying drawer; expected cash is the hand sum', async () => {
    const s = await openSessionAt(t1);
    const sold = await nonCashSale('card');
    const before = (await sessionOf(s.id)).expected;
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${sold.saleId}/refunds`,
      headers: { cookie: manager },
      payload: { reason: 'Final', mode: 'whole' },
    });
    expect(r.statusCode, r.body).toBe(200);
    const refundId = r.json().refund.id as string;
    const [slice] = r.json().refund.tenderAllocation as RefundAllocationEntry[];
    expect(slice).toMatchObject({ route: 'terminal_void', status: 'pending' });
    // Pending: nothing has left the drawer yet.
    expect(await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, refundId))).toHaveLength(0);

    const deliver = async (requestId: string) => {
      const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, sold.attemptId));
      const [dev] = await ctx.db.select().from(device).where(eq(device.id, cardDeviceId));
      await withTx(ctx.db, { requestId }, 'terminal.result', (tx) =>
        recordTerminalResult(
          tx,
          { requestId },
          { attempt: attempt!, device: dev! },
          { outcome: 'declined', responseCode: '205', responseText: 'Transaction already settle' },
          slice!.actionId!,
        ),
      );
    };
    await deliver('void-1');
    await deliver('void-2');
    await Promise.all([deliver('void-3'), deliver('void-4')]);

    const outs = await ctx.db.select().from(cashMovement).where(eq(cashMovement.refundId, refundId));
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ sessionId: s.id, stationId: t1, kind: 'refund_out', amountSatang: sold.amountSatang });
    const [row] = await ctx.db.select().from(refund).where(eq(refund.id, refundId));
    expect(row!.tenderAllocation).toEqual([expect.objectContaining({ status: 'failed', fallback: 'cash' })]);

    const after = (await sessionOf(s.id)).expected;
    expect(after.cashInSatang).toBe(before.cashInSatang);
    expect(after.expectedSatang).toBe(before.expectedSatang - sold.amountSatang);
  });
});
