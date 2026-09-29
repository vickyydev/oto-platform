import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { paymentAttempt, paymentNotification, sale, station, type Db } from '@oto/db';
import { buildInvoiceNo, newId, type PaymentAttemptStatus, type PaymentAttemptView } from '@oto/shared';
import {
  GATEWAY_STATE_TO_ATTEMPT_STATUS,
  JwtSignatureError,
  QR_TERMINAL_STATES,
  SimulatorQrPayment,
  TwoC2PQrPayment,
  decodeUnverified,
  factsOf,
  isAboutTheMerchant,
  isAmountMismatch,
  isDuplicateInvoice,
  payloadOf,
  signJwt,
  verifyJwt,
  type CreateQrResult,
  type GatewayConfig,
  type QrPayment,
  type QrPaymentFacts,
  type SimulatorEvent,
} from '@oto/payments-2c2p';
import { resolveGatewayProvider, type Env, type GatewaySelection } from '../../env';
import { errors } from '../../lib/errors';
import { audit } from '../audit';
import { raiseAlert, recordRun, resolveAlert } from '../ops';
import { finaliseSale, type ActorContext } from '../sale';
import { assertSaleVouchersHeld } from '../vouchers';
import {
  attemptView,
  failAttempt,
  findAttemptByAction,
  openAttempt,
  outstandingAfter,
  settleAttempt,
  tenderMethodOf,
  type AttemptRow,
} from './attempt';
import { withTx, type OpContext, type Tx } from '../tx';

/**
 * THE QR TENDER, CLOUD SIDE (S2-10a, SCRUM-206, Slice D).
 *
 * `packages/payments-2c2p` knows 2C2P; this file knows the park. It mints an
 * attempt, asks the package for a QR, reads what the gateway says about it,
 * and settles the sale — and it is the ONLY file in `apps/api` that imports
 * that package, which is what keeps `PAYMENT_GATEWAY.md:571-573` true.
 *
 * FOUR RULES THIS FILE EXISTS TO ENFORCE, each of which is a way a park loses
 * money if it is written anywhere else:
 *
 * 1. **A notification is a trigger, not the truth.** Anything claiming a
 *    payment is followed by a Payment Inquiry on the same `invoiceNo`, and the
 *    two have to agree before a sale closes (`:668-670`). It costs one call
 *    and it is the difference between a signed message and a fact.
 * 2. **Paid means the amount AND the currency match.** A `0000` carrying a
 *    different figure is not a payment for this sale; it is an amount mismatch,
 *    it raises an alert, and a person deals with it (`:612-613`).
 * 3. **The webhook answers 200 within a second, always — even refusing.** A
 *    4xx there is a bug, not a defence: 2C2P retries, and a park whose webhook
 *    answers 400 to something it could not match gets it again all evening.
 * 4. **The money and the sale close together or not at all.** Settling an
 *    attempt and closing its sale is one transaction, the same `withTx` path a
 *    cash tender uses, with the audit row inside it.
 *
 * WHAT IS NOT HERE. Nothing draws a QR — the display renders the stored
 * payload itself (Slice F). No route is declared here — `routes/webhooks.ts`
 * has the notification and the simulator controls, and the till's own "open a
 * QR" route is `routes/payments.ts` (Slice C2), which calls `openQrAttempt`.
 */

// --- Which gateway this deployment runs -------------------------------------

interface ResolvedGateway {
  qr: QrPayment;
  selection: GatewaySelection;
  config: GatewayConfig;
}

/**
 * One `QrPayment` per process, keyed by the env object it was built from.
 *
 * A WeakMap rather than a module-level singleton because the test harness
 * builds several apps in one process and each must get its own simulator: a
 * QR minted by one suite marked paid from another is a test that passes for
 * the wrong reason. In the api there is one `Env` and therefore one gateway.
 *
 * THE SIMULATOR'S MEMORY LIVES HERE, in this process, for as long as it lives
 * — the same shape the box's printer simulators have (`services/print.ts`,
 * `simulatorFor`). A pretend machine's pretend state is not a business record.
 * The consequence, stated rather than hidden: a QR minted before a restart
 * cannot be marked paid from the Console afterwards. Its attempt is still
 * there, still pending, and still closes by the ordinary paths.
 */
const GATEWAYS = new WeakMap<Env, ResolvedGateway>();

export function gatewayFor(env: Env, log?: FastifyBaseLogger): ResolvedGateway {
  const existing = GATEWAYS.get(env);
  if (existing) return existing;

  const selection = resolveGatewayProvider(env);
  const config: GatewayConfig = {
    environment: env.PGW_ENV,
    baseUrl: env.PGW_BASE_URL,
    merchantId: env.PGW_MERCHANT_ID,
    secretKey: env.PGW_SECRET_KEY,
    currencyCode: env.PGW_CURRENCY_CODE,
    qrChannelCode: env.PGW_QR_CHANNEL_CODE,
    qrType: env.PGW_QR_TYPE,
    paymentExpiryMinutes: env.PGW_PAYMENT_EXPIRY_MIN,
    backendReturnUrl: env.PGW_BACKEND_RETURN_URL,
    frontendReturnUrl: env.PGW_FRONTEND_RETURN_URL,
    maintenance:
      env.PGW_MAINT_PRIVATE_KEY && env.PGW_MAINT_2C2P_PUBLIC_KEY
        ? {
            baseUrl: env.PGW_MAINT_BASE_URL,
            privateKeyPem: env.PGW_MAINT_PRIVATE_KEY,
            partnerPublicKeyPem: env.PGW_MAINT_2C2P_PUBLIC_KEY,
          }
        : undefined,
  };

  const resolved: ResolvedGateway = {
    qr: selection.provider === '2c2p' ? new TwoC2PQrPayment(config) : new SimulatorQrPayment(),
    selection,
    config,
  };
  GATEWAYS.set(env, resolved);

  /**
   * THE ANNOUNCEMENT the document asks for (`:786-788`). It is made once, when
   * the gateway is first resolved — which is at boot, because `buildDefaultJobs`
   * resolves it while assembling the poller. A deployment running a pretend
   * gateway says so in its first few log lines rather than in a support case.
   */
  log?.[selection.fellBack ? 'warn' : 'info'](
    {
      provider: selection.provider,
      deployEnv: env.DEPLOY_ENV,
      gatewayEnv: env.PGW_ENV,
      // NAMES ONLY. Never a value, never a partial value, never a masked one.
      missingVars: selection.missingVars,
    },
    `payment gateway: ${selection.reason}`,
  );
  return resolved;
}

/** The simulator, when this deployment is running one. Null when 2C2P is live. */
function simulatorOf(env: Env): SimulatorQrPayment | null {
  const { qr } = gatewayFor(env);
  return qr instanceof SimulatorQrPayment ? qr : null;
}

// --- Minting an attempt ------------------------------------------------------

/** Ours, so an advisory lock here can never collide with the job runner's. */
const INVOICE_LOCK_NAMESPACE = 0x070b;

/**
 * THE NEXT INVOICE NUMBER for this station on this trading day.
 *
 * `PAYMENT_GATEWAY.md:616-637` fixes the format and `buildInvoiceNo` in
 * `@oto/shared` builds it; what is here is the counter, and the counter is the
 * part that has to be right under two tills pressing QR at the same instant.
 *
 * AN ADVISORY LOCK, NOT A COUNTER TABLE. `edge.box_counter` mints
 * (device, day) values atomically and Slice C1 uses it for terminal
 * references — but its primary key starts with a BOX, and a station need not
 * have one (a till on the mall wifi, the booking site's `WEB` station later).
 * A transaction-scoped advisory lock on (station, business date) serialises
 * the read-and-mint with no migration, no new table and no store change, in
 * exactly the shape `services/jobs.ts` already uses to claim a tick. It is
 * held for one indexed read and released by the commit.
 *
 * The unique index `payment_attempt_gateway_invoice_unique` is the net underneath, and
 * it is global and permanent because 2C2P's own uniqueness is: a reused number
 * comes back `5005` at the counter with nothing a person can act on.
 */
async function mintInvoiceNo(
  tx: Tx,
  input: { stationId: string; stationCode: string; businessDate: string; prefix: string },
): Promise<string> {
  const key = createHash('sha256')
    .update(`${input.stationId}|${input.businessDate}`)
    .digest()
    .readInt32BE(0);
  await tx.execute(sql`select pg_advisory_xact_lock(${INVOICE_LOCK_NAMESPACE}::int4, ${key}::int4)`);

  const rows = await tx
    .select({ invoiceNo: paymentAttempt.invoiceNo })
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.stationId, input.stationId),
        eq(paymentAttempt.businessDate, input.businessDate),
        isNull(paymentAttempt.deviceId),
        inArray(paymentAttempt.provider, ['2c2p', 'simulator']),
        isNotNull(paymentAttempt.invoiceNo),
      ),
    );

  /**
   * The sequence is read off the LAST SIX CHARACTERS rather than by stripping
   * a known prefix: `PGW_INVOICE_PREFIX` can change between deploys, and the
   * six digits are in the same place whatever came before them.
   */
  let highest = 0;
  for (const row of rows) {
    const seq = Number((row.invoiceNo ?? '').slice(-6));
    if (Number.isInteger(seq) && seq > highest) highest = seq;
  }
  return buildInvoiceNo({
    prefix: input.prefix,
    stationCode: input.stationCode,
    businessDate: input.businessDate,
    seq: highest + 1,
  });
}

