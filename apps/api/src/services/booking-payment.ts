import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from 'pino';
import { booking, paymentAttempt, type Db } from '@oto/db';
import {
  BOOKING_QR_HEADER,
  BOOKING_QR_SEPARATOR,
  bookingQrKeyId,
  mintBookingQr,
  parseBookingQr,
  ulidFromUuid,
} from '@oto/shared';
import { resolveBandKey, type Env } from '../env';
import { audit } from './audit';
import { raiseAlert } from './ops';
import { buildSmsSender } from './sms';
import { bookingChange, recordChange } from './sync';
import { withTx, type Exec, type Tx } from './tx';

/**
 * WHAT A GATEWAY PAYMENT DOES TO A BOOKING (S2-12, SCRUM-209, arrival round 1).
 *
 * `services/payments/gateway.ts` settles money; this file is the one place
 * that turns a settled — or a dead — payment attempt into a booking's state.
 * It exists as its own file so the gateway can call it without the gateway
 * knowing what a booking looks like, and without this file knowing 2C2P
 * exists.
 *
 * THE INVARIANT OF THE ROUND, and where it is kept:
 *
 *   A booking becomes `paid` ONLY inside `settlePaidAttempt`, which runs only
 *   on facts a Payment Inquiry agreed with — after a signed backend
 *   notification, or from the inquiry poller. `confirmBookingPaid` below takes
 *   the transaction that settlement opened and is exported for that caller
 *   alone. Nothing a browser carries reaches this file: the frontend return is
 *   read in `booking-checkout.ts` as a display hint and writes nothing.
 *
 * Three moves, each idempotent under the booking's row lock:
 *
 *   paid       settlement of the booking's own attempt. The QR is signed here,
 *              in the same transaction, with the park key (`BAND_HMAC_KEY`).
 *              A payment arriving after the hold ran out still confirms the
 *              booking and raises an alert for a person (OD-A11).
 *   expired    the hold ran out — the pending sweeper — or the gateway closed
 *              the payment unpaid on the clock.
 *   cancelled  the hosted page's payment failed.
 */

export type BookingRow = typeof booking.$inferSelect;

/** The booking an attempt pays for, when it pays for one. */
export async function bookingForAttempt(exec: Exec, attemptId: string): Promise<BookingRow | null> {
  const [row] = await exec
    .select()
    .from(booking)
    .where(eq(booking.paymentAttemptId, attemptId))
    .limit(1);
  return row ?? null;
}

/** The QR a paid booking carries, rebuilt from its id and stored signature. No key needed. */
export function bookingQrOf(row: Pick<BookingRow, 'id' | 'qrSignature' | 'status'>): string | null {
  if (!row.qrSignature || (row.status !== 'paid' && row.status !== 'redeemed')) return null;
  const code = `${BOOKING_QR_HEADER}${ulidFromUuid(row.id)}${BOOKING_QR_SEPARATOR}${row.qrSignature}`;
  // Parsed back so a corrupted column can never be drawn as a QR somebody queues with.
  return parseBookingQr(code) ? code : null;
}

export interface BookingPaidOutcome {
  bookingId: string;
  /** True when this call made it paid; false when it already was. */
  confirmed: boolean;
  /** Paid after its hold ran out, or after it had been closed (OD-A11). */
  late: boolean;
  /** False when no park key is configured here, so no QR could be signed. */
  qrSigned: boolean;
  row: BookingRow;
}

/**
 * MARK THE BOOKING PAID, inside the settlement's own transaction.
 *
 * Called by `settlePaidAttempt` — which is to say, only on inquiry-agreed
 * facts — and by nothing else. A second call for the same booking finds it
 * paid and changes nothing, so a replayed notification or a poller racing
 * the webhook confirms it once.
 */
