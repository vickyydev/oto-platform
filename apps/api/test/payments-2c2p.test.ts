import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  branch,
  boxCommand,
  device,
  member,
  opsRun,
  paymentAttempt,
  paymentMethod,
  paymentNotification,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import { signJwt, type QrPaymentFacts } from '@oto/payments-2c2p';
import { loadEnv, resolveGatewayProvider } from '../src/env';
import { createJobRunner } from '../src/services/jobs';
import { buildAlertChannels } from '../src/services/ops';
import {
  POLL_BATCH,
  gatewayFor,
  gatewayStatus,
  handleNotification,
  openQrAttempt,
  pendingAttemptsQuery,
  settlePaidAttempt,
  simulateGatewayEvent,
} from '../src/services/payments/gateway';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-10a (SCRUM-206, Slice D) — THE QR TENDER, CLOUD SIDE.
 *
 * `packages/payments-2c2p` owns the wire and has its own suite. This file owns
 * what the park depends on: that a notification cannot close a sale unless it
 * is signed, ours, matched, of the right amount and confirmed by an inquiry;
 * that a second delivery of the same payment changes nothing; that every
 * refusal is answered **200** because a 4xx makes 2C2P redeliver all evening;
 * and that with the webhook suppressed entirely the poller still finds the
 * money.
 *
 * EVERY CREDENTIAL HERE IS MINTED IN THIS PROCESS. No `PGW_*` value of the
 * park's, of its sandbox merchant, or of 2C2P's public demo pair appears in
 * this repository.
 */

const SECRET = randomBytes(32).toString('hex');
const MERCHANT = 'OTOTESTMERCHANT';

let ctx: TestContext;
let cookie: string;
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

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
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

/** Open a QR tender on that sale, the way `routes/payments.ts` (Slice C2) will. */
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

/** The wire's `D(12,5)`, built here so a test never has to hardcode a price. */
function wire(amountSatang: number): string {
  return `${Math.trunc(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, '0')}000`;
}

/** One notification, exactly as the gateway would send it. */
function notification(over: Record<string, unknown>, secret = SECRET): { payload: string } {
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
      secret,
    ),
  };
}

