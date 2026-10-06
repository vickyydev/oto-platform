import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CartLine,
  Discount,
  FnbOrderLine,
  ManualDiscount,
  MerchOrderLine,
} from '@/types';
import { PROTOTYPE_REDERIVATION, ticketTotals } from '@/lib/cartWire';
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
 *   3. this device, re-deriving the cart the way the prototype's own
 *      arithmetic did — ONLY when the engine refuses the cart outright (a
 *      drop-off line with no length chosen yet, or a cart priced under a rate
 *      mode that has since changed). Since SCRUM-271 the engine does this too
 *      (`ticketTotals` in lib/cartWire.ts), reproducing the prototype's figure
 *      rather than running a second calculator for it. The
 *      engine refuses rather than guess; the screen still has to show the guest
 *      a running total, and the prototype's figure is the one it has always
 *      shown. Nothing is sold from this source: the pay preflight refuses an
 *      unpriced drop-off line, and a commit carries the engine's own integers.
 *
 * THE DEFECT THIS PROJECT KEEPS PRODUCING is an async answer landing on a cart
 * that has moved on. Every request carries a sequence number and a cart
 * signature; an answer whose sequence is not the latest is dropped.
 */

/**
 * WHAT CAME BACK INSTEAD OF A PRICE — SCRUM-351.
 *
 * Two facts that a counter has to act on differently used to arrive here as one
 * string, and the F&B station told them apart by matching the message text
 * (`PLATFORM_FAULT_MESSAGES` in `pages/OrderStation.tsx`, now deleted):
 *
 *   - a REFUSAL is about THIS cart. The platform read it and objected — a
 *     required question nobody answered, an option that is not in its group, a
 *     price that moved. The commit meets the same rule the quote did, so
 *     charging on it can only carry the guest to the payment screen and fail
 *     there.
 *   - a FAULT says nothing about the cart: the api's own 5xx envelope, or a
 *     status text from a proxy when nothing of ours ran. This till's arithmetic
 *     is the documented fallback for exactly that, and an outage upstream is not
 *     a reason to stop taking money.
 *
 * `message` is the string this field used to be — the platform's own words — so
 * a component that only prints the error reads `.message` and changes nothing
 * else about what it shows.
 */
export interface QuoteError {
  kind: 'refusal' | 'fault';
  /** The HTTP status that carried it; null when the rejection was not an `ApiError`. */
  status: number | null;
  /** The platform's error code, `UNKNOWN` for a body with no envelope of ours; null off an `ApiError`. */
  code: string | null;
  /** The platform's own words, for the note at the counter. */
  message: string;
}

/**
 * A REFUSAL IS A 4xx THAT CARRIED A PLATFORM ERROR ENVELOPE, and nothing else.
 *
 * The envelope is the evidence that our code read the cart and judged it:
 * `api/client.ts` takes `code` from the body's `error.code` and falls back to
 * `UNKNOWN` when the body had no envelope, which is what a proxy's own page
 * arrives as. A 5xx is our code failing rather than judging.
 *
 * The last arm is defensive rather than a case seen in practice: `quoteCart` and
 * `quoteItemCart` re-throw an `ApiError` and answer every other failure with
 * this till's own figures (`api/sales.ts`), so a request that reached no server
 * arrives as a quote and not as an error at all. It is written down so that an
 * unexpected rejection cannot read as the platform refusing the cart.
 */
function quoteErrorOf(err: unknown, fallbackMessage: string): QuoteError {
  if (err instanceof ApiError) {
    const refused = err.status >= 400 && err.status < 500 && err.code !== 'UNKNOWN';
    return {
      kind: refused ? 'refusal' : 'fault',
      status: err.status,
      code: err.code,
      message: err.message,
    };
  }
  return {
    kind: 'fault',
    status: null,
    code: null,
    message: err instanceof Error ? err.message : fallbackMessage,
  };
}

export interface CartQuoteState {
  /** What every component that shows money reads. Never null — there is always a figure. */
  totals: OrderTotals;
  quote: CartQuote;
  /** A platform round trip is in flight and this figure may yet be replaced. */
  pending: boolean;
  /**
   * What came back instead of a price, and whether it was about this cart. Null
   * when the platform answered. The figure shown is this till's either way.
   */
  error: QuoteError | null;
}

/**
 * The figure the prototype showed for a cart the engine will not price, as the
 * engine re-derives it (`ticketTotals`: the subtotal from the stored lines,
 * every base at today's rate mode).
 */
function prototypeTotals(
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
): OrderTotals {
  const totals = ticketTotals(lines, discounts, manualDiscounts);
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
  promoCodes: readonly string[] = [],
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
  // S2-10b — a voucher put on or taken off moves the price, so it re-asks.
  return `${mode}#${who}#${linePart}#${promoPart}#${manualPart}#${promoCodes.join('|')}`;
}

/** How long the till waits after the last cart change before asking the platform. */
const QUOTE_DEBOUNCE_MS = 200;

/** One empty list, so a cart with no voucher does not hand a new array to every render. */
const NO_CODES: readonly string[] = [];

export function useCartQuote(args: {
  lines: readonly CartLine[];
  discounts: readonly Discount[];
  manualDiscounts: readonly ManualDiscount[];
  identity: CartIdentity | null;
  /** Stop asking once the sale is committed — the sale's own figures stand then. */
  enabled?: boolean;
  /**
   * S2-10b — the voucher held for this cart, by its code. The platform prices
   * it; this till's own figure never includes it, so the platform is asked
   * even for a cart whose only line is the voucher's free item.
   */
  promoCodes?: readonly string[];
}): CartQuoteState {
  const { lines, discounts, manualDiscounts, identity } = args;
  const promoCodes = args.promoCodes ?? NO_CODES;
  const enabled = args.enabled ?? true;
  const rate = todayRateMode();
  const signature = cartSignature(lines, discounts, manualDiscounts, identity, rate.mode, promoCodes);

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
          engineVersion: PROTOTYPE_REDERIVATION,
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
          engineVersion: PROTOTYPE_REDERIVATION,
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
  const [error, setError] = useState<QuoteError | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (
      !enabled ||
      !identity ||
      local.engineRefused !== null ||
      (lines.length === 0 && promoCodes.length === 0)
    ) {
      setPending(false);
      return;
    }
    const seq = ++seqRef.current;
    setPending(true);
    const timer = window.setTimeout(() => {
      void quoteCart({ lines, discounts, manualDiscounts, identity, promoCodes })
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
          setError(quoteErrorOf(err, 'The platform did not price this cart.'));
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
  const [error, setError] = useState<QuoteError | null>(null);
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
          setError(quoteErrorOf(err, 'The platform did not price this order.'));
          setPending(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);

  const live = platform && platform.signature === signature ? platform.quote : local;
  return { totals: live.totals, quote: live, pending, error };
}
