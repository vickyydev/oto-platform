import { randomBytes } from 'node:crypto';
import { buildSimulatedEmvcoPayload } from './emvco';
import { RESP_CODE_PAID, RESP_CODE_QR_SHOWN } from './resp-codes';
import type {
  CancelResult,
  CreateQrInput,
  CreateQrResult,
  QrPayment,
  QrPaymentFacts,
  QrState,
  RefundInput,
  RefundResult,
} from './contract';

/**
 * THE GATEWAY SIMULATOR (`PAYMENT_GATEWAY.md:726-734`).
 *
 * Answers in the same shapes as `TwoC2PQrPayment` so that nothing downstream
 * branches on which one is live: a `1005`-style pending answer, a locally
 * generated EMVCo payload, an `expiryTimer` and a real-looking `tranRef`. CI,
 * a demo and a fresh checkout therefore run the whole tender path — mint,
 * display, notification, inquiry, settlement — with no sandbox account and no
 * internet.
 *
 * IT IS A STATE MACHINE, NOT A STUB. The five controls on the Console panel
 * change what this object will SAY the next time it is asked, and then the
 * production path is exercised against that answer. "Customer paid" does not
 * mark a sale paid; it makes the simulator's record say paid and posts a
 * signed notification to the real webhook route, which verifies the signature,
 * matches the invoice, compares the amount, runs its inquiry against this same
 * object and only then settles. That is the whole point of the design: the
 * demo drives the code the park will run, not a shortcut past it.
 *
 * WHERE ITS MEMORY LIVES, and the one limitation to know. In this process,
 * keyed by invoice number — the same shape the box's printer simulators use
 * (`services/print.ts`, `simulatorFor(boxId, deviceId)`), and for the same
 * reason: a pretend machine's pretend state is not a business record and has
 * no business in the database. The consequence is that a QR minted before a
 * restart cannot be marked paid from the panel afterwards; the attempt is
 * still there, still pending, and still closes by the ordinary paths — a real
 * notification, or the sweeper flagging it. Say so rather than pretending
 * otherwise.
 *
 * `suppress_webhook` IS WHY THIS HOLDS STATE AT ALL. It marks the payment paid
 * here and posts nothing, so the only thing that can discover the payment is
 * the inquiry poller — which is how the acceptance proves the poller is a real
 * safety net rather than decoration.
 */

interface SimulatedPayment {
  invoiceNo: string;
  amountSatang: number;
  state: QrState;
  respCode: string;
  tranRef: string;
  paymentId: string;
  expiresAt: Date;
  paidAt: Date | null;
  /** Set by "customer paid" with a different figure — the amount-mismatch plant. */
  paidAmountSatang: number | null;
  /** `V` moves it here; `R` needs it to have been settled first. */
  settled: boolean;
}

export interface SimulatorDeps {
  now?: () => Date;
  /** Injected so a test can assert an exact reference; random in every other use. */
  reference?: () => string;
}

/** What the Console's five buttons ask the simulator to pretend next. */
export type SimulatorEvent = 'paid' | 'decline' | 'expire' | 'late_paid' | 'suppress_webhook';

export class SimulatorQrPayment implements QrPayment {
  readonly provider = 'simulator' as const;

  private readonly payments = new Map<string, SimulatedPayment>();
  private readonly now: () => Date;
  private readonly reference: () => string;

  constructor(deps: SimulatorDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.reference = deps.reference ?? (() => randomBytes(9).toString('hex').toUpperCase());
  }

