import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { paymentsApi } from '@/api/payments';
import { HoldSaleButtons } from '@/components/till/HeldSales';
import { NumberKeypad } from '@/components/till/NumberKeypad';
import { PaymentTenderPanel } from '@/components/till/PaymentTenderPanel';
import { partPaidShown } from '@/lib/heldSales';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import {
  CASH_SHORT_REFUSAL,
  usePaymentStage,
  type PaymentStageController,
  type PaymentStageOptions,
} from '@/lib/usePaymentStage';
import { apiSale, settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-796 — THE PAYMENT AMOUNT IS THE AMOUNT DUE UNLESS STAFF CHOOSE
 * "PARTIAL PAYMENT". The till's tender panel (`PaymentTenderPanel`, on the
 * counter's till, the phone's, the restaurant and shop stations and History's
 * Add time) no longer asks for the amount: one tap on the tender takes the
 * whole balance, Cash received starts at it (exact cash), and only Partial
 * payment opens the amount field, filled with the amount due for staff to
 * reduce. Save as partly paid is offered only on a partial payment or once
 * part of the sale is paid.
 *
 * The stage and the panel run on the hook harness in place of React
 * (support/hooks.ts); the panel's tree is read as elements and pressed.
 */
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/lib/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/payments')>();
  const methods = [
    { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
    { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
    { id: 'park-qr', kind: 'qr' as const, label: 'PromptPay', enabled: true, sortOrder: 2 },
  ];
  return {
    ...actual,
    findPaymentMethod: (id: string) => methods.find((method) => method.id === id),
    getEnabledPaymentMethods: () => methods,
  };
});

beforeEach(() => {
  vi.stubGlobal('React', React);
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

type El = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function words(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
}
const byTestId = (tree: unknown, id: string) => elements(tree).find((el) => el.props['data-testid'] === id);
const byId = (tree: unknown, id: string) => elements(tree).find((el) => el.props.id === id);
const keypad = (tree: unknown) => elements(tree).find((el) => el.type === NumberKeypad);
const focus = (input: El) => (input.props.onFocus as (event: unknown) => void)({ currentTarget: { select: () => undefined } });

const written = (sale = apiSale(), extra: Partial<Extract<SaleWriteOutcome, { written: true }>> = {}): SaleWriteOutcome => ({
  ok: true, written: true, saleId: sale.id, sale, replay: false, ...extra,
});
const cashPart = (amountSatang: number): PaymentAttemptView => ({
  id: 'attempt-part', saleId: 'sale-1', method: 'cash', provider: 'manual', status: 'approved',
  amountSatang, tenderedSatang: amountSatang, changeSatang: 0, terminalRef: null, tid: null, approvalCode: null,
  last4: null, invoiceNo: null, tranRef: null, actionId: 'part', offline: false,
  paidAt: '2026-11-09T04:20:00.000Z', createdAt: '2026-11-09T04:20:00.000Z',
});

/** ฿540 owed (the fixture sale), on the stage and its panel, side by side as the till draws them. */
function mount() {
  const prepareSale = vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(written());
  const finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
    .mockResolvedValue(written(apiSale({ status: 'finalised' }), { finalised: true, outstandingSatang: 0 }));
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang: 54_000,
    prepareSale, finaliseSale, onComplete: vi.fn(),
  };
  const stage = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  const panel = renderHook((s: PaymentStageController) => PaymentTenderPanel({ stage: s, showSubmit: false }), stage.result.current);
  unmounts.push(stage.unmount, panel.unmount);
  /** The panel as it reads the stage now. */
  const view = () => { panel.rerender(stage.result.current); return panel.result.current; };
  return { stage: () => stage.result.current, view, prepareSale, finaliseSale };
}

describe('one tap on the tender takes the whole amount', () => {
  it('cash: no amount is asked for, Cash received is the amount due and the change is nothing', async () => {
    const t = mount();
    t.stage().selectMethod('park-cash');
    const tree = t.view();
    expect(byId(tree, 'payment-part-amount')).toBeUndefined();
    expect(words(byTestId(tree, 'payment-partial'))).toBe('Partial payment');
    expect(byId(tree, 'payment-cash-received')?.props.value).toBe('540.00');
    expect(words(tree)).toContain('Change ฿0.00');
    expect(keypad(tree)).toBeUndefined();
    expect(byTestId(tree, 'payment-cash-short')).toBeUndefined();
    expect(t.stage().state.partial).toBe(false);
    expect(t.stage().canSubmit).toBe(true);

    await t.stage().submit();
    expect(t.finaliseSale).toHaveBeenCalledTimes(1);
    expect(t.finaliseSale.mock.calls[0]![0]).toEqual({
      method: 'park-cash', kind: 'cash', amountSatang: 54_000, tenderedSatang: 54_000, changeSatang: 0,
    });
  });

  it.each([['park-card', 'card'], ['park-qr', 'qr']] as const)('%s: no amount field, and the press sends the whole balance', async (method, kind) => {
    const start = vi.spyOn(paymentsApi, 'start').mockResolvedValue({
      route: 'manual', attempt: null, outstandingSatang: 54_000, replayed: false,
      qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null,
    });
    const t = mount();
    t.stage().selectMethod(method);
    const tree = t.view();
    expect(byId(tree, 'payment-part-amount')).toBeUndefined();
    expect(byId(tree, 'payment-cash-received')).toBeUndefined();
    expect(byTestId(tree, 'payment-partial')).toBeDefined();
    expect(t.stage().canSubmit).toBe(true);

    await t.stage().submit();
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ saleId: 'sale-1', method, kind, amountSatang: 54_000 });
  });
});

