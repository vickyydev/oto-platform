import { useEffect, useState } from 'react';
import { partySettleFormDefaults, partySettlementLive, type PartySettleQuote } from '@oto/shared';
import {
  previewSettlementOnPlatform,
  readPartyPlanOnPlatform,
  type PartyPlanRead,
  type PartySettlePreviewOutcome,
} from '@/api/parties';
import type { PartyBooking } from '@/types';
import {
  computePartyOutstanding,
  computePartyTotal,
  partyExtraChargesTotal,
  partyLineItemsTotal,
  partyPaymentsTotal,
} from './party';

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
 * SCRUM-936 — BEFORE A SETTLEMENT (none yet, or one cancelled or refunded), a
 * party the OTO App planned is owed its package, as the prototype's party page
 * shows it (`basePrice` in the bill, `components/parties/PartyDetail.tsx`):
 * the tab carries no package of its own when the OTO App's bill total is 0,
 * and the page read Total ฿0 and "Fully paid". With `planned` — the platform's
 * own preview of Settle party on the plan's counts — the bill is that quote's
 * total, deposit and balance beside the tab's charges and payments, and
 * `settlementOwed` is what Settle party will take.
 *
 * Anything else — no plan, no quote, or a settlement settled — is the tab's
 * bill exactly as the page read it before. So is a party the platform will
 * not settle as one sale (`settlesOnTab`): its balance is taken on the tab.
 */
export interface PartyBillShown {
  total: number;
  deposit: number;
  /** Taken so far, the deposit aside: the tab's payments, and the settlement till's while it is open. */
  paid: number;
  outstanding: number;
  /**
   * The open settlement's balance; before a settlement, the planned one's (what
   * Settle party will take); 0 otherwise.
   */
  settlementOwed: number;
}

const satang = (baht: number) => Math.round(baht * 100);

/**
 * SCRUM-936 — A PARTY THE PLATFORM WILL NOT SETTLE AS ONE SALE, though its
 * preview prices it: walk-up guests already on its tab (`PARTY_WALK_UPS_ON_TAB`,
 * which the preview reports as `walkUps`), or a tab that already took money
 * beyond its own charges (`PARTY_PAID_ON_TAB`, which the preview does not
 * flag) — the two refusals of `settleParty` (`services/party-settlement.ts`).
 * Its balance is taken on the tab, as the platform's refusal says, so its
 * page reads the tab's bill and Take balance opens the tab's balance screen.
 */
export function settlesOnTab(party: PartyBooking, quote: PartySettleQuote): boolean {
  if (quote.walkUps > 0) return true;
  return satang(partyPaymentsTotal(party)) > satang(partyLineItemsTotal(party) + partyExtraChargesTotal(party));
}

/** The quote a bill is read on: none for a party the platform settles on its tab. */
export function billQuoteOf(party: PartyBooking, quote: PartySettleQuote | null | undefined): PartySettleQuote | null {
  return quote && !settlesOnTab(party, quote) ? quote : null;
}

export function partyBillShown(party: PartyBooking, quote?: PartySettleQuote | null): PartyBillShown {
  const total = computePartyTotal(party);
  const outstanding = computePartyOutstanding(party);
  const paid = partyPaymentsTotal(party);
  const open = party.settlement?.state === 'open' ? party.settlement : null;
  const planned = billQuoteOf(party, quote);
  if (!open) {
    if (planned && !partySettlementLive(party.settlement)) {
      const totalSatang = planned.totalSatang + satang(partyLineItemsTotal(party) + partyExtraChargesTotal(party));
      return {
        total: totalSatang / 100,
        deposit: planned.depositSatang / 100,
        paid,
        outstanding: Math.max(0, totalSatang - planned.depositSatang - satang(paid)) / 100,
        settlementOwed: planned.balanceSatang / 100,
      };
    }
    return { total, deposit: party.deposit, paid, outstanding, settlementOwed: 0 };
  }
  const takenAtTill = Math.max(0, open.paidSatang - open.depositSatang);
  return {
    total: (open.grossSatang + satang(total)) / 100,
    deposit: open.depositSatang / 100,
    paid: (takenAtTill + satang(paid)) / 100,
    outstanding: (open.outstandingSatang + satang(outstanding)) / 100,
    settlementOwed: open.outstandingSatang / 100,
  };
}

/**
 * SCRUM-936 — WHERE THE PLATFORM'S PRICE OF A PARTY NOT YET SETTLED STANDS:
 * nothing to price (no plan the platform holds, or a settlement open or
 * settled, which carries its own figures); being read (the plan, then the
 * Settle party preview on its counts); priced; or not priced, with the
 * sentence that says why (the platform's refusal, or no connection).
 */
export type PlannedQuote =
  | { state: 'none' }
  | { state: 'reading' }
  | { state: 'priced'; quote: PartySettleQuote }
  | { state: 'refused'; message: string };

export const NO_PLANNED_QUOTE: PlannedQuote = { state: 'none' };
const READING: PlannedQuote = { state: 'reading' };

/** What the bill says when the platform's price of the party could not be read. */
export const PARTY_BILL_UNREAD = 'What this party owes could not be read from the platform';

