import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { quoteCart, type CartQuote } from '@/api/sales';
import { StepPayment } from '@/components/till/StepPayment';
import { useCartQuote } from '@/lib/cartQuote';
import { computeLineTotal } from '@/lib/pricing';
import { VOUCHER_ONLINE_ONLY, voucherPriceUnavailableLine, voucherUnpricedReason } from '@/lib/tillVoucher';
import { usePaymentStage } from '@/lib/usePaymentStage';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine } from '@/types';
import { cartQuote, settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-847 — THE PAYMENT STEP SAYS WHY WHEN THE VOUCHER PRICE IS NOT COMING.
 *
 * SCRUM-807 keeps the amount and Confirm shut until the platform has priced a
 * Golden Ticket drop-off, under "Waiting for the voucher price...". The quote
 * is asked once per cart, so when the platform refused it, failed, or nothing
 * answered, that line went on saying "Waiting" with nothing on its way.
 *
 * Driven here through the real quote hook and the sentence the voucher's card
 * already carries (`voucherUnpricedReason`), wired as `pages/Till.tsx` wires
 * them; the till's own lines are pinned by s847-voucher-price-wait-review.
 */
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/api/sales', async (original) => ({ ...await original<typeof import('@/api/sales')>(), quoteCart: vi.fn() }));

type El = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): El[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const unmounts: (() => void)[] = [];

const WAITING = 'Waiting for the voucher price...';
const NOT_FETCHED = 'The voucher price could not be fetched';
const WAYS_OUT = 'Go Back to change the order, or Cancel the sale.';

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('React', React);
});
afterEach(() => {
  unmounts.splice(0).forEach(unmount => unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const line = (): CartLine => {
  const ticketType = getTicketTypes().find(ticket => ticket.name === 'Full Day Pass')!;
  const value: CartLine = { id: 'zz-test-gift', ticketType, tier: 'tourist', kids: 1, adults: 0,
    socks: 0, addOns: [], lineTotal: 0, voucherGift: true,
    dropOff: { registrationId: 'zz-test-reg', checkInId: 'zz-test-child', childName: 'ZZ TEST child',
      childAge: 7, service: 'drop_off', hours: 8, lengthChosen: true, serviceFeeTHB: 225 } };
  return { ...value, lineTotal: computeLineTotal({ ...value, serviceFeeTHB: 225 }) };
};

/** The payment step over the real quote hook, with the voucher held, as the till wires it. */
function payment(offline = false) {
  let answer!: (quote: CartQuote) => void;
  let refuse!: (error: unknown) => void;
  vi.mocked(quoteCart).mockImplementation(() => new Promise((resolve, reject) => { answer = resolve; refuse = reject; }));
  const prepareSale = vi.fn();
  const onBack = vi.fn();
  const gift = line();
  const mounted = renderHook(() => {
    const cart = useCartQuote({ lines: [gift], discounts: [], manualDiscounts: [],
      identity: { branchId: 'zz-park', stationId: 'zz-till', tier: 'tourist', accountId: 'zz-staff', accountName: 'ZZ TEST' },
      promoCodes: ['ZZTEST847'] });
    const pricePending = cart.quote.source !== 'platform';
    const priceUnavailable = voucherUnpricedReason({ quote: cart.quote, pending: cart.pending, error: cart.error, offline });
    const stage = usePaymentStage({ scope: 'same-drop-off', isCurrentScope: () => true,
      active: !pricePending, totalSatang: Math.round(cart.totals.total * 100),
      prepareSale, finaliseSale: vi.fn(), onComplete: vi.fn() });
    const screen = StepPayment({ total: cart.totals.total, selectedMethod: null, onSelectMethod: vi.fn(),
      onComplete: vi.fn(), onBack, nothingToPay: cart.totals.total === 0, pricePending, priceUnavailable, paymentStage: stage });
    return { cart, stage, screen };
  });
  unmounts.push(mounted.unmount);
  const button = (label: string) => elements(mounted.result.current.screen).find(el => words(el.props.children) === label);
  return { ...mounted, prepareSale, onBack, button,
    text: () => words(mounted.result.current.screen),
    answer: (q: CartQuote) => answer(q), refuse: (e: unknown) => refuse(e) };
}

describe('SCRUM-847: the staff line while the voucher price is not in', () => {
  it('says it is waiting while the platform is being asked, and nothing about a failure', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    expect(quoteCart).toHaveBeenCalledTimes(1);
    expect(view.result.current.cart.pending).toBe(true);
    expect(view.text()).toContain(WAITING);
    expect(view.text()).not.toContain(NOT_FETCHED);
    expect(view.text()).toContain('Amount Due—');
  });

  it('a refusal: the price could not be fetched, in the platform’s words, with Back still there', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    view.refuse(new ApiError(409, 'VOUCHER_NOT_HELD', 'Scan the voucher at this till first — it is not held for this sale'));
    await settle();
    expect(view.result.current.cart.error?.kind).toBe('refusal');
    expect(view.text()).toContain(`${NOT_FETCHED}: Scan the voucher at this till first — it is not held for this sale. ${WAYS_OUT}`);
    expect(view.text()).not.toContain(WAITING);
    // Still no amount, no tender and no Confirm — and nothing asked again by itself.
    expect(view.text()).toContain('Amount Due—');
    expect(view.button('Confirm Payment Received')?.props.disabled).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quoteCart).toHaveBeenCalledTimes(1);
    expect(view.prepareSale).not.toHaveBeenCalled();
    const back = view.button('Back')!;
    expect(back.props.disabled).toBeFalsy();
    (back.props.onClick as () => void)();
    expect(view.onBack).toHaveBeenCalledTimes(1);
  });

  it('the platform failing (a 5xx) is said the same way, with what it said', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    view.refuse(new ApiError(503, 'UNKNOWN', 'Service Unavailable'));
    await settle();
    expect(view.result.current.cart.error?.kind).toBe('fault');
    expect(view.text()).toContain(`${NOT_FETCHED}: Service Unavailable. ${WAYS_OUT}`);
    expect(view.text()).not.toContain(WAITING);
  });

  it('nothing answered (the till is offline): says vouchers are redeemed online only', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    // What `quoteCart` answers when the request reached no server: this till's own figure, marked unanswered.
    view.answer(cartQuote(1315, { source: 'till', unanswered: true, reason: 'The platform did not answer; this till priced the cart.' }));
    await settle();
    expect(view.result.current.cart.pending).toBe(false);
    expect(view.result.current.cart.error).toBeNull();
    expect(view.text()).toContain(`${NOT_FETCHED}: ${VOUCHER_ONLINE_ONLY}. ${WAYS_OUT}`);
    expect(view.text()).not.toContain(WAITING);
    expect(view.text()).toContain('Amount Due—');
    expect(view.button('Confirm Payment Received')?.props.disabled).toBeTruthy();
    expect(view.button('Back')?.props.disabled).toBeFalsy();
  });

  it('a till that knows it is offline says nothing early: only once the request has come back', async () => {
    const view = payment(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(view.text()).toContain(WAITING);
    expect(view.text()).not.toContain(NOT_FETCHED);
    view.answer(cartQuote(1315, { source: 'till', unanswered: true }));
    await settle();
    expect(view.text()).toContain(`${NOT_FETCHED}: ${VOUCHER_ONLINE_ONLY}. ${WAYS_OUT}`);
  });

  it('the priced case is unchanged: the figure, no waiting line and no failure line', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    view.answer(cartQuote(0));
    await settle();
    expect(view.text()).toContain('Amount Due฿0');
    expect(view.text()).toContain('No payment needed');
    expect(view.text()).not.toContain(WAITING);
    expect(view.text()).not.toContain(NOT_FETCHED);
    expect(view.button('Complete Sale')?.props.disabled).toBeFalsy();
  });

  it('a reason is only ever shown while the price is pending, and a step with none keeps the waiting line', () => {
    const step = (props: { pricePending?: boolean; priceUnavailable?: string | null }) => words(StepPayment({ total: 540,
      selectedMethod: null, onSelectMethod: vi.fn(), onComplete: vi.fn(), onBack: vi.fn(), ...props }));
    // A sale with no voucher on it never passes either prop.
    expect(step({})).toContain('Amount Due฿540');
    expect(step({})).not.toContain(WAITING);
    expect(step({ priceUnavailable: 'ZZ TEST stale reason' })).not.toContain(NOT_FETCHED);
    expect(step({ pricePending: true })).toContain(WAITING);
    expect(step({ pricePending: true, priceUnavailable: null })).toContain(WAITING);
    expect(step({ pricePending: true, priceUnavailable: 'ZZ TEST reason' })).toContain(`${NOT_FETCHED}: ZZ TEST reason. ${WAYS_OUT}`);
  });

  it('the sentence ends once, whether or not the reason brought its own full stop', () => {
    expect(voucherPriceUnavailableLine('This voucher has expired.')).toBe(`${NOT_FETCHED}: This voucher has expired. ${WAYS_OUT}`);
    expect(voucherPriceUnavailableLine(VOUCHER_ONLINE_ONLY)).toBe(`${NOT_FETCHED}: Vouchers can only be redeemed online. ${WAYS_OUT}`);
  });
});
