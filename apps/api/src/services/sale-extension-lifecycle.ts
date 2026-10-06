import { and, eq, isNull } from 'drizzle-orm';
import { band, sale, saleExtension, saleExtensionBand } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import type { Tx } from './tx';

type Actor = { accountId: string; requestId?: string | null };

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
export async function applySaleExtension(tx: Tx, charge: typeof sale.$inferSelect, actor: Actor, now: Date) {
  const extension = await assertSaleExtensionCollectable(tx, charge.id);
  if (!extension || extension.status !== 'pending') return;
  const source = { id: extension.sourceSaleId };
  await tx.update(saleExtension).set({ status: 'applied', appliedAt: now }).where(eq(saleExtension.id, extension.id));
  await tx.update(saleExtensionBand).set({ appliedAt: now }).where(and(eq(saleExtensionBand.extensionId, extension.id), isNull(saleExtensionBand.appliedAt)));
  await audit.record(tx, { actorAccountId: actor.accountId, operatorId: extension.operatorId,
    branchId: extension.branchId, requestId: actor.requestId, action: 'sale.extension.apply', entityType: 'sale_extension', entityId: extension.id,
    after: { sourceSaleId: source.id, chargeSaleId: charge.id, minutesAdded: extension.minutesAdded, braceletCount: extension.braceletCount, selection: extension.selection } });
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
}

/** Called before a fresh collection and again at finalisation. Recorded money
 * remains on the original charge and can finish after explicit reselection. */
export async function assertSaleExtensionCollectable(tx: Tx, chargeSaleId: string) {
  const [found] = await tx.select().from(saleExtension).where(eq(saleExtension.chargeSaleId, chargeSaleId)).limit(1);
  if (!found || found.status !== 'pending') return found;
  const [source] = await tx.select().from(sale).where(eq(sale.id, found.sourceSaleId)).for('update').limit(1);
  const [extension] = await tx.select().from(saleExtension).where(eq(saleExtension.id, found.id)).for('update').limit(1);
  if (!extension || extension.status !== 'pending') return extension;
  if (!source || source.status !== 'finalised' || source.refundedSatang > 0) {
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