async function post(body: unknown, query = '?t=a-path-filter-not-a-credential') {
  return ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/payment${query}`,
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

async function alertsLike(prefix: string) {
  const rows = await ctx.db.select().from(alert);
  return rows.filter((row) => row.key.startsWith(prefix));
}

/**
 * A logger that keeps what it was given, so a test can read its own log lines.
 * The same shape `telemetry.test.ts` uses, and for the same reason.
 */
function captureLogger(lines: unknown[]): Record<string, unknown> {
  const at = (level: string) => (record: unknown, msg?: string) => {
    lines.push({ level, record, msg });
  };
  const logger: Record<string, unknown> = {
    level: 'info',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    silent: () => {},
  };
  logger.child = () => logger;
  return logger;
}

/** The simulator this app instance is running, so a test can drive the gateway. */
function simulator() {
  const { qr } = gatewayFor(ctx.app.env);
  return qr as unknown as {
    apply: (invoiceNo: string, event: string, opts?: { amountSatang?: number }) => unknown;
    knows: (invoiceNo: string) => boolean;
  };
}

// --- The happy path ---------------------------------------------------------

describe('the saved QR route at the counter (SCRUM-391)', () => {
  async function withRouting(qr: 'gateway' | 'none', run: () => Promise<void>) {
    const [before] = await ctx.db.select().from(station).where(eq(station.id, stationId));
    await ctx.db.update(station).set({ paymentRouting: { qr } }).where(eq(station.id, stationId));
    try {
      await run();
    } finally {
      await ctx.db.update(station).set({ paymentRouting: before!.paymentRouting }).where(eq(station.id, stationId));
    }
  }

  function press(saleId: string, extra: Record<string, unknown> = {}, key?: string) {
    return ctx.app.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
      payload: { saleId, tender: 'qr', method: 'promptpay', kind: 'qr', ...extra },
    });
  }

  it('returns a gateway QR and expiry through the tender route and polling read', async () => {
    await withRouting('gateway', async () => {
      const { saleId, grossSatang } = await openSale();
      const actionId = newId();
      const first = await press(saleId, { actionId }, `qr:${actionId}`);
      expect(first.statusCode, first.body).toBe(200);
      const shown = first.json();
      expect(shown.route).toBe('gateway');
      expect(shown.attempt.provider).toBe('simulator');
      expect(shown.attempt.invoiceNo).toMatch(/^[A-Z0-9]{1,20}$/);
      expect(shown.qrPayload).toMatch(/^000201/);
      expect(shown.expiresAt).not.toBeNull();
      expect(shown.expiryTimerMs).toBeGreaterThan(0);
      expect(shown.outstandingSatang).toBe(grossSatang);
      expect((await attemptOf(shown.attempt.id)).deviceId).toBeNull();
      expect(await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, actionId))).toHaveLength(0);

      // A dropped-connection retry must replay the complete HTTP answer, not an intermediate write.
      const cached = await press(saleId, { actionId }, `qr:${actionId}`);
      expect(cached.statusCode, cached.body).toBe(200);
      expect(cached.json()).toEqual(shown);
      const polled = await ctx.app.inject({
        method: 'GET', url: `/payments/attempts/${shown.attempt.id}`, headers: { cookie },
      });
      expect(polled.statusCode, polled.body).toBe(200);
      expect(polled.json()).toMatchObject({
        attempt: shown.attempt, qrPayload: shown.qrPayload, qrImageUrl: shown.qrImageUrl,
        expiresAt: shown.expiresAt, outstandingSatang: grossSatang,
      });

      simulator().apply(shown.attempt.invoiceNo, 'paid');
      const paid = await post(notification({
        invoiceNo: shown.attempt.invoiceNo, amount: wire(grossSatang), tranRef: `HTTP-${actionId}`,
      }));
      expect(paid.json().outcome).toBe('settled');
      const replay = await press(saleId, { actionId });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({
        route: 'gateway', replayed: true, outstandingSatang: 0,
        attempt: { id: shown.attempt.id, status: 'approved' },
      });
      expect((await saleOf(saleId)).receiptNumber).not.toBeNull();
      expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
    });
  });

  it('keeps a press on its original gateway route when the saved routing changes', async () => {
    await withRouting('gateway', async () => {
      const { saleId } = await openSale();
      const actionId = newId();
      const first = await press(saleId, { actionId });
      expect(first.statusCode, first.body).toBe(200);
      await ctx.db.update(station).set({ paymentRouting: { qr: 'none' } }).where(eq(station.id, stationId));
      const replay = await press(saleId, { actionId });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({
        route: 'gateway', replayed: true, qrPayload: first.json().qrPayload,
        attempt: { id: first.json().attempt.id },
      });
    });
  });

  it('refuses a new QR press where the counter disables QR', async () => {
    await withRouting('none', async () => {
      const { saleId } = await openSale();
      const res = await press(saleId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('QR_DISABLED_FOR_STATION');
      expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);
    });
  });

  it.each(['disabled', 'archived'] as const)('refuses a %s payment method before creating a gateway attempt', async (state) => {
    await withRouting('gateway', async () => {
      const [method] = await ctx.db.select().from(paymentMethod).where(and(
        eq(paymentMethod.operatorId, operatorId), eq(paymentMethod.code, 'promptpay'),
      ));
      await ctx.db.update(paymentMethod).set(state === 'disabled'
        ? { enabled: false }
        : { archivedAt: new Date() }).where(eq(paymentMethod.id, method!.id));
      try {
        const { saleId } = await openSale();
        const res = await press(saleId);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
        expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);
      } finally {
        await ctx.db.update(paymentMethod).set({ enabled: method!.enabled, archivedAt: method!.archivedAt }).where(eq(paymentMethod.id, method!.id));
      }
    });
  });

  it('settles a QR already shown when its payment method is disabled afterward', async () => {
    await withRouting('gateway', async () => {
      const { saleId, grossSatang } = await openSale();
      const actionId = newId();
      const shown = await press(saleId, { actionId });
      expect(shown.statusCode, shown.body).toBe(200);
      const [method] = await ctx.db.select().from(paymentMethod).where(and(
        eq(paymentMethod.operatorId, operatorId), eq(paymentMethod.code, 'promptpay'),
      ));
      await ctx.db.update(paymentMethod).set({ enabled: false }).where(eq(paymentMethod.id, method!.id));
      try {
        simulator().apply(shown.json().attempt.invoiceNo, 'paid');
        const paid = await post(notification({
          invoiceNo: shown.json().attempt.invoiceNo, amount: wire(grossSatang), tranRef: `DISABLED-${actionId}`,
        }));
        expect(paid.json().outcome).toBe('settled');
        expect((await saleOf(saleId)).status).toBe('finalised');
        const replay = await press(saleId, { actionId });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toMatchObject({ replayed: true, outstandingSatang: 0, attempt: { status: 'approved' } });
        expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
      } finally {
        await ctx.db.update(paymentMethod).set({ enabled: method!.enabled }).where(eq(paymentMethod.id, method!.id));
      }
    });
  });

  it('cannot reuse a press for another sale or amount, or mint a second unresolved QR', async () => {
    await withRouting('gateway', async () => {
      const { saleId, grossSatang } = await openSale();
      const actionId = newId();
      expect((await press(saleId, { actionId })).statusCode).toBe(200);
      const { saleId: otherSaleId } = await openSale();
      const foreign = await press(otherSaleId, { actionId });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json().error.code).toBe('ACTION_ID_REUSED');
      const changed = await press(saleId, { actionId, amountSatang: grossSatang - 1 });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe('ACTION_ID_REUSED');
      const changedTender = await press(saleId, { actionId, tender: 'card' });
      expect(changedTender.statusCode).toBe(409);
      expect(changedTender.json().error.code).toBe('ACTION_ID_REUSED');
      const second = await press(saleId, { actionId: newId() });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('PAYMENT_IN_FLIGHT');
      expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
    });
  });
});

describe('a QR is shown, paid, and the sale closes', () => {
  it('mints one invoice number per attempt and stores the payload the display renders', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);

    expect(shown.replay).toBe(false);
    expect(shown.invoiceNo).toMatch(/^[A-Z0-9]{1,20}$/);
    expect(shown.invoiceNo).toContain('T01');
    // `RAW`: the display renders this itself and never calls the gateway.
    expect(shown.qrPayload).toMatch(/^000201/);
    expect(shown.expiresAt).not.toBeNull();
    expect(shown.expiryTimerMs).toBeGreaterThan(0);

    const row = await attemptOf(shown.attempt.id);
    expect(row.method).toBe('qr');
    expect(row.provider).toBe('simulator');
    expect(row.status).toBe('sent_to_terminal');
    expect(row.saleId).toBe(saleId);
    expect(row.businessDate).toBe(today());
    expect(row.qrPayload).toBe(shown.qrPayload);

    // The press is the key, so a retry finds the attempt rather than minting a
    // second invoice number the gateway would refuse.
    const again = await showQr(saleId, grossSatang, row.actionId!);
    expect(again.replay).toBe(true);
    expect(again.attempt.id).toBe(shown.attempt.id);
  });

  it('settles inside the sale transaction and numbers the receipt', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    simulator().apply(shown.invoiceNo, 'paid');

    const res = await post(
      notification({ invoiceNo: shown.invoiceNo, amount: wire(grossSatang), tranRef: 'TR-1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('settled');

    const attempt = await attemptOf(shown.attempt.id);
    expect(attempt.status).toBe('approved');
    expect(attempt.paidAt).not.toBeNull();
    expect(attempt.tranRef).not.toBeNull();

    const closed = await saleOf(saleId);
    expect(closed.status).toBe('finalised');
    expect(closed.receiptNumber).not.toBeNull();

    // Both halves are audited, and the gateway's half names no person.
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, shown.attempt.id));
    const settled = rows.find((r) => r.action === 'payment.settled');
    expect(settled).toBeDefined();
    expect(settled!.actorAccountId).toBeNull();
    const finalised = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.finalise')));
    expect(finalised).toHaveLength(1);
    // Closed AS the person who pressed QR — the honest answer to "who took it".
    expect(finalised[0]!.actorAccountId).toBe(accountId);
  });

  it('records the delivery as an ops_run with the raw envelope and the source address', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    simulator().apply(shown.invoiceNo, 'paid');
    await post(notification({ invoiceNo: shown.invoiceNo, amount: wire(grossSatang), tranRef: 'TR-2' }));

    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'webhook:2c2p.payment'))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect(run).toBeDefined();
    const detail = run!.detail as Record<string, unknown>;
    expect(detail.outcome).toBe('settled');
    expect(detail.sourceIp).toBeTruthy();
    expect(String(detail.envelope).split('.')).toHaveLength(3);
  });
});

// --- Idempotency -------------------------------------------------------------

describe('a second delivery of the same payment changes nothing', () => {
  it('writes one notification row, one attempt, one receipt number', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    simulator().apply(shown.invoiceNo, 'paid');
    const body = notification({
      invoiceNo: shown.invoiceNo,
      amount: wire(grossSatang),
      tranRef: 'TR-DUP',
    });

    const first = await post(body);
    const second = await post(body);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().outcome).toBe('settled');
    expect(second.json().outcome).toBe('duplicate');

    const notes = await ctx.db
      .select()
      .from(paymentNotification)
      .where(eq(paymentNotification.invoiceNo, shown.invoiceNo));
    expect(notes).toHaveLength(1);

    const receipt = (await saleOf(saleId)).receiptNumber;
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    expect(receipt).not.toBeNull();
  });

  it('dedupes on paymentID when the delivery carries no tranRef', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    simulator().apply(shown.invoiceNo, 'paid');
    const body = notification({
      invoiceNo: shown.invoiceNo,
      amount: wire(grossSatang),
      paymentID: 'ccpp_no_tranref',
    });
    expect((await post(body)).json().outcome).toBe('settled');
    expect((await post(body)).json().outcome).toBe('duplicate');
    expect(
      await ctx.db
        .select()
        .from(paymentNotification)
        .where(eq(paymentNotification.invoiceNo, shown.invoiceNo)),
    ).toHaveLength(1);
    void saleId;
  });
});

// --- Every refusal answers 200 and writes no payment ------------------------

describe('a delivery that should not have arrived', () => {
  let saleId: string;
  let invoiceNo: string;
  let attemptId: string;
  let owed: number;

  beforeEach(async () => {
    const opened = await openSale();
    saleId = opened.saleId;
    owed = opened.grossSatang;
    const shown = await showQr(opened.saleId, opened.grossSatang);
    invoiceNo = shown.invoiceNo;
    attemptId = shown.attempt.id;
  });

  const untouched = async (): Promise<void> => {
    expect((await attemptOf(attemptId)).status).toBe('sent_to_terminal');
    expect((await saleOf(saleId)).status).not.toBe('finalised');
  };

  it('refuses a bad signature with 200 and no payment', async () => {
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'X' }, randomBytes(32).toString('hex')),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('bad_signature');
    await untouched();
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, invoiceNo)),
    ).toHaveLength(0);
  });

  it('refuses another merchant with 200 and no payment', async () => {
    const res = await post(
      notification({ merchantID: 'SOMEONE_ELSE', invoiceNo, amount: wire(owed), tranRef: 'X' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('wrong_merchant');
    await untouched();
  });

  it('refuses an invoice it never issued with 200, and raises an alert', async () => {
    const res = await post(
      notification({ invoiceNo: 'T99999999999999', amount: wire(owed), tranRef: 'X' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('unmatched_payment');
    expect(await alertsLike('payments.unmatched:')).not.toHaveLength(0);
    await untouched();
  });

  it('does not match, poll or simulate a terminal invoice as a gateway payment', async () => {
    const [terminal] = await ctx.db
      .select({ id: device.id })
      .from(device)
      .where(and(eq(device.operatorId, operatorId), eq(device.kind, 'terminal')))
      .limit(1);
    const id = newId();
    const terminalInvoice = 'TERMINALONLY001';
    await ctx.db.insert(paymentAttempt).values({
      id,
      operatorId,
      branchId,
      stationId,
      deviceId: terminal!.id,
      businessDate: today(),
      method: 'qr',
      provider: 'simulator',
      status: 'sent_to_terminal',
      amountSatang: owed,
      invoiceNo: terminalInvoice,
    });
    const res = await post(
      notification({
        invoiceNo: terminalInvoice,
        amount: wire(owed),
        tranRef: 'TERMINAL-NOT-GATEWAY',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('unmatched_payment');
    expect((await attemptOf(id)).status).toBe('sent_to_terminal');
    expect(await pendingAttemptsQuery(ctx.db)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    expect((await gatewayStatus(ctx.db, ctx.app.env, operatorId)).attempts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    await expect(
      simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, {
        operatorId,
        attemptId: id,
        event: 'paid',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await ctx.db
        .select()
        .from(paymentNotification)
        .where(eq(paymentNotification.invoiceNo, terminalInvoice)),
    ).toHaveLength(0);
    await untouched();
  });

  it('settles the gateway attempt when a terminal has the same invoice text', async () => {
    const [terminal] = await ctx.db
      .select({ id: device.id })
      .from(device)
      .where(and(eq(device.operatorId, operatorId), eq(device.kind, 'terminal')))
      .limit(1);
    const id = newId();
    await ctx.db.insert(paymentAttempt).values({
      id,
      operatorId,
      branchId,
      stationId,
      deviceId: terminal!.id,
      businessDate: today(),
      method: 'qr',
      provider: 'simulator',
      status: 'sent_to_terminal',
      amountSatang: owed,
      invoiceNo,
    });
    simulator().apply(invoiceNo, 'paid');
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'GATEWAY-NAMESPACE' }),
    );
    expect(res.statusCode).toBe(200);
    expect((await attemptOf(attemptId)).status).toBe('approved');
    expect((await saleOf(saleId)).status).toBe('finalised');
    expect((await attemptOf(id)).status).toBe('sent_to_terminal');
  });

  /**
   * The CHECK on `pos.payment_notification` forbids a row with neither
   * reference. The handler has to refuse it BEFORE the insert, or the check
   * becomes a 500 inside a webhook that must answer 200.
   */
  it('refuses a delivery carrying neither reference, before the insert', async () => {
    const res = await post(notification({ invoiceNo, amount: wire(owed) }));
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('no_reference');
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, invoiceNo)),
    ).toHaveLength(0);
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'webhook:2c2p.payment'))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect((run!.detail as { outcome: string }).outcome).toBe('no_reference');
    await untouched();
  });

  it('refuses the wrong path token with 200, saying nothing about why', async () => {
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'X' }),
      '?t=wrong',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('wrong_path_token');
    await untouched();
  });

  /**
   * THE RULE IS ALWAYS 200, AND LENGTH IS NOT AN EXCEPTION. A `max()` on the
   * token's schema would make an over-long one a **400** from the validator,
   * before the handler runs — and a 400 is what makes 2C2P redeliver. It is
   * validated loosely and refused inside, like every other refusal, with the
   * `ops_run` that says it was refused.
   */
  it('refuses an over-long path token with 200 and an ops_run, not a 400', async () => {
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'X' }),
      `?t=${'x'.repeat(5000)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('wrong_path_token');

    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'webhook:2c2p.payment'))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect((run!.detail as { outcome: string }).outcome).toBe('wrong_path_token');
    expect(run!.outcome).toBe('failed');
    await untouched();
  });

  /** THE PLANTED CASE: one satang off is not a payment for this sale. */
  it('refuses an amount that is one satang short — alerted, never paid', async () => {
    simulator().apply(invoiceNo, 'paid', { amountSatang: owed - 1 });
    const res = await post(
      notification({ invoiceNo, amount: wire(owed - 1), tranRef: 'TR-OFF-BY-ONE' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('amount_mismatch');

    const attempt = await attemptOf(attemptId);
    expect(attempt.status).toBe('awaiting_staff_confirmation');
    expect(attempt.paidAt).toBeNull();
    expect((await saleOf(saleId)).status).not.toBe('finalised');
    expect((await saleOf(saleId)).receiptNumber).toBeNull();
    expect(await alertsLike('payments.amount_mismatch:')).not.toHaveLength(0);
  });

  it('refuses a currency that is not the branch currency', async () => {
    simulator().apply(invoiceNo, 'paid');
    const res = await post(
      notification({
        invoiceNo,
        amount: wire(owed),
        currencyCode: 'SGD',
        tranRef: 'TR-CURRENCY',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('currency_mismatch');
    expect((await attemptOf(attemptId)).status).toBe('awaiting_staff_confirmation');
    expect((await saleOf(saleId)).receiptNumber).toBeNull();
  });

  /**
   * AND A NOTIFICATION WITH NO CURRENCY AT ALL IS THE SAME REFUSAL. The field
   * is mandatory (`PAYMENT_GATEWAY.md:296`), so an answer without one is not
   * an answer this platform can read — and a delivery must not be able to
   * release money by leaving a field out. The gateway's own record says paid
   * here, which is what makes the point: the sale still does not close.
   */
  it('refuses a notification that carries no currency at all', async () => {
    simulator().apply(invoiceNo, 'paid');
    const res = await post(
      notification({
        invoiceNo,
        amount: wire(owed),
        currencyCode: undefined,
        tranRef: 'TR-NO-CURRENCY',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('currency_mismatch');

    const attempt = await attemptOf(attemptId);
    expect(attempt.status).toBe('awaiting_staff_confirmation');
    expect(attempt.status).not.toBe('approved');
    expect(attempt.paidAt).toBeNull();
    expect((await saleOf(saleId)).status).not.toBe('finalised');
    expect((await saleOf(saleId)).receiptNumber).toBeNull();
    expect(await alertsLike('payments.currency_mismatch:')).not.toHaveLength(0);
  });

  /**
   * `9999` IS A REPORT ABOUT US, NOT ABOUT THE PAYMENT — 2C2P saying its
   * delivery to our webhook failed. Closing the attempt on it would declare a
   * sale dead because this service was slow, so the attempt is left exactly
   * where it was and the poller goes on asking about it.
   */
  it('closes nothing on a 9999, which is about our webhook and not the payment', async () => {
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'TR-9999', respCode: '9999' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('not_paid');
    await untouched();
    expect((await attemptOf(attemptId)).paidAt).toBeNull();
  });

  /**
   * 5015 and 5016 — "the customer paid more / less". The document is explicit
   * that these NEVER mark a sale paid, and the response code alone is enough:
   * the amount on the envelope may look right.
   */
  it('refuses a 5015 outright and leaves the sale open', async () => {
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'TR-5015', respCode: '5015' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('amount_mismatch');
    const attempt = await attemptOf(attemptId);
    expect(attempt.status).toBe('awaiting_staff_confirmation');
    expect(attempt.status).not.toBe('approved');
    expect((await saleOf(saleId)).status).not.toBe('finalised');
    expect(await alertsLike('payments.amount_mismatch:')).not.toHaveLength(0);
  });

  /**
   * THE INQUIRY IS THE TRUTH. A notification that says paid against a gateway
   * whose own record does not releases nothing — which is the shape a replayed
   * message under an old key would have.
   */
  it('refuses a notification the inquiry does not agree with', async () => {
    const res = await post(
      notification({ invoiceNo, amount: wire(owed), tranRef: 'TR-LIE' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('inquiry_disagreed');
    await untouched();
    expect(await alertsLike('payments.inquiry_disagreed:')).not.toHaveLength(0);
  });

  /**
   * THE ONE RULE THE WHOLE ENDPOINT IS BUILT AROUND. A 4xx makes 2C2P
   * redeliver, so there is no body — signed, unsigned, empty, or not a
   * notification at all — that this route may refuse with one.
   */
  it('never answers anything but 200, whatever it is sent', async () => {
    const bodies: unknown[] = [
      { payload: 'not-a-jwt' },
      { payload: 'a.b.c' },
      { payload: '' },
      {},
      { notThePayloadAtAll: true },
      [],
      42,
      null,
    ];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(typeof res.json().outcome).toBe('string');
    }
    await untouched();
  });
});

// --- The poller --------------------------------------------------------------

describe('the poller is a real safety net', () => {
  /**
   * ORDER, ASSERTED ON THE QUERY RATHER THAN ON 201 ROWS. A tick reads at most
   * `POLL_BATCH` waiting attempts; newest-first would mean that on a branch
   * with more than that waiting at once, the oldest are never read at all —
   * never inquired about and never reaching the exhaustion rule either, so
   * they wait for ever while the newest are asked about again and again.
   *
   * Proving that with real rows costs 201 attempts and a sale each. The thing
   * that decides it is one clause of one query, so that is what is checked.
   */
  it('reads the waiting QRs oldest first, so a full batch cannot starve them', () => {
    const { sql: text } = pendingAttemptsQuery(ctx.db).toSQL();
    const lower = text.toLowerCase();
    expect(lower).toContain('order by');
    expect(lower).toMatch(/order by\s+"?[\w".]*created_at"?\s+asc/);
    expect(lower).not.toContain('desc');
    expect(POLL_BATCH).toBe(200);
  });

  it('reaches approved within one interval with the webhook suppressed', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);

    // The Console's fifth control: the gateway's record says paid and NOTHING
    // is posted. Only an inquiry can discover it.
    const press = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password) },
      payload: { attemptId: shown.attempt.id, event: 'suppress_webhook' },
    });
    // Reception cannot press it — that is `admin:ops:manage`.
    expect(press.statusCode).toBe(403);
    simulator().apply(shown.invoiceNo, 'suppress_webhook');

    expect((await attemptOf(shown.attempt.id)).status).toBe('sent_to_terminal');
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, shown.invoiceNo)),
    ).toHaveLength(0);

    const runner = createJobRunner({
      db: ctx.db,
      env: ctx.app.env,
      log: ctx.app.log,
      channels: buildAlertChannels('console', ctx.app.log),
    });
    expect(runner.jobs.map((j) => j.name)).toContain('job:payments.inquiry');
    expect(await runner.runJob('job:payments.inquiry', { force: true })).toBe('ok');

    expect((await attemptOf(shown.attempt.id)).status).toBe('approved');
    const closed = await saleOf(saleId);
    expect(closed.status).toBe('finalised');
    expect(closed.receiptNumber).not.toBeNull();
    // And it settled with no notification row at all — the webhook never ran.
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, shown.invoiceNo)),
    ).toHaveLength(0);
  });

  it('flags a tender nobody answered, and clears the flag when it is answered', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    // Older than PAYMENT_PENDING_MIN, without waiting ten minutes.
    await ctx.db
      .update(paymentAttempt)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(paymentAttempt.id, shown.attempt.id));

    const runner = createJobRunner({
      db: ctx.db,
      env: ctx.app.env,
      log: ctx.app.log,
      channels: buildAlertChannels('console', ctx.app.log),
    });
    expect(await runner.runJob('job:payments.pending', { force: true })).toBe('ok');
    const raised = (await alertsLike('payments.pending:')).filter((row) => row.resolvedAt === null);
    expect(raised).not.toHaveLength(0);

    // Answer it, and the condition closes itself.
    simulator().apply(shown.invoiceNo, 'paid');
    await post(notification({ invoiceNo: shown.invoiceNo, amount: wire(grossSatang), tranRef: 'TR-LATE-FLAG' }));
    expect(await runner.runJob('job:payments.pending', { force: true })).toBe('ok');
    const stillOpen = (await alertsLike('payments.pending:')).filter((row) => row.resolvedAt === null);
    expect(stillOpen).toHaveLength(0);
    void saleId;
  });
});