export interface OpenQrAttemptInput {
  operatorId: string;
  branchId: string;
  /** Null while the cart is still being built. The webhook settles whatever it is tied to. */
  saleId?: string | null;
  stationId: string;
  businessDate: string;
  amountSatang: number;
  /** The configured tender's token, so the receipt prints the name the park gave it. */
  methodCode?: string | null;
  kind?: string;
  /** `x-oto-action-id` — one press of QR, however many HTTP attempts it took. */
  actionId?: string | null;
  /** Who pressed it. Recorded, and it is who the sale is closed BY when the money lands. */
  accountId: string;
  /** What the guest is paying for, for the gateway's `description` (C 250). */
  description?: string;
}

export interface OpenQrAttemptResult {
  attempt: PaymentAttemptView;
  /** The EMVCo payload the display renders itself. Null when the mint failed. */
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  expiryTimerMs: number | null;
  invoiceNo: string;
  /** True when this call found a press that had already been made. */
  replay: boolean;
}

/**
 * OPEN A QR TENDER: mint the number, write the attempt, ask for the code.
 *
 * THREE ACTS, DELIBERATELY NOT ONE TRANSACTION.
 *
 *   1. the attempt row, committed — so the press is recorded BEFORE anything
 *      is asked of the gateway, and a retry down a dropped connection finds it
 *      rather than minting a second invoice number (2C2P refuses the reuse and
 *      the refusal reaches the counter);
 *   2. the network call, outside any transaction — an HTTPS round trip to
 *      Bangkok is not something to hold a database connection open across, and
 *      the pool is deliberately small;
 *   3. the QR written onto the attempt, committed.
 *
 * If the process dies between 1 and 3 the attempt sits `created` with no
 * payload, which is a state the sweeper flags and a person can see. That is
 * the honest failure. The alternative — one transaction around a call to a
 * third party — trades it for a connection held open by a gateway that is
 * having a bad afternoon.
 */
