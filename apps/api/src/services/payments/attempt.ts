import { and, asc, eq, sql } from 'drizzle-orm';
import { paymentAttempt, paymentMethod, sale, type PaymentMethod, type PaymentProvider } from '@oto/db';
import {
  newId,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PAYMENT_ATTEMPT_TERMINAL_STATUSES,
  type PaymentAttemptStatus,
  type PaymentAttemptView,
} from '@oto/shared';
import { errors } from '../../lib/errors';
import type { Exec, Tx } from '../tx';

/**
 * THE ONE WRITER OF `pos.payment_attempt` (S2-10a, SCRUM-206, Slice B).
 *
 * Cash is the only tender that reaches it today. The card terminal (C2), the
 * QR gateway (D) and the offline replay (G) all arrive at these same five
 * functions, and that is the point of the file: if each of them wrote its own
 * insert, the day's takings would be grouped by whichever writer happened to
 * run, and `method`, `business_date` and `paid_at` would mean something
 * slightly different per tender. There is one shape and one vocabulary.
 *
 * THE LIFECYCLE, AND WHY IT IS TWO STEPS EVEN FOR CASH.
 *
 *   openAttempt   writes the row BEFORE the money is asked for. That is what
 *                 makes the attempt the idempotency key rather than a record of
 *                 the past: a tender retried down a dropped connection finds
 *                 the row instead of charging the card a second time
 *                 (`payment_attempt_action_unique`).
 *   settleAttempt the money is ours: `approved` (or `awaiting_settlement`,
 *                 taken on the terminal's own connection), with `paid_at` and
 *                 whatever the instrument said — approval code, TID, last four.
 *   failAttempt   it is not, and nothing more will happen on its own:
 *                 `declined`, `cancelled`, `not_found`.
 *
 * Cash passes through both in one transaction, which looks like a wasted
 * update until you notice it is the same path an EDC takes with a person
 * standing at the counter in between. One path, exercised on every sale, is
 * worth more than a shortcut that only the rare tender ever runs.
 *
 * WHAT IS NOT HERE. Nothing in this file opens a transaction: every function
 * takes the caller's handle, because a tender and the sale it settles close
 * together or not at all. Nothing here decides whether a sale is finished
 * either — that is `finaliseSale`'s, which owns the receipt number.
 */

/** The statuses that mean the money was taken (`PAYMENT_ATTEMPT_TAKEN_STATUSES`). */
const TAKEN = PAYMENT_ATTEMPT_TAKEN_STATUSES;

/**
 * THE STATUS `outstandingOf` COUNTS, and the one a cash tender is written at.
 *
 * One of ten words `pos.payment_attempt.status` allows (S2-10a). A cash tender
 * at the counter is approved at the moment it is recorded; the words either
 * side of it — `sent_to_terminal`, `unknown`, `awaiting_staff_confirmation` —
 * are for the instruments that answer over a cable or not at all, and nothing
 * in Slice B writes them. EDC and QR attach to the same row: an attempt
 * reaching one of the TAKEN statuses is what closes a sale, whichever
 * instrument produced it.
 */
export const TENDER_APPROVED: PaymentAttemptStatus = 'approved';

export type AttemptRow = typeof paymentAttempt.$inferSelect;

/**
 * One attempt as every read answers with it — the Attempts list on the Sale
 * detail, and the till reading its own tender back.
 *
 * Deliberately not the row: `payload`, `qr_payload` and the tenancy columns
 * are not here (`PaymentAttemptView` in `@oto/shared` says why).
 */
