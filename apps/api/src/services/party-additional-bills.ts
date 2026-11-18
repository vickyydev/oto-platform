import { and, asc, eq } from 'drizzle-orm';
import { partyAdditionalBill } from '@oto/db';
import { deriveId, type PartyAdditionalBill, type PartyAdditionalBillReceipt, type PartyChargeView, type PartyPaymentView } from '@oto/shared';
import { errors } from '../lib/errors';
import type { Exec } from './tx';

export function additionalBillFigures(charges: readonly Pick<PartyChargeView, 'totalSatang'>[], payments: readonly Pick<PartyPaymentView, 'amountSatang' | 'takenAt'>[]) {
  const totalSatang = charges.reduce((sum, row) => sum + row.totalSatang, 0);
  const paidSatang = payments.reduce((sum, row) => sum + row.amountSatang, 0);
  const outstandingSatang = Math.max(0, totalSatang - paidSatang);
  return { totalSatang, paidSatang, outstandingSatang, state: outstandingSatang > 0 ? 'open' as const : 'paid' as const,
    paidAt: outstandingSatang === 0 ? [...payments].map((row) => row.takenAt).sort().at(-1) ?? null : null };
}

export async function additionalBillsOf(db: Exec, branchId: string, eventId: string, charges: PartyChargeView[], payments: PartyPaymentView[], heldRows?: typeof partyAdditionalBill.$inferSelect[], receipts?: ReadonlyMap<string, PartyAdditionalBillReceipt>): Promise<PartyAdditionalBill[]> {
  const rows = heldRows ?? await db.select().from(partyAdditionalBill).where(and(eq(partyAdditionalBill.branchId, branchId), eq(partyAdditionalBill.otoappEventId, eventId))).orderBy(asc(partyAdditionalBill.createdAt), asc(partyAdditionalBill.id));
  return rows.map((row) => {
    const billed = charges.filter((charge) => charge.additionalBillId === row.id);
    const taken = payments.filter((payment) => payment.additionalBillId === row.id);
    // SCRUM-1002 — the bill's own receipt once it is paid in full; null until then.
    return { id: row.id, eventId: row.otoappEventId, mainSettlementId: row.mainSettlementId, createdAt: row.createdAt.toISOString(), charges: billed, payments: taken, ...additionalBillFigures(billed, taken), receipt: receipts?.get(row.id) ?? null };
  });
}

/** Called only under lockParty, after current successful payment facts have been read. */
export async function billForNewCharge(db: Exec, q: { operatorId: string; branchId: string; eventId: string; mainSettlementId: string; chargeId: string; bills: PartyAdditionalBill[]; now: Date }): Promise<string> {
  const open = [...q.bills].reverse().find((bill) => bill.mainSettlementId === q.mainSettlementId && bill.state === 'open');
  if (open) return open.id;
  const id = deriveId(q.chargeId, 'party-additional-bill');
  await db.insert(partyAdditionalBill).values({ id, operatorId: q.operatorId, branchId: q.branchId, otoappEventId: q.eventId, mainSettlementId: q.mainSettlementId, createdAt: q.now, updatedAt: q.now });
  return id;
}

export function paymentBillOf(bills: readonly PartyAdditionalBill[], id: string | undefined): PartyAdditionalBill | null {
  if (!id) {
    if (bills.some((bill) => bill.state === 'open')) throw errors.conflict('ADDITIONAL_BILL_REQUIRED', 'Choose the additional bill to pay. The original receipt and older balance are separate.');
    return null;
  }
  const bill = bills.find((held) => held.id === id);
  if (!bill) throw errors.notFound('Additional bill not found for this party');
  if (bill.state === 'paid') throw errors.conflict('PARTY_NOTHING_OWED', 'This additional bill is already paid - nothing was taken');
  return bill;
}
