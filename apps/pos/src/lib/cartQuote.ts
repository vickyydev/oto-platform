import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CartLine,
  Discount,
  FnbOrderLine,
  ManualDiscount,
  MerchOrderLine,
} from '@/types';
import { computeTotals } from '@/lib/sale';
import { todayRateMode } from '@/lib/pricingMode';
import {
  localItemQuote,
  localQuote,
  quoteCart,
  quoteItemCart,
  unquotableReason,
  type CartIdentity,
  type CartQuote,
  type ItemCartIdentity,
  type OrderTotals,
} from '@/api/sales';
import { ApiError } from '@/api/client';

/**
 * THE PRICE ON THE SCREEN — S2-09a (SCRUM-203).
 *
 * The till used to answer "what does this cart cost" from its own copy of the
 * rules. This hook makes the platform answer it, keeps the answer live as the
 * cart changes, and — when the platform cannot be asked — says so instead of
 * quietly substituting a different arithmetic and letting the screen imply the
 * platform agreed.
 *
 * THREE SOURCES, IN ORDER, AND EACH ONE IS NAMED ON THE SCREEN:
 *   1. the platform's quote;
 *   2. this device, running the platform's own engine (`@oto/shared`, integer
 *      satang, the tested one) — when there is no pricing route on this
 *      deployment, no station yet, or no answer;
 *   3. this device, running the prototype's own arithmetic — ONLY when the
 *      engine refuses the cart outright (a drop-off line with no length chosen
 *      yet, or a cart priced under a rate mode that has since changed). The
 *      engine refuses rather than guess; the screen still has to show the guest
 *      a running total, and the prototype's figure is the one it has always
 *      shown. Nothing is sold from this source: the pay preflight refuses an
 *      unpriced drop-off line, and a commit carries the engine's own integers.
 *
 * THE DEFECT THIS PROJECT KEEPS PRODUCING is an async answer landing on a cart
 * that has moved on. Every request carries a sequence number and a cart
 * signature; an answer whose sequence is not the latest is dropped.
 */

export interface CartQuoteState {
  /** What every component that shows money reads. Never null — there is always a figure. */
  totals: OrderTotals;
  quote: CartQuote;
  /** A platform round trip is in flight and this figure may yet be replaced. */
  pending: boolean;
  /** The platform looked at this cart and objected. The figure shown is this till's. */
  error: string | null;
}

/** The prototype's own totals, for a cart the engine will not price. */
function prototypeTotals(
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
): OrderTotals {
  const totals = computeTotals([...lines], [...discounts], [...manualDiscounts]);
  return {
    subtotal: totals.subtotal,
    discountAmount: totals.discountAmount,
    scannedDiscounts: totals.scannedDiscounts,
    manualDiscountAmount: totals.manualDiscountAmount,
    manualAmounts: totals.manualAmounts,
    serviceChargeTotal: totals.serviceChargeTotal,
    taxTotal: totals.taxTotal,
    taxBreakdown: totals.taxBreakdown,
    total: totals.total,
  };
}

/**
 * The cart as a string, so a re-render with the same cart does not re-ask the
 * platform. Only the fields that move money are in it — a cart whose signature
 * is unchanged cannot have a different price.
 */
function cartSignature(
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
  identity: CartIdentity | null,
  mode: string,
): string {
  const linePart = lines
    .map(
      (line) =>
        `${line.id}:${line.ticketType.id}:${line.tier}:${line.kids}:${line.adults}:${line.socks}:${line.lineTotal}:` +
        `${line.addOns.map((a) => `${a.id}x${a.quantity}@${a.price}`).join('+')}:` +
        `${line.dropOff ? `${line.dropOff.serviceFeeTHB}/${line.dropOff.lengthChosen ? 1 : 0}/${line.dropOff.foodProvision?.paidTHB ?? 0}` : ''}:` +
        `${line.promoItem ? line.promoItem.priceTHB : ''}`,
    )
    .join('|');
  const promoPart = discounts.map((d) => `${d.code}:${d.type}:${d.value}`).join('|');
  const manualPart = manualDiscounts.map((m) => `${m.id}:${m.type}:${m.value}:${m.scope}`).join('|');
  const who = identity ? `${identity.branchId}/${identity.stationId}/${identity.tier}` : 'none';
  return `${mode}#${who}#${linePart}#${promoPart}#${manualPart}`;
}

/** How long the till waits after the last cart change before asking the platform. */
const QUOTE_DEBOUNCE_MS = 200;