export async function confirmBookingPaid(
  tx: Tx,
  env: Env,
  input: {
    attemptId: string;
    source: string;
    requestId?: string | null;
    now?: Date;
    /** The gateway itself called the payment late (`5017`, paid after its expiry). */
    gatewayLate?: boolean;
  },
): Promise<BookingPaidOutcome | null> {
  const [row] = await tx
    .select()
    .from(booking)
    .where(eq(booking.paymentAttemptId, input.attemptId))
    .for('update')
    .limit(1);
  if (!row) return null;
  if (row.status === 'paid' || row.status === 'redeemed') {
    return { bookingId: row.id, confirmed: false, late: false, qrSigned: Boolean(row.qrSignature), row };
  }
  const now = input.now ?? new Date();
  const late =
    input.gatewayLate === true ||
    row.status === 'expired' ||
    row.status === 'cancelled' ||
    (row.expiresAt !== null && now.getTime() > row.expiresAt.getTime());

  /**
   * THE SIGNATURE, WITH THE PARK KEY. The same key every box verifies bands
   * with (`BAND_HMAC_KEY`); domain separation in `booking-qr.ts` is what keeps
   * the two from ever standing in for each other. A deployment with no key
   * (staging before it is set) still records the payment — the money is real
   * — and reception falls back to the typed reference; the alert says why.
   */
  const key = resolveBandKey(env);
  const signature = key ? mintBookingQr(row.id, key).split(BOOKING_QR_SEPARATOR)[1]! : null;

  const [paidAttempt] = await tx.select({ methodCode: paymentAttempt.methodCode }).from(paymentAttempt)
    .where(eq(paymentAttempt.id, input.attemptId)).limit(1);
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};

  const [after] = await tx
    .update(booking)
    .set({
      status: 'paid',
      payload: { ...payload, paymentMethod: paidAttempt?.methodCode ?? null },
      paidAt: now,
      qrSignature: signature,
      qrKeyId: key ? bookingQrKeyId(key) : null,
      updatedAt: now,
    })
    .where(eq(booking.id, row.id))
    .returning();
  if (!after) throw new Error('the booking was not marked paid');

  await audit.record(tx, {
    // No person: the gateway said this, confirmed by an inquiry.
    actorAccountId: null,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: 'booking.pay',
    entityType: 'booking',
    entityId: row.id,
    requestId: input.requestId ?? null,
    before: { status: row.status, paidAt: null },
    after: {
      status: 'paid',
      reference: row.reference,
      paidAt: now.toISOString(),
      paymentAttemptId: input.attemptId,
      source: input.source,
      totalSatang: row.totalSatang,
      late,
      qrSigned: Boolean(signature),
    },
  });

  // The boxes at the branch hold today's and tomorrow's bookings; this one
  // just changed under them (the shape `redeemBooking` publishes).
  await recordChange(
    tx,
    { operatorId: row.operatorId, branchId: row.branchId },
    { scope: 'bookings', entityType: 'booking', entityId: row.id, payload: bookingChange(after, null) },
  );
  return { bookingId: row.id, confirmed: true, late, qrSigned: Boolean(signature), row: after };
}

/**
 * What follows a confirmation, after its transaction has committed: the
 * message to the family and, for a late or unsigned one, the alert.
 *
 * Outside the transaction on purpose. A confirmation text that failed must not
 * undo a payment, and an alert is its own write with its own flap window.
 */