export function attemptView(row: AttemptRow): PaymentAttemptView {
  return {
    id: row.id,
    saleId: row.saleId,
    method: row.method,
    provider: row.provider,
    status: row.status,
    amountSatang: row.amountSatang,
    tenderedSatang: row.tenderedSatang,
    changeSatang: row.changeSatang,
    terminalRef: row.terminalRef,
    tid: row.tid,
    approvalCode: row.approvalCode,
    last4: row.last4,
    invoiceNo: row.invoiceNo,
    tranRef: row.tranRef,
    actionId: row.actionId,
    offline: row.offline,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface OpenAttemptInput {
  /** Null while the cart is still being built — a QR minted before the sale is committed. */
  saleId?: string | null;
  operatorId: string;
  branchId: string;
  /** Where it was taken. Null for money with no counter in the path. */
  stationId?: string | null;
  /** The terminal that will answer. Null for cash, the gateway and a manual entry. */
  deviceId?: string | null;
  /** The trading day the tender belongs to — the sale's, never re-derived from the clock. */
  businessDate: string;
  method: PaymentMethod;
  /** The configured tender's token as the till chose it, for the receipt and the reconciliation. */
  methodCode?: string | null;
  provider?: PaymentProvider;
  amountSatang: number;
  /** Cash only: what was handed over, and what went back. */
  tenderedSatang?: number | null;
  changeSatang?: number | null;
  /** `x-oto-action-id` — one press, however many HTTP attempts it took. */
  actionId?: string | null;
  /** Taken while the box could not reach the cloud (Slice G). */
  offline?: boolean;
  /** The gateway's own number for this attempt, minted per attempt and unique for ever. */
  invoiceNo?: string | null;
  /**
   * Where the attempt starts. `created` is the honest first word for anything
   * that has to go and ask an instrument; a caller that already knows the
   * answer still opens `created` and settles, so the row's history is the same
   * shape whichever tender wrote it.
   */
  status?: PaymentAttemptStatus;
  /** Facts with no column of their own. Never a raw frame and never a PAN. */
  payload?: Record<string, unknown> | null;
}

/**
 * Open an attempt. The row exists from here on, whatever happens next.
 *
 * THE REPLAY NET IS THE DATABASE'S, not a check in front of it: a retry that
 * reached two connections at once is refused by
 * `payment_attempt_action_unique` rather than by whichever of them read first.
 * The caller decides what that refusal means — `findAttemptByAction` before
 * the insert is how `finaliseSale` turns it into "this press already took its
 * money" instead of an error at a counter.
 */
export async function openAttempt(tx: Tx, input: OpenAttemptInput): Promise<AttemptRow> {
  if (input.saleId) {
    // All tender writers reserve under the same sale lock before requesting money.
    const [saleRow] = await tx
      .select()
      .from(sale)
      .where(and(eq(sale.id, input.saleId), eq(sale.operatorId, input.operatorId)))
      .for('update')
      .limit(1);
    if (!saleRow) throw errors.notFound('Sale not found');
    const attempts = await tx
      .select({ amountSatang: paymentAttempt.amountSatang, status: paymentAttempt.status })
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleRow.id));
    let taken = 0;
    let reserved = 0;
    for (const attempt of attempts) {
      if (TAKEN.includes(attempt.status)) taken += attempt.amountSatang;
      else if (!PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(attempt.status)) {
        reserved += attempt.amountSatang;
      }
    }
    const availableSatang = saleRow.grossSatang - taken - reserved;
    if (input.amountSatang > availableSatang) {
      if (reserved > 0) {
        throw errors.conflict(
          'PAYMENT_IN_FLIGHT',
          'A payment is still waiting for an answer. Resolve it before charging this balance again.',
          { availableSatang, reservedSatang: reserved },
        );
      }
      throw errors.badRequest('That tender is more than this sale still owes', {
        amountSatang: input.amountSatang,
        outstandingSatang: availableSatang,
      });
    }
  }
  const [row] = await tx
    .insert(paymentAttempt)
    .values({
      id: newId(),
      operatorId: input.operatorId,
      branchId: input.branchId,
      saleId: input.saleId ?? null,
      stationId: input.stationId ?? null,
      deviceId: input.deviceId ?? null,
      businessDate: input.businessDate,
      method: input.method,
      methodCode: input.methodCode ?? null,
      provider: input.provider ?? 'manual',
      status: input.status ?? 'created',
      amountSatang: input.amountSatang,
      tenderedSatang: input.tenderedSatang ?? null,
      changeSatang: input.changeSatang ?? null,
      invoiceNo: input.invoiceNo ?? null,
      actionId: input.actionId ?? null,
      offline: input.offline ?? false,
      payload: (input.payload ?? null) as never,
    })
    .returning();
  if (!row) throw new Error('the payment attempt was not recorded');
  return row;
}

