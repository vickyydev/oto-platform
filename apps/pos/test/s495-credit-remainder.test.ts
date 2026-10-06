import * as ReactModule from 'react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale } from './support/fixtures';
import { renderHook, type RenderedHook } from './support/hooks';
import { FnbPayment } from '@/components/fnb/FnbPayment';
import { paymentSubmitLabel } from '@/components/till/PaymentTenderPanel';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageController, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import type { Wristband } from '@/types';

/**
 * SCRUM-495, register entry 17 (OD-W3) — THE REST AFTER CREDIT IS ON CARD
 * FROM THE FIRST LOOK AT THE PAYMENT SCREEN. The approved F&B and shop
 * counters start the remainder on card (`useState<FnbRemainder>('card')`,
 * reset to card on entering payment) and keep what staff choose for it.
 *
 * Staging (e5fc2ef2): ฿350 credit on a ฿400 F&B order, and on a ฿500 shop
 * order, opened with the remainder buttons showing and nothing chosen. React
 * runs the payment screen's effects before the station's, so the card the
 * screen chose was wiped when the station's stage started afresh for the
 * payment screen, and the screen never chose again.
 *
 * Here the station is mounted as the stations mount it: the stage in the
 * station, the payment screen its child, and the child's effects run first.
 */
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const hooks = await import('./support/hooks');
  return { ...actual, default: actual, ...hooks };
});

const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
  { id: 'park-qr', kind: 'qr' as const, label: 'PromptPay', enabled: true, sortOrder: 2 },
];
const unmounts: (() => void)[] = [];

interface StationProps { onPayment: boolean; useCredit: boolean; totalSatang: number }
type Counter = 'F&B counter' | 'F&B phone' | 'shop';
type PaymentProps = Parameters<typeof FnbPayment>[0];

const outcome = (totalSatang: number): SaleWriteOutcome => {
  const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: totalSatang } });
  return { ok: true, written: true, saleId: sale.id, sale, replay: false };
};

/**
 * A counter as the station builds it: the stage lives in the station and is
 * reset when the payment screen opens (`active`), and the payment screen is
 * the station's child — rendered inside the station's render, its effects
 * run before the station's, as React commits them.
 */
function counter(kind: Counter, balanceTHB: number, start: StationProps) {
  let props = start;
  let screen: RenderedHook<PaymentProps, void> | null = null;
  let tree: ReactElement | null = null;
  const setUseCredit = (useCredit: boolean) => { props = { ...props, useCredit }; host.rerender(props); };
  const band = { id: 'band-1', code: 'WB-0001', creditBalanceTHB: balanceTHB } as unknown as Wristband;
  const host = renderHook((p: StationProps) => {
    const stage = usePaymentStage({
      scope: 'order-1', isCurrentScope: (scope) => scope === 'order-1',
      active: p.onPayment, totalSatang: p.totalSatang,
      prepareSale: async () => outcome(p.totalSatang),
      finaliseSale: async () => outcome(p.totalSatang),
      onComplete: () => undefined,
      wallet: balanceTHB > 0 ? { key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: p.useCredit, previewSatang: balanceTHB * 100 } : null,
    } satisfies PaymentStageOptions);
    if (!p.onPayment) {
      screen?.unmount();
      screen = null;
      return stage;
    }
    // OrderStation and MobileOrderStation hand over the band; MerchStation its
    // balance and the credit label.
    const paymentProps: PaymentProps = kind === 'shop'
      ? { total: p.totalSatang / 100, wristband: band, creditBalanceOverride: balanceTHB, pickupCode: '', creditLabel: 'Credit',
        stage, onBack: () => undefined, useCredit: p.useCredit, onUseCreditChange: setUseCredit }
      : { total: p.totalSatang / 100, wristband: band, pickupCode: kind === 'F&B phone' ? '' : 'A12',
        stage, onBack: () => undefined, useCredit: p.useCredit, onUseCreditChange: setUseCredit };
    if (screen) screen.rerender(paymentProps);
    else {
      screen = renderHook((q: PaymentProps) => { tree = FnbPayment(q) as ReactElement; }, paymentProps);
      unmounts.push(() => screen?.unmount());
    }
    return stage;
  }, props);
  unmounts.push(host.unmount);
  return {
    get stage(): PaymentStageController { return host.result.current; },
    get tree(): ReactElement { if (!tree) throw new Error('the payment screen is not showing'); return tree; },
    show: (next: Partial<StationProps>) => { props = { ...props, ...next }; host.rerender(props); },
  };
}