export async function openQrAttempt(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: OpenQrAttemptInput,
): Promise<OpenQrAttemptResult> {
  const { qr, selection } = gatewayFor(env, log);
  if (input.amountSatang <= 0) throw errors.badRequest('A QR tender has to settle something');
  const methodCode = input.methodCode ?? 'promptpay';
  const operationCtx = { ...ctx, idempotency: undefined };

  // Act 1.
  const prepared = await withTx(db, operationCtx, 'payment.qr.open', async (tx) => {
    let saleRow: typeof sale.$inferSelect | undefined;
    if (input.saleId) {
      /**
       * S2-10b — THE TENDER GUARD, before a QR the guest can pay exists: the
       * sale is locked, it must still be open, and a voucher it was priced with
       * must still be held for it (VOUCHER_NOT_HELD). A QR shown for a sale
       * that can no longer close is money the gateway takes and nothing here
       * can settle — the settlement and the close are one transaction, and the
       * close would refuse. Locked first, as every other tender locks it, so a
       * void or a close cannot slip in between this and the attempt.
       */
      [saleRow] = await tx
        .select()
        .from(sale)
        .where(eq(sale.id, input.saleId))
        .for('update')
        .limit(1);
      if (!saleRow || saleRow.operatorId !== input.operatorId) {
        throw errors.notFound('Sale not found');
      }
      if (
        saleRow.branchId !== input.branchId ||
        saleRow.stationId !== input.stationId ||
        saleRow.businessDate !== input.businessDate
      ) {
        throw errors.badRequest('This QR tender does not match its recorded sale');
      }
    }
    const existing = input.actionId
      ? await findAttemptByAction(tx, input.operatorId, input.actionId)
      : null;
    if (existing) {
      if (
        existing.saleId !== (input.saleId ?? null) ||
        existing.branchId !== input.branchId ||
        existing.stationId !== input.stationId ||
        existing.amountSatang !== input.amountSatang ||
        existing.methodCode !== methodCode ||
        existing.method !== 'qr' ||
        !existing.invoiceNo
      ) {
        throw errors.conflict('ACTION_ID_REUSED', 'That action id already recorded a different tender');
      }
      return { row: existing, replay: true, stationCode: '' };
    }
    if (saleRow) {
      if (saleRow.status !== 'tendering') {
        throw errors.conflict(
          'SALE_CLOSED',
          `This sale is ${saleRow.status} and cannot take another tender`,
        );
      }
      await assertSaleVouchersHeld(
        tx,
        {
          saleId: saleRow.id,
          operatorId: saleRow.operatorId,
          branchId: saleRow.branchId,
          stationId: saleRow.stationId,
        },
        new Date(),
      );
    }
    const [st] = await tx.select().from(station).where(eq(station.id, input.stationId)).limit(1);
    if (!st || st.operatorId !== input.operatorId || st.branchId !== input.branchId || st.archivedAt) {
      throw errors.badRequest('This QR tender names a station that is no longer available');
    }
    if (!st.codePrefix) {
      throw errors.badRequest(
        'This station has no code prefix, so it cannot number a gateway invoice — set one on the station',
      );
    }
    const method = await tenderMethodOf(tx, input.operatorId, methodCode, input.kind ?? 'qr');
    if (method !== 'qr') throw errors.badRequest('A gateway QR must use a QR payment method');
    const invoiceNo = await mintInvoiceNo(tx, {
      stationId: input.stationId,
      stationCode: st.codePrefix,
      businessDate: input.businessDate,
      prefix: env.PGW_INVOICE_PREFIX,
    });
    const row = await openAttempt(tx, {
      operatorId: input.operatorId,
      branchId: input.branchId,
      saleId: input.saleId ?? null,
      stationId: input.stationId,
      businessDate: input.businessDate,
      method,
      methodCode,
      provider: selection.provider === '2c2p' ? '2c2p' : 'simulator',
      status: 'created',
      amountSatang: input.amountSatang,
      actionId: input.actionId ?? null,
      invoiceNo,
      payload: {
        /**
         * WHO CLOSES THE SALE WHEN THE MONEY LANDS. The webhook has no
         * session and `ActorContext.accountId` is not optional, so the sale
         * service is called as the person who pressed QR — which is also the
         * honest answer to "who took this money": reception did, on a
         * gateway's word. The gateway's own part is a separate audit row,
         * `payment.settled`, with no actor at all.
         */
        takenByAccountId: input.accountId,
        ...(input.actionId ? { actionId: input.actionId } : {}),
      },
    });
    await audit.record(tx, {
      actorAccountId: input.accountId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      action: 'payment.qr.open',
      entityType: 'payment_attempt',
      entityId: row.id,
      actionId: input.actionId ?? null,
      requestId: ctx.requestId,
      after: {
        saleId: input.saleId ?? null,
        amountSatang: input.amountSatang,
        invoiceNo,
        provider: row.provider,
      },
    });
    return { row, replay: false, stationCode: st.codePrefix };
  });
  const opened = prepared.row;
  if (prepared.replay) {
    const image = (opened.payload as { qrImageUrl?: unknown } | null)?.qrImageUrl;
    return {
      attempt: attemptView(opened),
      qrPayload: opened.qrPayload,
      qrImageUrl: typeof image === 'string' ? image : null,
      expiresAt: opened.expiresAt?.toISOString() ?? null,
      expiryTimerMs: opened.expiresAt ? Math.max(0, opened.expiresAt.getTime() - Date.now()) : null,
      invoiceNo: opened.invoiceNo!,
      replay: true,
    };
  }

  // Act 2 — outside every transaction.
  const startedAt = new Date();
  let minted: CreateQrResult;
  try {
    minted = await qr.createQr({
      attemptId: opened.id,
      invoiceNo: opened.invoiceNo!,
      amountSatang: input.amountSatang,
      description: input.description ?? 'OTO Park',
      expiryMinutes: env.PGW_PAYMENT_EXPIRY_MIN,
      userDefined: { stationCode: prepared.stationCode, businessDate: input.businessDate },
    });
    await recordRun(db, {
      kind: 'adapter',
      name: 'adapter:2c2p.create_qr',
      outcome: minted.state === 'qr_shown' ? 'ok' : 'failed',
      startedAt,
      actionId: input.actionId ?? null,
      operatorId: input.operatorId,
      branchId: input.branchId,
      stationId: input.stationId,
      detail: { invoiceNo: opened.invoiceNo, respCode: minted.respCode, state: minted.state },
    });
  } catch (err) {
    await recordRun(db, {
      kind: 'adapter',
      name: 'adapter:2c2p.create_qr',
      outcome: 'failed',
      startedAt,
      error: err,
      actionId: input.actionId ?? null,
      operatorId: input.operatorId,
      branchId: input.branchId,
      stationId: input.stationId,
      detail: { invoiceNo: opened.invoiceNo },
    });
    await withTx(db, operationCtx, 'payment.qr.failed', async (tx) => {
      await failAttempt(tx, opened.id, {
        status: 'declined',
        payload: mergePayload(opened.payload, { gatewayError: (err as Error).name }),
      });
    });
    throw errors.badRequest('The payment gateway could not be reached, so no QR was shown');
  }

  if (minted.state !== 'qr_shown' || !(minted.qrPayload || minted.qrImageUrl)) {
    await withTx(db, operationCtx, 'payment.qr.failed', async (tx) => {
      await failAttempt(tx, opened.id, {
        status: 'declined',
        payload: mergePayload(opened.payload, { respCode: minted.respCode, state: minted.state }),
      });
    });
    if (isDuplicateInvoice(minted.respCode)) {
      // Our own number generator, not the guest. Worth a person looking.
      await raiseAlert(
        db,
        {
          key: `payments.invoice_reuse:${input.branchId}`,
          category: 'payments.invoice_reuse',
          severity: 'critical',
          subject: 'Gateway invoice number reused',
          summary: `The gateway refused invoice ${opened.invoiceNo} as one it has already seen (${minted.respCode}).`,
          detail: { invoiceNo: opened.invoiceNo, respCode: minted.respCode },
          operatorId: input.operatorId,
          branchId: input.branchId,
        },
        { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
      );
    }
    throw errors.badRequest(
      `The payment gateway would not show a QR for this sale (${minted.respCode})`,
    );
  }

  // Act 3.
  const shown = await withTx(db, operationCtx, 'payment.qr.shown', async (tx) =>
    advanceAttempt(tx, opened.id, {
      status: 'sent_to_terminal',
      qrPayload: minted.qrPayload,
      expiresAt: minted.expiresAt,
      tranRef: minted.providerRef,
      payload: mergePayload(opened.payload, {
        respCode: minted.respCode,
        ...(minted.qrImageUrl ? { qrImageUrl: minted.qrImageUrl } : {}),
      }),
    }),
  );

  return {
    attempt: attemptView(shown),
    qrPayload: shown.qrPayload,
    qrImageUrl: minted.qrImageUrl,
    expiresAt: shown.expiresAt?.toISOString() ?? null,
    expiryTimerMs: minted.expiryTimerMs,
    invoiceNo: shown.invoiceNo!,
    replay: false,
  };
}

/**
 * THE WRITER `attempt.ts` DOES NOT HAVE, and the reason it is here.
 *
 * Slice B's attempt service is the one writer of the money columns and it has
 * exactly three verbs: open, settle (approved or awaiting_settlement) and fail
 * (declined, cancelled, not_found). A QR needs a fourth move that is none of
 * those — `created` to `sent_to_terminal`, carrying the EMVCo payload and the
 * expiry — and `settleAttempt` refuses any status that is not money taken,
 * correctly.
 *
 * So this writes the QR columns and the status that goes with them, and it
 * writes NOTHING about money: no `paid_at`, no amount, no approval code. Those
 * still belong to `settleAttempt` and every settlement below goes through it.
 * **Reported back to Slice B**: `advanceAttempt` belongs in `attempt.ts` beside
 * the other three, and the card terminal (C2) will want the same move.
 */
async function advanceAttempt(
  tx: Tx,
  attemptId: string,
  input: {
    status: Extract<PaymentAttemptStatus, 'sent_to_terminal' | 'inquiring' | 'awaiting_staff_confirmation'>;
    qrPayload?: string | null;
    expiresAt?: Date | null;
    tranRef?: string | null;
    paymentId?: string | null;
    payload?: Record<string, unknown> | null;
  },
): Promise<AttemptRow> {
  const [row] = await tx
    .update(paymentAttempt)
    .set({
      status: input.status,
      ...(input.qrPayload === undefined ? {} : { qrPayload: input.qrPayload }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.tranRef === undefined ? {} : { tranRef: input.tranRef }),
      ...(input.paymentId === undefined ? {} : { paymentId: input.paymentId }),
      ...(input.payload === undefined ? {} : { payload: input.payload as never }),
    })
    .where(eq(paymentAttempt.id, attemptId))
    .returning();
  if (!row) throw new Error('the payment attempt was not advanced');
  return row;
}

/**
 * Merge onto what is already on the row.
 *
 * `settleAttempt` and `failAttempt` document their `payload` as "merged over
 * what `openAttempt` wrote" and in fact ASSIGN it, so passing a partial object
 * to either of them silently drops `takenByAccountId` — which is the account
 * this file closes a sale as. Every call below therefore merges first.
 * **Reported back to Slice B**: the comment and the code disagree
 * (`services/payments/attempt.ts`, the `payload` line of both setters).
 */
function mergePayload(
  current: unknown,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
  return { ...base, ...extra };
}

// --- Settling ----------------------------------------------------------------

export type SettleSource = 'webhook' | 'inquiry';

export interface SettleOutcome {
  outcome:
    | 'settled'
    | 'already_settled'
    | 'amount_mismatch'
    | 'currency_mismatch'
    | 'inquiry_disagreed'
    | 'not_paid';
  attemptId: string;
  /** Whether this settlement also closed the sale and numbered its receipt. */
  finalisedSale: boolean;
  outstandingSatang: number | null;
}

/**
 * MARK PAID — the one idempotent writer both the webhook and the poller go
 * through, "so whichever arrives first wins and the second is a no-op"
 * (`PAYMENT_GATEWAY.md:674-684`).
 *
 * It re-reads the attempt FOR UPDATE inside the transaction and does nothing
 * if it is already in a status that means the money was taken. That is the
 * whole of the race: a notification and an inquiry landing within milliseconds
 * of each other both find the row, one settles it and the other finds it
 * settled.
 *
 * THE INQUIRY IS RUN BY THE CALLER, not here, and the distinction matters:
 * this function is given FACTS that have already been agreed, so a caller
 * cannot accidentally settle on an unverified notification by calling the
 * wrong function.
 */
export async function settlePaidAttempt(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  input: { attempt: AttemptRow; facts: QrPaymentFacts; source: SettleSource; requestId?: string },
): Promise<SettleOutcome> {
  const { attempt, facts } = input;

  /**
   * Rule 2, and it is checked before the transaction and again nowhere else:
   * `amountSatang` is null when the answer carried a figure this platform
   * could not read, and an amount that cannot be compared is not an amount
   * that agrees.
   */
  if (facts.amountSatang === null || facts.amountSatang !== attempt.amountSatang) {
    await flagForAPerson(db, env, attempt, {
      reason: 'amount_mismatch',
      subject: 'A gateway payment does not match the sale',
      summary:
        `The gateway reported ${facts.amountSatang ?? 'an unreadable amount'} satang against ` +
        `invoice ${attempt.invoiceNo}, which asked for ${attempt.amountSatang}.`,
      detail: { reportedSatang: facts.amountSatang, expectedSatang: attempt.amountSatang },
      respCode: facts.respCode,
    });
    return {
      outcome: 'amount_mismatch',
      attemptId: attempt.id,
      finalisedSale: false,
      outstandingSatang: null,
    };
  }
  /**
   * AN ABSENT CURRENCY IS A MISMATCH, not a pass. `currencyCode` is mandatory
   * on both the notification and the inquiry (`PAYMENT_GATEWAY.md:296`), so an
   * answer without one is not an answer this platform can read — and the same
   * reasoning as the amount above applies: a figure that cannot be compared is
   * not a figure that agrees. The alternative lets a delivery release money by
   * leaving a field out.
   */
  if (facts.currencyCode !== env.PGW_CURRENCY_CODE) {
    await flagForAPerson(db, env, attempt, {
      reason: 'currency_mismatch',
      subject: 'A gateway payment is in another currency',
      summary:
        `The gateway reported ${facts.currencyCode ?? 'no currency'} against invoice ` +
        `${attempt.invoiceNo}, not ${env.PGW_CURRENCY_CODE}.`,
      detail: { reportedCurrency: facts.currencyCode, expected: env.PGW_CURRENCY_CODE },
      respCode: facts.respCode,
    });
    return {
      outcome: 'currency_mismatch',
      attemptId: attempt.id,
      finalisedSale: false,
      outstandingSatang: null,
    };
  }

  const ctx: OpContext = {
    requestId: input.requestId,
    actorAccountId: null,
    operatorId: attempt.operatorId,
    branchId: attempt.branchId,
    log,
  };

  return withTx(db, ctx, 'payment.settled', async (tx) => {
    const [live] = await tx
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attempt.id))
      .for('update')
      .limit(1);
    if (!live) throw new Error('the payment attempt vanished between the read and the settlement');
    if (live.status === 'approved' || live.status === 'awaiting_settlement') {
      return {
        outcome: 'already_settled' as const,
        attemptId: live.id,
        finalisedSale: false,
        outstandingSatang: null,
      };
    }

    /**
     * `paid_at` IS OUR OWN CLOCK, not the gateway's stamp, and the reason is
     * which day the money lands in. `attempt.ts` has `paid_at` feeding end of
     * day (S2-15a), and `transactionDateTime` arrives as `yyyyMMddHHmmss` with
     * NO STATED TIME ZONE: `PAYMENT_GATEWAY.md` prints the format in the
     * notification field table (`:297`) and again in the constraints table
     * (`:349`) and says nothing about the zone either time. The only zones the
     * document does state are the acquirer cut-offs and the business date,
     * both Asia/Bangkok (`:435-441`, `:632`) — which is a reason to suspect
     * Bangkok wall time, not a reason to claim it. Reading a Bangkok stamp as
     * UTC would put a 19:00 payment at 02:00 the next day, on the wrong side
     * of a business day that starts at 06:00.
     *
     * So the instant this platform records is the one it witnessed — the
     * notification's or the inquiry's arrival here — which is within seconds
     * of the payment on the webhook path and within one poll interval on the
     * other. The gateway's own stamp is kept beside it, unparsed, exactly as
     * it arrived, for a support case and for whoever settles the zone in the
     * first sandbox session (`PAYMENT_GATEWAY.md:492-508`). When it is
     * settled, `paid_at` can take it.
     */
    const settled = await settleAttempt(tx, live.id, {
      status: 'approved',
      paidAt: new Date(),
      tranRef: facts.tranRef,
      paymentId: facts.paymentId,
      approvalCode: facts.approvalCode,
      payload: mergePayload(live.payload, {
        respCode: facts.respCode,
        channelCode: facts.channelCode,
        agentCode: facts.agentCode,
        settledBy: input.source,
        gatewayStamp: facts.transactionDateTime,
      }),
    });

    await audit.record(tx, {
      // No account: a gateway said this, not a person. The person who opened
      // the tender is named on the sale's own `sale.finalise` row below.
      actorAccountId: null,
      operatorId: settled.operatorId,
      branchId: settled.branchId,
      action: 'payment.settled',
      entityType: 'payment_attempt',
      entityId: settled.id,
      actionId: settled.actionId,
      requestId: input.requestId ?? null,
      before: { status: live.status },
      after: {
        status: settled.status,
        source: input.source,
        invoiceNo: settled.invoiceNo,
        tranRef: settled.tranRef,
        amountSatang: settled.amountSatang,
        saleId: settled.saleId,
      },
    });

    if (!settled.saleId) {
      // A QR minted before the cart was committed. The money is recorded; the
      // sale attaches to it when it is committed (Slice F's flow).
      return {
        outcome: 'settled' as const,
        attemptId: settled.id,
        finalisedSale: false,
        outstandingSatang: null,
      };
    }

    const [saleRow] = await tx
      .select()
      .from(sale)
      .where(eq(sale.id, settled.saleId))
      .limit(1);
    if (!saleRow) throw new Error('the settled attempt points at a sale that is not there');
    const outstanding = await outstandingAfter(tx, saleRow);

    /**
     * ONLY WHEN THE BALANCE IS ZERO, and this guard is load-bearing.
     *
     * `finaliseSale` with no tender on a sale that still owes money takes the
     * balance IN CASH — "calling this route is the confirmation that the money
     * was taken" is its own comment, and it is right for the till's button and
     * catastrophic here. A QR that covered half a split would otherwise close
     * the sale with an invented cash tender for the rest.
     */
    if (outstanding > 0 || saleRow.status === 'finalised') {
      return {
        outcome: 'settled' as const,
        attemptId: settled.id,
        finalisedSale: false,
        outstandingSatang: outstanding,
      };
    }

    const openedBy = accountOf(settled.payload);
    if (!openedBy) {
      // Nothing in this slice can produce this: `openQrAttempt` always records
      // the account. A booking-site QR (S2-12) could, and then the sale is
      // left open deliberately rather than closed by nobody.
      await raiseAlert(
        db,
        {
          key: `payments.unattributed:${settled.id}`,
          category: 'payments.unattributed',
          severity: 'warning',
          subject: 'A paid QR could not close its sale',
          summary: `Invoice ${settled.invoiceNo} was paid, but the attempt records nobody who opened it, so the sale was left open.`,
          detail: { attemptId: settled.id, saleId: settled.saleId },
          operatorId: settled.operatorId,
          branchId: settled.branchId,
        },
        { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
      );
      return {
        outcome: 'settled' as const,
        attemptId: settled.id,
        finalisedSale: false,
        outstandingSatang: outstanding,
      };
    }

    const actor: ActorContext = {
      accountId: openedBy,
      operatorId: settled.operatorId,
      branchId: settled.branchId,
      requestId: input.requestId,
      // No branch assertion: the branch came off the attempt row, not off a
      // caller who could have asked for somebody else's.
    };
    const closed = await finaliseSale(tx, actor, settled.saleId, {
      actionId: settled.actionId,
    });
    return {
      outcome: 'settled' as const,
      attemptId: settled.id,
      finalisedSale: closed.finalised,
      outstandingSatang: closed.outstandingSatang,
    };
  });
}

