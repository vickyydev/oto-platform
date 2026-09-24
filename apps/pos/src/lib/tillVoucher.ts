import { useCallback, useRef, useState } from 'react';
import {
  isLegacyBoothCode,
  isoDateInTz,
  newId,
  normaliseBoothCode,
  verifyBoothCode,
  wallClockMinutesInTz,
} from '@oto/shared';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { salesApi, type CartQuote } from '@/api/sales';
import { vouchersApi, type VoucherView } from '@/api/vouchers';
import type { QuoteError } from '@/lib/cartQuote';
import { getBranchTimezone } from '@/lib/pricingMode';

/**
 * S2-10b (SCRUM-207) — A LUCKY WHEEL VOUCHER ON THE CART THIS TILL IS RINGING UP.
 *
 * The owner's rules, as the till keeps them (24 September):
 *
 *   - A scan — off the box's scanner, a USB scanner on this computer, or typed
 *     into Redeem voucher — asks the platform what the voucher is
 *     (`GET /vouchers/lookup`) and then HOLDS it for this cart
 *     (`POST /sales/:id/vouchers`), by the sale id this till minted for the
 *     cart. Nothing is used up until the sale is paid.
 *   - The value is the platform's. The till puts the voucher's CODE on the cart
 *     (`promoCodes`) and shows what the quote says it did; it never works out a
 *     discount itself and never describes one.
 *   - Every refusal the platform gives is shown in its own words: invalid, not
 *     synced, already redeemed (who, when, where), expired, in use at another
 *     till, offline, not set up, locked — and, when it refuses to price the
 *     cart, the quote's refusal too (VOUCHER_NOT_HELD and every other), on the
 *     voucher's card (`voucherUnpricedReason`). The till adds words only for
 *     what it knows before asking or without an answer: that it has no
 *     connection, that the cart carries a promo code, that Pay has been
 *     pressed, and — at the ticket till — that a menu item is the restaurant's
 *     (`refuseHere`).
 *   - Taking the voucher off a cart that has not been rung up releases it
 *     (`DELETE`); a sale rung up with it lets it go only by being voided, which
 *     the till's Cancel does with a reason (`cancel` in lib/saleWriter.ts).
 *
 * One hook serves both tills that redeem vouchers — the ticket counter
 * (`pages/Till.tsx`) and the F&B counter (`pages/OrderStation.tsx`) — so the two
 * cannot disagree about any of that.
 */

/** Said when this till has no connection (spec §8: online only) — and only then. */
export const VOUCHER_ONLINE_ONLY = 'Vouchers can only be redeemed online';
/**
 * The platform's own words for a voucher beside a promo code
 * (VOUCHER_NOT_COMBINABLE). The till says them itself in the two places it
 * knows first: a voucher scanned onto a cart carrying a code, and a code
 * entered on a cart carrying a voucher.
 */
export const VOUCHER_NOT_COMBINABLE =
  'A voucher cannot be combined with another voucher or promo code on the same sale';
/**
 * The platform's words for a voucher scanned after Pay (SALE_ALREADY_RUNG_UP),
 * said by the till while the payment screen is open: that cart is the one
 * being paid for, and it must not change under the person paying.
 */
export const VOUCHER_AFTER_PAY = 'This sale has already been rung up — scan the voucher before Pay';
/** Said on the confirmation screen, where there is no cart to hold it for. */
export const VOUCHER_AFTER_SALE = 'This sale is finished — start a new sale to redeem the voucher';
/**
 * Said when the sale is pressed through while the platform is still pricing a
 * cart that just changed: a voucher is charged at its figure alone, so nothing
 * is written until it has answered.
 */
export const VOUCHER_BEING_PRICED = 'The platform is still pricing the voucher — press again in a moment';
/**
 * Said by the ticket till for a voucher whose free item is on the menu: the
 * kitchen makes it, the restaurant till sends the kitchen its ticket, and the
 * ticket counter has neither the item nor a way to order it.
 */
export const VOUCHER_AT_THE_RESTAURANT = 'Redeem this voucher at the restaurant till';
/**
 * The reason the till's Cancel voids a sale it rang up that took no money —
 * any such sale, voucher or not: the owner's rule for Cancel, so a sale nobody
 * will pay is never left `tendering` behind a screen that has moved on.
 */