// --- What day the money lands in ---------------------------------------------

/**
 * `paid_at` FEEDS END OF DAY (S2-15a), so the instant written on it decides
 * which business day a payment is counted in. `transactionDateTime` arrives as
 * `yyyyMMddHHmmss` with no time zone stated anywhere in `PAYMENT_GATEWAY.md`
 * (`:297`, `:349`), so it is kept as the string it arrived as and the platform
 * dates the payment by the clock it actually witnessed.
 */
describe('a payment is dated by our clock, not by the gateway stamp', () => {
  it('writes paid_at as the moment we saw it and keeps the gateway stamp beside it', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    const attempt = await attemptOf(shown.attempt.id);

    // A stamp years in the past: whatever zone it is in, it is not now.
    const facts: QrPaymentFacts = {
      state: 'paid',
      respCode: '0000',
      respDesc: 'Successful',
      invoiceNo: shown.invoiceNo,
      amountSatang: grossSatang,
      currencyCode: 'THB',
      tranRef: 'TR-STAMP',
      paymentId: null,
      approvalCode: null,
      channelCode: 'PPQR',
      agentCode: 'SIM',
      transactionDateTime: '20200101000000',
      raw: {},
    };

    const before = new Date();
    const settled = await settlePaidAttempt(ctx.db, ctx.app.env, ctx.app.log, {
      attempt,
      facts,
      source: 'inquiry',
    });
    expect(settled.outcome).toBe('settled');

    const row = await attemptOf(shown.attempt.id);
    expect(row.status).toBe('approved');
    expect(row.paidAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // Not the 2020 stamp, and not a day away from the one the branch is in.
    expect(row.paidAt!.getUTCFullYear()).toBe(before.getUTCFullYear());
    // The gateway's own stamp is not lost — it is kept unparsed, for support.
    expect((row.payload as { gatewayStamp?: string }).gatewayStamp).toBe('20200101000000');
  });
});

