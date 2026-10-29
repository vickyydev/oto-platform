import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  branch,
  member,
  opsRun,
  paymentAttempt,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import { signJwt } from '@oto/payments-2c2p';
import {
  gatewayFor,
  openQrAttempt,
  pendingAttemptsQuery,
} from '../src/services/payments/gateway';
import { scrubDetail } from '../src/services/ops';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * ABANDONING A PENDING QR FROM THE TILL (`POST /payments/attempts/:id/cancel`).
 *
 * A guest who walks away from a PromptPay QR used to leave the till stuck: the
 * payment stage was locked while the attempt was pending, the sale could not
 * be voided around it (`PAYMENT_IN_FLIGHT`), and nothing but the gateway's own
 * expiry freed it. This file pins the way out and, more importantly, what the
 * way out may NOT do: it never cancels money, it never hides a payment that a
 * person has to look at, it never touches a terminal's tender, and a payment
 * the gateway reports after the cancel is treated as the late payment it is —
 * through the path that already existed for an expired QR.
 *
 * EVERY CREDENTIAL HERE IS MINTED IN THIS PROCESS.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let timezone: string;
let dayStart: string;
let twoHoursId: string;
let jamesId: string;
let accountId: string;

const today = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: MERCHANT,
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  timezone = hkt.timezone;
  dayStart = hkt.businessDayStart;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;

  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
  accountId = me.json().account.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------

/** A committed, unfinalised sale, and what it owes. */
async function openSale(): Promise<{ saleId: string; grossSatang: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId,
      memberId: jamesId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  return { saleId, grossSatang: row!.grossSatang };
}

/** A QR on the display for that sale, the way the till's press opens it. */
async function showQr(saleId: string, grossSatang: number, actionId = newId()) {
  return openQrAttempt(
    ctx.db,
    ctx.app.env,
    ctx.app.log,
    { operatorId, branchId, requestId: `test-${actionId}` },
    {
      operatorId,
      branchId,
      saleId,
      stationId,
      businessDate: today(),
      amountSatang: grossSatang,
      methodCode: 'promptpay',
      actionId,
      accountId,
      description: 'OTO Park admission',
    },
  );
}

/** The till's press of Cancel on a pending QR. */
function cancel(attemptId: string, extra: { key?: string; actionId?: string; reason?: string } = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/payments/attempts/${attemptId}/cancel`,
    headers: {
      cookie,
      ...(extra.key ? { 'idempotency-key': extra.key } : {}),
      ...(extra.actionId ? { 'x-oto-action-id': extra.actionId } : {}),
    },
    payload: extra.reason ? { reason: extra.reason } : {},
  });
}

function voidSale(saleId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/void`,
    headers: { cookie },
    payload: { reason: 'Guest walked away from the QR' },
  });
}

/** The wire's `D(12,5)`, built here so a test never has to hardcode a price. */
function wire(amountSatang: number): string {
  return `${Math.trunc(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, '0')}000`;
}

/** One notification, exactly as the gateway would send it. */
function notification(over: Record<string, unknown>): { payload: string } {
  return {
    payload: signJwt(
      {
        merchantID: MERCHANT,
        currencyCode: 'THB',
        transactionDateTime: '20260923101500',
        agentCode: 'SCB',
        channelCode: 'PPQR',
        respCode: '0000',
        respDesc: 'Successful',
        ...over,
      },
      SECRET,
    ),
  };
}

function postNotification(body: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url: '/webhooks/2c2p/payment?t=a-path-filter-not-a-credential',
    payload: body as never,
  });
}

async function attemptOf(id: string) {
  const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id));
  return row!;
}

async function saleOf(id: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, id));
  return row!;
}

async function auditRowsOf(attemptId: string, action: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, attemptId), eq(auditLog.action, action)));
}

/** The simulator this app instance is running, so a test can drive the gateway. */
function simulator() {
  const { qr } = gatewayFor(ctx.app.env);
  return qr as unknown as {
    apply: (invoiceNo: string, event: string, opts?: { amountSatang?: number }) => unknown;
    inquire: (input: { invoiceNo: string }) => Promise<{ state: string }>;
  };
}

// --- The way out -------------------------------------------------------------

