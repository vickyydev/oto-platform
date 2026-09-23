import { useEffect, useMemo, useRef, useState } from 'react';
import type { Discount, FnbOrderLine, ManualDiscount, MerchOrderLine } from '@/types';
import { localItemQuote, quoteItemCart, type CartQuote, type ItemCartIdentity } from '@/api/sales';
import { ApiError } from '@/api/client';
import type { CartQuoteState, QuoteError } from '@/lib/cartQuote';
import { todayRateMode } from '@/lib/pricingMode';

/**
 * THE PRICE ON THE F&B AND SHOP SCREENS, WITH THE CODES ON THE ORDER — SCRUM-362.
 *
 * `useItemCartQuote` (lib/cartQuote.ts) is this hook without the codes: it
 * quotes an order from its lines and its manual discounts, and neither its
 * arguments nor its cart signature has anywhere for a promo code to ride. The
 * two stations now enter codes, and a code has to reach BOTH sides or the
 * screen is wrong — the platform would quote an order it was never told about a
 * code for, and a code typed into the entry would change no figure at all.
 *
 * THIS IS THAT HOOK WITH `promos` THREADED THROUGH, and it is deliberately the
 * same contract: the local figure is computed synchronously so the panel is
 * never blank, a platform answer replaces it per line and in total, a refusal
 * is surfaced rather than swallowed, and an answer whose sequence is not the
 * latest is dropped so a previous guest's price cannot land on this one.
 *
 * IT SHOULD NOT SURVIVE AS A SECOND HOOK. `useItemCartQuote` taking an optional
 * `promos` argument would delete this file; lib/cartQuote.ts belongs to another
 * slice in flight, so the codes are threaded here instead of edited into it.
 */

/** A 4xx carrying a platform error envelope is a judgement on this order; nothing else is. */
function quoteErrorOf(err: unknown, fallbackMessage: string): QuoteError {
  if (err instanceof ApiError) {
    const refused = err.status >= 400 && err.status < 500 && err.code !== 'UNKNOWN';
    return { kind: refused ? 'refusal' : 'fault', status: err.status, code: err.code, message: err.message };
  }
  return {
    kind: 'fault',
    status: null,
    code: null,
    message: err instanceof Error ? err.message : fallbackMessage,
  };
}

/**
 * The order as a string, so a re-render with the same order does not re-ask the
 * platform. The same fields `itemCartSignature` covers in lib/cartQuote.ts —
 * the note included, because two rows of one item with different notes are two
 * lines all the way to the kitchen — PLUS the codes, since a code applied or
 * removed moves the price and has to re-ask.
 */
function signatureOf(
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  manualDiscounts: readonly ManualDiscount[],
  promos: readonly Discount[],
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
  const promoPart = promos.map((p) => `${p.code}:${p.type}:${p.value}`).join('|');
  const who = identity ? `${identity.branchId}/${identity.stationId}/${identity.channel}` : 'none';
  return `${mode}#${who}#${linePart}#${manualPart}#${promoPart}`;
}

/** How long the station waits after the last change before asking the platform. */
const QUOTE_DEBOUNCE_MS = 200;

export function useItemCartQuoteWithPromos(args: {
  kind: 'fnb' | 'shop';
  lines: readonly (FnbOrderLine | MerchOrderLine)[];
  manualDiscounts: readonly ManualDiscount[];
  /** The codes this station holds. Empty is the ordinary case. */
  promos: readonly Discount[];
  identity: ItemCartIdentity | null;
  /** Stop asking once the order is committed — the sale's own figures stand then. */
  enabled?: boolean;
}): CartQuoteState {
  const { kind, lines, manualDiscounts, promos, identity } = args;
  const enabled = args.enabled ?? true;
  const rate = todayRateMode();
  const signature = signatureOf(lines, manualDiscounts, promos, identity, rate.mode);

  const local = useMemo(
    (): CartQuote =>
      localItemQuote(
        kind,
        lines as readonly FnbOrderLine[] & readonly MerchOrderLine[],
        manualDiscounts,
        { promos },
      ),
    // The signature covers every field these three arrays contribute to a price.
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
        promos,
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
