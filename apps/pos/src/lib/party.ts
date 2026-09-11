import { PartyBooking, PartyStatus } from '@/types';

// total = basePrice + Σ lineItems + Σ partyExtraCharges
// outstanding = total − deposit − Σ partyPayments
// (Booking core fields are READ-ONLY from Events; extra charges/payments are POS-owned.)

export const partyLineItemsTotal = (party: PartyBooking): number =>
  party.lineItems.reduce((sum, li) => sum + li.qty * li.price, 0);

export const partyExtraChargesTotal = (party: PartyBooking): number =>
  party.partyExtraCharges.reduce((sum, c) => sum + c.total, 0);

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
    const itemsTotal = items.reduce((s, it) => s + it.lineTotal, 0);
    const total = charges.reduce((s, c) => s + c.total, 0);
    return [
      {
        kind,
        label: PARTY_EXTRA_KIND_LABELS[kind],
        items,
        itemsTotal,
        total,
        adjustment: total - itemsTotal,
      },
    ];
  });
};

export const partyPaymentsTotal = (party: PartyBooking): number =>
  party.partyPayments.reduce((sum, p) => sum + p.amount, 0);

export const computePartyTotal = (party: PartyBooking): number =>
  party.basePrice + partyLineItemsTotal(party) + partyExtraChargesTotal(party);

export const computePartyOutstanding = (party: PartyBooking): number =>
  Math.max(0, computePartyTotal(party) - party.deposit - partyPaymentsTotal(party));

export const PARTY_STATUS_LABELS: Record<PartyStatus, string> = {
  upcoming: 'Upcoming',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
