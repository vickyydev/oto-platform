import type { PartyBooking } from '@/types';

/** Keep review on an open bill; collection retains its separately frozen target. */
export function openAdditionalBillId(bills: PartyBooking['additionalBills'], selected = ''): string {
  return bills?.some((bill) => bill.id === selected && bill.state === 'open')
    ? selected : bills?.find((bill) => bill.state === 'open')?.id ?? '';
}

export function additionalBillParty(party: PartyBooking, billId: string): PartyBooking {
  const bill = party.additionalBills?.find((row) => row.id === billId);
  return bill ? { ...party, basePrice: 0, deposit: 0, availableDeposit: 0, lineItems: [], packageName: `Additional bill ${bill.id.slice(0, 8)}`,
    partyExtraCharges: party.partyExtraCharges.filter((charge) => bill.charges.some((row) => row.id === charge.id)),
    partyPayments: party.partyPayments.filter((payment) => bill.payments.some((row) => row.id === payment.id)),
  } : party;
}
