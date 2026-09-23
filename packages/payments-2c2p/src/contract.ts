import type { PaymentAttemptStatus } from '@oto/shared';

/**
 * THE QR PAYMENT CONTRACT (S2-10a, SCRUM-206, Slice D).
 *
 * `docs/architecture/PAYMENT_GATEWAY.md:568-590` states the rule this file
 * exists to keep: **nothing outside this package knows 2C2P exists.** The sale
 * service asks a `QrPayment` for a QR and is told when it was paid; it never
 * sees a `paymentToken`, a `respCode` or a JWT. Two implementations answer in
 * the same shapes so that nothing downstream branches on which one is live —
 * `TwoC2PQrPayment` against the gateway, and `SimulatorQrPayment` against
 * nothing at all, which is what lets CI, a demo and a fresh checkout run the
 * whole tender path with no sandbox account.
 *
 * WHERE IT WAS MEANT TO LIVE. The document and `DEVELOPMENT_PLAN.md:280` put
 * `QrPayment` in `packages/contracts` beside `PaymentTerminal`. That package
 * does not exist, and creating it is not this slice's to do — the terminal
 * contract it would share is `packages/box-agent/src/terminal/contract.ts`
 * (Slice C1), inside the agent rather than in a package of its own. So the
 * interface is declared and exported here, and moving it later is an import
 * path, not a redesign.
 *
 * MONEY CROSSES THIS BOUNDARY AS INTEGER SATANG. `D(12,5)` is a wire format
 * and it is applied in `twoc2p.ts` at the moment the body is built, nowhere
 * else (`PAYMENT_GATEWAY.md:590`). A float never touches a total.
 */

/**
 * THE GATEWAY'S OWN VOCABULARY — §3.2 of the document, not the ledger's.
 *
 * `PAYMENT_GATEWAY.md:594-613` describes a QR's life in these words and the
 * ticket's `pos.payment_attempt.status` CHECK uses different ones. Neither
 * document maps one onto the other, and each slice inventing its own mapping
 * is how the Attempts list becomes unreadable. `GATEWAY_STATE_TO_ATTEMPT_STATUS`
 * below is that mapping, written once (decision D-3).
 *
 * Three words here are not in §3.2 and are not inventions either — they are
 * what the response-code table (`:361-385`) actually distinguishes and what a
 * person has to act on differently:
 *
 *   `pending`          `0001`/`2001`: 2C2P has it and nobody has paid yet.
 *                      Distinct from `qr_shown`, which is a fact about OUR
 *                      display rather than about their record.
 *   `amount_mismatch`  `5015`/`5016`: somebody paid, and not what was asked.
 *                      It is emphatically not `paid` — see the note on the map.
 *   `not_found`        `2002`: the invoice never reached 2C2P at all, which is
 *                      a fault on our side of the wire and not a guest who
 *                      declined to pay.
 */
export const QR_STATES = [
  'created',
  'qr_shown',
  'pending',
  'paid',
  'expired',
  'cancelled',
  'late_paid',
  'amount_mismatch',
  'not_found',
  'duplicate_invoice',
  'refunded',
  'failed',
] as const;
export type QrState = (typeof QR_STATES)[number];

/**
 * D-3 — THE ONE MAPPING FROM THE GATEWAY'S WORDS TO THE LEDGER'S.
 *
 * Written here, restated in `docs/progress/SPRINT_2_PROGRESS.md`, and used by
 * `apps/api/src/services/payments/gateway.ts` and by nothing else. Four of the
 * twelve deserve their reasoning on the line rather than in a paragraph:
 *
 *  - `expired` -> `cancelled`, with `payload.expired = true` written beside it
 *    by the caller. The ledger has no `expired`, and `declined` would be a lie:
 *    nobody refused this payment, the clock ran out on it.
 *  - `late_paid` -> `awaiting_staff_confirmation`. Money arrived for a sale
 *    somebody has probably already settled another way. It is never `approved`
 *    without a person: the two answers — apply it, or refund it — are a
 *    judgement about a guest who is standing there or has gone home.
 *  - `amount_mismatch` -> `awaiting_staff_confirmation`, NEVER `approved`.
 *    `PAYMENT_GATEWAY.md:612-613` is explicit, and it is the plant in this
 *    slice's evidence: a notification one satang off does not close a sale.
 *  - `duplicate_invoice` -> `declined`. `5005`/`9015` mean we reused an invoice
 *    number, which is our bug and not the guest's: the attempt cannot be
 *    settled against a payment that belongs to an earlier one.
 *
 * `refunded` maps to nothing. It is S2-11's word and this slice does not write
 * it; a refund confirmed through maintenance is reported by `refund()` and
 * recorded by that ticket.
 */
