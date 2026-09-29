import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartQuote, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import {
  quoteCart,
  quoteItemCart,
  type CartIdentity,
  type CartQuote,
  type ItemCartIdentity,
} from '@/api/sales';
import { useCartQuote } from '@/lib/cartQuote';
import { useItemCartQuoteWithPromos } from '@/lib/itemPromoQuote';
import { computeLineTotal } from '@/lib/pricing';
import { getMenuItems, getTicketTypes } from '@/store/catalogStore';
import type { CartLine, Discount, FnbOrderLine, ManualDiscount } from '@/types';

/**
 * THE PRICE ON THE SCREEN — `lib/cartQuote.ts` (S2-09a, SCRUM-203) for the
 * ticket tills and `lib/itemPromoQuote.ts` (SCRUM-362) for the F&B and shop
 * stations, which keep one contract:
 *
 *   - this device's figure is on the screen at once, and the platform is asked
 *     200 ms after the last change to the cart;
 *   - the cart's SIGNATURE decides whether it changed: only what moves money is
 *     in it, so an unchanged cart re-rendered asks nothing;
 *   - every request carries a SEQUENCE number, and an answer that is not the
 *     latest is dropped — the defect this project keeps producing is an async
 *     answer landing on a cart that has moved on;
 *   - a refusal about the cart is told apart from a fault that says nothing
 *     about it.
 *
 * The hooks run on the harness in place of React (support/hooks.ts). Only the
 * round trip is replaced — `quoteCart` and `quoteItemCart`, whose answers the
 * test gives — and `window` is Node's own global, whose timers are faked. The
 * local figure is the till's real engine over the catalogue's seed.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/sales')>()),
  quoteCart: vi.fn(),
  quoteItemCart: vi.fn(),
}));

const QUOTE_DEBOUNCE_MS = 200;
const askTill = vi.mocked(quoteCart);
const askStation = vi.mocked(quoteItemCart);

/** One question to the platform, held until the test answers it. */
interface Asked<A> {
  args: A;
  answer: (quote: CartQuote) => Promise<void>;
  refuse: (error: unknown) => Promise<void>;
}

function holdAnswers<A>(mock: { mockImplementation: (fn: (args: A) => Promise<CartQuote>) => unknown }) {
  const asked: Asked<A>[] = [];
  mock.mockImplementation(
    (args: A) =>
      new Promise<CartQuote>((resolve, reject) => {
        asked.push({
          args,
          answer: async (quote) => {
            resolve(quote);
            await settle();
          },
          refuse: async (error) => {
            reject(error);
            await settle();
          },
        });
      }),
  );
  return asked;
}

/** The platform's answer, told apart from this device's by its source and its total. */
const platformQuote = (total: number): CartQuote => cartQuote(total);

const oneHour = getTicketTypes().find((ticket) => ticket.id === 't-1h')!;

/** A walk-in's "1 Hour Play" line, priced as the till prices it (฿690 a child). */
function ticketLine(kids = 1, id = 'line-1'): CartLine {
  const priced = { ticketType: oneHour, tier: 'tourist', kids, adults: 0, socks: 0, addOns: [] };
  return { id, ...priced, lineTotal: computeLineTotal(priced) };
}

const identity: CartIdentity = {
  branchId: 'branch-1',
  stationId: 'station-1',
  tier: 'tourist',
  accountId: 'account-1',
  accountName: 'Reception',
};

/** A staff discount taken at the counter: ฿50 off the order. */
const serviceRecovery: ManualDiscount = {
  id: 'md-1',
  scope: 'order',
  type: 'fixed',
  value: 50,
  reason: 'Service recovery',
  amountTHB: 50,
  appliedBy: 'Reception',
  appliedById: 'account-1',
  appliedAt: '2026-09-25T04:00:00.000Z',
};

type TillArgs = Parameters<typeof useCartQuote>[0];

function mountTill(args: Partial<TillArgs> = {}) {
  const initial: TillArgs = { lines: [ticketLine()], discounts: [], manualDiscounts: [], identity, ...args };
  return renderHook((props: TillArgs) => useCartQuote(props), initial);
}