export const CANCELLED_AT_THE_TILL = 'Cancelled at the till';
/**
 * The reason a sale rung up with a voucher is voided when staff change the
 * order on the payment screen and pay again: the corrected cart is a new sale,
 * and the voucher cannot follow it until the abandoned one lets it go.
 */
export const ORDER_CHANGED_AFTER_PAY = 'Order changed at the till after Pay';

/**
 * Is this the shape of a booth voucher's code? The box's rule
 * (`isBoothVoucherCode` in packages/box-agent/src/scan.ts), used where a string
 * reaches the till without the box having read it — a USB scanner typing into
 * the page, a code typed into the promo box or the F&B band field. Eleven
 * characters with a right check character, or the ten-character shape printed
 * before the check; digits alone are a retail barcode's shape (and a band's)
 * and are not claimed.
 */
export function looksLikeVoucherCode(raw: string): boolean {
  const code = normaliseBoothCode(raw);
  if (/^[0-9]+$/.test(code)) return false;
  return verifyBoothCode(code).ok || isLegacyBoothCode(code);
}

/**
 * A free item off the MENU: the lookup names the linked product's kind
 * (`effect.product.kind`, the `pos.product` row's), and `menu` is what the F&B
 * tills sell — made by the kitchen or the bar, which only the restaurant
 * till's order sends a ticket to. A `merch` product (the shop's shelf) or an
 * `addon` (a ticket extra) is handed over from stock, which the ticket counter
 * can do.
 */
export function isMenuItemVoucher(view: VoucherView): boolean {
  return view.effect.type === 'free_item' && view.effect.product.kind === 'menu';
}

/**
 * WHY THE VOUCHER'S CARD HAS NO FIGURE FROM THE PLATFORM, in one sentence — what
 * the card, Pay and the F&B charge button say while the platform has not priced
 * the cart the voucher is on. Null while there is nothing to say: the platform
 * priced it, or is being asked.
 *
 *   - The platform answered and refused (a 4xx of ours): ITS words, whatever
 *     the refusal — "Scan the voucher at this till first — it is not held for
 *     this sale" when the hold was lost, and every other.
 *   - The platform answered and failed (a 5xx, a proxy's page): what it said.
 *   - Nothing answered, or this till knows it is offline: "Vouchers can only be
 *     redeemed online" — the one case the till speaks for itself.
 *   - Otherwise the quote's own reason for not being the platform's (no station
 *     on this device, no pricing route on this deployment).
 */
export function voucherUnpricedReason(args: {
  quote: CartQuote;
  pending: boolean;
  error: QuoteError | null;
  offline: boolean;
}): string | null {
  const { quote, pending, error, offline } = args;
  if (quote.source === 'platform' || pending) return null;
  if (error) return error.message;
  if (offline || quote.unanswered) return VOUCHER_ONLINE_ONLY;
  return quote.reason ?? null;
}

/** A voucher held for this cart. */
export interface HeldVoucher {
  /** The platform's answer to the hold: what it is, where and when it was printed. */
  view: VoucherView;
  /** The code as the platform stores it — what rides the cart's `promoCodes`. */
  code: string;
  /** The sale id it is held for: this cart's, as the till minted it. */
  saleId: string;
}

/** Why a voucher was not put on the cart, exactly as the counter shows it. */
export interface VoucherRefusal {
  /** The platform's error code, or the till's own for a refusal made here. */
  code: string;
  message: string;
  /** The code that was refused, as the till read it. */
  voucherCode: string;
}

/** A refusal in the platform's own words; the till's words only where nobody answered. */
function refusalOf(err: unknown, voucherCode: string): VoucherRefusal {
  if (err instanceof NetworkError) {
    return { code: 'VOUCHER_OFFLINE', message: VOUCHER_ONLINE_ONLY, voucherCode };
  }
  if (isMissingRoute(err)) {
    return {
      code: 'NOT_ON_THIS_DEPLOYMENT',
      message: 'This deployment cannot redeem vouchers yet',
      voucherCode,
    };
  }
  if (err instanceof ApiError) return { code: err.code, message: err.message, voucherCode };
  return {
    code: 'UNKNOWN',
    message: err instanceof Error ? err.message : 'The voucher could not be checked',
    voucherCode,
  };
}