/**
 * The attempt waits for a person, and the Failures page says why.
 *
 * Used for both amount and currency disagreements and for a late payment. The
 * status is `awaiting_staff_confirmation` in all three cases, which is exactly
 * what that word is for: no machine can answer this and the answer has to be
 * attributable to somebody.
 */
async function flagForAPerson(
  db: Db,
  env: Env,
  attempt: AttemptRow,
  input: {
    /** Names the condition, and names the alert it raises. */
    reason: 'amount_mismatch' | 'currency_mismatch' | 'late_payment';
    subject: string;
    summary: string;
    detail: Record<string, unknown>;
    respCode: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [live] = await tx
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attempt.id))
      .for('update')
      .limit(1);
    if (!live || live.status === 'approved' || live.status === 'awaiting_settlement') return;
    await advanceAttempt(tx, attempt.id, {
      status: 'awaiting_staff_confirmation',
      payload: mergePayload(live.payload, { respCode: input.respCode, flagged: input.reason }),
    });
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: attempt.operatorId,
      branchId: attempt.branchId,
      action: 'payment.needs_a_person',
      entityType: 'payment_attempt',
      entityId: attempt.id,
      actionId: attempt.actionId,
      before: { status: live.status },
      after: { status: 'awaiting_staff_confirmation', reason: input.reason, ...input.detail },
    });
  });
  await raiseAlert(
    db,
    {
      key: `payments.${input.reason}:${attempt.id}`,
      category: `payments.${input.reason}`,
      severity: 'critical',
      subject: input.subject,
      summary: input.summary,
      detail: { attemptId: attempt.id, invoiceNo: attempt.invoiceNo, ...input.detail },
      operatorId: attempt.operatorId,
      branchId: attempt.branchId,
    },
    { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
  );
}

// --- The webhook -------------------------------------------------------------

export interface NotificationDelivery {
  /** The parsed body, whatever it turned out to be. Never trusted. */
  body: unknown;
  sourceIp: string | null;
  /** A small, named subset. Never the whole header bag, which carries cookies. */
  headers: Record<string, string | undefined>;
  requestId?: string;
  /** Whether `PGW_WEBHOOK_SECRET` was present and right, when one is configured. */
  pathTokenOk: boolean;
}

export type NotificationOutcome =
  | 'no_payload'
  | 'bad_signature'
  | 'wrong_merchant'
  | 'no_reference'
  | 'duplicate'
  | 'unmatched_payment'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'inquiry_disagreed'
  | 'late_paid'
  | 'not_paid'
  | 'settled'
  | 'already_settled'
  | 'wrong_path_token';

/**
 * THE NINE STEPS of `PAYMENT_GATEWAY.md:641-670`, in order.
 *
 * **It never throws and it never answers anything but 200.** Every refusal is
 * a value, the route turns every value into 200, and the one `try` around the
 * whole thing is what makes an unforeseen failure a 200 as well. A 4xx here is
 * a bug: 2C2P redelivers on anything else, and a park whose webhook answers
 * 400 to a notification it could not match gets it again all evening.
 */
