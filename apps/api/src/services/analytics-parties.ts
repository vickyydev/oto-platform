import { and, eq, inArray, sql } from 'drizzle-orm';
import { partyPayment, paymentAttempt } from '@oto/db';
import { PAYMENT_ATTEMPT_TAKEN_STATUSES } from '@oto/shared';
import { listBranchEvents } from './otoapp-events';
import type { Exec } from './tx';

/** Performance's party inputs, from the same events and ledger as the party tab.
 * Analytics Q3 keeps the prototype's timing: count parties held on this day;
 * count only money taken on this business day for those parties. Charges and
 * the app's recorded deposit are not additional takings. As in End of Day,
 * the app's confirmed event date governs money, not a pending till edit or
 * the historical party_date captured when a payment was taken.
 */
export async function partyFactsOf(
  db: Exec,
  clock: { id: string; operatorId: string; timezone: string },
  date: string,
): Promise<{ count: number; payments: Array<{ amountSatang: number; hour: number }> }> {
  const parties = (await listBranchEvents(db, { branchId: clock.id, from: date, to: date }))
    .filter((event) => event.type === 'party' && event.startDate === date);
  if (parties.length === 0) return { count: 0, payments: [] };
  const payments = await db.select({
    amountSatang: paymentAttempt.amountSatang,
    hour: sql<number>`extract(hour from (coalesce(${paymentAttempt.paidAt}, ${paymentAttempt.createdAt}) at time zone ${clock.timezone}))::int`,
  }).from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .where(and(
      eq(partyPayment.operatorId, clock.operatorId),
      eq(partyPayment.branchId, clock.id),
      eq(paymentAttempt.operatorId, clock.operatorId),
      eq(paymentAttempt.branchId, clock.id),
      inArray(partyPayment.otoappEventId, parties.map((event) => event.id)),
      eq(paymentAttempt.businessDate, date),
      inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES]),
    ));
  return { count: parties.length, payments };
}