/**
 * The sale a refusal says still holds this voucher, rung up at THIS till —
 * `HELD_ELSEWHERE` names it only to the till that rang it up.
 */
function rungUpHereOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'HELD_ELSEWHERE') return null;
  const details = err.details as { rungUp?: unknown; saleId?: unknown } | undefined;
  return details?.rungUp === true && typeof details.saleId === 'string' ? details.saleId : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "8 Oct 2026" — and with `time`, "8 Oct 2026 15:02" — on the branch's clock,
 * assembled from the same pinned parts the platform's refusals use
 * (`formatVoucherDate` in apps/api/src/services/vouchers.ts), so the card and
 * the platform's own sentences print a date the same way.
 */
export function formatVoucherStamp(iso: string, opts: { time?: boolean } = {}): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const timeZone = getBranchTimezone();
  const [year, month, day] = isoDateInTz(instant, timeZone).split('-');
  const date = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
  if (!opts.time) return date;
  const minutes = wallClockMinutesInTz(instant, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

export interface TillVoucher {
  /** The voucher on this cart, or null. */
  held: HeldVoucher | null;
  /** The last refusal, shown until the next attempt or until dismissed. */
  refusal: VoucherRefusal | null;
  /** A request is out; the entry waits for it. */
  busy: boolean;
  /**
   * The voucher on the cart as of now — for code that runs across awaits, where
   * `held` is the value of the render that started it (a move changes its sale id).
   */
  current: () => HeldVoucher | null;
  /**
   * Look the code up and hold it for this cart. `blockedBy` is a reason the
   * till already knows the answer is no — said, and nothing is asked.
   * Resolves true when the voucher is on the cart.
   */
  redeem: (raw: string, blockedBy?: string | null) => Promise<boolean>;
  /** Take it off a cart that has not been rung up. Resolves true when it is off. */
  release: () => Promise<boolean>;
  /**
   * Hold it for the sale id the next commit will carry, when that is not the
   * one it is held for (a refused Pay burns the id it was sent under). A sale
   * rung up at this till that still holds it is voided first, with a reason.
   */
  moveTo: (saleId: string) => Promise<boolean>;
  /** Show a refusal the till made itself. */
  refuse: (message: string, voucherCode: string, code?: string) => void;
  dismiss: () => void;
  /** A new cart: forget the voucher, and ignore any answer still in flight. */
  reset: () => void;
}

/**
 * THE VOUCHER ON THIS TILL'S CART.
 *
 * `isOffline` is asked before any request: a till that knows it has no
 * connection says so rather than sending a code the platform cannot answer
 * for.
 *
 * `refuseHere` is this till's own no, asked once the platform has said what
 * the voucher is and before it is held: the ticket till sends a menu item to
 * the restaurant till (`isMenuItemVoucher`). Nothing is held, so nothing is
 * left to let go; the lookup consumed nothing and counted no miss.
 *
 * AN ANSWER NEVER LANDS ON A CART THAT HAS MOVED ON. Every request captures an
 * epoch that `reset` bumps — the guard `saleEpochRef` is in `pages/Till.tsx`,
 * for the same reason. A hold that comes back after the till moved on is let go
 * again rather than left on a cart nobody has.
 */
export function useTillVoucher(options: {
  isOffline: () => boolean;
  refuseHere?: (view: VoucherView) => string | null;
}): TillVoucher {
  const [held, setHeldState] = useState<HeldVoucher | null>(null);
  const [refusal, setRefusal] = useState<VoucherRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  const heldRef = useRef<HeldVoucher | null>(null);
  const busyRef = useRef(false);
  const epochRef = useRef(0);
  /** The sale id minted for this cart the first time a voucher was held for it. */
  const cartSaleIdRef = useRef<string | null>(null);
  const offline = useRef(options.isOffline);
  offline.current = options.isOffline;
  const refuseHere = useRef(options.refuseHere);
  refuseHere.current = options.refuseHere;

  const setHeld = useCallback((next: HeldVoucher | null) => {
    heldRef.current = next;
    setHeldState(next);
  }, []);

  const start = useCallback(() => {
    busyRef.current = true;
    setBusy(true);
  }, []);
  const finish = useCallback((epoch: number) => {
    if (epochRef.current !== epoch) return;
    busyRef.current = false;
    setBusy(false);
  }, []);

  const redeem = useCallback(
    async (raw: string, blockedBy?: string | null): Promise<boolean> => {
      const code = normaliseBoothCode(raw);
      if (!code || busyRef.current) return false;
      if (blockedBy) {
        setRefusal({ code: 'TILL_REFUSED', message: blockedBy, voucherCode: code });
        return false;
      }
      if (offline.current()) {
        setRefusal({ code: 'VOUCHER_OFFLINE', message: VOUCHER_ONLINE_ONLY, voucherCode: code });
        return false;
      }
      const epoch = epochRef.current;
      start();
      setRefusal(null);
      try {
        // What it is, first — consumes nothing (the owner's "a scan answers at once").
        const looked = await vouchersApi.lookup(code);
        if (epochRef.current !== epoch) return false;
        const notHere = refuseHere.current?.(looked.voucher) ?? null;
        if (notHere) {
          setRefusal({ code: 'VOUCHER_WRONG_TILL', message: notHere, voucherCode: looked.voucher.code });
          return false;
        }
        // Then held for THIS cart. A second voucher is sent for the same cart,
        // so the platform can answer "only one voucher" in its own words.
        const saleId =
          heldRef.current?.saleId ?? cartSaleIdRef.current ?? (cartSaleIdRef.current = newId());
        const answer = await vouchersApi.hold(saleId, code);
        if (epochRef.current !== epoch) {
          void vouchersApi.release(answer.saleId, answer.voucher.id).catch(() => undefined);
          return false;
        }
        setHeld({ view: answer.voucher, code: answer.voucher.code, saleId: answer.saleId });
        return true;
      } catch (err) {
        if (epochRef.current === epoch) setRefusal(refusalOf(err, code));
        return false;
      } finally {
        finish(epoch);
      }
    },
    [finish, setHeld, start],
  );

  const release = useCallback(async (): Promise<boolean> => {
    const current = heldRef.current;
    if (!current) return true;
    if (busyRef.current) return false;
    const epoch = epochRef.current;
    start();
    try {
      // `released: false` means it is no longer held for this cart: off it either way.
      await vouchersApi.release(current.saleId, current.view.id);
      if (epochRef.current === epoch) {
        setHeld(null);
        setRefusal(null);
      }
      return true;
    } catch (err) {
      if (epochRef.current === epoch) setRefusal(refusalOf(err, current.code));
      return false;
    } finally {
      finish(epoch);
    }
  }, [finish, setHeld, start]);

  const moveTo = useCallback(
    async (saleId: string): Promise<boolean> => {
      const current = heldRef.current;
      if (!current || current.saleId === saleId) return true;
      const epoch = epochRef.current;
      try {
        let answer;
        try {
          answer = await vouchersApi.hold(saleId, current.code);
        } catch (err) {
          const abandoned = rungUpHereOf(err);
          if (!abandoned || abandoned === saleId) throw err;
          await salesApi.voidSale(abandoned, ORDER_CHANGED_AFTER_PAY);
          answer = await vouchersApi.hold(saleId, current.code);
        }
        if (epochRef.current !== epoch) return false;
        cartSaleIdRef.current = saleId;
        setHeld({ view: answer.voucher, code: answer.voucher.code, saleId: answer.saleId });
        return true;
      } catch (err) {
        if (epochRef.current === epoch) setRefusal(refusalOf(err, current.code));
        return false;
      }
    },
    [setHeld],
  );

  const refuse = useCallback((message: string, voucherCode: string, code = 'TILL_REFUSED') => {
    setRefusal({ code, message, voucherCode: normaliseBoothCode(voucherCode) });
  }, []);

  const dismiss = useCallback(() => setRefusal(null), []);

  const reset = useCallback(() => {
    epochRef.current += 1;
    cartSaleIdRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setHeld(null);
    setRefusal(null);
  }, [setHeld]);

  const current = useCallback(() => heldRef.current, []);

  return { held, refusal, busy, current, redeem, release, moveTo, refuse, dismiss, reset };
}