  createQr(input: CreateQrInput): Promise<CreateQrResult> {
    const at = this.now();
    const expiresAt = new Date(at.getTime() + input.expiryMinutes * 60_000);
    const record: SimulatedPayment = {
      invoiceNo: input.invoiceNo,
      amountSatang: input.amountSatang,
      state: 'qr_shown',
      respCode: RESP_CODE_QR_SHOWN,
      /** 2C2P's own shape for a trace reference: a prefix and hex. Ours says what it is. */
      tranRef: `SIM${this.reference()}`,
      paymentId: `sim_${this.reference().slice(0, 12).toLowerCase()}`,
      expiresAt,
      paidAt: null,
      paidAmountSatang: null,
      settled: false,
    };
    this.payments.set(input.invoiceNo, record);
    return Promise.resolve({
      qrPayload: buildSimulatedEmvcoPayload({
        amountSatang: input.amountSatang,
        invoiceNo: input.invoiceNo,
      }),
      qrImageUrl: null,
      expiresAt,
      expiryTimerMs: input.expiryMinutes * 60_000,
      providerRef: record.tranRef,
      state: 'qr_shown',
      respCode: RESP_CODE_QR_SHOWN,
      respDesc: 'Pending for user scan QR.',
    });
  }

  inquire({ invoiceNo }: { invoiceNo: string }): Promise<QrPaymentFacts> {
    const record = this.payments.get(invoiceNo);
    if (!record) {
      // 2C2P's own answer for an invoice it has never seen. The simulator does
      // not invent a friendlier one: `2002` is what the poller has to handle.
      return Promise.resolve(this.factsOf(null, invoiceNo, '2002', 'Transaction not found'));
    }
    // The clock expires a QR nobody pressed a button about, exactly as the
    // gateway's would — otherwise "expire" would only ever be a demo control
    // and the real expiry path would never run.
    if (record.state === 'qr_shown' && this.now() >= record.expiresAt) {
      record.state = 'expired';
      record.respCode = '9020';
    }
    return Promise.resolve(this.factsOf(record, invoiceNo, record.respCode, describe(record.state)));
  }

  cancel({ invoiceNo }: { invoiceNo: string }): Promise<CancelResult> {
    const record = this.payments.get(invoiceNo);
    if (!record) return Promise.resolve({ ok: false, reason: 'failed', detail: '2002' });
    if (record.state === 'paid') {
      // A paid QR is not cancellable, here or anywhere. The caller's answer is
      // a refund, and the simulator refuses rather than quietly unwinding money.
      return Promise.resolve({ ok: false, reason: 'failed', detail: 'already paid' });
    }
    record.state = 'cancelled';
    record.respCode = '0003';
    return Promise.resolve({ ok: true });
  }

  /**
   * Maintenance, honoured — the ticket asks for `V` and `R` to be real on the
   * simulator even though no POS button reaches them (S2-11 owns the UI).
   *
   * The two windows are the point of implementing it at all: a **void** only
   * before settlement, a **refund** only after it (`PAYMENT_GATEWAY.md:407-412`).
   * `markSettled` is what a demo calls to cross that line.
   */
  refund({ invoiceNo, amountSatang, processType }: RefundInput): Promise<RefundResult> {
    const record = this.payments.get(invoiceNo);
    if (!record || record.state !== 'paid') {
      return Promise.resolve({
        state: 'failed',
        respCode: '2002',
        respDesc: 'Transaction not found, or not in a state that can be voided or refunded',
        providerRefundRef: null,
      });
    }
    if (processType === 'V' && record.settled) {
      return Promise.resolve({
        state: 'failed',
        respCode: '4121',
        respDesc: 'Already settled — a void is only possible before the cut-off',
        providerRefundRef: null,
      });
    }
    if (processType === 'R' && !record.settled) {
      return Promise.resolve({
        state: 'failed',
        respCode: '4121',
        respDesc: 'Not settled yet — a refund only applies to a settled transaction; void it instead',
        providerRefundRef: null,
      });
    }
    if (amountSatang > (record.paidAmountSatang ?? record.amountSatang)) {
      return Promise.resolve({
        state: 'failed',
        respCode: '4122',
        respDesc: 'More than was paid',
        providerRefundRef: null,
      });
    }
    record.state = processType === 'R' ? 'refunded' : 'cancelled';
    record.respCode = processType === 'R' ? '4120' : '0003';
    return Promise.resolve({
      state: record.state,
      respCode: '00',
      respDesc: 'Success',
      providerRefundRef: `SIMRF${this.reference().slice(0, 10)}`,
    });
  }

