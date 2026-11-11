import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartQuote, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import { quoteCart, type CartIdentity, type CartQuote } from '@/api/sales';
import { useCartQuote } from '@/lib/cartQuote';
import { computeLineTotal } from '@/lib/pricing';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine } from '@/types';

/**
 * SCRUM-869 — THE QUOTE IS PENDING FROM THE RENDER THE CART CHANGED ON.
 *
 * `useCartQuote` sent its question from an effect, and set `pending` there
 * too. A browser commits the render before it runs that effect, so for one
 * committed render after every tap the figure was this till's and `pending`
 * was false — which the customer display's publisher and the staff layout
 * read as "the platform refused this cart" and flipped on (the e2e's
 * observer caught the staff column at half width on two edits of three).
 *
 * The harness in `support/hooks.ts` runs effects as part of the render, so
 * here they are held back and flushed by hand, as a browser holds them back
 * until after the commit: what the hook returns BEFORE the flush is what the
 * screen is drawn from.
 */

const deferred = vi.hoisted(() => ({ queue: [] as Array<() => void> }));
vi.mock('react', async () => {
  const hooks = await import('./support/hooks');
  const useEffect: typeof hooks.useEffect = (effect, deps) => hooks.useEffect(() => {
    let cleanup: ReturnType<typeof effect> | undefined;
    deferred.queue.push(() => { cleanup = effect(); });
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, deps);
  return { ...hooks, useEffect };
});
vi.mock('@/lib/displaySession', () => ({ useStationDisplay: vi.fn() }));
vi.mock('@/api/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/sales')>()),
  quoteCart: vi.fn(),
}));

/** Run the effects a browser would have run after the commit. */
const flush = () => { for (const effect of deferred.queue.splice(0)) effect(); };

const QUOTE_DEBOUNCE_MS = 200;
const askTill = vi.mocked(quoteCart);
const oneHour = getTicketTypes().find((ticket) => ticket.id === 't-1h')!;
function ticketLine(kids = 1, id = 'line-1'): CartLine {
  const priced = { ticketType: oneHour, tier: 'tourist', kids, adults: 0, socks: 0, addOns: [] };
  return { id, ...priced, lineTotal: computeLineTotal(priced) };
}
const identity: CartIdentity = { branchId: 'branch-1', stationId: 'station-1', tier: 'tourist', accountId: 'account-1', accountName: 'Reception' };
type TillArgs = Parameters<typeof useCartQuote>[0];
const cart = (kids: number, extra: Partial<TillArgs> = {}): TillArgs => ({ lines: [ticketLine(kids)], discounts: [], manualDiscounts: [], identity, ...extra });

let answers: Array<{ resolve: (quote: CartQuote) => void; reject: (error: unknown) => void }>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  deferred.queue.length = 0;
  answers = [];
  askTill.mockImplementation(() => new Promise<CartQuote>((resolve, reject) => { answers.push({ resolve, reject }); }));
});
afterEach(() => { vi.useRealTimers(); });

async function answered(index: number, total: number) {
  answers[index]!.resolve(cartQuote(total));
  await settle();
}

describe('SCRUM-869: what the committed render reads while the platform is asked', () => {
  it('a changed cart is pending on its first render, before the effect that asks about it', async () => {
    const view = renderHook((props: TillArgs) => useCartQuote(props), cart(1));
    expect(view.result.current.pending, 'the first render, before any effect').toBe(true);
    expect(view.result.current.quote.source).toBe('till');
    flush();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askTill).toHaveBeenCalledTimes(1);
    await answered(0, 700);
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.quote.source).toBe('platform');

    // +1 kid: the render the tap produced, with its effects still to run.
    view.rerender(cart(2));
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.pending, 'the render after the tap, before its effect').toBe(true);
    expect(view.result.current.error).toBeNull();
    flush();
    expect(view.result.current.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    await answered(1, 1400);
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.totals.total).toBe(1400);
  });

  it('a refusal is about the cart it answered: that cart is not pending, the next edit is', async () => {
    const view = renderHook((props: TillArgs) => useCartQuote(props), cart(1));
    flush();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    answers[0]!.reject(new ApiError(409, 'PRICE_MOVED', 'The price of 1 Hour Play has changed'));
    await settle();
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.error).toEqual({ kind: 'refusal', status: 409, code: 'PRICE_MOVED', message: 'The price of 1 Hour Play has changed' });
    // Re-rendered with the same cart: still answered, still not pending.
    view.rerender(cart(1));
    expect(view.result.current.pending).toBe(false);
    // Edited: a question not yet asked, pending from this render; the old refusal is still what is shown until the answer.
    view.rerender(cart(2));
    expect(view.result.current.pending).toBe(true);
    expect(view.result.current.error?.code).toBe('PRICE_MOVED');
    flush();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    await answered(1, 1400);
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it('a till that asks nothing is never pending: no station, an empty cart, a committed sale', () => {
    for (const args of [cart(1, { identity: null }), cart(1, { lines: [] }), cart(1, { enabled: false })]) {
      const view = renderHook((props: TillArgs) => useCartQuote(props), args);
      expect(view.result.current.pending, JSON.stringify({ identity: args.identity, lines: args.lines.length, enabled: args.enabled })).toBe(false);
      flush();
      expect(view.result.current.pending).toBe(false);
      view.unmount();
    }
    expect(askTill).not.toHaveBeenCalled();
  });
});