/** Every element in the payment screen's markup (built, never rendered). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
const remainderButton = (tree: ReactElement, id: string) => {
  const button = elements(tree).find((el) => el.type === 'button' && el.key === id);
  if (!button) throw new Error(`no remainder button for ${id}`);
  return button.props.onClick as (event: { stopPropagation: () => void }) => void;
};
const creditCard = (tree: ReactElement) => {
  const card = elements(tree).find((el) => el.props['aria-pressed'] !== undefined);
  if (!card) throw new Error('no credit card');
  return card.props.onClick as () => void;
};

beforeEach(() => {
  // FnbPayment's markup is compiled to React.createElement; it is built, never rendered.
  vi.stubGlobal('React', ReactModule);
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

describe('the rest after credit starts on card the first time the payment screen shows', () => {
  for (const [kind, totalSatang] of [['F&B counter', 40_000], ['F&B phone', 40_000], ['shop', 50_000]] as const) {
    it(`${kind}: ฿350 credit on a ฿${totalSatang / 100} order — card chosen for the rest, the button ready`, () => {
      // The band is scanned on an empty order, the order is rung up, then Pay.
      const test = counter(kind, 350, { onPayment: false, useCredit: true, totalSatang: 0 });
      test.show({ totalSatang });
      test.show({ onPayment: true });
      const { stage } = test;
      expect(stage.state.method).toBe('park-card');
      expect(stage.state.amountSatang).toBe(totalSatang - 35_000);
      expect(stage.creditPendingSatang).toBe(35_000);
      expect(paymentSubmitLabel(stage)).toBe('Start card payment');
      expect(paymentSubmitLabel(stage)).not.toBe('Select a payment method');
      expect(stage.canSubmit).toBe(true);
    });

    it(`${kind}: back to the order and Pay again — card again`, () => {
      const test = counter(kind, 350, { onPayment: false, useCredit: true, totalSatang });
      test.show({ onPayment: true });
      expect(test.stage.state.method).toBe('park-card');
      test.show({ onPayment: false });
      expect(test.stage.state.method).toBeNull();
      test.show({ onPayment: true });
      expect(test.stage.state.method).toBe('park-card');
      expect(test.stage.state.amountSatang).toBe(totalSatang - 35_000);
      expect(paymentSubmitLabel(test.stage)).toBe('Start card payment');
    });
  }

  it('credit covering the whole order keeps the no-tender path', () => {
    const test = counter('F&B counter', 350, { onPayment: false, useCredit: true, totalSatang: 30_000 });
    test.show({ onPayment: true });
    expect(test.stage.creditCoversAll).toBe(true);
    expect(test.stage.state.method).toBeNull();
    expect(paymentSubmitLabel(test.stage)).toBe('Complete Sale');
    expect(test.stage.canSubmit).toBe(true);
  });

  it('with no card tender configured nothing is preselected', () => {
    const noCard = METHODS.filter((m) => m.kind !== 'card');
    vi.mocked(paymentMethods.getEnabledPaymentMethods).mockReturnValue(noCard);
    vi.mocked(paymentMethods.findPaymentMethod).mockImplementation((id) => noCard.find((m) => m.id === id));
    const test = counter('shop', 350, { onPayment: false, useCredit: true, totalSatang: 50_000 });
    test.show({ onPayment: true });
    expect(test.stage.state.method).toBeNull();
    expect(paymentSubmitLabel(test.stage)).toBe('Select a payment method');
  });

  it('the rest staff choose is kept, across later figures and the credit toggle', () => {
    const test = counter('F&B counter', 350, { onPayment: false, useCredit: true, totalSatang: 40_000 });
    test.show({ onPayment: true });
    expect(test.stage.state.method).toBe('park-card');

    remainderButton(test.tree, 'park-cash')({ stopPropagation: () => undefined });
    expect(test.stage.state.method).toBe('park-cash');
    test.show({});
    test.stage.setTenderedSatang(10_000);
    expect(test.stage.state.method).toBe('park-cash');

    // Credit off and back on: the rest is still the cash staff chose.
    creditCard(test.tree)();
    expect(test.stage.state.amountSatang).toBe(40_000);
    creditCard(test.tree)();
    expect(test.stage.state.method).toBe('park-cash');
    expect(test.stage.state.amountSatang).toBe(5_000);
  });

  it('credit off and on with nothing chosen for the rest: card, as staging showed after the toggle', () => {
    const test = counter('shop', 350, { onPayment: false, useCredit: false, totalSatang: 50_000 });
    test.show({ onPayment: true });
    expect(test.stage.state.method).toBeNull();
    creditCard(test.tree)();
    expect(test.stage.state.method).toBe('park-card');
    expect(test.stage.state.amountSatang).toBe(15_000);
  });
});