/** What an instrument said when it approved the money. */
export interface SettleAttemptInput {
  /** `approved`, or `awaiting_settlement` for money taken on the terminal's own connection. */
  status?: PaymentAttemptStatus;
  /** When the money became ours. Defaults to now — a cash tender is paid as it is recorded. */
  paidAt?: Date;
  terminalRef?: string | null;
  tid?: string | null;
  mid?: string | null;
  approvalCode?: string | null;
  last4?: string | null;
  invoiceNo?: string | null;
  tranRef?: string | null;
  paymentId?: string | null;
  /** Who said it was paid when no machine could — the audited confirmation path (C2). */
  staffConfirmedByAccountId?: string | null;
  /** Merged over what `openAttempt` wrote, so the allow-listed adapter answer lands beside it. */
  payload?: Record<string, unknown> | null;
}

/**
 * The money is ours: stamp the attempt and say when.
 *
 * `paid_at` is set here and nowhere else. Without it the end of day (S2-15a)
 * would have to guess a payment time from `created_at`, which for a QR paid
 * twenty minutes after the till gave up is a different trading hour and
 * sometimes a different trading day.
 */
export async function settleAttempt(
  tx: Tx,
  attemptId: string,
  input: SettleAttemptInput = {},
): Promise<AttemptRow> {
  const status = input.status ?? TENDER_APPROVED;
  if (!TAKEN.includes(status)) {
    throw new Error(`settleAttempt is for money that was taken, not for "${status}"`);
  }
  const [row] = await tx
    .update(paymentAttempt)
    .set({
      status,
      paidAt: input.paidAt ?? new Date(),
      ...pick(input, [
        'terminalRef',
        'tid',
        'mid',
        'approvalCode',
        'last4',
        'invoiceNo',
        'tranRef',
        'paymentId',
        'staffConfirmedByAccountId',
      ]),
      ...(input.payload ? { payload: input.payload as never } : {}),
    })
    .where(eq(paymentAttempt.id, attemptId))
    .returning();
  if (!row) throw new Error('the payment attempt was not settled');
  return row;
}

/**
 * It did not happen, and nothing more will happen on its own.
 *
 * The sale is left exactly as it was: a declined card does not touch the
 * balance, and the till offers the methods again. The row stays — a declined
 * attempt is a fact about the evening, and the second attempt that succeeds
 * only makes sense beside it.
 */
export async function failAttempt(
  tx: Tx,
  attemptId: string,
  input: { status: Extract<PaymentAttemptStatus, 'declined' | 'cancelled' | 'not_found'>; payload?: Record<string, unknown> | null },
): Promise<AttemptRow> {
  const [row] = await tx
    .update(paymentAttempt)
    .set({
      status: input.status,
      ...(input.payload ? { payload: input.payload as never } : {}),
    })
    .where(eq(paymentAttempt.id, attemptId))
    .returning();
  if (!row) throw new Error('the payment attempt was not closed');
  return row;
}

/** Every attempt against one sale, oldest first — the order they were taken in. */
export async function attemptsForSale(db: Exec, saleId: string): Promise<PaymentAttemptView[]> {
  const rows = await db
    .select()
    .from(paymentAttempt)
    .where(eq(paymentAttempt.saleId, saleId))
    .orderBy(asc(paymentAttempt.createdAt));
  return rows.map(attemptView);
}

/**
 * What a sale still owes: its gross, less every tender that was actually taken.
 *
 * `awaiting_settlement` counts along with `approved` — the guest's card was
 * charged on the terminal's own connection, and a till that asked for the
 * balance again would take it twice. What is unsettled about it is the
 * reconciliation, not the payment.
 */
export async function outstandingAfter(
  db: Exec,
  row: { id: string; grossSatang: number },
): Promise<number> {
  const attempts = await db
    .select({ amountSatang: paymentAttempt.amountSatang, status: paymentAttempt.status })
    .from(paymentAttempt)
    .where(eq(paymentAttempt.saleId, row.id));
  const taken = attempts
    .filter((attempt) => TAKEN.includes(attempt.status))
    .reduce((sum, attempt) => sum + attempt.amountSatang, 0);
  return row.grossSatang - taken;
}

