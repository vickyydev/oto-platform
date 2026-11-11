import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteCart, type CartQuote } from '@/api/sales';
import { StepPayment } from '@/components/till/StepPayment';
import { useCartQuote } from '@/lib/cartQuote';
import { computeLineTotal } from '@/lib/pricing';
import { usePaymentStage } from '@/lib/usePaymentStage';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine } from '@/types';
import { cartQuote, settle } from './support/fixtures';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/api/sales', async (original) => ({ ...await original<typeof import('@/api/sales')>(), quoteCart: vi.fn() }));

type El = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): El[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const unmounts: (() => void)[] = [];

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

describe('SCRUM-807: a delayed Golden Ticket drop-off quote', () => {
  const line = (): CartLine => {
    const ticketType = getTicketTypes().find(ticket => ticket.name === 'Full Day Pass')!;
    const value: CartLine = { id: 'zz-test-gift', ticketType, tier: 'tourist', kids: 1, adults: 0,
      socks: 0, addOns: [], lineTotal: 0, voucherGift: true,
      dropOff: { registrationId: 'zz-test-reg', checkInId: 'zz-test-child', childName: 'ZZ TEST child',
        childAge: 7, service: 'drop_off', hours: 8, lengthChosen: true, serviceFeeTHB: 225 } };
    return { ...value, lineTotal: computeLineTotal({ ...value, serviceFeeTHB: 225 }) };
  };

  function payment() {
    let answer!: (quote: CartQuote) => void;
    let refuse!: (error: unknown) => void;
    vi.mocked(quoteCart).mockImplementation(() => new Promise((resolve, reject) => { answer = resolve; refuse = reject; }));
    const prepareSale = vi.fn();
    const onSelectMethod = vi.fn();
    const gift = line();
    const mounted = renderHook(() => {
      const cart = useCartQuote({ lines: [gift], discounts: [], manualDiscounts: [],
        identity: { branchId: 'zz-park', stationId: 'zz-till', tier: 'tourist', accountId: 'zz-staff', accountName: 'ZZ TEST' },
        promoCodes: ['ZZTEST807'] });
      // The actual till wiring is pinned by s807-voucher-pricing-review.
      const pricePending = cart.quote.source !== 'platform';
      const stage = usePaymentStage({ scope: 'same-drop-off', isCurrentScope: () => true,
        active: !pricePending, totalSatang: Math.round(cart.totals.total * 100),
        prepareSale, finaliseSale: vi.fn(), onComplete: vi.fn() });
      const screen = StepPayment({ total: cart.totals.total, selectedMethod: null, onSelectMethod,
        onComplete: vi.fn(), onBack: vi.fn(), nothingToPay: cart.totals.total === 0, pricePending, paymentStage: stage });
      return { cart, stage, screen };
    });
    unmounts.push(mounted.unmount);
    return { ...mounted, prepareSale, onSelectMethod, answer: (q: CartQuote) => answer(q), refuse: (e: unknown) => refuse(e) };
  }

  it('keeps the unpriced amount and Confirm shut, then shows the returned zero without Back and Pay', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    expect(quoteCart).toHaveBeenCalledTimes(1);
    expect(view.result.current.cart.totals.total).toBeGreaterThan(0);
    expect(words(view.result.current.screen)).toContain('Amount Due—');
    expect(words(view.result.current.screen)).not.toContain('No payment needed');
    expect(elements(view.result.current.screen).find(el => words(el.props.children) === 'Confirm Payment Received')?.props.disabled).toBeTruthy();
    const cash = elements(view.result.current.screen).find(el => typeof el.props.onClick === 'function' && words(el.props.children) === 'Cash')!;
    (cash.props.onClick as () => void)();
    expect(view.onSelectMethod).not.toHaveBeenCalled();
    await view.result.current.stage.submit();
    expect(view.prepareSale).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    view.answer(cartQuote(0));
    await settle();
    expect(view.result.current.stage.state.outstandingSatang).toBe(0);
    expect(view.result.current.stage.state.amountSatang).toBe(0);
    expect(words(view.result.current.screen)).toContain('Amount Due฿0');
    expect(words(view.result.current.screen)).toContain('No payment needed');
    expect(elements(view.result.current.screen).find(el => words(el.props.children) === 'Complete Sale')?.props.disabled).toBeFalsy();
    expect(view.prepareSale).not.toHaveBeenCalled(); // no money gesture was made
  });

  it('keeps an unanswered or refused voucher price unavailable', async () => {
    const view = payment();
    await vi.advanceTimersByTimeAsync(200);
    view.refuse(new Error('ZZ TEST quote unavailable'));
    await settle();
    expect(view.result.current.cart.error).not.toBeNull();
    expect(words(view.result.current.screen)).toContain('Amount Due—');
    expect(elements(view.result.current.screen).find(el => words(el.props.children) === 'Confirm Payment Received')?.props.disabled).toBeTruthy();
  });

  it('does not describe a still-pending zero as free', () => {
    const screen = StepPayment({ total: 0, selectedMethod: null, onSelectMethod: vi.fn(),
      onComplete: vi.fn(), onBack: vi.fn(), nothingToPay: true, pricePending: true });
    expect(words(screen)).toContain('Amount Due—');
    expect(words(screen)).not.toContain('No payment needed');
  });
});