let asked: Asked<Parameters<typeof quoteCart>[0]>[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  // The hooks debounce on `window.setTimeout`; in Node that is the global's, faked above.
  vi.stubGlobal('window', globalThis);
  asked = holdAnswers(askTill);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCartQuote — the ticket till', () => {
  it("shows this device's figure at once, and asks the platform 200 ms after the last change", async () => {
    const view = mountTill();
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.totals.total).toBe(690);
    expect(view.result.current.pending).toBe(true);

    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS - 1);
    expect(askTill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(askTill).toHaveBeenCalledTimes(1);

    await asked[0]!.answer(platformQuote(700));
    expect(view.result.current.quote.source).toBe('platform');
    expect(view.result.current.totals.total).toBe(700);
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it('asks once for a burst of changes, about the cart on the screen at the end', async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(100);
    view.rerender({ lines: [ticketLine(2)], discounts: [], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(100);
    view.rerender({ lines: [ticketLine(3)], discounts: [], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);

    expect(askTill).toHaveBeenCalledTimes(1);
    expect(asked[0]!.args.lines[0]!.kids).toBe(3);
    expect(view.result.current.totals.total).toBe(2_070);
  });

  it('asks nothing more when the same cart is rendered again as new objects', async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    await asked[0]!.answer(platformQuote(700));

    view.rerender({ lines: [ticketLine()], discounts: [], manualDiscounts: [], identity: { ...identity } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(askTill).toHaveBeenCalledTimes(1);
    expect(view.result.current.totals.total).toBe(700);
    expect(view.result.current.pending).toBe(false);
  });

  it('drops an answer about a cart that has moved on, when it arrives first', async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ lines: [ticketLine(2)], discounts: [], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askTill).toHaveBeenCalledTimes(2);

    await asked[0]!.answer(platformQuote(111)); // about one child: nobody is looking at that cart
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.totals.total).toBe(1_380);
    expect(view.result.current.pending).toBe(true);

    await asked[1]!.answer(platformQuote(1_400));
    expect(view.result.current.totals.total).toBe(1_400);
    expect(view.result.current.pending).toBe(false);
  });

  it('drops an answer about a cart that has moved on, when it arrives last', async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ lines: [ticketLine(2)], discounts: [], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);

    await asked[1]!.answer(platformQuote(1_400));
    await asked[0]!.answer(platformQuote(111));
    expect(view.result.current.totals.total).toBe(1_400);
  });

  it('drops a refusal about a cart that has moved on', async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ lines: [ticketLine(2)], discounts: [], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);

    await asked[0]!.refuse(new ApiError(409, 'PRICE_MOVED', 'The price of 1 Hour Play has changed'));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.pending).toBe(true); // the question about this cart is still out

    await asked[1]!.answer(platformQuote(1_400));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.totals.total).toBe(1_400);
  });

  it("shows the platform's figure only while its own cart is on the screen", async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    await asked[0]!.answer(platformQuote(700));

    view.rerender({ lines: [ticketLine(2)], discounts: [], manualDiscounts: [], identity });
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.totals.total).toBe(1_380);
    expect(view.result.current.pending).toBe(true);
  });

  it.each([
    ['a refusal: a 4xx carrying our envelope', new ApiError(409, 'PRICE_MOVED', 'The price of 1 Hour Play has changed'), 'refusal', 409, 'PRICE_MOVED'],
    ['a fault: our 5xx', new ApiError(503, 'SERVICE_UNAVAILABLE', 'Try again'), 'fault', 503, 'SERVICE_UNAVAILABLE'],
    ["a fault: a proxy's page with no envelope", new ApiError(502, 'UNKNOWN', 'Bad Gateway'), 'fault', 502, 'UNKNOWN'],
    ['a fault: a 4xx with no envelope of ours', new ApiError(400, 'UNKNOWN', 'Bad Request'), 'fault', 400, 'UNKNOWN'],
    ['a fault: something that is not an answer', new TypeError('Failed to fetch'), 'fault', null, null],
  ] as const)('keeps %s', async (_label, error, kind, status, code) => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    await asked[0]!.refuse(error);

    expect(view.result.current.error).toEqual({ kind, status, code, message: error.message });
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.totals.total).toBe(690);
    expect(view.result.current.pending).toBe(false);
  });

  it('asks nothing without a station, for an empty cart, or once the sale is committed', async () => {
    const view = mountTill({ identity: null });
    await vi.advanceTimersByTimeAsync(1_000);
    view.rerender({ lines: [], discounts: [], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(1_000);
    view.rerender({ lines: [ticketLine()], discounts: [], manualDiscounts: [], identity, enabled: false });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(askTill).not.toHaveBeenCalled();
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.totals.total).toBe(690);
  });

  it('asks about a cart whose only line is its voucher, and again when a voucher goes on or comes off (S2-10b)', async () => {
    const view = mountTill({ lines: [], promoCodes: ['B1RT7KMQ4XW'] });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askTill).toHaveBeenCalledTimes(1);
    expect(asked[0]!.args.promoCodes).toEqual(['B1RT7KMQ4XW']);

    view.rerender({ lines: [ticketLine()], discounts: [], manualDiscounts: [], identity, promoCodes: ['B1RT7KMQ4XW'] });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ lines: [ticketLine()], discounts: [], manualDiscounts: [], identity, promoCodes: [] });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askTill).toHaveBeenCalledTimes(3);
    expect(asked[2]!.args.promoCodes).toEqual([]);
  });

  it('asks again for a promo code, a staff discount or another tier', async () => {
    const view = mountTill();
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    const staff10: Discount = { code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10 };
    view.rerender({ lines: [ticketLine()], discounts: [staff10], manualDiscounts: [], identity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ lines: [ticketLine()], discounts: [staff10], manualDiscounts: [serviceRecovery], identity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(asked[2]!.args.manualDiscounts).toEqual([serviceRecovery]);
    view.rerender({
      lines: [ticketLine()],
      discounts: [staff10],
      manualDiscounts: [serviceRecovery],
      identity: { ...identity, tier: 'thai' },
    });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askTill).toHaveBeenCalledTimes(4);
  });

  it("shows the prototype's figure and says why, asking nothing, for a line the engine did not price", async () => {
    const stale = { ...ticketLine(), lineTotal: 999 };
    const view = mountTill({ lines: [stale] });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(askTill).not.toHaveBeenCalled();
    // A running figure for the guest, named as the prototype's, with the
    // engine's own reason — and no satang, so there is nothing a commit could
    // be reconciled against: nothing is sold from this source.
    expect(view.result.current.quote).toMatchObject({ source: 'till', engineVersion: 'prototype', satang: null });
    expect(view.result.current.quote.reason).toMatch(/^Cart lines were not priced under this pricing context/);
    expect(view.result.current.pending).toBe(false);
  });

  it('asks nothing for a drop-off child with no play length chosen yet', async () => {
    const dropOff: CartLine = {
      ...ticketLine(1, 'line-dropoff'),
      lineTotal: 0,
      dropOff: {
        registrationId: 'registration-1',
        checkInId: 'checkin-1',
        childName: 'Nong Ploy',
        childAge: 5,
        service: 'drop_off',
        hours: 1,
        lengthChosen: false,
        serviceFeeTHB: 0,
      },
    };
    const view = mountTill({ lines: [dropOff] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(askTill).not.toHaveBeenCalled();
    expect(view.result.current.quote).toMatchObject({
      source: 'till',
      engineVersion: 'prototype',
      satang: null,
      reason: 'A drop-off child has no play length chosen yet.',
    });
  });
});

describe('useItemCartQuoteWithPromos — the F&B and shop stations', () => {
  const fries = getMenuItems().find((item) => item.id === 'm-fries')!;
  const stationIdentity: ItemCartIdentity = { ...identity, channel: 'fnb' };
  type StationArgs = Parameters<typeof useItemCartQuoteWithPromos>[0];
  let stationAsked: Asked<Parameters<typeof quoteItemCart>[0]>[];

  function friesLine(optionIds: string[], note?: string): FnbOrderLine {
    return {
      id: 'fnb-1',
      menuItem: fries,
      qty: 1,
      selectedModifiers: [{ groupId: 'fries-sauce', optionIds }],
      lineTotal: 90,
      ...(note ? { note } : {}),
    };
  }

  function mountStation(lines: FnbOrderLine[], promos: Discount[] = []) {
    const initial: StationArgs = { kind: 'fnb', lines, manualDiscounts: [], promos, identity: stationIdentity };
    return renderHook((props: StationArgs) => useItemCartQuoteWithPromos(props), initial);
  }

  beforeEach(() => {
    stationAsked = holdAnswers(askStation);
  });

  it('pauses sent quote responses and refusals during a staff lock, retaining the last same-cart quote on resume', async () => {
    const lines = [friesLine(['fries-sauce-ketchup'])];
    const args: StationArgs = { kind: 'fnb', lines, manualDiscounts: [], promos: [], identity: stationIdentity };
    const view = mountStation(lines);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ ...args, enabled: false });
    await stationAsked[0]!.answer(platformQuote(101));
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(askStation).toHaveBeenCalledTimes(1);

    view.rerender(args);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    await stationAsked[1]!.answer(platformQuote(102));
    view.rerender({ ...args, enabled: false });
    expect(view.result.current.totals.total).toBe(102);
    view.rerender(args);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(view.result.current.totals.total).toBe(102);
    view.rerender({ ...args, enabled: false });
    await stationAsked[2]!.refuse(new ApiError(409, 'MODIFIER_REQUIRED', 'Choose a sauce'));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.totals.total).toBe(102);
    view.unmount();
  });

  it('asks again for a note — two notes are two lines to the kitchen — but not for sauces picked in another order', async () => {
    const view = mountStation([friesLine(['fries-sauce-ketchup', 'fries-sauce-mayo'])]);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askStation).toHaveBeenCalledTimes(1);

    const same = { kind: 'fnb' as const, manualDiscounts: [], promos: [], identity: stationIdentity };
    view.rerender({ ...same, lines: [friesLine(['fries-sauce-mayo', 'fries-sauce-ketchup'])] });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askStation).toHaveBeenCalledTimes(1);

    view.rerender({ ...same, lines: [friesLine(['fries-sauce-mayo', 'fries-sauce-ketchup'], 'no salt')] });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askStation).toHaveBeenCalledTimes(2);
    expect(stationAsked[1]!.args.lines[0]!.id).toBe('fnb-1');
  });

  it('asks again when a code goes on, and drops the answer about the order before it', async () => {
    const lines = [friesLine(['fries-sauce-ketchup'])];
    const view = mountStation(lines);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);

    const fnb10: Discount = { code: 'FNB10', label: 'F&B 10%', type: 'percent', value: 10, target: { kind: 'fnb' } };
    view.rerender({ kind: 'fnb', lines, manualDiscounts: [], promos: [fnb10], identity: stationIdentity });
    expect(view.result.current.totals.total).toBe(81); // this device's figure, the code applied
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askStation).toHaveBeenCalledTimes(2);
    expect(stationAsked[1]!.args.promos).toEqual([fnb10]);

    await stationAsked[0]!.answer(platformQuote(90)); // the order without the code
    expect(view.result.current.quote.source).toBe('till');
    expect(view.result.current.totals.total).toBe(81);
    expect(view.result.current.pending).toBe(true); // the question about this order is still out
    await stationAsked[1]!.answer(platformQuote(81));
    expect(view.result.current.quote.source).toBe('platform');
    expect(view.result.current.pending).toBe(false);
  });

  it('asks again for a staff discount on the order', async () => {
    const lines = [friesLine(['fries-sauce-ketchup'])];
    const view = mountStation(lines);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ kind: 'fnb', lines, manualDiscounts: [serviceRecovery], promos: [], identity: stationIdentity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    expect(askStation).toHaveBeenCalledTimes(2);
    expect(stationAsked[1]!.args.manualDiscounts).toEqual([serviceRecovery]);
  });

  it('drops a refusal about the order before the last change', async () => {
    const lines = [friesLine(['fries-sauce-ketchup'])];
    const view = mountStation(lines);
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);
    view.rerender({ kind: 'fnb', lines: [friesLine(['fries-sauce-ketchup'], 'no salt')], manualDiscounts: [], promos: [], identity: stationIdentity });
    await vi.advanceTimersByTimeAsync(QUOTE_DEBOUNCE_MS);

    await stationAsked[0]!.refuse(new ApiError(409, 'MODIFIER_REQUIRED', 'Choose a sauce'));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.pending).toBe(true);
  });
});