export async function afterBookingPaid(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  outcome: BookingPaidOutcome,
): Promise<void> {
  if (!outcome.confirmed) return;
  const row = outcome.row;
  if (outcome.late) {
    await raiseAlert(
      db,
      {
        key: `bookings.late_payment:${row.id}`,
        category: 'bookings.late_payment',
        severity: 'warning',
        subject: 'A booking was paid after its hold ran out',
        summary: `Booking ${row.reference} was paid after it expired. It is confirmed — the money is the family's either way — so check nothing else was sold against it.`,
        detail: { bookingId: row.id, reference: row.reference, paymentAttemptId: row.paymentAttemptId },
        operatorId: row.operatorId,
        branchId: row.branchId,
      },
      { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
    );
  }
  if (!outcome.qrSigned) {
    await raiseAlert(
      db,
      {
        key: `bookings.qr_unsigned:${row.branchId}`,
        category: 'bookings.qr_unsigned',
        severity: 'warning',
        subject: 'A paid booking has no signed QR',
        summary: `Booking ${row.reference} is paid, but this deployment has no park key (BAND_HMAC_KEY) to sign its QR. Reception can redeem it by its reference.`,
        detail: { bookingId: row.id, reference: row.reference },
        operatorId: row.operatorId,
        branchId: row.branchId,
      },
      { flapWindowSeconds: env.ALERT_FLAP_WINDOW_S },
    );
  }
  await sendBookingConfirmation(log, row);
}

/**
 * The confirmation, through the messaging CONSOLE adapter (plan §2.1): the
 * message is written to the api log with the phone hashed, which is where
 * customer messaging stands until its own ticket gives it a channel. Best
 * effort — a message that could not be written is logged, never thrown.
 */
async function sendBookingConfirmation(log: FastifyBaseLogger, row: BookingRow): Promise<void> {
  const payload = (row.payload ?? {}) as { phone?: unknown };
  const phone = typeof payload.phone === 'string' ? payload.phone : null;
  if (!phone) return;
  try {
    const sender = buildSmsSender({ adapter: 'console' }, log as unknown as Logger);
    await sender.send(
      phone,
      `OTO Park: booking ${row.reference} for ${row.bookingDate} is paid. Show the QR on your confirmation page at reception.`,
    );
  } catch (err) {
    log.warn({ err, bookingId: row.id }, 'the booking confirmation could not be sent');
  }
}

/**
 * The attempt died without money: the booking goes with it, if it is still
 * waiting. Inside the transaction that closed the attempt.
 */
export async function closeBookingUnpaid(
  tx: Tx,
  input: { attemptId: string; status: 'expired' | 'cancelled'; reason: string; requestId?: string | null },
): Promise<BookingRow | null> {
  const [row] = await tx
    .select()
    .from(booking)
    .where(eq(booking.paymentAttemptId, input.attemptId))
    .for('update')
    .limit(1);
  if (!row || row.status !== 'pending') return null;
  return closeOne(tx, row, input.status, input.reason, input.requestId ?? null);
}

async function closeOne(
  tx: Tx,
  row: BookingRow,
  status: 'expired' | 'cancelled',
  reason: string,
  requestId: string | null,
): Promise<BookingRow> {
  const [after] = await tx
    .update(booking)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(booking.id, row.id), eq(booking.status, 'pending')))
    .returning();
  if (!after) return row;
  await audit.record(tx, {
    actorAccountId: null,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: status === 'expired' ? 'booking.expire' : 'booking.cancel',
    entityType: 'booking',
    entityId: row.id,
    requestId,
    before: { status: row.status, expiresAt: row.expiresAt?.toISOString() ?? null },
    after: { status, reason, reference: row.reference },
  });
  await recordChange(
    tx,
    { operatorId: row.operatorId, branchId: row.branchId },
    { scope: 'bookings', entityType: 'booking', entityId: row.id, payload: bookingChange(after, null) },
  );
  return after;
}

/** How many overdue holds one sweep ends. A bound on the tick, not on the day. */
const EXPIRE_BATCH = 200;

/**
 * THE PENDING SWEEPER'S BOOKING HALF (OD-A11): every unpaid booking whose hold
 * has run out becomes `expired`, audited, one transaction each so one bad row
 * cannot hold the rest.
 *
 * Its payment attempt is left to the poller, which keeps asking the gateway
 * until the attempt's own expiry and closes it there. A payment that lands in
 * between still confirms the booking — late, with an alert.
 */
export async function expireOverdueBookings(
  db: Db,
  log: FastifyBaseLogger | undefined,
  now: Date = new Date(),
): Promise<number> {
  const due = await db
    .select({ id: booking.id, operatorId: booking.operatorId, branchId: booking.branchId })
    .from(booking)
    .where(
      and(
        eq(booking.status, 'pending'),
        isNull(booking.archivedAt),
        lt(booking.expiresAt, now),
      ),
    )
    .orderBy(asc(booking.expiresAt))
    .limit(EXPIRE_BATCH);
  let expired = 0;
  for (const item of due) {
    const done = await withTx(
      db,
      { actorAccountId: null, operatorId: item.operatorId, branchId: item.branchId, log },
      'booking.expire',
      async (tx) => {
        const [row] = await tx
          .select()
          .from(booking)
          .where(eq(booking.id, item.id))
          .for('update')
          .limit(1);
        if (!row || row.status !== 'pending' || !row.expiresAt || row.expiresAt >= now) return false;
        await closeOne(tx, row, 'expired', 'hold_elapsed', null);
        return true;
      },
    );
    if (done) expired += 1;
  }
  return expired;
}

/** A pending booking still inside its hold — the only one a checkout may open. */
export function holdIsOpen(row: Pick<BookingRow, 'status' | 'expiresAt'>, now: Date): boolean {
  return row.status === 'pending' && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
}