describe('staff abandon a pending gateway QR', () => {
  it('closes the attempt as cancelled, audited with the account, tells the gateway, and frees the sale to be voided', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    expect((await attemptOf(shown.attempt.id)).status).toBe('sent_to_terminal');
    // The till could not void around it before.
    const blocked = await voidSale(saleId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('PAYMENT_IN_FLIGHT');

    const actionId = newId();
    const res = await cancel(shown.attempt.id, { key: `cancel:${actionId}`, actionId, reason: 'Guest walked away' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      replayed: false,
      outstandingSatang: grossSatang,
      attempt: { id: shown.attempt.id, status: 'cancelled', paidAt: null },
    });

    const row = await attemptOf(shown.attempt.id);
    expect(row.status).toBe('cancelled');
    expect(row.paidAt).toBeNull();
    const payload = row.payload as {
      cancelledBy?: { accountId?: string; reason?: string };
      gatewayCancel?: { accepted?: boolean };
      expired?: boolean;
      takenByAccountId?: string;
    };
    // Which of the two `cancelled` it is, beside decision D-3's `expired`.
    expect(payload.cancelledBy).toMatchObject({ accountId, reason: 'Guest walked away' });
    expect(payload.expired).toBeUndefined();
    // The note on the attempt was merged, never assigned over what opened it.
    expect(payload.takenByAccountId).toBe(accountId);
    // The gateway was told, best effort, and its answer recorded.
    expect(payload.gatewayCancel).toMatchObject({ accepted: true });
    expect((await simulator().inquire({ invoiceNo: shown.invoiceNo })).state).toBe('cancelled');
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'adapter:2c2p.cancel'))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect(run).toMatchObject({ outcome: 'ok', actionId });
    // The invoice as the record keeps it: every run's detail passes the one
    // redactor, which masks any 14-19 digit run that passes the card checksum,
    // so the trading day decides (the first number of 30 Oct 2026 is masked).
    expect((run!.detail as { invoiceNo: string; accepted: boolean })).toMatchObject(
      scrubDetail({ invoiceNo: shown.invoiceNo, accepted: true }) as Record<string, unknown>,
    );

    // Audited, by the person who pressed it.
    const audited = await auditRowsOf(shown.attempt.id, 'payment.qr.cancel');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorAccountId: accountId, actionId });
    expect(audited[0]!.before).toEqual({ status: 'sent_to_terminal' });
    expect(audited[0]!.after).toMatchObject({ status: 'cancelled', saleId, reason: 'Guest walked away' });

    // Out of the poller's set: nothing will ask the gateway about it again.
    expect((await pendingAttemptsQuery(ctx.db)).map((a) => a.id)).not.toContain(shown.attempt.id);

    // And the sale is the till's again: unpaid, open, and voidable.
    expect((await saleOf(saleId)).status).toBe('tendering');
    const voided = await voidSale(saleId);
    expect(voided.statusCode, voided.body).toBe(200);
    expect((await saleOf(saleId)).status).toBe('voided');
  });

  it('a second press answers the same: the stored answer under the same key, a replay under a new one', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    const actionId = newId();
    const first = await cancel(shown.attempt.id, { key: `cancel:${actionId}`, actionId });
    expect(first.statusCode, first.body).toBe(200);

    // A dropped-connection retry: the same key replays the complete answer.
    const retried = await cancel(shown.attempt.id, { key: `cancel:${actionId}`, actionId });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toEqual(first.json());

    // A fresh press on a QR staff already cancelled writes nothing and says so.
    const again = await cancel(shown.attempt.id, { key: `cancel:${newId()}` });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json()).toMatchObject({ replayed: true, attempt: { id: shown.attempt.id, status: 'cancelled' } });

    expect(await auditRowsOf(shown.attempt.id, 'payment.qr.cancel')).toHaveLength(1);
    expect((await attemptOf(shown.attempt.id)).status).toBe('cancelled');
  });
});

// --- What it refuses ---------------------------------------------------------

