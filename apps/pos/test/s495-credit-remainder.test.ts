import * as ReactModule from 'react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook, type RenderedHook } from './support/hooks';
import * as salesModule from '@/api/sales';
import { FnbPayment } from '@/components/fnb/FnbPayment';
import { NumberKeypad } from '@/components/till/NumberKeypad';
import { PaymentTenderPanel, paymentSubmitLabel } from '@/components/till/PaymentTenderPanel';
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
function counter(kind: Counter, balanceTHB: number, start: StationProps, finalise?: PaymentStageOptions['finaliseSale']) {
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
      finaliseSale: finalise ?? (async () => outcome(p.totalSatang)),
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
/** The method card below the credit card (the prototype's PayMethodRow). */
const methodCard = (tree: ReactElement, id: string) => {
  const card = elements(tree).find((el) => el.type !== 'button' && el.key === id && el.props.role === 'button');
  if (!card) throw new Error(`no method card for ${id}`);
  return {
    click: card.props.onClick as () => void,
    press: card.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void,
  };
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

  it('a method card chosen while credit is on is the rest; credit off keeps it for the whole amount', () => {
    const test = counter('F&B phone', 350, { onPayment: false, useCredit: true, totalSatang: 40_000 });
    test.show({ onPayment: true });
    expect(test.stage.state.method).toBe('park-card');

    methodCard(test.tree, 'park-qr').click();
    expect(test.stage.state.method).toBe('park-qr');
    expect(test.stage.state.amountSatang).toBe(5_000);

    // Credit off: nothing re-picked, the whole amount on what staff chose.
    creditCard(test.tree)();
    expect(test.stage.state.method).toBe('park-qr');
    expect(test.stage.state.amountSatang).toBe(40_000);
    // Credit on again: the rest is still that choice.
    creditCard(test.tree)();
    expect(test.stage.state.method).toBe('park-qr');
    expect(test.stage.state.amountSatang).toBe(5_000);
  });

  it('a method chosen for the whole amount with credit off leaves the rest on the earlier choice (payRemainder)', () => {
    const test = counter('shop', 350, { onPayment: false, useCredit: true, totalSatang: 50_000 });
    test.show({ onPayment: true });
    remainderButton(test.tree, 'park-cash')({ stopPropagation: () => undefined });
    expect(test.stage.state.method).toBe('park-cash');

    creditCard(test.tree)();
    methodCard(test.tree, 'park-qr').press({ key: 'Enter', preventDefault: () => undefined });
    expect(test.stage.state.method).toBe('park-qr');
    expect(test.stage.state.amountSatang).toBe(50_000);
    expect(paymentSubmitLabel(test.stage)).toBe('Show payment QR');

    // The prototype changes payRemainder only from the buttons under credit.
    creditCard(test.tree)();
    expect(test.stage.state.method).toBe('park-cash');
    expect(test.stage.state.amountSatang).toBe(15_000);
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

/**
 * SCRUM-796 — A PART PAID AFTER CREDIT IS THE PART STAFF TYPED. With the
 * customer's credit selected the screen keeps the tender on the rest after
 * credit; once staff choose Partial payment the figure they type is the
 * payment, and the press takes the credit first and then that part, leaving
 * the balance owed. Full amount puts the payment back to the rest after credit.
 */
describe('a partial payment after credit on the restaurant and shop counters', () => {
  const cashAttempt = (amountSatang: number): PaymentAttemptView => ({
    id: 'attempt-cash-part', saleId: 'sale-1', method: 'cash', provider: 'manual', status: 'approved',
    amountSatang, tenderedSatang: amountSatang, changeSatang: 0, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: null, tranRef: null, actionId: 'press:cash', offline: false,
    paidAt: '2026-11-09T05:00:00.000Z', createdAt: '2026-11-09T05:00:00.000Z',
  });
  const creditAttempt = (amountSatang: number): PaymentAttemptView => ({
    ...cashAttempt(amountSatang), id: 'attempt-credit', method: 'wallet', tenderedSatang: null, changeSatang: null, actionId: 'press:wallet',
  });
  const byTestId = (tree: ReactNode, id: string) => elements(tree).find((el) => el.props['data-testid'] === id);
  const byId = (tree: ReactNode, id: string) => elements(tree).find((el) => el.props.id === id);
  const keypad = (tree: ReactNode) => elements(tree).find((el) => el.type === NumberKeypad);

  /** The counter with its tender panel drawn beside it, as FnbPayment draws it. */
  function counterWithPanel(kind: Counter, totalSatang: number, finalise?: PaymentStageOptions['finaliseSale']) {
    const test = counter(kind, 350, { onPayment: false, useCredit: true, totalSatang }, finalise);
    test.show({ onPayment: true });
    const panel = renderHook((s: PaymentStageController) => PaymentTenderPanel({ stage: s, showSubmit: false }), test.stage);
    unmounts.push(panel.unmount);
    const view = () => { panel.rerender(test.stage); return panel.result.current as ReactNode; };
    return { test, view };
  }

  for (const [kind, totalSatang, typed, partSatang] of [
    ['F&B counter', 40_000, ['2', '20'], 2_000],
    ['F&B phone', 40_000, ['2', '20'], 2_000],
    ['shop', 50_000, ['5', '50'], 5_000],
  ] as const) {
    const restSatang = totalSatang - 35_000;
    it(`${kind}: ฿350 credit on a ฿${totalSatang / 100} order, cash for the rest, a ฿${partSatang / 100} part typed — that part is taken`, async () => {
      const spend = vi.spyOn(salesModule, 'spendWalletOnSale').mockResolvedValue({
        sale: apiSale(), replay: false, finalised: false, outstandingSatang: restSatang,
        walletAttempt: creditAttempt(35_000), walletSpend: { walletId: 'wallet-1', amountSatang: 35_000, balanceAfterSatang: 0 },
      });
      const finalise = vi.fn<PaymentStageOptions['finaliseSale']>().mockImplementation(async () => {
        const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: totalSatang } });
        return { ok: true, written: true, saleId: sale.id, sale, replay: false, finalised: false,
          outstandingSatang: restSatang - partSatang, attempt: cashAttempt(partSatang) };
      });
      const { test, view } = counterWithPanel(kind, totalSatang, finalise);
      remainderButton(test.tree, 'park-cash')({ stopPropagation: () => undefined });
      expect(test.stage.state.amountSatang).toBe(restSatang);

      (byTestId(view(), 'payment-partial')!.props.onClick as () => void)();
      for (const next of typed) (keypad(view())!.props.onChange as (value: string) => void)(next);
      test.show({});
      const tree = view();
      expect(test.stage.state.partial).toBe(true);
      expect(test.stage.state.amountSatang).toBe(partSatang);
      expect(test.stage.state.tenderedSatang).toBe(partSatang);
      expect(byId(tree, 'payment-part-amount')?.props.value).toBe(typed[typed.length - 1]);
      expect(byId(tree, 'payment-cash-received')?.props.value).toBe((partSatang / 100).toFixed(2));
      expect(test.stage.canSubmit).toBe(true);

      await test.stage.submit();
      expect(spend).toHaveBeenCalledTimes(1);
      expect(finalise).toHaveBeenCalledTimes(1);
      expect(finalise.mock.calls[0]![0]).toEqual({
        method: 'park-cash', kind: 'cash', amountSatang: partSatang, tenderedSatang: partSatang, changeSatang: 0,
      });
      // Credit and the part are recorded; the sale stays open on the balance.
      expect(test.stage.state.phase).toBe('ready');
      expect(test.stage.state.outstandingSatang).toBe(restSatang - partSatang);
      expect(test.stage.state.settlements.map((part) => part.amountSatang)).toEqual([35_000, partSatang]);
      expect(test.stage.state.partial).toBe(false);
      expect(test.stage.state.amountSatang).toBe(restSatang - partSatang);
    });

    it(`${kind}: Full amount after a typed part puts the payment back to the rest after credit`, () => {
      const { test, view } = counterWithPanel(kind, totalSatang);
      remainderButton(test.tree, 'park-cash')({ stopPropagation: () => undefined });
      (byTestId(view(), 'payment-partial')!.props.onClick as () => void)();
      for (const next of typed) (keypad(view())!.props.onChange as (value: string) => void)(next);
      expect(test.stage.state.amountSatang).toBe(partSatang);

      (byTestId(view(), 'payment-full-amount')!.props.onClick as () => void)();
      test.show({});
      expect(test.stage.state.partial).toBe(false);
      expect(test.stage.state.amountSatang).toBe(restSatang);
      expect(test.stage.state.tenderedSatang).toBe(restSatang);
      expect(byId(view(), 'payment-part-amount')).toBeUndefined();
    });
  }
});