export function useCartQuote(args: {
  lines: readonly CartLine[];
  discounts: readonly Discount[];
  manualDiscounts: readonly ManualDiscount[];
  identity: CartIdentity | null;
  /** Stop asking once the sale is committed — the sale's own figures stand then. */
  enabled?: boolean;
}): CartQuoteState {
  const { lines, discounts, manualDiscounts, identity } = args;
  const enabled = args.enabled ?? true;
  const rate = todayRateMode();
  const signature = cartSignature(lines, discounts, manualDiscounts, identity, rate.mode);

  /**
   * The figure this device computes, recomputed synchronously on every cart
   * change. It is what the screen shows until the platform answers, and it is
   * never absent — a till that shows no total while a round trip is in flight
   * is unusable at a counter.
   */
  const local = useMemo((): { quote: CartQuote; engineRefused: string | null } => {
    const blocked = unquotableReason(lines);
    if (blocked) {
      return {
        quote: {
          totals: prototypeTotals(lines, discounts, manualDiscounts),
          satang: null,
          source: 'till',
          pricingMode: rate.mode,
          pricingModeReason: rate.reason,
          engineVersion: 'prototype',
          reason: blocked,
        },
        engineRefused: blocked,
      };
    }
    try {
      return { quote: localQuote(lines, discounts, manualDiscounts), engineRefused: null };
    } catch (err) {
      // `computeTicketCartTotals` refuses a cart whose stored line totals were
      // not priced under this rate mode, and names the lines. The guest still
      // needs a running total; the prototype's is the one the till has always
      // shown, and nothing is sold from it — the commit carries engine integers
      // or it does not happen.
      const message = err instanceof Error ? err.message : 'This cart could not be priced.';
      return {
        quote: {
          totals: prototypeTotals(lines, discounts, manualDiscounts),
          satang: null,
          source: 'till',
          pricingMode: rate.mode,
          pricingModeReason: rate.reason,
          engineVersion: 'prototype',
          reason: message,
        },
        engineRefused: message,
      };
    }
    // The signature covers every field these three arrays contribute to a price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const [platform, setPlatform] = useState<{ signature: string; quote: CartQuote } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !identity || local.engineRefused !== null || lines.length === 0) {
      setPending(false);
      return;
    }
    const seq = ++seqRef.current;
    setPending(true);
    const timer = window.setTimeout(() => {
      void quoteCart({ lines, discounts, manualDiscounts, identity })
        .then((quote) => {
          // The cart has moved on since this went out, or another request has
          // overtaken it. Either way this answer is about a cart that is no
          // longer on the screen.
          if (seqRef.current !== seq) return;
          setPlatform({ signature, quote });
          setError(null);
          setPending(false);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setPlatform(null);
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'The platform refused this cart.',
          );
          setPending(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled, local.engineRefused]);

  const live = platform && platform.signature === signature ? platform.quote : local.quote;
  return { totals: live.totals, quote: live, pending, error };
}

// --- The F&B and shop orders (S2-09b) ---------------------------------------

/**
 * The order as a string. The same job `cartSignature` does for the till: only
 * what can move money is in it, so a re-render does not re-ask the platform.
 *
 * The NOTE is in it, and that is not decoration. Two rows of the same item with
 * different notes are two lines all the way to the kitchen, and merging them
 * would be a different order — so a note edit has to re-ask.
 */
function itemCartSignature(
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  manualDiscounts: readonly ManualDiscount[],
  identity: ItemCartIdentity | null,
  mode: string,
): string {
  const linePart = lines
    .map((line) => {
      const shared = `${line.id}:${line.qty}:${line.lineTotal}:${line.variantId ?? ''}`;
      if ('menuItem' in line) {
        const mods = line.selectedModifiers
          .map((m) => `${m.groupId}=${[...m.optionIds].sort().join(',')}`)
          .sort()
          .join('+');
        return `${shared}:${line.menuItem.id}:${mods}:${line.note ?? ''}:${line.isPrepaid ? 'p' : ''}`;
      }
      return `${shared}:${line.merchItem.id}`;
    })
    .join('|');
  const manualPart = manualDiscounts.map((m) => `${m.id}:${m.type}:${m.value}:${m.scope}`).join('|');
  const who = identity ? `${identity.branchId}/${identity.stationId}/${identity.channel}` : 'none';
  return `${mode}#${who}#${linePart}#${manualPart}`;
}

/**
 * THE PRICE ON THE F&B AND SHOP SCREENS.
 *
 * Same contract as `useCartQuote`, and for the same reason: the figure the
 * order panel, the customer display and the payment screen show is the
 * platform's, or it says whose it is instead. `lineTotals` on the returned
 * quote is what lets the panel draw the platform's figure against each ROW as
 * well as in the total — an order of five items priced right in total and wrong
 * per line is an order staff cannot check against the screen in front of them.
 */
export function useItemCartQuote(args: {
  kind: 'fnb' | 'shop';
  lines: readonly (FnbOrderLine | MerchOrderLine)[];
  manualDiscounts: readonly ManualDiscount[];
  identity: ItemCartIdentity | null;
  /** Stop asking once the order is committed — the sale's own figures stand then. */
  enabled?: boolean;
}): CartQuoteState {
  const { kind, lines, manualDiscounts, identity } = args;
  const enabled = args.enabled ?? true;
  const rate = todayRateMode();
  const signature = itemCartSignature(lines, manualDiscounts, identity, rate.mode);

  const local = useMemo(
    () =>
      localItemQuote(
        kind,
        lines as readonly FnbOrderLine[] & readonly MerchOrderLine[],
        manualDiscounts,
      ),
    // The signature covers every field these two arrays contribute to a price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, kind],
  );

  const [platform, setPlatform] = useState<{ signature: string; quote: CartQuote } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !identity || lines.length === 0) {
      setPending(false);
      return;
    }
    const seq = ++seqRef.current;
    setPending(true);
    const timer = window.setTimeout(() => {
      void quoteItemCart({
        kind,
        lines: lines as readonly FnbOrderLine[] & readonly MerchOrderLine[],
        manualDiscounts,
        identity,
      })
        .then((quote) => {
          // The order has moved on since this went out, or another request has
          // overtaken it: this answer is about an order nobody is looking at.
          if (seqRef.current !== seq) return;
          setPlatform({ signature, quote });
          setError(null);
          setPending(false);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setPlatform(null);
          setError(
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'The platform refused this order.',
          );
          setPending(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);

  const live = platform && platform.signature === signature ? platform.quote : local;
  return { totals: live.totals, quote: live, pending, error };
}
