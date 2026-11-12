import type { PartyBooking } from '@/types';
import { computePartyOutstanding, computePartyTotal, partyPaymentsTotal } from './party';

/**
 * SCRUM-916 — THE PARTY BILL AS THE PARTY PAGE SHOWS IT, in baht.
 *
 * Since SCRUM-804 a party with a settlement open or settled carries its
 * package and its deposit on the settlement sale, so the tab's own bill
 * (`toOtoEvent`, `billOfParty`) zeroes them: it is the tab's charges less the
 * tab's payments, and nothing takes the package twice. Read on its own, that
 * bill said Total ฿0, Deposit paid ฿0 and a green Outstanding ฿0 — "Fully
 * paid" — while the open settlement still had its whole balance to take.
 *
 * While a settlement is OPEN, the page shows the settlement's own figures as
 * the platform answered them — its total, its deposit, the money its till
 * took and its balance, never summed again from parts — beside whatever the
 * tab holds of its own (a charge put on the tab meanwhile, and its payments).
 * `settlementOwed` is the settlement's balance alone: what Take balance takes
 * through the settlement's payment screen, the one place it is taken.
 *
 * Anything else — no settlement, or one settled, voided or refunded — is the
 * tab's bill exactly as the page read it before.
 */
export interface PartyBillShown {
  total: number;
  deposit: number;
  /** Taken so far, the deposit aside: the tab's payments, and the settlement till's while it is open. */
  paid: number;
  outstanding: number;
  /** The open settlement's balance; 0 when no settlement is open. */
  settlementOwed: number;
}

const satang = (baht: number) => Math.round(baht * 100);

export function partyBillShown(party: PartyBooking): PartyBillShown {
  const total = computePartyTotal(party);
  const outstanding = computePartyOutstanding(party);
  const paid = partyPaymentsTotal(party);
  const open = party.settlement?.state === 'open' ? party.settlement : null;
  if (!open) return { total, deposit: party.deposit, paid, outstanding, settlementOwed: 0 };
  const takenAtTill = Math.max(0, open.paidSatang - open.depositSatang);
  return {
    total: (open.grossSatang + satang(total)) / 100,
    deposit: open.depositSatang / 100,
    paid: (takenAtTill + satang(paid)) / 100,
    outstanding: (open.outstandingSatang + satang(outstanding)) / 100,
    settlementOwed: open.outstandingSatang / 100,
  };
}