export async function handleNotification(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  delivery: NotificationDelivery,
): Promise<{ outcome: NotificationOutcome }> {
  const startedAt = new Date();
  const { qr } = gatewayFor(env, log);

  /**
   * STEP 3 — the `ops_run` with the raw envelope, the decoded claims, the
   * source IP and the outcome. "The audit trail for any dispute."
   *
   * It is written on the way OUT rather than the way in, so that the row
   * carries what was decided as well as what arrived: a delivery recorded
   * before the decision would need a second row to say what happened to it,
   * and the Failures page would group two halves of one event apart. Nothing
   * is lost by the order — the `catch` at the bottom records the deliveries
   * that never reached a decision at all.
   */
  const record = async (
    outcome: NotificationOutcome,
    detail: Record<string, unknown>,
  ): Promise<{ outcome: NotificationOutcome }> => {
    try {
      await recordRun(db, {
        kind: 'webhook',
        name: 'webhook:2c2p.payment',
        // `ok` means "we dealt with it", which includes deciding not to act on
        // it. `failed` is for the deliveries that should not have arrived:
        // those are what the Failures page groups by fingerprint.
        outcome: REFUSALS.has(outcome) ? 'failed' : 'ok',
        startedAt,
        requestId: delivery.requestId ?? null,
        detail: {
          outcome,
          sourceIp: delivery.sourceIp,
          headers: delivery.headers,
          ...detail,
        },
        ...(REFUSALS.has(outcome) ? { error: new Error(`webhook ${outcome}`) } : {}),
      });
    } catch (err) {
      // A record of a refusal must never become a non-200.
      log.error({ err }, 'the payment webhook could not record its own delivery');
    }
    return { outcome };
  };

  try {
    // 0. The path filter. NOT authentication — a wrong token is still recorded
    //    and still answered 200, because anything else tells a scanner it found
    //    something.
    if (!delivery.pathTokenOk) {
      return await record('wrong_path_token', {});
    }

    const jwt = payloadOf(delivery.body);
    if (!jwt) return await record('no_payload', { body: shapeOf(delivery.body) });

    // 1. Verify. Then read. Never the other way round.
    let claims: Record<string, unknown>;
    try {
      claims = verifyJwt(jwt, verificationSecret(env));
    } catch (err) {
      return await record('bad_signature', {
        // The raw envelope is the evidence in a dispute and is kept. What is
        // NOT kept is any suggestion that its contents mean anything: the
        // claims are recorded under a name that says they were never verified.
        envelope: jwt,
        unverifiedClaims: decodeUnverified(jwt)?.claims ?? null,
        reason: err instanceof JwtSignatureError ? err.reason : 'claims',
      });
    }

    // 2. Ours? Compared against a real value in every configuration — see
    //    `expectedMerchantId`, which is why an unconfigured deployment does
    //    not end up comparing "" with "" and passing everything.
    const merchantId = typeof claims.merchantID === 'string' ? claims.merchantID : null;
    const expected = expectedMerchantId(env);
    if (!merchantId || !expected || merchantId !== expected) {
      return await record('wrong_merchant', { envelope: jwt, merchantID: merchantId });
    }

    const invoiceNo = typeof claims.invoiceNo === 'string' ? claims.invoiceNo : '';
    const facts = factsOf(claims, invoiceNo);

    // 4a. The key is not optional. A delivery carrying neither reference
    //     cannot be matched to an earlier one, so it is refused BEFORE the
    //     insert the CHECK would refuse anyway, and lives as an `ops_run`.
    if (!facts.invoiceNo || (!facts.tranRef && !facts.paymentId)) {
      return await record('no_reference', { envelope: jwt, claims: facts.raw });
    }

    /**
     * 5 BEFORE 4, and this is the one deviation from the document's order.
     *
     * `pos.payment_notification.operator_id` is NOT NULL, so a row cannot be
     * written until the invoice has been matched to something that has a
     * tenancy. The document's step 4 assumes the merchant's operator can be
     * looked up from configuration; it cannot, because `PGW_MERCHANT_ID` names
     * a merchant and not an operator, and inventing a tenancy would file
     * somebody else's money under this park.
     *
     * So an unmatched invoice is alerted and answered 200 with no notification
     * row — the `ops_run` above carries the envelope, which is the evidence
     * step 3 exists for. A duplicate of an unmatched delivery is alerted again
     * and `raiseAlert`'s own flap window is what stops that being noise.
     */
    const [matched] = await db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.invoiceNo, facts.invoiceNo),
          isNull(paymentAttempt.deviceId),
          inArray(paymentAttempt.provider, ['2c2p', 'simulator']),
        ),
      )
      .limit(1);
    if (!matched) {
      await raiseAlert(
        db,
        {
          key: `payments.unmatched:${facts.invoiceNo}`,
          category: 'payments.unmatched_payment',
          severity: 'critical',
          subject: 'A payment arrived for an invoice this platform did not issue',
          summary: `The gateway reported ${facts.respCode} against invoice ${facts.invoiceNo}, which matches no payment attempt.`,
          detail: { invoiceNo: facts.invoiceNo, respCode: facts.respCode, tranRef: facts.tranRef },
        },
        { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
      );
      return await record('unmatched_payment', { envelope: jwt, claims: facts.raw });
    }

    /**
     * 4b. IDEMPOTENCY, IN THE DATABASE rather than in a branch of this
     *     handler. `(invoiceNo, tranRef)` falling back to `(invoiceNo,
     *     paymentID)`, both unique indexes on `pos.payment_notification`. A
     *     second delivery of the same payment loses the insert, does nothing,
     *     and answers 200 — which is the behaviour whether it arrived a second
     *     later or a day later, and whether or not this process is the one
     *     that saw the first.
     */
    const claimed = await withTx(
      db,
      {
        requestId: delivery.requestId,
        actorAccountId: null,
        operatorId: matched.operatorId,
        branchId: matched.branchId,
        log,
      },
      'payment.notification',
      async (tx) =>
        tx
          .insert(paymentNotification)
          .values({
            id: newId(),
            operatorId: matched.operatorId,
            attemptId: matched.id,
            invoiceNo: facts.invoiceNo,
            tranRef: facts.tranRef,
            paymentId: facts.paymentId,
            respCode: facts.respCode,
            raw: { claims: facts.raw, envelope: jwt } as never,
          })
          /**
           * `onConflictDoNothing` rather than catching a 23505, because a
           * duplicate delivery is ORDINARY — 2C2P publishes no retry schedule
           * and the document says to assume redelivery. A unique violation
           * would abort the transaction and leave a failure row behind for
           * something that is working exactly as designed.
           */
          .onConflictDoNothing()
          .returning({ id: paymentNotification.id }),
    );
    if (claimed.length === 0) {
      return await record('duplicate', { envelope: jwt, claims: facts.raw });
    }

    // 6, 7. Act on the code — and on what an inquiry says about it.
    const outcome = await actOn(db, env, log, qr, matched, facts, 'webhook', delivery.requestId);
    return await record(outcome, { envelope: jwt, claims: facts.raw, attemptId: matched.id });
  } catch (err) {
    /**
     * Step 8, and the reason it is a catch rather than a promise: "never let
     * an internal failure turn into a non-200". Whatever went wrong, the
     * delivery is acknowledged and the poller — which reads the same attempts
     * from the database rather than from this request — picks the payment up.
     */
    log.error({ err, reqId: delivery.requestId }, 'the payment webhook failed internally');
    try {
      await recordRun(db, {
        kind: 'webhook',
        name: 'webhook:2c2p.payment',
        outcome: 'failed',
        startedAt,
        error: err,
        requestId: delivery.requestId ?? null,
        detail: { outcome: 'internal_error', sourceIp: delivery.sourceIp },
      });
    } catch {
      // Nothing left to do but answer 200.
    }
    return { outcome: 'not_paid' };
  }
}

/** The deliveries that should not have arrived, as against the ones we declined to act on. */
const REFUSALS = new Set<NotificationOutcome>([
  'no_payload',
  'bad_signature',
  'wrong_merchant',
  'no_reference',
  'unmatched_payment',
  'wrong_path_token',
]);

/**
 * What a signal — from a notification or from the poller — makes of an attempt.
 *
 * THE INQUIRY RUNS HERE, on the paid path only, and its disagreement is a
 * refusal rather than a warning: "before anything is released a Payment
 * Inquiry on the same `invoiceNo` must agree. That is our rule, not 2C2P's,
 * and it costs one call" (`:668-670`). A notification that says paid and an
 * inquiry that does not is the exact shape of a forged or replayed message
 * that happened to carry a valid signature from an older key.
 */