describe('what a cancel may not do', () => {
  it('refuses a paid QR: the money stays on the sale and the sale stays closed', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    simulator().apply(shown.invoiceNo, 'paid');
    const paid = await postNotification(
      notification({ invoiceNo: shown.invoiceNo, amount: wire(grossSatang), tranRef: `TR-${newId()}` }),
    );
    expect(paid.json().outcome).toBe('settled');

    const res = await cancel(shown.attempt.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ATTEMPT_ALREADY_PAID');
    expect((await attemptOf(shown.attempt.id)).status).toBe('approved');
    expect((await saleOf(saleId)).status).toBe('finalised');
    expect(await auditRowsOf(shown.attempt.id, 'payment.qr.cancel')).toHaveLength(0);
  });

  it('refuses a QR the gateway has already closed, and one that waits for a person', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    const expired = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
      payload: { attemptId: shown.attempt.id, event: 'expire' },
    });
    expect(expired.statusCode, expired.body).toBe(200);
    expect((await attemptOf(shown.attempt.id)).status).toBe('cancelled');

    // Closed by the gateway's clock, not by staff: nothing here to cancel.
    const closed = await cancel(shown.attempt.id);
    expect(closed.statusCode, closed.body).toBe(409);
    expect(closed.json().error.code).toBe('ATTEMPT_CLOSED');

    const other = await openSale();
    const late = await showQr(other.saleId, other.grossSatang);
    const flagged = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
      payload: { attemptId: late.attempt.id, event: 'late_paid' },
    });
    expect(flagged.json().webhookOutcome).toBe('late_paid');
    expect((await attemptOf(late.attempt.id)).status).toBe('awaiting_staff_confirmation');
    const needsAPerson = await cancel(late.attempt.id);
    expect(needsAPerson.statusCode, needsAPerson.body).toBe(409);
    expect(needsAPerson.json().error.code).toBe('ATTEMPT_NEEDS_A_PERSON');
    expect((await attemptOf(late.attempt.id)).status).toBe('awaiting_staff_confirmation');
  });

  it('refuses a tender that is not a gateway QR, and answers 404 for an attempt that is not there', async () => {
    const { saleId } = await openSale();
    const manual = await ctx.app.inject({
      method: 'POST',
      url: '/payments/manual',
      headers: { cookie },
      payload: { saleId, approvalCode: 'A1B2C3', tid: 'TID-TEST', actionId: newId() },
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const res = await cancel(manual.json().attempt.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ATTEMPT_NOT_A_GATEWAY_QR');
    expect((await attemptOf(manual.json().attempt.id)).status).toBe('approved');

    const missing = await cancel(newId());
    expect(missing.statusCode).toBe(404);
  });
});

// --- Money that arrives after the cancel ------------------------------------

describe('a payment the gateway reports after the cancel', () => {
  it('a late notification takes the existing late-paid path: the attempt waits for a person and the sale is not closed', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    expect((await cancel(shown.attempt.id)).statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
      payload: { attemptId: shown.attempt.id, event: 'late_paid' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().webhookOutcome).toBe('late_paid');
    expect((await attemptOf(shown.attempt.id)).status).toBe('awaiting_staff_confirmation');
    expect((await saleOf(saleId)).status).toBe('tendering');
    expect((await saleOf(saleId)).receiptNumber).toBeNull();
    const raised = (await ctx.db.select().from(alert)).filter((row) => row.key === `payments.late_payment:${shown.attempt.id}`);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'critical', subject: 'A QR was paid after it was cancelled' });

    // Money may have moved: the sale is no longer voidable around it.
    const voided = await voidSale(saleId);
    expect(voided.statusCode).toBe(409);
    expect(voided.json().error.code).toBe('PAYMENT_IN_FLIGHT');
  });

  it('a plain "paid" against a cancelled QR is late by our clock and takes the same path, never settling the sale', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    expect((await cancel(shown.attempt.id)).statusCode).toBe(200);

    // The gateway kept the QR alive and the guest scanned it on the way out.
    simulator().apply(shown.invoiceNo, 'paid');
    const res = await postNotification(
      notification({ invoiceNo: shown.invoiceNo, amount: wire(grossSatang), tranRef: `TR-${newId()}` }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('late_paid');
    expect((await attemptOf(shown.attempt.id)).status).toBe('awaiting_staff_confirmation');
    expect((await saleOf(saleId)).status).toBe('tendering');
    expect((await saleOf(saleId)).receiptNumber).toBeNull();
    expect(await auditRowsOf(shown.attempt.id, 'payment.settled')).toHaveLength(0);
  });
});