describe('Partial payment opens the amount field', () => {
  it('fills it with the amount due, takes the part staff type, and the next tender starts at the balance', async () => {
    const t = mount();
    t.finaliseSale.mockResolvedValueOnce(written(apiSale(), { finalised: false, outstandingSatang: 24_000, attempt: cashPart(30_000) }));
    t.stage().selectMethod('park-cash');
    (byTestId(t.view(), 'payment-partial')!.props.onClick as () => void)();

    let tree = t.view();
    expect(t.stage().state.partial).toBe(true);
    expect(byTestId(tree, 'payment-partial')).toBeUndefined();
    expect(byId(tree, 'payment-part-amount')?.props.value).toBe('540.00');
    expect(words(byTestId(tree, 'payment-full-amount'))).toBe('Full amount');
    // The keypad opens on the amount, and its first key replaces the figure.
    expect(keypad(tree)?.props.value).toBe('');
    for (const next of ['3', '30', '300']) {
      (keypad(t.view())!.props.onChange as (value: string) => void)(next);
    }
    tree = t.view();
    expect(t.stage().state.amountSatang).toBe(30_000);
    // Cash received that matched the amount follows it: exact cash for the part.
    expect(t.stage().state.tenderedSatang).toBe(30_000);
    expect(byId(tree, 'payment-part-amount')?.props.value).toBe('300');
    expect(byId(tree, 'payment-cash-received')?.props.value).toBe('300.00');

    await t.stage().submit();
    expect(t.finaliseSale.mock.calls[0]![0]).toEqual({
      method: 'park-cash', kind: 'cash', amountSatang: 30_000, tenderedSatang: 30_000, changeSatang: 0,
    });
    // The part is recorded; the balance is owed and the next tender asks for it whole.
    expect(t.stage().state.outstandingSatang).toBe(24_000);
    expect(t.stage().state.settlements).toHaveLength(1);
    expect(t.stage().state.partial).toBe(false);
    expect(t.stage().state.amountSatang).toBe(24_000);
    t.stage().selectMethod('park-cash');
    tree = t.view();
    expect(words(tree)).toContain('Balance due ฿240.00');
    expect(byId(tree, 'payment-part-amount')).toBeUndefined();
    expect(byId(tree, 'payment-cash-received')?.props.value).toBe('240.00');
  });

  it('Full amount closes the field and puts the amount back to the balance', () => {
    const t = mount();
    t.stage().selectMethod('park-card');
    (byTestId(t.view(), 'payment-partial')!.props.onClick as () => void)();
    (byId(t.view(), 'payment-part-amount')!.props.onChange as (event: unknown) => void)({ target: { value: '100' } });
    expect(t.stage().state.amountSatang).toBe(10_000);

    (byTestId(t.view(), 'payment-full-amount')!.props.onClick as () => void)();
    const tree = t.view();
    expect(t.stage().state.partial).toBe(false);
    expect(t.stage().state.amountSatang).toBe(54_000);
    expect(byId(tree, 'payment-part-amount')).toBeUndefined();
    expect(keypad(tree)).toBeUndefined();
  });

  it('a stage whose amount is fixed is offered no part amount', () => {
    const t = mount();
    t.stage().selectMethod('park-cash');
    const fixed = renderHook((s: PaymentStageController) => PaymentTenderPanel({ stage: s, showSubmit: false, fixedAmount: true }), t.stage());
    unmounts.push(fixed.unmount);
    expect(byTestId(fixed.result.current, 'payment-partial')).toBeUndefined();
    expect(byId(fixed.result.current, 'payment-part-amount')).toBeUndefined();
  });
});