// --- The simulator panel, and what it proves ---------------------------------

describe('the Console simulator drives the real path', () => {
  let adminCookie: string;

  beforeAll(async () => {
    const { ADMIN } = await import('./helpers');
    adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  });

  it('reports which gateway is live, by name, with no value of any variable', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('simulator');
    expect(body.simulatorAvailable).toBe(true);
    expect(body.channelCode).toBe('PPQR');
    expect(body.webhookSecretSet).toBe(true);
    // Presence flags only. The secret itself must be nowhere in the answer.
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('a-path-filter-not-a-credential');
  });

  it('a press signs a notification and closes the sale through the webhook', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
      payload: { attemptId: shown.attempt.id, event: 'paid' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().webhookOutcome).toBe('settled');

    expect((await attemptOf(shown.attempt.id)).status).toBe('approved');
    expect((await saleOf(saleId)).receiptNumber).not.toBeNull();
    // It went through the REAL route: there is a notification row for it.
    expect(
      await ctx.db.select().from(paymentNotification).where(eq(paymentNotification.invoiceNo, shown.invoiceNo)),
    ).toHaveLength(1);
  });

  it('expire and decline close the attempt without money', async () => {
    for (const event of ['expire', 'decline'] as const) {
      const { saleId, grossSatang } = await openSale();
      const shown = await showQr(saleId, grossSatang);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/webhooks/2c2p/simulator',
        headers: { cookie: adminCookie },
        payload: { attemptId: shown.attempt.id, event },
      });
      expect(res.statusCode, res.body).toBe(200);
      const attempt = await attemptOf(shown.attempt.id);
      expect(attempt.status, event).toBe('cancelled');
      expect(attempt.paidAt).toBeNull();
      if (event === 'expire') {
        expect((attempt.payload as { expired?: boolean }).expired).toBe(true);
      }
      expect((await saleOf(saleId)).receiptNumber).toBeNull();
    }
  });

  it('a late payment waits for a person rather than closing the sale', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
      payload: { attemptId: shown.attempt.id, event: 'late_paid' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().webhookOutcome).toBe('late_paid');
    expect((await attemptOf(shown.attempt.id)).status).toBe('awaiting_staff_confirmation');
    expect((await saleOf(saleId)).receiptNumber).toBeNull();
    expect(await alertsLike('payments.late_payment:')).not.toHaveLength(0);
  });
});