async function actOn(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  qr: QrPayment,
  attempt: AttemptRow,
  facts: QrPaymentFacts,
  source: SettleSource,
  requestId?: string,
): Promise<NotificationOutcome> {
  if (isAmountMismatch(facts.respCode)) {
    await flagForAPerson(db, env, attempt, {
      reason: 'amount_mismatch',
      subject: 'A guest paid an amount that is not the amount asked for',
      summary: `The gateway answered ${facts.respCode} against invoice ${attempt.invoiceNo}: the guest paid more or less than the sale asked for.`,
      detail: { respCode: facts.respCode, expectedSatang: attempt.amountSatang },
      respCode: facts.respCode,
    });
    return 'amount_mismatch';
  }

  if (facts.state === 'late_paid') {
    await flagForAPerson(db, env, attempt, {
      reason: 'late_payment',
      subject: 'A QR was paid after it expired',
      summary: `Invoice ${attempt.invoiceNo} was paid after it expired. Apply it to the sale if it is still open, or refund it.`,
      detail: { respCode: facts.respCode, tranRef: facts.tranRef },
      respCode: facts.respCode,
    });
    return 'late_paid';
  }

  if (facts.state !== 'paid') {
    await applyNonPaidState(db, attempt, facts);
    return 'not_paid';
  }

  /**
   * STEP 6 — COMPARE WHAT THE NOTIFICATION ITSELF CLAIMED, before the inquiry
   * and before anything is settled.
   *
   * The inquiry's own figures are compared again inside `settlePaidAttempt`,
   * which is what actually guards the money. This check is about the DELIVERY:
   * a notification claiming a different amount or another currency against one
   * of our invoices is a fact worth refusing and alerting on in its own right,
   * and settling on the inquiry alone would let it pass unremarked. The
   * document puts it at step 6 for that reason.
   */
  const claimedSatang = facts.amountSatang;
  if (claimedSatang === null || claimedSatang !== attempt.amountSatang) {
    await flagForAPerson(db, env, attempt, {
      reason: 'amount_mismatch',
      subject: 'A gateway payment does not match the sale',
      summary:
        `A notification reported ${claimedSatang ?? 'an unreadable amount'} satang against ` +
        `invoice ${attempt.invoiceNo}, which asked for ${attempt.amountSatang}.`,
      detail: { reportedSatang: claimedSatang, expectedSatang: attempt.amountSatang },
      respCode: facts.respCode,
    });
    return 'amount_mismatch';
  }
  /** Mandatory on the notification too (`PAYMENT_GATEWAY.md:296`): absent is a mismatch. */
  if (facts.currencyCode !== env.PGW_CURRENCY_CODE) {
    await flagForAPerson(db, env, attempt, {
      reason: 'currency_mismatch',
      subject: 'A gateway payment is in another currency',
      summary:
        `A notification reported ${facts.currencyCode ?? 'no currency'} against invoice ` +
        `${attempt.invoiceNo}, not ${env.PGW_CURRENCY_CODE}.`,
      detail: { reportedCurrency: facts.currencyCode, expected: env.PGW_CURRENCY_CODE },
      respCode: facts.respCode,
    });
    return 'currency_mismatch';
  }

  /** Rule 1. One call, and a disagreement settles nothing. */
  let truth: QrPaymentFacts;
  const startedAt = new Date();
  try {
    truth = await qr.inquire({ invoiceNo: attempt.invoiceNo! });
    await recordRun(db, {
      kind: 'adapter',
      name: 'adapter:2c2p.inquiry',
      outcome: 'ok',
      startedAt,
      requestId: requestId ?? null,
      actionId: attempt.actionId,
      operatorId: attempt.operatorId,
      branchId: attempt.branchId,
      detail: { invoiceNo: attempt.invoiceNo, respCode: truth.respCode, state: truth.state },
    });
  } catch (err) {
    await recordRun(db, {
      kind: 'adapter',
      name: 'adapter:2c2p.inquiry',
      outcome: 'failed',
      startedAt,
      error: err,
      requestId: requestId ?? null,
      actionId: attempt.actionId,
      operatorId: attempt.operatorId,
      branchId: attempt.branchId,
      detail: { invoiceNo: attempt.invoiceNo },
    });
    // The notification is acknowledged and nothing is released. The poller
    // will ask again; that is what it is for.
    return 'inquiry_disagreed';
  }

  if (truth.state !== 'paid') {
    await raiseAlert(
      db,
      {
        key: `payments.inquiry_disagreed:${attempt.id}`,
        category: 'payments.inquiry_disagreed',
        severity: 'critical',
        subject: 'A payment notification does not survive its inquiry',
        summary: `A notification said invoice ${attempt.invoiceNo} was paid; the inquiry answered ${truth.respCode}. Nothing was released.`,
        detail: { invoiceNo: attempt.invoiceNo, notified: facts.respCode, inquired: truth.respCode },
        operatorId: attempt.operatorId,
        branchId: attempt.branchId,
      },
      { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
    );
    return 'inquiry_disagreed';
  }

  const settled = await settlePaidAttempt(db, env, log, {
    attempt,
    // The INQUIRY's figures, not the notification's: the inquiry is the truth,
    // so it is also the thing the amount is compared against and the thing
    // written onto the row.
    facts: truth,
    source,
    requestId,
  });
  if (settled.outcome === 'already_settled') return 'already_settled';
  if (settled.outcome === 'amount_mismatch') return 'amount_mismatch';
  if (settled.outcome === 'currency_mismatch') return 'currency_mismatch';
  return 'settled';
}

/** Expired, cancelled, not found — the states that end an attempt without money. */
async function applyNonPaidState(
  db: Db,
  attempt: AttemptRow,
  facts: QrPaymentFacts,
): Promise<void> {
  /**
   * `9999` SAYS NOTHING ABOUT THE PAYMENT. It is 2C2P reporting that ITS
   * delivery to our webhook failed — a fact about our availability — so an
   * attempt must never be closed on it: that would declare a sale dead because
   * this service was slow, while the guest's money is on its way. The status
   * filter below happens to drop it today (`failed` maps to the ledger's
   * `unknown`, which is not one of the three closing statuses); this line is
   * the one that says WHY, at the point of the decision, so that a code added
   * to the map later cannot quietly make it a `cancelled`.
   */
  if (isAboutTheMerchant(facts.respCode)) return;

  const status = GATEWAY_STATE_TO_ATTEMPT_STATUS[facts.state];
  if (!status || status === attempt.status) return;
  if (status !== 'cancelled' && status !== 'declined' && status !== 'not_found') return;

  await db.transaction(async (tx) => {
    const [live] = await tx
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attempt.id))
      .for('update')
      .limit(1);
    if (!live || live.status === 'approved' || live.status === 'awaiting_settlement') return;
    await failAttempt(tx, attempt.id, {
      status,
      payload: mergePayload(live.payload, {
        respCode: facts.respCode,
        // Which of the two `cancelled` means, which the ledger's one word
        // cannot say on its own (decision D-3).
        ...(facts.state === 'expired' ? { expired: true } : {}),
      }),
    });
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: attempt.operatorId,
      branchId: attempt.branchId,
      action: 'payment.qr.closed',
      entityType: 'payment_attempt',
      entityId: attempt.id,
      actionId: attempt.actionId,
      before: { status: live.status },
      after: { status, respCode: facts.respCode, state: facts.state },
    });
  });
}

// --- The poller ---------------------------------------------------------------

/** The statuses a QR attempt can still be waiting in. */
const PENDING_STATUSES: PaymentAttemptStatus[] = ['created', 'sent_to_terminal', 'inquiring'];

export interface PollSummary extends Record<string, unknown> {
  examined: number;
  inquired: number;
  settled: number;
  closed: number;
  failed: number;
}

/**
 * ASK THE GATEWAY ABOUT EVERY QR STILL ON A DISPLAY.
 *
 * THE SAFETY NET, and the acceptance proves it is real: with the webhook
 * suppressed the attempt still reaches `approved` within one interval. The
 * webhook is the fast path and this is the one that has to work when the fast
 * path does not — a notification that never arrived, a deploy that was
 * restarting when it did, 2C2P answering `9999` to itself.
 *
 * THE BACK-OFF IS COMPUTED, NOT STORED. `PAYMENT_GATEWAY.md:674-684` asks for
 * every three seconds for two minutes and then every ten, jittered. Both come
 * off the attempt's own `created_at` and its id: the first two minutes are
 * every tick, and after that an attempt is due when the tick lands in its own
 * slice of the ten-second window, where the slice is derived from the id. No
 * `last_polled_at` column, no write per tick, and a hundred attempts spread
 * themselves across the window instead of arriving together.
 */
/** How many waiting QRs one tick reads. A bound on the tick, not on the day. */
export const POLL_BATCH = 200;

/**
 * THE WAITING QRs ONE TICK ASKS ABOUT — **OLDEST FIRST**.
 *
 * The order is the whole point of this being its own function. A tick reads at
 * most `POLL_BATCH` rows, and newest-first means that on a branch with more
 * than that many attempts waiting at once, the ones at the bottom are never
 * read: never inquired about, and never reaching `isExhausted` either, so they
 * sit pending for ever while the newest are polled over and over. Oldest first
 * makes the batch a queue — the attempt that has waited longest is the one a
 * tick always gets to, and an attempt leaves the set the moment it settles or
 * is closed.
 */
