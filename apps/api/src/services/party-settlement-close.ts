import { and, eq, isNull } from 'drizzle-orm';
import { partyEdit, partySettlement, type sale } from '@oto/db';
import { deriveId, type PartyStoredEditFields } from '@oto/shared';
import { audit } from './audit';
import type { Tx } from './tx';

/**
 * SCRUM-804 — A PARTY'S SETTLEMENT SALE, AT THE MOMENT IT IS PAID.
 *
 * A settlement's balance is taken through the ordinary payment stage, and a
 * card or a QR answers later — from the terminal or the gateway, with the till
 * possibly gone. Every path that closes a sale goes through `finaliseSale`, so
 * the settlement is closed here, in the transaction that closes its sale:
 * stamped settled, and given the party edit that tells the OTO App which sale
 * settled the party (`fields.posSaleId`, kept there in
 * `beo_event_billing.pos_order_ref`). The edit is written `pending`; the push
 * to the app runs after the commit (`writeBackPartySettlement`), and a push
 * that fails waits on the Failures page like any party edit.
 *
 * The edit's id is derived from the settlement's, so a sale closed twice (a
 * replay) never writes it twice. In a file of its own because
 * `party-settlement.ts` imports `sale.ts`.
 */
export const partySettlementEditId = (settlementId: string): string =>
  deriveId(settlementId, 'party-settlement:pos-sale-id');

export async function applyPartySettlementClose(
  tx: Tx,
  closed: typeof sale.$inferSelect,
  actor: { accountId: string | null; requestId?: string | null },
  now: Date,
): Promise<void> {
  const [settlement] = await tx
    .select()
    .from(partySettlement)
    .where(and(eq(partySettlement.saleId, closed.id), isNull(partySettlement.releasedAt)))
    .for('update')
    .limit(1);
  if (!settlement || settlement.writeBackEditId) return;
  const editId = partySettlementEditId(settlement.id);
  const fields: PartyStoredEditFields = { posSaleId: closed.id };
  await tx
    .insert(partyEdit)
    .values({
      id: editId,
      operatorId: settlement.operatorId,
      branchId: settlement.branchId,
      otoappEventId: settlement.otoappEventId,
      fields,
      syncState: 'pending',
      accountId: actor.accountId ?? settlement.accountId,
      stationId: settlement.stationId,
      boxId: settlement.boxId,
      actionId: settlement.actionId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await tx
    .update(partySettlement)
    .set({ settledAt: settlement.settledAt ?? now, writeBackEditId: editId, updatedAt: now })
    .where(eq(partySettlement.id, settlement.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId ?? settlement.accountId,
    operatorId: settlement.operatorId,
    branchId: settlement.branchId,
    action: 'party.update',
    entityType: 'party_edit',
    entityId: editId,
    actionId: settlement.actionId,
    requestId: actor.requestId ?? undefined,
    after: {
      eventId: settlement.otoappEventId,
      posSaleId: closed.id,
      settlementId: settlement.id,
      receiptNumber: closed.receiptNumber,
    },
  });
}