/** The quote the bill is read on, once priced: none for a party settled on its tab. */
export function plannedQuoteOf(party: PartyBooking, planned: PlannedQuote): PartySettleQuote | null {
  return planned.state === 'priced' ? billQuoteOf(party, planned.quote) : null;
}

/**
 * SCRUM-936 — WHAT THE BILL CANNOT SAY YET. A party not settled whose tab
 * carries no package of its own (`basePrice` 0: the OTO App planned it, and
 * Settle party prices it) is owed its package. Until the platform's price is
 * in, its page shows a dash for the package, Total and Outstanding and takes
 * nothing — never "Fully paid"; when the platform would not price it, the
 * dash stays and `note` says why. Null when the bill can be read.
 */
export function partyBillUnpriced(party: PartyBooking, planned: PlannedQuote): { note: string | null } | null {
  if (partySettlementLive(party.settlement) || party.basePrice > 0) return null;
  if (planned.state === 'reading') return { note: null };
  if (planned.state === 'refused') return { note: planned.message };
  return null;
}

/**
 * SCRUM-936 — WHAT A PARTIES LIST ROW SAYS ON ITS RIGHT: the outstanding the
 * party page shows (`partyBillShown` on the same quote, an open settlement's
 * balance included), else "Paid". While a party not settled is being priced
 * the row names no figure, and so does one whose package is owed but could
 * not be priced: never "Paid" while its package is owed.
 */
export type PartyListFigure = { kind: 'owed'; amount: number } | { kind: 'paid' } | null;

export function partyListFigure(party: PartyBooking, planned: PlannedQuote = NO_PLANNED_QUOTE): PartyListFigure {
  if (planned.state === 'reading' || partyBillUnpriced(party, planned)) return null;
  const bill = partyBillShown(party, plannedQuoteOf(party, planned));
  if (bill.outstanding > 0) return { kind: 'owed', amount: bill.outstanding };
  return { kind: 'paid' };
}

/**
 * SCRUM-936 — THE PLATFORM'S PRICE OF SETTLING A PARTY NOT YET SETTLED, on the
 * plan's counts (`partySettleFormDefaults`, the counts Settle party opens on),
 * through the same preview the Settle form reads (`POST /parties/:id/settle/
 * preview`, which writes nothing). `planRead` is the page's read of the plan
 * (`usePartyPlanReadState`): undefined while it is being read, null when it
 * could not be read.
 */
export function usePlannedSettleQuote(
  party: PartyBooking | null,
  planRead: PartyPlanRead | null | undefined,
  stationId: string | null,
): PlannedQuote {
  const [answer, setAnswer] = useState<{ key: string; outcome: PartySettlePreviewOutcome } | null>(null);
  const plan = planRead?.plan ?? null;
  const settling = party !== null && !partySettlementLive(party.settlement);
  /**
   * SCRUM-967 — the plan itself is in the key, the kitchen plan with it: the
   * platform prices each kitchen extra from the plan it reads, so a kitchen
   * change (saved on the till's Edit form, or in the OTO App and read at the
   * page's next read of the plan) moves the quote though the form's counts
   * stay as they were. While the new quote is read the bill and Take balance
   * wait (`reading`), never showing the figure from before the change.
   */
  const key =
    party && settling && plan
      ? JSON.stringify([party.id, party.settlement?.id ?? null, party.settlement?.state ?? null,
        partySettleFormDefaults(plan, party), plan, planRead?.kitchenPlan ?? null])
      : null;
  useEffect(() => {
    if (!key || !plan || !party) return;
    let live = true;
    void previewSettlementOnPlatform({ party, form: partySettleFormDefaults(plan, party), stationId }).then((outcome) => {
      if (live) setAnswer({ key, outcome });
    });
    return () => {
      live = false;
    };
    // The key holds everything the quote is asked on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!settling) return NO_PLANNED_QUOTE;
  if (planRead === undefined) return READING;
  if (planRead === null) return { state: 'refused', message: `${PARTY_BILL_UNREAD}. Open the party again to read it.` };
  if (!key) return NO_PLANNED_QUOTE;
  if (answer?.key !== key) return READING;
  return answer.outcome.ok
    ? { state: 'priced', quote: answer.outcome.quote }
    : { state: 'refused', message: `${PARTY_BILL_UNREAD} — ${answer.outcome.message}` };
}

/**
 * SCRUM-936 — the same price for a screen that has not read the party's plan:
 * a parties list row. Reads the plan (`GET /parties/:id`) once for a party not
 * yet settled, then asks for the price as the party pages do. The party pages
 * (counter and phone) price it from their own plan read
 * (`usePartyPlanReadState`), the one that also feeds their kitchen sections.
 */
export function usePartyPlannedQuote(party: PartyBooking | null, stationId: string | null): PlannedQuote {
  const [read, setRead] = useState<{ id: string; read: PartyPlanRead | null } | null>(null);
  const id = party && !partySettlementLive(party.settlement) ? party.id : null;
  useEffect(() => {
    if (!id || !party) return;
    let live = true;
    void readPartyPlanOnPlatform({ id: party.id, branchId: party.branchId }).then((answer) => {
      if (live) setRead({ id, read: answer });
    });
    return () => {
      live = false;
    };
    // The party's id is what the plan is read for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return usePlannedSettleQuote(party, id && read?.id === id ? read.read : undefined, stationId);
}
