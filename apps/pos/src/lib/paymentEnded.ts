import type { PaymentAttemptView } from '@oto/shared';

/**
 * SCRUM-979 (points 1, 11, 12, 13) — WHAT THE TILL SAYS WHEN A TENDER ENDS
 * WITHOUT MONEY.
 *
 * Since SCRUM-972 the platform ends a card payment the counter's box refused
 * BEFORE the terminal was asked as `declined`, with the reason in the read
 * view's `responseText` (`GET /payments/attempts/:id`; apps/api
 * `services/payments/terminal.ts`, `NOT_SENT_WORDS` and
 * `COMMAND_EXPIRED_WORDS`). Staff were told "Payment declined. Choose a
 * payment method." and could tell a guest their card was refused.
 *
 * TELLING THE TWO APART. A real decline by the terminal or the bank also fills
 * `responseText`, with the terminal's own words ("Bank error (code 05)", the
 * Digio and GHL response tables: packages/box-agent `terminal/digio.ts`,
 * `terminal/ghl.ts`), and the read view carries nothing else that marks a
 * payment that was never sent (the platform keeps that in the attempt's
 * payload, `notSent`, and the audit row `payment.attempt.not_sent`, neither
 * of which the till reads). So the text's presence cannot be the test. The
 * till knows the platform's own five sentences, word for word, and only those
 * say "not started"; any other text, or none, is a real decline and keeps
 * today's words exactly. A sentence the platform rewords is read as a real
 * decline until this list follows it (test/s979-payment-ended.test.ts reads
 * the platform's file and fails first). The platform could say it outright
 * instead: a `notSent: true` on the read view (see the lane's report).
 */
export const PAYMENT_NOT_STARTED_SENTENCES: readonly string[] = [
  'This counter’s box is offline, so the card terminal was not asked. Take another way to pay, or try again when the box is back online.',
  'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.',
  'The card terminal could not be asked for this payment, so nothing was charged. Try again, or take another way to pay.',
  'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.',
  'This counter’s box did not pick up the card payment in time, so the terminal was never asked. Try again, or take another way to pay.',
];

/** The statuses a tender ends in when it took no money and nothing more will happen to it. */
export const ENDED_WITHOUT_MONEY: readonly PaymentAttemptView['status'][] = ['declined', 'cancelled', 'not_found'];

export function endedWithoutMoney(attempt: Pick<PaymentAttemptView, 'status'> | null | undefined): boolean {
  return !!attempt && ENDED_WITHOUT_MONEY.includes(attempt.status);
}

/** The platform's reason when this declined tender was never sent to the terminal; null for anything else. */
export function notStartedReason(
  attempt: Pick<PaymentAttemptView, 'status'>,
  responseText: string | null | undefined,
): string | null {
  if (attempt.status !== 'declined' || typeof responseText !== 'string') return null;
  const text = responseText.trim();
  return PAYMENT_NOT_STARTED_SENTENCES.includes(text) ? text : null;
}

/**
 * The line in the place of the stage's error for a tender that ended without
 * money: the platform's reason for one never sent, else the stage's own words
 * (`today`, the ticket till's "Payment declined. Choose a payment method." or
 * the party balance's "… Press again or go back …").
 */
export function endedTenderLine(
  attempt: Pick<PaymentAttemptView, 'status'>,
  responseText: string | null | undefined,
  today: (status: string) => string,
): { line: string; notStarted: boolean } {
  const reason = notStartedReason(attempt, responseText);
  return reason ? { line: reason, notStarted: true } : { line: today(attempt.status.replaceAll('_', ' ')), notStarted: false };
}
