import { BOX_STOCK_REFUSALS } from '@oto/shared';
import { ApiError } from '@/api/client';

/**
 * S2-14b ROUND 4 (handover Q1) — THE COUNTER'S STOCK REFUSALS, ON THE TILL.
 *
 * On the box lane the box guards the cart against its stock snapshot when the
 * money is pressed (`payment.cash`, a card on its terminal, credit): "Only 3
 * Grip Socks S left", a size the line does not name, an item it has no count
 * for, a count over a day old (`BOX_STOCK_REFUSALS`). The platform's own guard
 * says the first two in the same words at commit. Each one took NOTHING — no
 * money, no receipt number, nothing queued — so the till says the counter's
 * words exactly as they came, never retries them, and never says the order is
 * saved somewhere: on the box lane it is not.
 */
export const STOCK_REFUSAL_CODES: readonly string[] = [
  BOX_STOCK_REFUSALS.short.code,
  BOX_STOCK_REFUSALS.size.code,
  BOX_STOCK_REFUSALS.unknown.code,
  BOX_STOCK_REFUSALS.stale.code,
];

/** True for a refusal of the cart's stock — by its code. */
export function isStockRefusalCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && STOCK_REFUSAL_CODES.includes(code);
}

/** The refusal's own words when `err` is a stock refusal, else null. */
export function stockRefusalWords(err: unknown): string | null {
  return err instanceof ApiError && isStockRefusalCode(err.code) ? err.message : null;
}

/**
 * What to do about it, in the counter's terms: a shortage or a size is fixed by
 * changing the order; an item the offline counter cannot count waits for the
 * connection.
 */
export function stockRefusalAdvice(code: string): string {
  return code === BOX_STOCK_REFUSALS.unknown.code || code === BOX_STOCK_REFUSALS.stale.code
    ? 'Take the item off this order and sell it when the connection is back — nothing was charged.'
    : 'Change the order — fewer, or another size — and press Pay again. Nothing was charged.';
}