describe('Cash received', () => {
  it('the keypad types what the customer hands over, and the change is worked out as before', async () => {
    const t = mount();
    t.stage().selectMethod('park-cash');
    focus(byId(t.view(), 'payment-cash-received')!);
    let tree = t.view();
    // Tapping the field does not empty it: it still reads the amount due until a key is pressed.
    expect(byId(tree, 'payment-cash-received')?.props.value).toBe('540.00');
    expect(t.stage().state.tenderedSatang).toBe(54_000);
    expect(keypad(tree)?.props.value).toBe('');
    for (const next of ['1', '10', '100', '1000']) {
      (keypad(t.view())!.props.onChange as (value: string) => void)(next);
    }
    tree = t.view();
    expect(t.stage().state.tenderedSatang).toBe(100_000);
    expect(t.stage().state.amountSatang).toBe(54_000);
    expect(words(tree)).toContain('Change ฿460.00');
    expect(byTestId(tree, 'payment-cash-short')).toBeUndefined();

    await t.stage().submit();
    expect(t.finaliseSale.mock.calls[0]![0]).toEqual({
      method: 'park-cash', kind: 'cash', amountSatang: 54_000, tenderedSatang: 100_000, changeSatang: 46_000,
    });
  });

  it('typed on a keyboard, the figure is replaced as Playwright and staff type it', () => {
    const t = mount();
    t.stage().selectMethod('park-cash');
    const input = byId(t.view(), 'payment-cash-received')!;
    focus(input);
    (byId(t.view(), 'payment-cash-received')!.props.onChange as (event: unknown) => void)({ target: { value: '600.00' } });
    expect(t.stage().state.tenderedSatang).toBe(60_000);
    expect(words(t.view())).toContain('Change ฿60.00');
  });

  it('less than the amount due with no partial payment is refused, in the words the press already used', async () => {
    const t = mount();
    t.stage().selectMethod('park-cash');
    focus(byId(t.view(), 'payment-cash-received')!);
    for (const next of ['5', '50', '500']) {
      (keypad(t.view())!.props.onChange as (value: string) => void)(next);
    }
    const tree = t.view();
    expect(t.stage().state.tenderedSatang).toBe(50_000);
    expect(t.stage().canSubmit).toBe(false);
    expect(words(byTestId(tree, 'payment-cash-short'))).toBe(CASH_SHORT_REFUSAL);
    expect(CASH_SHORT_REFUSAL).toBe('Cash received must cover this payment.');
    expect(words(tree)).toContain('Change ฿0.00');

    await t.stage().submit();
    expect(t.finaliseSale).not.toHaveBeenCalled();
    expect(t.stage().state.error).toBe(CASH_SHORT_REFUSAL);
  });
});

describe('Save as partly paid shows on a partial payment only', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

  it('hidden on a whole-amount payment; shown once Partial payment is chosen or part of the sale is paid', () => {
    expect(partPaidShown(false, 0)).toBe(false);
    expect(partPaidShown(undefined, 0)).toBe(false);
    expect(partPaidShown(true, 0)).toBe(true);
    expect(partPaidShown(false, 20_000)).toBe(true);
  });

  it('Hold sale stays; Save as partly paid is left out when it is not offered', () => {
    const props = {
      holdReason: null,
      partPaidReason: 'Take a part payment first — nothing has been paid on this sale yet.',
      onHold: () => undefined,
      onSavePartPaid: () => undefined,
    };
    const hidden = renderToStaticMarkup(React.createElement(HoldSaleButtons, { ...props, showPartPaid: false }));
    expect(hidden).toContain('Hold sale');
    expect(hidden).not.toContain('Save as partly paid');
    expect(hidden).not.toContain('Take a part payment first');
    const shown = renderToStaticMarkup(React.createElement(HoldSaleButtons, { ...props, showPartPaid: true }));
    expect(shown).toContain('Save as partly paid');
    expect(shown).toContain('Take a part payment first — nothing has been paid on this sale yet.');
  });

  it('the counter’s till and the phone’s till both ask the stage whether staff chose a partial payment', () => {
    for (const file of ['pages/Till.tsx', 'components/mobile/MobileTill.tsx']) {
      expect(src(file), file).toContain('showPartPaid={partPaidShown(paymentStage.state.partial, paidOnScreen)}');
    }
  });

  it('the stage turns partial on and off, and every fresh tender starts with it off', async () => {
    const t = mount();
    expect(t.stage().state.partial).toBe(false);
    t.stage().selectMethod('park-cash');
    t.stage().setPartial?.(true);
    expect(t.stage().state.partial).toBe(true);
    expect(t.stage().state.amountSatang).toBe(54_000);
    t.stage().setAmountSatang(20_000);
    t.stage().setPartial?.(false);
    expect(t.stage().state).toMatchObject({ partial: false, amountSatang: 54_000, tenderedSatang: 54_000 });
    t.stage().setPartial?.(true);
    t.stage().setAmountSatang(20_000);
    t.finaliseSale.mockResolvedValueOnce(written(apiSale(), { finalised: false, outstandingSatang: 34_000, attempt: cashPart(20_000) }));
    await t.stage().submit();
    expect(t.stage().state).toMatchObject({ partial: false, outstandingSatang: 34_000, amountSatang: 34_000 });
  });
});
