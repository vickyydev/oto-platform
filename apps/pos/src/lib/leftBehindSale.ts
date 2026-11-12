import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { salesApi, type ApiSale } from '@/api/sales';
import type { RungUpSale } from '@/lib/tillVoucher';
import { branchTradingDate } from '@/lib/pricingMode';
import { saleOnScreen } from '@/lib/saleOnScreen';
import { TICKET_KINDS } from '@/lib/resumeSale';

/**
 * SCRUM-407 (audit C1 remainder, T7) — AN UNPAID SALE LEFT AT THIS TILL.
 *
 * The counter till keeps its sale through a staff lock: the till stays mounted
 * under the lock screen (`App.tsx`, `retainedStation`). A reload, a closed tab
 * or a header tab pressed mid-payment do unmount it, and a sale rung up at Pay
 * lives only in that screen's memory — while the platform keeps it, and any
 * voucher on it, until it is paid or voided. So when the till opens it asks the
 * platform for this station's sales still `tendering`, and offers each one: its
 * till, time and amount, and a Void for an account the platform lets void. The
 * platform refuses the void of a sale that has taken money, in its own words.
 *
 * RESUMING ONE. A sale rung up at THIS station by THIS account is the sale
 * the person in front of the screen was taking money for when the page went,
 * so it is offered to continue as well as to void (`resumable`), and the till
 * goes straight back to its payment screen (`resumeId`): the one this tab
 * remembers having on screen (`lib/saleOnScreen.ts`) when the platform still
 * holds it unpaid, or the only such sale. Several open at once with none
 * remembered are offered, not chosen. A sale rung up by another account, or
 * at another station, is never resumed here — another screen may be taking
 * cash for it (audit M12) — and is offered only the void, as before. A
 * voided or finalised sale is never listed: the platform is asked for
 * `tendering` alone and each answer is checked again.
 *
 * Asked once per till and station. A sale this screen rings up afterwards is
 * its own and never listed; a sale another screen at the same station is
 * paying for right now is, and the card says how recently it was rung up.
 *
 * A PARTY'S SETTLEMENT IS THE PARTY PAGE'S (SCRUM-889). Settle party rings
 * the party up as one sale at this till, and a settlement left at its
 * balance is listed here like any unpaid sale. It is never resumed as a
 * ticket order — its deposit, its balance and its close belong to the party
 * page's Resume settlement — so it is offered as "Party settlement open —
 * Resume on the party page", with the way there, and nothing more: no
 * resume, no void here (the party page's Cancel settlement is its way out).
 *
 * TODAY'S TRADING DAY ONLY (SCRUM-865). A sale left unpaid on an earlier day
 * is nobody's to continue: the family it was rung up for has gone, and
 * opening it on the next customer's payment screen is exactly the mistake
 * this list exists to prevent. It stays in History, where it can be voided.
 *
 * AN F&B OR SHOP ORDER IS NOT THE TICKETS TAB'S (SCRUM-917). The restaurant
 * and shop counters ring up at the same station, so an order left part-paid
 * there is one of this station's unpaid sales too. The Tickets tab cannot
 * open it (`rebuildResumedSale` finds no ticket line), and picking it by
 * itself put a red "That sale is not a ticket sale" on screen before staff
 * had pressed anything. The list row names what the sale was made of
 * (`lineKinds`); a sale with no ticket line is left off this list and stays
 * where it is finished — F&B or Shop, and History. A row that names no kinds
 * (an older platform) is listed as before, and the resume still refuses it.
 */

/**
 * SCRUM-917 — whether the Tickets tab can open a listed sale: it has a ticket
 * line (`TICKET_KINDS`, what the resume rebuilds), or its row names no kinds.
 */
export function opensOnTicketsTab(sale: Pick<ApiSale, 'lineKinds'>): boolean {
  if (!sale.lineKinds) return true;
  return sale.lineKinds.some((kind) => TICKET_KINDS.has(kind));
}

/** The void's reason, as the voids report reads it. */
export const VOIDED_LEFT_BEHIND = 'Left unpaid at the till (page reloaded or left mid-payment)';

/** An unpaid sale at this station, and whether this screen may continue it. */
export interface LeftBehindSale extends RungUpSale {
  /** Rung up at this station by the signed-in account: offered to resume. */
  resumable: boolean;
  /**
   * SCRUM-889 — present when the sale settles a party: never resumable here,
   * it is finished on the party page. Absent on every other sale.
   */
  partySettlement?: { eventId: string };
}

/** SCRUM-889 — the party page, opened on the party a settlement belongs to. */
export function partyPageHref(sale: { partySettlement?: { eventId: string } }): string {
  return sale.partySettlement ? `/parties?party=${encodeURIComponent(sale.partySettlement.eventId)}` : '/parties';
}

/** The party a listed sale settles, when it settles one (SCRUM-889). */
export function partySettlementOf(sale: Pick<ApiSale, 'partySettlement'>): { eventId: string } | null {
  return sale.partySettlement?.eventId ? { eventId: sale.partySettlement.eventId } : null;
}

