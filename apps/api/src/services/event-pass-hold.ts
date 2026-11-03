import { and, eq } from 'drizzle-orm';
import { eventAttendeeLink, eventPassHold, sale, saleLine } from '@oto/db';
import { audit } from './audit';
import type { Tx } from './tx';

/**
 * SCRUM-732 — A PASS WAITING FOR ITS MONEY, at the two moments its sale ends.
 *
 * A pass paid by QR or card cannot be one transaction: the money answers later,
 * from a gateway or a terminal, and the till may be gone by then. So the sale
 * waits in `tendering` beside a hold (`pos.event_pass_hold`, written by
 * `openEventPass`), and the two ends of a sale's life settle the hold in the
 * transaction that ends it. Every path that closes a sale goes through
 * `finaliseSale`, which is what makes the prototype's rule hold whoever closes
 * it: a completed payment always lands a roster entry, and nothing else does.
 *
 * In a file of its own because `event-writes.ts` imports `sale.ts`.
 */

type Actor = { accountId: string | null; requestId?: string | null };

/** Called inside paid finalisation: the money is in, so the child is on the roster. */
export async function applyEventPassHold(
  tx: Tx,
  charge: typeof sale.$inferSelect,
  actor: Actor,
  now: Date,
): Promise<void> {
  const [hold] = await tx
    .select()
    .from(eventPassHold)
    .where(and(eq(eventPassHold.saleId, charge.id), eq(eventPassHold.status, 'pending')))
    .for('update')
    .limit(1);
  if (!hold) return;
  const [line] = await tx
    .select({ id: saleLine.id })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, charge.id), eq(saleLine.cartLineId, hold.id)))
    .limit(1);
  await tx.insert(eventAttendeeLink).values({
    id: hold.id,
    operatorId: hold.operatorId,
    branchId: hold.branchId,
    otoappEventId: hold.otoappEventId,
    eventType: hold.eventType,
    childId: hold.childId,
    memberId: hold.memberId,
    saleId: charge.id,
    saleLineId: line?.id ?? null,
    billing: 'sale',
    priceSnapshotSatang: hold.priceSnapshotSatang,
    parentAttending: hold.parentAttending,
    attendanceDays: hold.attendanceDays,
    source: 'till',
    syncState: 'pending',
    writeback: hold.writeback,
    accountId: hold.accountId,
    stationId: hold.stationId,
    boxId: hold.boxId,
    actionId: hold.actionId,
    createdAt: now,
    updatedAt: now,
  });
  await tx
    .update(eventPassHold)
    .set({ status: 'applied', appliedAt: now, updatedAt: now })
    .where(eq(eventPassHold.id, hold.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId ?? hold.accountId,
    operatorId: hold.operatorId,
    branchId: hold.branchId,
    action: 'event.pass_sell',
    entityType: 'event_attendee_link',
    entityId: hold.id,
    actionId: hold.actionId,
    requestId: actor.requestId,
    after: {
      eventId: hold.otoappEventId,
      eventType: hold.eventType,
      billing: 'sale',
      priceSatang: hold.priceSnapshotSatang,
      pricingMode: hold.pricingMode,
      saleId: charge.id,
      receiptNumber: charge.receiptNumber,
      stationId: hold.stationId,
      boxId: hold.boxId,
      registerProperly: hold.registerProperly,
      attendanceDays: hold.attendanceDays.length,
      memberId: hold.memberId,
      childId: hold.childId,
    },
  });
}

/** Called when the sale is voided: nothing was paid, so the child is let go with it. */
export async function releaseEventPassHold(
  tx: Tx,
  charge: typeof sale.$inferSelect,
  actor: Actor,
  now: Date,
): Promise<void> {
  const [hold] = await tx
    .select()
    .from(eventPassHold)
    .where(and(eq(eventPassHold.saleId, charge.id), eq(eventPassHold.status, 'pending')))
    .for('update')
    .limit(1);
  if (!hold) return;
  await tx
    .update(eventPassHold)
    .set({ status: 'released', releasedAt: now, updatedAt: now })
    .where(eq(eventPassHold.id, hold.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: hold.operatorId,
    branchId: hold.branchId,
    action: 'event.pass_release',
    entityType: 'event_pass_hold',
    entityId: hold.id,
    requestId: actor.requestId,
    before: { status: 'pending' },
    after: { status: 'released', saleId: charge.id, eventId: hold.otoappEventId },
  });
}
