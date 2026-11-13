import { and, eq, inArray } from 'drizzle-orm';
import { partySettlement, paymentAttempt, refund } from '@oto/db';
import { isPartyDepositAttempt, isPaymentReversalPending, PAYMENT_ATTEMPT_TAKEN_STATUSES, PAYMENT_ATTEMPT_TERMINAL_STATUSES } from '@oto/shared';
import { errors } from '../lib/errors';
import type { Exec } from './tx';

type Attempt = typeof paymentAttempt.$inferSelect;
type Refund = typeof refund.$inferSelect;

export interface PartyDepositHistory {
  returnedSatang: number;
  reviewRequired: boolean;
}

/** A retained allocation is not a second payment, nor a refund to the family. */
export function assertPartyDepositHistory(history: PartyDepositHistory): void {
  if (history.reviewRequired) {
    throw errors.conflict(
      'PARTY_DEPOSIT_REVIEW_REQUIRED',
      'This party has an unresolved deposit refund. Review its payment records before settling or refunding it.',
    );
  }
}

/** Validate money slices before treating an old manual handback as returned. */
function returnsOnSale(attempts: Attempt[], refunds: Refund[], depositId: string | null) {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const returned = new Map<string, number>();
  let deposit = 0;
  let till = 0;
  let retained = 0;
  let review = false;
  for (const r of refunds) {
    let allocated = 0;
    if (!Array.isArray(r.tenderAllocation)) {
      review = true;
      continue;
    }
    for (const s of r.tenderAllocation) {
      if (!s || typeof s !== 'object') {
        review = true;
        continue;
      }
      if (!Number.isSafeInteger(s.amountSatang) || s.amountSatang <= 0) {
        review = true;
        continue;
      }
      allocated += s.amountSatang;
      const a = s.attemptId ? byId.get(s.attemptId) : null;
      if (s.attemptId && !a) review = true;
      if (a) {
        const total = (returned.get(a.id) ?? 0) + s.amountSatang;
        returned.set(a.id, total);
        if (total > a.amountSatang) review = true;
      }
      if (s.attemptId === depositId && depositId !== null) {
        if (!a || !isPartyDepositAttempt(a) || s.status !== 'done' || s.fallback) review = true;
        else deposit += s.amountSatang;
      } else {
        if (a && isPartyDepositAttempt(a)) review = true;
        till += s.amountSatang;
      }
    }
    if (allocated !== r.amountSatang) review = true;
    retained += r.retainedPartyDepositSatang;
  }
  return { deposit, till, retained, review };
}

/** Batch-safe: one malformed party is flagged without breaking the day's list. */
export async function partyDepositHistoriesOf(
  db: Exec,
  q: { branchId: string; eventIds: readonly string[] },
): Promise<Map<string, PartyDepositHistory>> {
  const out = new Map(q.eventIds.map((id) => [id, { returnedSatang: 0, reviewRequired: false }]));
  if (!q.eventIds.length) return out;
  const settlements = await db
    .select()
    .from(partySettlement)
    .where(
      and(
        eq(partySettlement.branchId, q.branchId),
        inArray(partySettlement.otoappEventId, [...q.eventIds]),
      ),
    );
  if (!settlements.length) return out;
  const ids = settlements.map((s) => s.saleId);
  const attempts = await db
    .select()
    .from(paymentAttempt)
    .where(inArray(paymentAttempt.saleId, ids));
  const refunds = await db.select().from(refund).where(inArray(refund.saleId, ids));
  for (const s of settlements) {
    const entry = out.get(s.otoappEventId)!;
    const own = attempts.filter((a) => a.saleId === s.saleId);
    const d = own.find((a) => a.id === s.depositAttemptId);
    const p = d?.payload as { partyEventId?: unknown; settlementId?: unknown } | null;
    if (
      (s.depositSatang > 0 &&
        (!d ||
          !isPartyDepositAttempt(d) ||
          d.amountSatang !== s.depositSatang ||
          d.operatorId !== s.operatorId ||
          d.branchId !== s.branchId ||
          p?.partyEventId !== s.otoappEventId ||
          p?.settlementId !== s.id)) ||
      (s.depositSatang === 0 && s.depositAttemptId !== null)
    )
      entry.reviewRequired = true;
    const ownRefunds = refunds.filter((r) => r.saleId === s.saleId);
    const money = returnsOnSale(own, ownRefunds, s.depositAttemptId);
    entry.returnedSatang += money.deposit;
    entry.reviewRequired ||= money.review || money.deposit + money.retained > s.depositSatang;
    if (d && !PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(d.status) && d.status !== 'cancelled')
      entry.reviewRequired = true;
    if (money.retained > 0) {
      const releases = ownRefunds.filter((r) => r.retainedPartyDepositSatang > 0);
      const cancellation = (
        d?.payload as {
          cancelledWithSale?: { refundId?: string; retainedPartyDepositSatang?: number };
        } | null
      )?.cancelledWithSale;
      if (
        releases.length !== 1 ||
        d?.status !== 'cancelled' ||
        cancellation?.refundId !== releases[0]?.id ||
        cancellation?.retainedPartyDepositSatang !== money.retained
      )
        entry.reviewRequired = true;
    }
  }
  return out;
}

export async function availablePartyDeposit(
  db: Exec,
  q: { branchId: string; eventId: string; recordedSatang: number },
): Promise<number> {
  const h = (
    await partyDepositHistoriesOf(db, { branchId: q.branchId, eventIds: [q.eventId] })
  ).get(q.eventId)!;
  assertPartyDepositHistory({
    ...h,
    reviewRequired: h.reviewRequired || h.returnedSatang > q.recordedSatang,
  });
  return Math.max(0, q.recordedSatang - h.returnedSatang);
}

/** The current sale's money ceiling, distinct from its immutable charged gross. */
export async function partyRefundBalanceOf(db: Exec, saleId: string) {
  const [s] = await db
    .select()
    .from(partySettlement)
    .where(eq(partySettlement.saleId, saleId))
    .limit(1);
  if (!s) return null;
  const h = (
    await partyDepositHistoriesOf(db, { branchId: s.branchId, eventIds: [s.otoappEventId] })
  ).get(s.otoappEventId)!;
  const attempts = await db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
  const refunds = await db.select().from(refund).where(eq(refund.saleId, saleId));
  const money = returnsOnSale(attempts, refunds, s.depositAttemptId);
  const paid = attempts
    .filter((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status) && !isPartyDepositAttempt(a))
    .reduce((n, a) => n + a.amountSatang, 0);
  const retainableSatang = Math.max(0, s.depositSatang - money.deposit - money.retained);
  return {
    ...h,
    remainingSatang: Math.max(0, paid - money.till),
    retainedSatang: money.retained,
    retainableSatang,
    inFlight: attempts.some((a) => !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(a.status) || isPaymentReversalPending(a.payload)),
    depositAttemptId: s.depositAttemptId,
  };
}
