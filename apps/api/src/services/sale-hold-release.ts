import { and, eq, isNull } from 'drizzle-orm';
import { saleHold, type SaleHoldRelease } from '@oto/db';
import { audit } from './audit';
import type { Tx } from './tx';

/**
 * SCRUM-774 — END A SALE'S OPEN HOLD, whatever closed the sale.
 *
 * A held sale leaves the branch's Held sales list when it is taken back to a
 * till (`resumed`, in `services/sale-holds.ts`), and also when anything else
 * closes it: a void at a till or from the list (`voided`), the refund of a
 * part-paid sale that closes it (`refunded`), a payment that brings its
 * balance to zero (`paid`), or the midnight job (`not_collected`). Each of
 * those calls this in its own transaction, under the sale's row lock, so the
 * list and the ledger can never disagree about whether a sale is waiting.
 *
 * Kept apart from `sale-holds.ts` because `sale.ts` and `refunds.ts` call it
 * and `sale-holds.ts` calls them. A null account is the platform itself.
 * Answers the hold it ended, or null when the sale was not held.
 */
export async function releaseOpenHold(
  tx: Tx,
  saleId: string,
  reason: SaleHoldRelease,
  actor: { accountId: string | null; operatorId: string; requestId?: string | null },
  now: Date,
  extra: { resumedStationId?: string; resumeActionId?: string | null } = {},
): Promise<typeof saleHold.$inferSelect | null> {
  const [ended] = await tx
    .update(saleHold)
    .set({
      releasedAt: now,
      releasedByAccountId: actor.accountId,
      releasedReason: reason,
      resumedStationId: extra.resumedStationId ?? null,
      resumeActionId: extra.resumeActionId ?? null,
      updatedAt: now,
    })
    .where(and(eq(saleHold.saleId, saleId), isNull(saleHold.releasedAt)))
    .returning();
  if (!ended) return null;
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: ended.branchId,
    action: reason === 'resumed' ? 'sale.hold.resume' : 'sale.hold.release',
    entityType: 'sale',
    entityId: saleId,
    requestId: actor.requestId ?? null,
    actionId: extra.resumeActionId ?? null,
    ...(actor.accountId === null ? { origin: 'job' } : {}),
    before: { holdId: ended.id, held: true, kind: ended.kind, label: ended.label, heldStationId: ended.heldStationId },
    after: {
      holdId: ended.id,
      held: false,
      reason,
      ...(extra.resumedStationId ? { resumedStationId: extra.resumedStationId } : {}),
    },
  });
  return ended;
}
