import type { PartyBooking } from '@/types';
import { satangText } from './bahtText';

/** Keep review on an open bill; collection retains its separately frozen target. */
export function openAdditionalBillId(bills: PartyBooking['additionalBills'], selected = ''): string {
  return bills?.some((bill) => bill.id === selected && bill.state === 'open')
    ? selected : bills?.find((bill) => bill.state === 'open')?.id ?? '';
}

/**
 * SCRUM-1000 — a bill's name, as the party pages and both payment screens say
 * it: "Additional bill 1" for the party's first (the platform lists them oldest
 * first). The phone till named each by the start of its reference, which is the
 * party's own and so the same for every bill of one party. Null for no bill.
 */
export function additionalBillName(bills: PartyBooking['additionalBills'], billId: string | null | undefined): string | null {
  const at = billId ? bills?.findIndex((bill) => bill.id === billId) ?? -1 : -1;
  return at < 0 ? null : `Additional bill ${at + 1}`;
}

export interface AdditionalBillChoice {
  /** The bill's id; '' for the older unassigned tab. */
  value: string;
  label: string;
  disabled: boolean;
}

/**
 * SCRUM-1000 — "Bill to collect", one list for the counter and phone tills.
 * The older unassigned tab cannot be chosen while an additional bill is open
 * (the platform refuses that payment: "Choose the additional bill to pay"); a
 * paid bill stays in the list, named, and cannot be chosen.
 */
export function additionalBillChoices(bills: PartyBooking['additionalBills']): AdditionalBillChoice[] {
  const list = bills ?? [];
  return [
    { value: '', label: 'Older unassigned tab balance', disabled: list.some((bill) => bill.state === 'open') },
    ...list.map((bill, index) => ({
      value: bill.id,
      label: `Additional bill ${index + 1} - ${bill.state} - THB ${satangText(bill.outstandingSatang)} outstanding`,
      disabled: bill.state === 'paid',
    })),
  ];
}

/**
 * The party as one additional bill's payer sees it: that bill's own charges and
 * payments, under the bill's name, with no package, add-ons or deposit (those
 * are the main bill's, which the parents settled).
 */
export function additionalBillParty(party: PartyBooking, billId: string): PartyBooking {
  const bill = party.additionalBills?.find((row) => row.id === billId);
  return bill ? { ...party, basePrice: 0, deposit: 0, availableDeposit: 0, lineItems: [],
    packageName: additionalBillName(party.additionalBills, bill.id) ?? undefined,
    partyExtraCharges: party.partyExtraCharges.filter((charge) => bill.charges.some((row) => row.id === charge.id)),
    partyPayments: party.partyPayments.filter((payment) => bill.payments.some((row) => row.id === payment.id)),
  } : party;
}
