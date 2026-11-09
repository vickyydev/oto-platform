import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleExtensionsRead } from '@/api/history';
import { api } from '@/api/client';
import { ExtensionPayment } from '@/components/history/SaleExtensions';
import type { StationDisplayState } from '@/lib/displaySession';
import { getEnabledPaymentMethods } from '@/lib/payments';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-797 — EXTRA HOUR in History's Add time: 1, 2 or 3 hours at ฿300 per
 * child per hour, the children read off the order, and the whole sum on
 * screen before the charge is made ("3 children x 2 hours x ฿300 = ฿1,800").
 * An order the platform refuses (a Full Day pass, no child) says why.
 */
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: null, can: () => true, offlineUnlock: null }),
}));

// This runner has no React plugin, so the component's JSX is compiled to
// `React.createElement` and looks for `React` in scope.
beforeEach(() => {
  vi.stubGlobal('React', React);
});

function elements(node: unknown): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function words(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
}
function button(tree: unknown, startsWith: string) {
  const found = elements(tree).find((node) => typeof node.props.onClick === 'function' && words(node.props.children).startsWith(startsWith));
  expect(found, startsWith).toBeDefined();
  return found!;
}

/** Three children on a 1-hour ticket with one adult: four bracelets, three children charged. */
const order: SaleExtensionsRead = {
  options: [
    { id: 'ext-60', label: '+1 hour', hours: 1, minutes: 60, unitSatang: 30000 },
    { id: 'ext-120', label: '+2 hours', hours: 2, minutes: 120, unitSatang: 60000 },
    { id: 'ext-180', label: '+3 hours', hours: 3, minutes: 180, unitSatang: 90000 },
  ],
  children: 3,
  perChildHourSatang: 30000,
  refusal: null,
  eligibleBands: [
    { id: 'band-k1', shortCode: 'T1-7KMQ4X', kind: 'kid' },
    { id: 'band-k2', shortCode: 'T1-9ABCDE', kind: 'kid' },
    { id: 'band-k3', shortCode: 'T1-4FGHJK', kind: 'kid' },
    { id: 'band-a1', shortCode: 'T1-2LMNPQ', kind: 'adult' },
  ],
  extensions: [],
};

function open(data: SaleExtensionsRead) {
  return renderHook(() =>
    ExtensionPayment({ saleId: 'source-1', stationId: 'station-1', data, resume: null, operatorName: 'Som', onClose: vi.fn() }),
  );
}

describe('the extra hour is priced per child from the order', () => {
  it('offers 1, 2 or 3 hours, each with its sum for the children on the order', () => {
    const hook = open(order);
    expect(words(button(hook.result.current, '+1 hour').props.children)).toBe('+1 hour3 children x 1 hour x ฿300฿900');
    expect(words(button(hook.result.current, '+2 hours').props.children)).toBe('+2 hours3 children x 2 hours x ฿300฿1800');
    expect(words(button(hook.result.current, '+3 hours').props.children)).toBe('+3 hours3 children x 3 hours x ฿300฿2700');
    expect(words(hook.result.current)).not.toContain('30 minutes');
    hook.unmount();
  });

  it('shows the whole sum and the amount before the charge is made, and charges the option chosen', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ sale: { id: 'charge-1', status: 'tendering', totals: { grossSatang: 180_000 } }, extension: {}, replay: false });
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: { id: 'charge-1', status: 'tendering', totals: { grossSatang: 180_000 } }, attempts: [] });
    const hook = open(order);
    (button(hook.result.current, '+2 hours').props.onClick as () => void)();
    const sum = elements(hook.result.current).find((node) => node.props['aria-label'] === 'Extra hour sum');
    expect(words(sum)).toBe('3 children x 2 hours x ฿300 = ฿1,800');
    expect(words(hook.result.current)).toContain('Amount to charge฿1800');
    expect(post).not.toHaveBeenCalled();
    (button(hook.result.current, 'Continue to payment').props.onClick as () => void)();
    await settle();
    // Every bracelet on the order carries the time, the adult's with the children's.
    expect(post.mock.calls[0]?.[1]).toMatchObject({ optionId: 'ext-120',
      selection: { mode: 'bands', bandIds: ['band-k1', 'band-k2', 'band-k3', 'band-a1'] } });
    expect(words(hook.result.current)).toContain('Amount to charge฿1800');
    hook.unmount(); post.mockRestore(); get.mockRestore();
  });

  it('unticking a bracelet does not change the money', () => {
    const hook = open(order);
    (button(hook.result.current, '+1 hour').props.onClick as () => void)();
    const boxes = () => elements(hook.result.current).filter((node) => node.type === 'input' && node.props.type === 'checkbox');
    (boxes()[3]!.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    expect(boxes().map((box) => box.props.checked)).toEqual([true, true, true, false]);
    expect(words(hook.result.current)).toContain('Amount to charge฿900');
    hook.unmount();
  });

  it('one child for one hour is ฿300', () => {
    const hook = open({ ...order, children: 1, eligibleBands: order.eligibleBands.slice(0, 1) });
    (button(hook.result.current, '+1 hour').props.onClick as () => void)();
    const sum = elements(hook.result.current).find((node) => node.props['aria-label'] === 'Extra hour sum');
    expect(words(sum)).toBe('1 child x 1 hour x ฿300 = ฿300');
    hook.unmount();
  });
});

describe('the customer display shows the amount as any separate tender', () => {
  it('a card or QR tender for the charge is handed to the display; nothing before the charge exists', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ sale: { id: 'charge-1', status: 'tendering', totals: { grossSatang: 90_000 } }, extension: {}, replay: false });
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: { id: 'charge-1', status: 'tendering', totals: { grossSatang: 90_000 } }, attempts: [] });
    const handover = vi.fn((_state: StationDisplayState) => vi.fn());
    const hook = renderHook(() =>
      ExtensionPayment({ saleId: 'source-1', stationId: 'station-1', data: order, resume: null, operatorName: 'Som', onClose: vi.fn(), displayHandoff: handover }),
    );
    (button(hook.result.current, '+1 hour').props.onClick as () => void)();
    (button(hook.result.current, 'Continue to payment').props.onClick as () => void)();
    await settle();
    expect(handover).not.toHaveBeenCalled();
    const card = getEnabledPaymentMethods().find((method) => method.kind === 'card');
    expect(card, 'a card method is configured').toBeDefined();
    (button(hook.result.current, card!.label).props.onClick as () => void)();
    await settle();
    expect(handover).toHaveBeenCalled();
    expect(handover.mock.calls.at(-1)![0].presentation('')).toMatchObject({ stage: 'payment',
      cart: { kind: 'tender', supported: true, subject: 'extra_hour', method: 'card' }, payment: { amountSatang: 90_000 } });
    hook.unmount(); post.mockRestore(); get.mockRestore();
  });
});

describe('an order the platform refuses says why', () => {
  it('a Full Day pass shows the platform’s words and nothing to charge', () => {
    const message = 'An extra hour is added only to a 1 or 2-hour child ticket. A Full Day pass cannot take extra hours.';
    const hook = open({ ...order, options: [], children: 0, refusal: { code: 'EXTENSION_TICKET_NOT_ELIGIBLE', message } });
    const alert = elements(hook.result.current).find((node) => node.props.role === 'alert');
    expect(words(alert)).toBe(message);
    expect(button(hook.result.current, 'Choose a duration').props.disabled).toBe(true);
    expect(words(hook.result.current)).toContain('Amount to charge฿0');
    hook.unmount();
  });
});
