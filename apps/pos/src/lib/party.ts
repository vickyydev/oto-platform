import { satangFromBaht } from '@oto/shared';
import { PartyBooking, PartyStatus } from '@/types';

// total = basePrice + Σ lineItems + Σ partyExtraCharges
// outstanding = total − deposit − Σ partyPayments
// (Booking core fields are READ-ONLY from Events; extra charges/payments are POS-owned.)
//
// SCRUM-1000 — every sum is taken in satang and handed back in baht. Summed
// as baht floats, a tab of ฿32.08 less ฿25.03 paid came to 7.049999999999997,
// and the customer's bill printed it so.

const sumBaht = <T>(rows: readonly T[], baht: (row: T) => number): number =>
  rows.reduce((sum, row) => sum + satangFromBaht(baht(row)), 0) / 100;

export const partyLineItemsTotal = (party: PartyBooking): number =>
  sumBaht(party.lineItems, (li) => li.qty * li.price);

export const partyExtraChargesTotal = (party: PartyBooking): number =>
  sumBaht(party.partyExtraCharges, (c) => c.total);

export type PartyExtraKind = 'ticket' | 'fnb';

// Wording shared by the staff balance screen + customer settlement display,
// matching the mobile party view.
export const PARTY_EXTRA_KIND_LABELS: Record<PartyExtraKind, string> = {
  ticket: 'Extra tickets',
  fnb: 'Extra F&B',
};

export interface PartyExtraGroup {
  kind: PartyExtraKind;
  label: string;
  items: { name: string; qty: number; lineTotal: number }[];
  // Sum of the descriptive per-item breakdown (pre-discount component subtotals).
  itemsTotal: number;
  // Authoritative charged amount (after any manual discount/tax) — Σ charge.total.
  total: number;
  // total − itemsTotal: negative when a discount/comp reduced the charge below
  // the sum of its listed line items. Surfaced so the bill reconciles.
  adjustment: number;
}

// Extra charges grouped by kind (tickets first, then F&B), so both the staff
// and customer screens render per-kind subtotals and reconcile the listed line
// items against the authoritative charged total without duplicating logic.
export const partyExtraChargeGroups = (party: PartyBooking): PartyExtraGroup[] => {
  const order: PartyExtraKind[] = ['ticket', 'fnb'];
  return order.flatMap((kind) => {
    const charges = party.partyExtraCharges.filter((c) => c.kind === kind);
    if (charges.length === 0) return [];
    const items = charges.flatMap((c) => c.items);
    const itemsTotal = sumBaht(items, (it) => it.lineTotal);
    const total = sumBaht(charges, (c) => c.total);
    return [
      {
        kind,
        label: PARTY_EXTRA_KIND_LABELS[kind],
        items,
        itemsTotal,
        total,
        adjustment: (satangFromBaht(total) - satangFromBaht(itemsTotal)) / 100,
      },
    ];
  });
};

export const partyPaymentsTotal = (party: PartyBooking): number =>
  sumBaht(party.partyPayments, (p) => p.amount);

export const computePartyTotal = (party: PartyBooking): number =>
  sumBaht([party.basePrice, partyLineItemsTotal(party), partyExtraChargesTotal(party)], (baht) => baht);

export const computePartyOutstanding = (party: PartyBooking): number =>
  Math.max(
    0,
    satangFromBaht(computePartyTotal(party)) -
      satangFromBaht(party.availableDeposit ?? party.deposit) -
      satangFromBaht(partyPaymentsTotal(party)),
  ) / 100;

export const PARTY_STATUS_LABELS: Record<PartyStatus, string> = {
  upcoming: 'Upcoming',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