// --- No secret reaches a log, a record or an answer --------------------------

describe('the secret never leaves the process', () => {
  /**
   * THE PLANT'S SECOND HALF. A `PGW_SECRET_KEY` in a log line, an `ops_run`
   * detail, an audit row or an HTTP answer is a live credential in a hosted
   * log stream, and this is what fails when one gets there.
   */
  it('appears in no ops_run, no audit row and no response body', async () => {
    const { saleId, grossSatang } = await openSale();
    const shown = await showQr(saleId, grossSatang);
    simulator().apply(shown.invoiceNo, 'paid');
    const res = await post(
      notification({ invoiceNo: shown.invoiceNo, amount: wire(grossSatang), tranRef: 'TR-SECRET' }),
    );
    expect(res.body).not.toContain(SECRET);

    const runs = await ctx.db.select().from(opsRun).limit(500);
    expect(JSON.stringify(runs)).not.toContain(SECRET);
    const audits = await ctx.db.select().from(auditLog).limit(500);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    const attempts = await ctx.db.select().from(paymentAttempt).limit(500);
    expect(JSON.stringify(attempts)).not.toContain(SECRET);
    const notes = await ctx.db.select().from(paymentNotification).limit(500);
    expect(JSON.stringify(notes)).not.toContain(SECRET);
    void saleId;
  });

  /**
   * AND NOT A LOG LINE EITHER.
   *
   * Pino writes to a file descriptor, so a test cannot read the api's own
   * stream back (`telemetry.test.ts` says the same). The gateway service takes
   * its logger as an argument, though, so the whole path — the mint, the
   * announcement, the delivery, the internal-failure branch — can be driven
   * through a capturing one and every binding it wrote inspected whole.
   */
  it('never reaches a log line', async () => {
    const lines: unknown[] = [];
    const log = captureLogger(lines);
    const { saleId, grossSatang } = await openSale();
    const shown = await openQrAttempt(
      ctx.db,
      ctx.app.env,
      log as never,
      { operatorId, branchId },
      {
        operatorId,
        branchId,
        saleId,
        stationId,
        businessDate: today(),
        amountSatang: grossSatang,
        accountId,
      },
    );
    simulator().apply(shown.invoiceNo, 'paid');
    await handleNotification(ctx.db, ctx.app.env, log as never, {
      body: notification({
        invoiceNo: shown.invoiceNo,
        amount: wire(grossSatang),
        tranRef: 'TR-LOGGED',
      }),
      sourceIp: '203.0.113.7',
      headers: { 'user-agent': 'test' },
      requestId: 'test-log-capture',
      pathTokenOk: true,
    });
    // It has to have written something, or the assertion under it is empty.
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('is absent from the status the Console reads', async () => {
    const { ADMIN } = await import('./helpers');
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/webhooks/2c2p/simulator',
      headers: { cookie: adminCookie },
    });
    expect(res.body).not.toContain(SECRET);
  });
});

