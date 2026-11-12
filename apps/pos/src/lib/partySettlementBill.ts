import { useEffect, useState } from 'react';
import { partySettleFormDefaults, partySettlementLive, type PartyPlan, type PartySettleQuote } from '@oto/shared';
import { previewSettlementOnPlatform, readPartyPlanOnPlatform } from '@/api/parties';
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
 * SCRUM-936 — WHAT A PARTIES LIST ROW SAYS ON ITS RIGHT: the outstanding the
 * party page shows (`partyBillShown`, an open settlement's balance included),
 * else "Paid". A party not yet settled whose tab carries no package of its own
 * (`basePrice` 0: the OTO App planned it, and Settle party prices it) is not
 * known to be paid from the list's read, so the row names no figure rather
 * than saying Paid while its package is owed; its page says what it owes.
 */
export type PartyListFigure = { kind: 'owed'; amount: number } | { kind: 'paid' } | null;

export function partyListFigure(party: PartyBooking): PartyListFigure {
  const bill = partyBillShown(party);
  if (bill.outstanding > 0) return { kind: 'owed', amount: bill.outstanding };
  if (!partySettlementLive(party.settlement) && party.basePrice <= 0) return null;
  return { kind: 'paid' };
}

/**
 * SCRUM-936 — THE PLATFORM'S QUOTE FOR SETTLING A PARTY NOT YET SETTLED, on the
 * plan's counts (`partySettleFormDefaults`, the counts Settle party opens on),
 * through the same preview the Settle form reads (`POST /parties/:id/settle/
 * preview`, which writes nothing). Null while there is no plan, while the
 * party's settlement is open or settled, before the answer, or when the
 * platform would not price it (no package, no permission, no connection) —
 * the page then reads the tab's bill as before.
 */
export function usePlannedSettleQuote(
  party: PartyBooking | null,
  plan: PartyPlan | null,
  stationId: string | null,
): PartySettleQuote | null {
  const [answer, setAnswer] = useState<{ key: string; quote: PartySettleQuote } | null>(null);
  const key =
    party && plan && !partySettlementLive(party.settlement)
      ? JSON.stringify([party.id, party.settlement?.id ?? null, party.settlement?.state ?? null, partySettleFormDefaults(plan, party)])
      : null;
  useEffect(() => {
    if (!key || !plan || !party) return;
    let live = true;
    void previewSettlementOnPlatform({ party, form: partySettleFormDefaults(plan, party), stationId }).then((outcome) => {
      if (live && outcome.ok) setAnswer({ key, quote: outcome.quote });
    });
    return () => {
      live = false;
    };
    // The key holds everything the quote is asked on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key && answer?.key === key ? answer.quote : null;
}

/**
 * SCRUM-936 — the same quote for a screen that has not read the party's plan:
 * the phone's party page, which shows the bill and sends staff to a counter
 * till to settle. Reads the plan (`GET /parties/:id`) for a party not yet
 * settled, then asks for the quote as the counter's page does.
 */
export function usePartyPlannedQuote(party: PartyBooking | null, stationId: string | null): PartySettleQuote | null {
  const [read, setRead] = useState<{ id: string; plan: PartyPlan | null } | null>(null);
  const id = party && !partySettlementLive(party.settlement) ? party.id : null;
  useEffect(() => {
    if (!id || !party) return;
    let live = true;
    void readPartyPlanOnPlatform({ id: party.id, branchId: party.branchId }).then((answer) => {
      if (live) setRead({ id, plan: answer?.plan ?? null });
    });
    return () => {
      live = false;
    };
    // The party's id is what the plan is read for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return usePlannedSettleQuote(party, id && read?.id === id ? read.plan : null, stationId);
}