export const GATEWAY_STATE_TO_ATTEMPT_STATUS: Record<QrState, PaymentAttemptStatus | null> = {
  created: 'created',
  qr_shown: 'sent_to_terminal',
  pending: 'sent_to_terminal',
  paid: 'approved',
  expired: 'cancelled',
  cancelled: 'cancelled',
  late_paid: 'awaiting_staff_confirmation',
  amount_mismatch: 'awaiting_staff_confirmation',
  not_found: 'not_found',
  duplicate_invoice: 'declined',
  refunded: null,
  failed: 'unknown',
};

/** The states nothing more happens to on its own — the poller stops here. */
export const QR_TERMINAL_STATES: readonly QrState[] = [
  'paid',
  'expired',
  'cancelled',
  'not_found',
  'duplicate_invoice',
  'refunded',
];

export interface CreateQrInput {
  /** Our attempt id, carried through `userDefined1` so a support case can be traced. */
  attemptId: string;
  /** OUR number, one per attempt, unique for ever (`buildInvoiceNo` in `@oto/shared`). */
  invoiceNo: string;
  amountSatang: number;
  /** What the guest is paying for. HTML-specials are avoided, not escaped: the field is C 250. */
  description: string;
  /** `PGW_PAYMENT_EXPIRY_MIN`. 2C2P's own default is twenty. */
  expiryMinutes: number;
  /** `userDefined2`..`5`. Ours, echoed back on the notification. */
  userDefined?: Record<string, string | undefined>;
}

export interface CreateQrResult {
  /**
   * The EMVCo payload, requested as `qrType: RAW`. The display renders THIS
   * and never calls the gateway — "a blocked S3 host cannot break a sale"
   * (`PAYMENT_GATEWAY.md:251-258`).
   */
  qrPayload: string | null;
  /** The image URL, only if the raw payload was not returned. A fallback, not the path. */
  qrImageUrl: string | null;
  expiresAt: Date;
  /** Milliseconds, flow 1005 only — what drives the countdown beside the amount. */
  expiryTimerMs: number | null;
  /** 2C2P's own reference for the attempt, when the mint already produced one. */
  providerRef: string | null;
  state: QrState;
  /** `respCode`/`respDesc` as they arrived, for the `ops_run` and for support. */
  respCode: string;
  respDesc: string | null;
}

/** What an inquiry or a notification says, after the codes are mapped. */
export interface QrPaymentFacts {
  state: QrState;
  respCode: string;
  respDesc: string | null;
  invoiceNo: string;
  /** Satang, converted from the wire's `D(12,5)`. Null when the answer carried none. */
  amountSatang: number | null;
  currencyCode: string | null;
  tranRef: string | null;
  paymentId: string | null;
  approvalCode: string | null;
  channelCode: string | null;
  agentCode: string | null;
  /**
   * `yyyyMMddHHmmss` as it arrived, and kept as the string it arrived as. Its
   * time zone is not stated anywhere in `PAYMENT_GATEWAY.md` — the format is
   * printed at `:297` and `:349` with no zone beside it — so the caller stores
   * it unparsed and dates the payment by its own clock instead.
   */
  transactionDateTime: string | null;
  /**
   * The decoded claims, allow-listed. NEVER the signature and never the key
   * that verified it. `accountNo` arrives masked from 2C2P and is dropped here
   * anyway: this platform stores four digits or nothing.
   */
  raw: Record<string, unknown>;
}

export type CancelResult = { ok: true } | { ok: false; reason: 'unsupported' | 'failed'; detail?: string };

export interface RefundInput {
  invoiceNo: string;
  amountSatang: number;
  /**
   * `V` is a void — same trading day, before the acquirer's cut-off. `R` is a
   * refund and only applies to a settled transaction. They are two different
   * operations on two different sides of a cut-off, which is why the letter is
   * the caller's decision and not inferred here (`PAYMENT_GATEWAY.md:407-412`).
   */
  processType: 'V' | 'R';
}

export interface RefundResult {
  state: QrState;
  /** 2C2P's maintenance answer: `00` is success. Not a payment `respCode`. */
  respCode: string;
  respDesc: string | null;
  providerRefundRef: string | null;
}

/**
 * The seam. Four methods, and the sale service only ever calls the first two.
 */
export interface QrPayment {
  /** Which implementation this is, for the startup line and the Integrations card. */
  readonly provider: 'simulator' | '2c2p';
  createQr(input: CreateQrInput): Promise<CreateQrResult>;
  /**
   * THE TRUTH, as against the notification, which is only a trigger
   * (`PAYMENT_GATEWAY.md:668-670`). Called by the poller, and called again by
   * the webhook before anything is released.
   */
  inquire(input: { invoiceNo: string }): Promise<QrPaymentFacts>;
  /** Staff abandoned the tender. Best effort: QR support is UNCERTAIN (U4). */
  cancel(input: { invoiceNo: string }): Promise<CancelResult>;
  /** Maintenance, on its own host and in its own crypto envelope. S2-11 calls it. */
  refund(input: RefundInput): Promise<RefundResult>;
}