export function pendingAttemptsQuery(db: Db) {
  return db
    .select()
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.method, 'qr'),
        inArray(paymentAttempt.provider, ['2c2p', 'simulator']),
        isNull(paymentAttempt.deviceId),
        inArray(paymentAttempt.status, PENDING_STATUSES),
        isNotNull(paymentAttempt.invoiceNo),
      ),
    )
    .orderBy(asc(paymentAttempt.createdAt))
    .limit(POLL_BATCH);
}

export async function pollPendingAttempts(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  now: Date = new Date(),
): Promise<PollSummary> {
  const { qr } = gatewayFor(env, log);
  const summary: PollSummary = { examined: 0, inquired: 0, settled: 0, closed: 0, failed: 0 };

  const rows = await pendingAttemptsQuery(db);

  for (const attempt of rows) {
    summary.examined += 1;
    if (!isInquiryDue(attempt, now, env)) continue;
    summary.inquired += 1;
    const startedAt = new Date();
    let facts: QrPaymentFacts;
    try {
      facts = await qr.inquire({ invoiceNo: attempt.invoiceNo! });
      await recordRun(db, {
        kind: 'adapter',
        name: 'adapter:2c2p.inquiry',
        outcome: 'ok',
        startedAt,
        actionId: attempt.actionId,
        operatorId: attempt.operatorId,
        branchId: attempt.branchId,
        detail: { invoiceNo: attempt.invoiceNo, respCode: facts.respCode, state: facts.state },
      });
    } catch (err) {
      summary.failed += 1;
      await recordRun(db, {
        kind: 'adapter',
        name: 'adapter:2c2p.inquiry',
        outcome: 'failed',
        startedAt,
        error: err,
        actionId: attempt.actionId,
        operatorId: attempt.operatorId,
        branchId: attempt.branchId,
        detail: { invoiceNo: attempt.invoiceNo },
      });
      continue;
    }

    if (facts.state === 'paid') {
      // The poller's own answer IS the inquiry, so it settles directly rather
      // than inquiring a second time about the call it just made.
      const settled = await settlePaidAttempt(db, env, log, { attempt, facts, source: 'inquiry' });
      if (settled.outcome === 'settled') summary.settled += 1;
      if (settled.finalisedSale) summary.closed += 1;
      continue;
    }
    if (facts.state === 'late_paid' || isAmountMismatch(facts.respCode)) {
      await flagForAPerson(db, env, attempt, {
        reason: facts.state === 'late_paid' ? 'late_payment' : 'amount_mismatch',
        subject:
          facts.state === 'late_paid'
            ? 'A QR was paid after it expired'
            : 'A guest paid an amount that is not the amount asked for',
        summary: `Invoice ${attempt.invoiceNo} answered ${facts.respCode} to an inquiry and needs a person.`,
        detail: { respCode: facts.respCode },
        respCode: facts.respCode,
      });
      continue;
    }
    if (QR_TERMINAL_STATES.includes(facts.state)) {
      await applyNonPaidState(db, attempt, facts);
    } else if (isExhausted(attempt, now, env)) {
      /**
       * Polling stops at `PGW_INQUIRY_MAX_MIN` and the attempt is CANCELLED
       * rather than left pending for ever: an attempt nobody will ever ask
       * about again is not "waiting", and leaving it in a pending status would
       * keep it on the Failures page as a live condition every day.
       */
      await applyNonPaidState(db, attempt, { ...facts, state: 'expired' });
    }
  }
  return summary;
}

/** Whether the tick that is running should ask about this attempt. */
export function isInquiryDue(
  attempt: Pick<AttemptRow, 'id' | 'createdAt' | 'expiresAt'>,
  now: Date,
  env: Env,
): boolean {
  const ageMs = now.getTime() - attempt.createdAt.getTime();
  if (ageMs < 0) return false;
  if (isExhausted(attempt, now, env)) return true; // one last ask, then it is closed.
  // The first two minutes: every tick.
  if (ageMs <= 120_000) return true;
  /**
   * After that, once in every ten seconds — and each attempt in its own slice
   * of that window, so a busy Saturday does not send fifty inquiries in the
   * same millisecond. The slice comes off the id, so it is stable for an
   * attempt and spread across them.
   */
  const slot = Math.floor(ageMs / 10_000);
  const offset = jitterOffsetMs(attempt.id);
  const since = ageMs - slot * 10_000;
  return since >= offset && since < offset + env.PGW_INQUIRY_INTERVAL_S * 1000;
}

/** Past the polling window, or a minute past its own expiry. */
function isExhausted(
  attempt: Pick<AttemptRow, 'createdAt' | 'expiresAt'>,
  now: Date,
  env: Env,
): boolean {
  if (now.getTime() - attempt.createdAt.getTime() > env.PGW_INQUIRY_MAX_MIN * 60_000) return true;
  return attempt.expiresAt !== null && now.getTime() > attempt.expiresAt.getTime() + 60_000;
}

function jitterOffsetMs(id: string): number {
  return createHash('sha256').update(id).digest().readUInt16BE(0) % 10_000;
}

// --- The sweeper --------------------------------------------------------------

export interface PendingSummary extends Record<string, unknown> {
  pending: number;
  branches: number;
  opened: number;
  cleared: number;
}

/**
 * `job:payments.pending` — ANYTHING UNRESOLVED AND OLDER THAN
 * `PAYMENT_PENDING_MIN`, on the Failures page.
 *
 * A DIFFERENT DIAL FROM THE POLLER'S, and the difference is the whole point:
 * `PGW_INQUIRY_MAX_MIN` (thirty) is when this platform stops ASKING 2C2P;
 * `PAYMENT_PENDING_MIN` (ten) is when it stops waiting quietly and tells
 * somebody. Ten minutes is a guest who has left the counter. Conflating the
 * two would mean nobody hears about a stuck tender until half an hour after
 * the family has gone home.
 *
 * It covers the card terminal's states too (`unknown`), deliberately: the rule
 * is "no sale with an unknown outcome is left silent", and a tender that never
 * came back from a terminal is the same failure as one that never came back
 * from a gateway.
 */