// --- The boot refusal ---------------------------------------------------------

describe('a production deployment will not quietly run a pretend gateway', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    DEPLOY_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@db.example.com:5432/oto',
    COOKIE_SECURE: 'true',
    OPS_TEST_CONTROLS: 'false',
    SEED_PROFILE: 'production',
    SMS_ADAPTER: 'twilio',
    MINIO_ENDPOINT: 'account.r2.cloudflarestorage.com',
    MINIO_PORT: '443',
    MINIO_USE_SSL: 'true',
    MINIO_ACCESS_KEY: 'not-the-dev-default',
    MINIO_SECRET_KEY: 'not-the-dev-default',
  } as const;

  it('refuses to boot with PGW_PROVIDER=2c2p and no credentials', () => {
    expect(() =>
      loadEnv({ ...productionEnv, PGW_PROVIDER: '2c2p', PGW_MERCHANT_ID: '', PGW_SECRET_KEY: '' }),
    ).toThrow(/PGW_MERCHANT_ID and PGW_SECRET_KEY/);
  });

  it('refuses to boot with the simulator chosen outright', () => {
    expect(() => loadEnv({ ...productionEnv, PGW_PROVIDER: 'simulator' })).toThrow(
      /PGW_PROVIDER is simulator/,
    );
  });

  it('names only the variable that is missing, never a value', () => {
    let message = '';
    try {
      loadEnv({ ...productionEnv, PGW_PROVIDER: '2c2p', PGW_MERCHANT_ID: 'M1', PGW_SECRET_KEY: '' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('PGW_SECRET_KEY');
    expect(message).not.toContain('PGW_MERCHANT_ID is unset');
    expect(message).not.toContain('M1');
  });

  it('accepts a complete production configuration', () => {
    expect(() =>
      loadEnv({
        ...productionEnv,
        PGW_PROVIDER: '2c2p',
        PGW_ENV: 'production',
        PGW_MERCHANT_ID: 'M1',
        PGW_SECRET_KEY: 'k'.repeat(32),
      }),
    ).not.toThrow();
  });

  /**
   * The narrowing, from the other side: everywhere that is not a live park,
   * a missing credential still selects the simulator rather than stopping a
   * developer or CI. What it must never do is stay quiet about it, and the
   * startup line is what `resolveGatewayProvider` produces.
   */
  it('lets a local deployment fall back, and says which variables are unset', () => {
    const env = loadEnv({
      DEPLOY_ENV: 'local',
      NODE_ENV: 'test',
      PGW_PROVIDER: '2c2p',
      PGW_MERCHANT_ID: '',
      PGW_SECRET_KEY: '',
    });
    const selection = resolveGatewayProvider(env);
    expect(selection.provider).toBe('simulator');
    expect(selection.fellBack).toBe(true);
    expect(selection.missingVars).toEqual(['PGW_MERCHANT_ID', 'PGW_SECRET_KEY']);
    expect(selection.reason).toContain('No QR shown here is a real payment instruction');
  });

  it('refuses an invoice prefix the gateway would not accept', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', PGW_INVOICE_PREFIX: 'TOOLONG' })).toThrow(
      /PGW_INVOICE_PREFIX/,
    );
    expect(() => loadEnv({ NODE_ENV: 'test', PGW_INVOICE_PREFIX: 'SB-1' })).toThrow(
      /PGW_INVOICE_PREFIX/,
    );
    expect(() => loadEnv({ NODE_ENV: 'test', PGW_INVOICE_PREFIX: 'SBX' })).not.toThrow();
  });
});
