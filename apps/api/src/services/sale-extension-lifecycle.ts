import { and, eq, inArray, isNull } from 'drizzle-orm';
import { band, checkin, sale, saleExtension, saleExtensionBand, saleLine } from '@oto/db';
import { isExtraHourLine } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import type { Tx } from './tx';

// SCRUM-774: a null account is the platform itself (the midnight void of a held sale).
type Actor = { accountId: string | null; requestId?: string | null };

/**
 * SCRUM-797 — THE ADDED HOURS REACH THE CHILD'S CLOCK. The one play clock the
 * platform keeps is a supervised (drop-off or nanny) stay's booked minutes:
 * the Drop-Off board counts it down to "overdue", and the box's desk reads it
 * through the `checkin` scope it pulls on its own tick. Every child on the
 * order's 1- and 2-hour tickets paid for the hours, so each of their stays on
 * this admission that is still booked or in the park moves by them: forward
 * when the charge is paid, back when a paid charge is voided or refunded. A
 * collected child's record, and a stay with no booked length, are left as
 * they were. Each move is a `checkin.update` audit row, so it shows in the
 * stay's change history as any edit of its booked play time does.
 */
async function moveExtraHourClocks(
  tx: Tx,
  extension: typeof saleExtension.$inferSelect,
  direction: 1 | -1,
  actor: Actor,
  now: Date,
) {
  const lines = await tx.select({ kind: saleLine.kind, cartLineId: saleLine.cartLineId,
    ticketPackageId: saleLine.ticketPackageId, stayHours: saleLine.stayHours })
    .from(saleLine).where(eq(saleLine.saleId, extension.sourceSaleId));
  // A stay's id is its drop-off cart line's (`loadChoice` in checkin.ts reads it the same way).
  const paidFor = [...new Set(lines.filter((line) => line.kind === 'kids' && line.cartLineId !== null
    && isExtraHourLine({ ticket: line.ticketPackageId !== null, stayHours: line.stayHours }))
    .map((line) => line.cartLineId!))];
  if (paidFor.length === 0) return;
  const stays = await tx.select().from(checkin).where(and(eq(checkin.operatorId, extension.operatorId),
    eq(checkin.saleId, extension.sourceSaleId), inArray(checkin.id, paidFor),
    inArray(checkin.status, ['registered', 'in_park']))).for('update');
  for (const stay of stays) {
    if (stay.bookedMinutes === null) continue;
    const bookedMinutes = stay.bookedMinutes + direction * extension.minutesAdded;
    if (bookedMinutes <= 0) continue;
    await tx.update(checkin).set({ bookedMinutes, updatedAt: now }).where(eq(checkin.id, stay.id));
    await audit.record(tx, { actorAccountId: actor.accountId, operatorId: stay.operatorId, branchId: stay.branchId,
      requestId: actor.requestId ?? null, action: 'checkin.update', entityType: 'checkin', entityId: stay.id,
      before: { bookedMinutes: stay.bookedMinutes },
      after: { bookedMinutes, event: direction > 0 ? 'extra_hour' : 'extra_hour_cancelled', extensionId: extension.id,
        chargeSaleId: extension.chargeSaleId, minutesAdded: extension.minutesAdded } });
  }
}

/** The source row is already locked by the refund writer. */
export async function assertNoPendingExtensions(tx: Tx, sourceSaleId: string) {
  const [pending] = await tx.select({ chargeSaleId: saleExtension.chargeSaleId }).from(saleExtension)
    .where(and(eq(saleExtension.sourceSaleId, sourceSaleId), eq(saleExtension.status, 'pending'))).limit(1);
  if (pending) throw errors.conflict('EXTENSION_PENDING', 'Finish or void the pending time extension before refunding this admission.', pending);
}

/** No partial-minute rule exists: keep this explicit until the park chooses one. */
export async function assertExtensionRefund(tx: Tx, chargeSaleId: string, amountSatang: number, remainingSatang: number) {
  const [extension] = await tx.select({ id: saleExtension.id }).from(saleExtension).where(eq(saleExtension.chargeSaleId, chargeSaleId)).limit(1);
  if (extension && amountSatang !== remainingSatang) {
    throw errors.conflict('EXTENSION_FULL_REFUND_ONLY', 'Refund the whole time extension. Partial time-extension refunds are not available yet.');
  }
}