export async function flagPendingPayments(
  db: Db,
  env: Env,
  now: Date = new Date(),
): Promise<PendingSummary> {
  const cutoff = new Date(now.getTime() - env.PAYMENT_PENDING_MIN * 60_000);
  const rows = await db
    .select({
      id: paymentAttempt.id,
      operatorId: paymentAttempt.operatorId,
      branchId: paymentAttempt.branchId,
      method: paymentAttempt.method,
      status: paymentAttempt.status,
      createdAt: paymentAttempt.createdAt,
    })
    .from(paymentAttempt)
    .where(
      and(
        inArray(paymentAttempt.status, ['sent_to_terminal', 'unknown', 'inquiring']),
        sql`${paymentAttempt.createdAt} < ${cutoff}`,
      ),
    )
    .limit(500);

  const byBranch = new Map<string, { operatorId: string; ids: string[]; oldest: Date }>();
  for (const row of rows) {
    const bucket = byBranch.get(row.branchId) ?? {
      operatorId: row.operatorId,
      ids: [],
      oldest: row.createdAt,
    };
    bucket.ids.push(row.id);
    if (row.createdAt < bucket.oldest) bucket.oldest = row.createdAt;
    byBranch.set(row.branchId, bucket);
  }

  const summary: PendingSummary = {
    pending: rows.length,
    branches: byBranch.size,
    opened: 0,
    cleared: 0,
  };

  for (const [branchId, bucket] of byBranch) {
    const raised = await raiseAlert(
      db,
      {
        key: `payments.pending:${branchId}`,
        category: 'payments.pending',
        severity: 'warning',
        subject: 'Tenders with no outcome',
        summary:
          `${bucket.ids.length} payment attempt${bucket.ids.length === 1 ? '' : 's'} at this branch ` +
          `${bucket.ids.length === 1 ? 'has' : 'have'} been waiting for an answer for more than ${env.PAYMENT_PENDING_MIN} minutes.`,
        detail: { attemptIds: bucket.ids.slice(0, 20), oldestAt: bucket.oldest.toISOString() },
        operatorId: bucket.operatorId,
        branchId,
      },
      { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
    );
    if (raised.outcome === 'opened') summary.opened += 1;
  }

  /**
   * And the other direction: a branch whose tenders have all been answered
   * closes its own alert. Without this the condition would stay open for ever,
   * because nothing else knows it stopped being true.
   */
  const stillPending = new Set(byBranch.keys());
  const open = await db
    .select({ branchId: paymentAttempt.branchId })
    .from(paymentAttempt)
    .groupBy(paymentAttempt.branchId);
  for (const { branchId } of open) {
    if (stillPending.has(branchId)) continue;
    if (await resolveAlert(db, `payments.pending:${branchId}`, 'answered')) summary.cleared += 1;
  }
  return summary;
}

// --- The Console's simulator --------------------------------------------------

export interface GatewayStatus {
  provider: 'simulator' | '2c2p';
  environment: string;
  /** True when the simulator was chosen because a credential is unset. */
  fellBack: boolean;
  reason: string;
  /** Unset `PGW_*` variables, BY NAME. Never a value, never a masked one. */
  missingVars: string[];
  /** Whether this deployment lets the panel drive the gateway at all. */
  simulatorAvailable: boolean;
  channelCode: string;
  /** Whether a webhook URL is configured. Presence only. */
  backendReturnUrlSet: boolean;
  webhookSecretSet: boolean;
  maintenanceConfigured: boolean;
  attempts: PendingQrAttempt[];
}

export interface PendingQrAttempt extends PaymentAttemptView {
  invoiceNo: string;
  expiresAt: string | null;
  /** False when this process has forgotten the QR — after a restart. */
  simulatorKnowsIt: boolean;
  saleReceiptNumber: string | null;
}

/**
 * WHAT THE INTEGRATIONS PAGE SHOWS, and it is names and states only.
 *
 * Nothing on this page is ever a credential: a provider is configured or it is
 * not, and where it is not, what is named is the VARIABLE that is unset —
 * never its value, never a partial value, never a masked one. A masked secret
 * on a screen is still a secret on a screen (`services/ops.ts` states the same
 * rule for every other integration, and this answers in its spirit).
 */
export async function gatewayStatus(db: Db, env: Env, operatorId: string): Promise<GatewayStatus> {
  const { selection } = gatewayFor(env);
  const sim = simulatorOf(env);

  const rows = await db
    .select({ attempt: paymentAttempt, receiptNumber: sale.receiptNumber })
    .from(paymentAttempt)
    .leftJoin(sale, eq(sale.id, paymentAttempt.saleId))
    .where(
      and(
        eq(paymentAttempt.operatorId, operatorId),
        eq(paymentAttempt.method, 'qr'),
        isNull(paymentAttempt.deviceId),
        inArray(paymentAttempt.provider, ['2c2p', 'simulator']),
        inArray(paymentAttempt.status, PENDING_STATUSES),
        isNotNull(paymentAttempt.invoiceNo),
      ),
    )
    .orderBy(desc(paymentAttempt.createdAt))
    .limit(20);

  return {
    provider: selection.provider,
    environment: env.PGW_ENV,
    fellBack: selection.fellBack,
    reason: selection.reason,
    missingVars: selection.missingVars,
    simulatorAvailable: sim !== null,
    channelCode: env.PGW_QR_CHANNEL_CODE,
    backendReturnUrlSet: Boolean(env.PGW_BACKEND_RETURN_URL.trim()),
    webhookSecretSet: Boolean(env.PGW_WEBHOOK_SECRET.trim()),
    maintenanceConfigured: Boolean(
      env.PGW_MAINT_PRIVATE_KEY.trim() && env.PGW_MAINT_2C2P_PUBLIC_KEY.trim(),
    ),
    attempts: rows.map(({ attempt, receiptNumber }) => ({
      ...attemptView(attempt),
      invoiceNo: attempt.invoiceNo!,
      expiresAt: attempt.expiresAt?.toISOString() ?? null,
      simulatorKnowsIt: sim ? sim.knows(attempt.invoiceNo!) : false,
      saleReceiptNumber: receiptNumber,
    })),
  };
}

export interface SimulateResult {
  event: SimulatorEvent;
  attemptId: string;
  invoiceNo: string;
  /** Null for `suppress_webhook` — nothing was posted, which is the point of it. */
  webhookOutcome: NotificationOutcome | null;
  /** What the gateway's record says now, whether or not a notification was sent. */
  gatewayState: string;
}

/**
 * ONE PRESS OF A SIMULATOR BUTTON, and what makes it worth having.
 *
 * It does NOT mark a sale paid. It changes what the simulated gateway will SAY,
 * and then — for four of the five events — SIGNS A NOTIFICATION WITH THE
 * CONFIGURED SECRET AND SENDS IT THROUGH THE REAL WEBHOOK HANDLER. Every step
 * the park will depend on runs: the signature is verified, the merchant is
 * checked, the delivery is recorded, the idempotency key is claimed, the
 * invoice is matched, the amount is compared, the inquiry has to agree, and the
 * sale closes inside one transaction. A demo that took a shortcut past any of
 * those would be a demo of something nobody is going to run.
 *
 * The fifth, `suppress_webhook`, posts nothing at all — which is how the
 * inquiry poller is shown to be a safety net rather than decoration.
 */
export async function simulateGatewayEvent(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  input: {
    attemptId: string;
    event: SimulatorEvent;
    operatorId: string;
    requestId?: string;
    /** Pay a different figure — what the amount-mismatch evidence is built on. */
    amountSatang?: number;
    sourceIp?: string | null;
  },
): Promise<SimulateResult> {
  const sim = simulatorOf(env);
  if (!sim) {
    throw errors.badRequest(
      'This deployment is configured for the real gateway, so there is nothing to simulate',
    );
  }

  const [attempt] = await db
    .select()
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.id, input.attemptId),
        eq(paymentAttempt.operatorId, input.operatorId),
        isNull(paymentAttempt.deviceId),
        inArray(paymentAttempt.provider, ['2c2p', 'simulator']),
      ),
    )
    .limit(1);
  if (!attempt?.invoiceNo) throw errors.notFound('No such payment attempt');
  if (!sim.knows(attempt.invoiceNo)) {
    throw errors.badRequest(
      'This QR was minted before the API last restarted, so the simulator no longer remembers it. Take a new one.',
    );
  }

  const facts = sim.apply(attempt.invoiceNo, input.event, { amountSatang: input.amountSatang });
  if (!facts) throw errors.badRequest('The simulator has no record of that invoice');

  if (input.event === 'suppress_webhook') {
    return {
      event: input.event,
      attemptId: attempt.id,
      invoiceNo: attempt.invoiceNo,
      webhookOutcome: null,
      gatewayState: facts.state,
    };
  }

  /**
   * SIGNED WITH THE CONFIGURED SECRET — which on a simulator deployment is
   * whatever `PGW_SECRET_KEY` happens to be, empty included. An empty key
   * cannot sign, so the simulator uses a per-process key in that case and the
   * webhook is handed the same one: the SIGNATURE CHECK still runs and still
   * has to pass, which is the property being demonstrated.
   */
  const secret = simulatorSecret(env);
  const claims = {
    ...facts.raw,
    merchantID: env.PGW_MERCHANT_ID || SIMULATED_MERCHANT_ID,
    invoiceNo: attempt.invoiceNo,
  };
  const body = { payload: signJwt(claims, secret) };

  const { outcome } = await handleNotification(db, env, log, {
    body,
    sourceIp: input.sourceIp ?? null,
    headers: { 'x-oto-simulated': 'true' },
    requestId: input.requestId,
    pathTokenOk: true,
  });

  return {
    event: input.event,
    attemptId: attempt.id,
    invoiceNo: attempt.invoiceNo,
    webhookOutcome: outcome,
    gatewayState: facts.state,
  };
}

/**
 * The merchant id a simulated notification carries when none is configured.
 *
 * It is a literal and it is not a credential: on a simulator deployment
 * `PGW_MERCHANT_ID` is empty, and the merchant check at step 2 would then
 * compare "" with "" and pass for any delivery at all. Both sides use this
 * instead, so the check is a real comparison of two real values.
 */
const SIMULATED_MERCHANT_ID = 'OTOSIM';

/** A key that exists for as long as this process does, when none is configured. */
let processSimulatorKey: string | null = null;
function simulatorSecret(env: Env): string {
  if (env.PGW_SECRET_KEY.trim()) return env.PGW_SECRET_KEY;
  processSimulatorKey ??= createHash('sha256')
    .update(`oto-gateway-simulator:${process.pid}:${Date.now()}`)
    .digest('hex');
  return processSimulatorKey;
}

/**
 * The secret the webhook verifies with, which on a simulator deployment is the
 * same per-process key the panel signs with.
 */
export function verificationSecret(env: Env): string {
  return simulatorSecret(env);
}

/** The merchant id the webhook compares against, simulator included. */
export function expectedMerchantId(env: Env): string {
  return env.PGW_MERCHANT_ID || (resolveGatewayProvider(env).provider === 'simulator' ? SIMULATED_MERCHANT_ID : '');
}

// --- Small readers ------------------------------------------------------------

function accountOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as { takenByAccountId?: unknown }).takenByAccountId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What arrived, described without quoting it. */
function shapeOf(body: unknown): string {
  if (body === null) return 'null';
  if (Array.isArray(body)) return 'array';
  return typeof body;
}