/**
 * The attempt one press of Pay already wrote, if it wrote one.
 *
 * Read inside the caller's transaction and before its insert, so a retry is
 * answered with what the first call did rather than with a unique violation.
 * Scoped to the operator because the id is minted on a till.
 */
export async function findAttemptByAction(
  db: Exec,
  operatorId: string,
  actionId: string,
): Promise<AttemptRow | null> {
  const [row] = await db
    .select()
    .from(paymentAttempt)
    .where(and(eq(paymentAttempt.operatorId, operatorId), eq(paymentAttempt.actionId, actionId)))
    .limit(1);
  return row ?? null;
}

/**
 * THE LEDGER'S WORD FOR A TENDER, which is not the token the till sent.
 *
 * Two columns, and the difference is the whole point of them (S2-10a):
 * `method_code` is the token the park configured — `cash`, `promptpay`, a
 * second acquirer's name — and `method` is what KIND of money it was, from a
 * CHECK, which is what the day's takings are grouped by. The prototype's rule,
 * ported: behaviour keys off the kind and never off the token
 * (`apps/pos/src/lib/payments.ts:41`), so a park renaming "PromptPay" changes a
 * label and nothing else.
 *
 * The kind is read from `pos.payment_method`, which is the park's own list.
 * `credit_card` resolves to `card` first, because the POS has normalised that
 * legacy token on read since the prototype (`lib/payments.ts:12`) and the
 * ledger should not be the one place it stops resolving. The till's own
 * classification is the fallback only for a token this operator has no row
 * for. A configured disabled or archived tender is refused, even when an older
 * till still displays it. Settling an existing attempt does not re-resolve it.
 *
 * A TENDER NOBODY CAN CLASSIFY IS REFUSED rather than guessed at. The list's
 * fourth kind, `other`, has no word in the ledger's vocabulary: `wallet` and
 * `voucher` are named there for the tickets that will write them and nothing
 * maps to them yet, and money filed under the wrong word is a figure in
 * somebody's day-end report that no later correction can find.
 *
 * It lives here rather than in `sale.ts`, where Slice A wrote it, because the
 * EDC, the QR and the offline replay must file money under the same word as
 * the counter does — and they never go through `finaliseSale` to get it.
 */
export async function tenderMethodOf(
  db: Exec,
  operatorId: string,
  methodCode: string,
  declaredKind: string | undefined,
): Promise<PaymentMethod> {
  const code = methodCode === 'credit_card' ? 'card' : methodCode;
  const [configured] = await db
    .select({ kind: paymentMethod.kind, enabled: paymentMethod.enabled, archivedAt: paymentMethod.archivedAt })
    .from(paymentMethod)
    .where(
      and(
        eq(paymentMethod.operatorId, operatorId),
        eq(paymentMethod.code, code),
      ),
    )
    // A live replacement wins over archived history with the same code.
    .orderBy(sql`${paymentMethod.archivedAt} asc nulls first`)
    .limit(1);
  if (configured && (!configured.enabled || configured.archivedAt)) {
    throw errors.conflict(
      'PAYMENT_METHOD_UNAVAILABLE',
      'This payment method is no longer available. Choose an available method.',
      { method: methodCode },
    );
  }
  const kind = configured?.kind ?? declaredKind;
  if (kind === 'cash' || kind === 'card' || kind === 'qr') return kind;
  // Two different refusals, because they are two different things to go and
  // fix: a tender the park does not have, and a tender whose kind the ledger
  // cannot file money under.
  throw errors.badRequest(
    kind
      ? `The tender “${methodCode}” is set up as “${kind}”, and the ledger has no word for that kind of money yet`
      : `This park takes no tender called “${methodCode}”, so the sale cannot record what kind of money it was`,
    { method: methodCode, kind: kind ?? null },
  );
}

/** The keys a caller actually set, so an update never blanks a column it said nothing about. */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