export interface LeftBehindSales {
  sales: LeftBehindSale[];
  /**
   * The sale the till should go straight back to on opening: the remembered
   * one when the platform still holds it unpaid for this account, else the
   * only resumable one. Null when there is none, or several and no memory.
   */
  resumeId: string | null;
  /** The sale being voided, while the platform answers. */
  busyId: string | null;
  /** The platform's refusal of the last void, in its words. */
  refusal: string | null;
  voidSale: (saleId: string) => Promise<void>;
  dismiss: (saleId: string) => void;
  dismissRefusal: () => void;
}

/**
 * Whether a sale the platform listed is one THIS screen may continue: still
 * unpaid, at this station, rung up by this account. The list is asked for
 * this station's `tendering` sales, and every answer is checked again here
 * rather than trusted by its presence.
 */
export function resumableHere(
  sale: Pick<ApiSale, 'status' | 'stationId' | 'soldBy' | 'resumedFromHold'>,
  at: { stationId: string; accountId: string | null },
): boolean {
  if (sale.status !== 'tendering' || sale.stationId !== at.stationId || at.accountId === null) return false;
  if (sale.soldBy?.accountId === at.accountId) return true;
  // SCRUM-774 — taken back from Held sales to this till by this account: it
  // was on this screen, taking money, when the page went.
  return sale.resumedFromHold?.stationId === at.stationId && sale.resumedFromHold.accountId === at.accountId;
}

/**
 * Which resumable sale to open on: the remembered one when it is among them,
 * else the only one; null when there are none or several without a memory.
 */
export function pickResumeId(
  sales: readonly LeftBehindSale[],
  remembered: string | null,
): string | null {
  const resumable = sales.filter((s) => s.resumable);
  if (remembered && resumable.some((s) => s.saleId === remembered)) return remembered;
  return resumable.length === 1 ? resumable[0]!.saleId : null;
}

export function useLeftBehindSales(opts: {
  branchId: string | null;
  stationId: string | null;
  stationName: string | null;
  /** The signed-in account, whose own unpaid sale may be resumed. */
  accountId?: string | null;
  /** False while locked, offline or without the read permission. */
  enabled: boolean;
  /** A sale this screen rang up is its own business, never "left behind". */
  ownsSale: (saleId: string) => boolean;
}): LeftBehindSales {
  const { branchId, stationId, stationName, enabled, ownsSale } = opts;
  const accountId = opts.accountId ?? null;
  const [sales, setSales] = useState<LeftBehindSale[]>([]);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const ownsRef = useRef(ownsSale);
  ownsRef.current = ownsSale;

  useEffect(() => {
    if (!enabled || !branchId || !stationId) return;
    const key = `${branchId}:${stationId}`;
    if (asked.current === key) return;
    asked.current = key;
    let cancelled = false;
    salesApi
      .list({ branchId, stationId, status: 'tendering', businessDate: branchTradingDate(), limit: 10 })
      .then(({ sales: found }) => {
        if (cancelled) return;
        const listed = found
          // SCRUM-774 — a held sale waits in Held sales, where any till takes it back.
          .filter((s) => s.status === 'tendering' && s.stationId === stationId && !ownsRef.current(s.id) && !s.hold)
          // SCRUM-917 — an F&B or shop order is finished at its own counter;
          // a party's settlement keeps its card here (SCRUM-889).
          .filter((s) => !!partySettlementOf(s) || opensOnTicketsTab(s))
          .map((s): LeftBehindSale => {
            const party = partySettlementOf(s);
            return {
              saleId: s.id,
              stationName,
              occurredAt: s.occurredAt,
              grossSatang: s.totals.grossSatang,
              // SCRUM-889 — a settlement is the party page's to finish.
              resumable: !party && resumableHere(s, { stationId, accountId }),
              ...(party ? { partySettlement: party } : {}),
            };
          });
        setSales(listed);
        setResumeId(pickResumeId(listed, saleOnScreen(stationId)));
      })
      // Nothing to offer is the quiet answer: an older platform, a dropped
      // link or a refused read leaves the till exactly as it was.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, branchId, stationId, stationName, accountId]);

  const dismiss = useCallback((saleId: string) => {
    setSales((prev) => prev.filter((s) => s.saleId !== saleId));
    setResumeId((prev) => (prev === saleId ? null : prev));
  }, []);

  const voidSale = useCallback(async (saleId: string) => {
    setBusyId(saleId);
    setRefusal(null);
    try {
      await salesApi.voidSale(saleId, VOIDED_LEFT_BEHIND);
      setSales((prev) => prev.filter((s) => s.saleId !== saleId));
      setResumeId((prev) => (prev === saleId ? null : prev));
    } catch (err) {
      setRefusal(err instanceof ApiError || err instanceof Error ? err.message : 'The sale could not be voided');
    } finally {
      setBusyId(null);
    }
  }, []);

  const dismissRefusal = useCallback(() => setRefusal(null), []);

  return { sales, resumeId, busyId, refusal, voidSale, dismiss, dismissRefusal };
}