/** Called inside paid finalisation, never by a UI promise or a terminal acknowledgement. */
export async function applySaleExtension(
  tx: Tx,
  charge: typeof sale.$inferSelect,
  // A device-rung sale (S2-20 K1) applies none, and the audit row names nobody.
  actor: { accountId: string | null; requestId?: string | null },
  now: Date,
) {
  const extension = await assertSaleExtensionCollectable(tx, charge.id);
  if (!extension || extension.status !== 'pending') return;
  const source = { id: extension.sourceSaleId };
  await tx.update(saleExtension).set({ status: 'applied', appliedAt: now }).where(eq(saleExtension.id, extension.id));
  await tx.update(saleExtensionBand).set({ appliedAt: now }).where(and(eq(saleExtensionBand.extensionId, extension.id), isNull(saleExtensionBand.appliedAt)));
  await audit.record(tx, { actorAccountId: actor.accountId, operatorId: extension.operatorId,
    branchId: extension.branchId, requestId: actor.requestId, action: 'sale.extension.apply', entityType: 'sale_extension', entityId: extension.id,
    after: { sourceSaleId: source.id, chargeSaleId: charge.id, minutesAdded: extension.minutesAdded, braceletCount: extension.braceletCount, selection: extension.selection } });
  await moveExtraHourClocks(tx, extension, 1, actor, now);
}

/** Voids/refunds preserve the extension and its band rows as financial history. */
export async function cancelSaleExtension(tx: Tx, charge: typeof sale.$inferSelect, actor: Actor, now: Date) {
  const [extension] = await tx.select().from(saleExtension).where(eq(saleExtension.chargeSaleId, charge.id)).for('update').limit(1);
  if (!extension || extension.status === 'voided') return;
  await tx.update(saleExtension).set({ status: 'voided', voidedAt: now }).where(eq(saleExtension.id, extension.id));
  await tx.update(saleExtensionBand).set({ revokedAt: now }).where(eq(saleExtensionBand.extensionId, extension.id));
  await audit.record(tx, { actorAccountId: actor.accountId, operatorId: extension.operatorId,
    branchId: extension.branchId, requestId: actor.requestId, action: 'sale.extension.cancel', entityType: 'sale_extension', entityId: extension.id,
    before: { status: extension.status }, after: { status: 'voided', sourceSaleId: extension.sourceSaleId, chargeSaleId: charge.id, reason: charge.status } });
  // Only a paid charge moved the clocks; a pending one never did.
  if (extension.status === 'applied') await moveExtraHourClocks(tx, extension, -1, actor, now);
}

/** Called before a fresh collection and again at finalisation. Recorded money
 * remains on the original charge and can finish after explicit reselection. */
export async function assertSaleExtensionCollectable(tx: Tx, chargeSaleId: string) {
  const [found] = await tx.select().from(saleExtension).where(eq(saleExtension.chargeSaleId, chargeSaleId)).limit(1);
  if (!found || found.status !== 'pending') return found;
  const [source] = await tx.select().from(sale).where(eq(sale.id, found.sourceSaleId)).for('update').limit(1);
  const [extension] = await tx.select().from(saleExtension).where(eq(saleExtension.id, found.id)).for('update').limit(1);
  if (!extension || extension.status !== 'pending') return extension;
  if (!source || source.status !== 'finalised') {
    throw errors.conflict('EXTENSION_SOURCE_CHANGED', 'This admission is no longer eligible for extra time.');
  }
  const selected = await tx.select({ state: band.status, sourceSaleId: band.saleId })
    .from(saleExtensionBand).innerJoin(band, eq(band.id, saleExtensionBand.bandId))
    .where(eq(saleExtensionBand.extensionId, extension.id)).for('update');
  if (selected.some((item) => item.state !== 'active' || item.sourceSaleId !== source.id)
    || (extension.selection.mode === 'bands' && selected.length !== extension.braceletCount)) {
    throw errors.conflict('EXTENSION_BAND_UNAVAILABLE', 'Choose the replacement bracelets before continuing this payment.',
      { extensionId: extension.id, sourceSaleId: source.id, needsReselection: true });
  }
  return extension;
}

/**
 * For the paths that close a charge on their own once its money is in (a
 * gateway notification, a box replay): money already taken is never refused.
 * When the admission or its selected bracelets changed after collection began,
 * the charge stays open with that money recorded, and the till's Add time
 * recovery reselects the bracelets and closes it.
 */
export async function extensionHoldsClose(tx: Tx, chargeSaleId: string): Promise<boolean> {
  try {
    await assertSaleExtensionCollectable(tx, chargeSaleId);
    return false;
  } catch (err) {
    if (err instanceof AppError && (err.code === 'EXTENSION_BAND_UNAVAILABLE' || err.code === 'EXTENSION_SOURCE_CHANGED')) return true;
    throw err;
  }
}