  // --- What the Console's buttons do ---------------------------------------

  /**
   * Put one payment into the state a button names, and answer with the facts a
   * notification for it would carry.
   *
   * It returns the facts rather than posting anything: the POSTING is the api's
   * (`services/payments/gateway.ts` signs them with the configured secret and
   * sends them to the real route), because the secret belongs to the api and
   * never to a package that a test also runs.
   */
  apply(
    invoiceNo: string,
    event: SimulatorEvent,
    opts: { amountSatang?: number } = {},
  ): QrPaymentFacts | null {
    const record = this.payments.get(invoiceNo);
    if (!record) return null;
    const at = this.now();
    switch (event) {
      case 'paid':
      case 'suppress_webhook':
        record.state = 'paid';
        record.respCode = RESP_CODE_PAID;
        record.paidAt = at;
        record.paidAmountSatang = opts.amountSatang ?? record.amountSatang;
        break;
      case 'decline':
        record.state = 'cancelled';
        record.respCode = '0003';
        break;
      case 'expire':
        record.state = 'expired';
        record.respCode = '9020';
        break;
      case 'late_paid':
        /**
         * A guest who scanned the QR on the way out. The attempt is expired
         * first — which is what makes the signal LATE rather than ordinary —
         * and `5017` is 2C2P's own code for it.
         */
        record.state = 'late_paid';
        record.respCode = '5017';
        record.paidAt = at;
        record.paidAmountSatang = opts.amountSatang ?? record.amountSatang;
        break;
    }
    return this.factsOf(record, invoiceNo, record.respCode, describe(record.state));
  }

  /** Cross the acquirer's cut-off, so `V` stops working and `R` starts. */
  markSettled(invoiceNo: string): void {
    const record = this.payments.get(invoiceNo);
    if (record) record.settled = true;
  }

  /** Whether this process still remembers a QR — what the panel's "unavailable" note reads. */
  knows(invoiceNo: string): boolean {
    return this.payments.has(invoiceNo);
  }

  private factsOf(
    record: SimulatedPayment | null,
    invoiceNo: string,
    respCode: string,
    respDesc: string,
  ): QrPaymentFacts {
    const amountSatang = record ? (record.paidAmountSatang ?? record.amountSatang) : null;
    const raw: Record<string, unknown> = {
      invoiceNo,
      respCode,
      respDesc,
      ...(record
        ? {
            amount: amountOnTheWire(amountSatang ?? 0),
            currencyCode: 'THB',
            tranRef: record.tranRef,
            paymentID: record.paymentId,
            channelCode: 'PPQR',
            agentCode: 'SIM',
          }
        : {}),
    };
    return {
      state: record ? record.state : 'not_found',
      respCode,
      respDesc,
      invoiceNo,
      amountSatang,
      currencyCode: record ? 'THB' : null,
      tranRef: record?.tranRef ?? null,
      paymentId: record?.paymentId ?? null,
      approvalCode: null,
      channelCode: record ? 'PPQR' : null,
      agentCode: record ? 'SIM' : null,
      transactionDateTime: record?.paidAt ? stampOf(record.paidAt) : null,
      raw,
    };
  }
}

function describe(state: QrState): string {
  switch (state) {
    case 'paid':
      return 'Successful';
    case 'qr_shown':
      return 'Pending for user scan QR.';
    case 'expired':
      return 'Payment Expired';
    case 'cancelled':
      return 'Transaction is cancelled';
    case 'late_paid':
      return 'Paid Expired';
    default:
      return state;
  }
}

/** `yyyyMMddHHmmss`, the notification's own stamp format. */
function stampOf(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
  );
}

function amountOnTheWire(amountSatang: number): string {
  const baht = Math.trunc(amountSatang / 100);
  return `${baht}.${String(amountSatang % 100).padStart(2, '0')}000`;
}
