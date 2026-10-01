import * as ReactModule from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import { spendWalletOnSale } from '@/api/sales';
import { FnbPayment } from '@/components/fnb/FnbPayment';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * S2-14a round 3 — the prescribed till fix (c): after the platform refuses a
 * credit press (`WALLET_EMPTY`, `WALLET_INSUFFICIENT`, `WALLET_EXPIRED`) the
 * credit toggle comes OFF, exactly as the box lane's refusal takes it off —
 * the whole amount owed, CASH preselected (OD-W3), the platform's words on
 * the card — so the next press takes the money instead of asking the wallet
 * again. Every refusal counts, so a second refusal in the same words still
 * takes the toggle off.
 */
// The hooks harness in place of React's hooks; the rest of React (forwardRef
// for the UI kit the card imports) stays real — nothing here is rendered.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const hooks = await import('./support/hooks');
  return { ...actual, default: actual, ...hooks };
});
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, spendWalletOnSale: vi.fn() };
});

const spend = vi.mocked(spendWalletOnSale);
const unmounts: (() => void)[] = [];
const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
];
const outcome = (sale = apiSale(), extra: Partial<Extract<SaleWriteOutcome, { written: true }>> = {}): SaleWriteOutcome => ({
  ok: true, written: true, saleId: sale.id, sale, replay: false, ...extra,
});

function mount(totalSatang = 9_000) {
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
  const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: totalSatang } });
  const finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
    .mockResolvedValue(outcome(apiSale({ status: 'finalised' }), { finalised: true, outstandingSatang: 0 }));
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (s) => s === 'current', totalSatang,
    prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome(sale)),
    finaliseSale,
    onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
    wallet: { key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: true, previewSatang: 5_000 },
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options, finaliseSale };
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

describe('a platform refusal of the credit press', () => {
  for (const [code, message] of [
    ['WALLET_EMPTY', 'This wallet has ฿0 left — take the order in cash or card.'],
    ['WALLET_INSUFFICIENT', 'This wallet has ฿20 left, not ฿50.'],
    ['WALLET_EXPIRED', "This wallet's credit has expired (฿50) — only a manager can bring it back. Take the order in cash or card."],
  ] as const) {
    it(`${code}: nothing taken, the platform's words, the whole amount owed in cash`, async () => {
      const test = mount();
      spend.mockRejectedValueOnce(new ApiError(409, code, message));
      await test.result.current.submit();
      const { state } = test.result.current;
      expect(state).toMatchObject({ phase: 'failed', error: message, method: 'park-cash', kind: 'cash', amountSatang: 9_000, tenderedSatang: 9_000 });
      expect(state.creditRefusalSeq).toBe(1);
      expect(state.settlements).toEqual([]);
      expect(state.creditSatang).toBe(0);
      expect(test.result.current.creditRefusal).toBe(message);
      expect(test.result.current.creditPendingSatang).toBe(0);
      expect(test.result.current.display.creditSatang).toBe(0);
      expect(test.finaliseSale).not.toHaveBeenCalled();

      // The station took the toggle off: the next press takes the cash, and the wallet is not asked again.
      test.rerender({ ...test.options, wallet: { ...test.options.wallet!, useCredit: false } });
      await test.result.current.submit();
      expect(spend).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale).toHaveBeenCalledTimes(1);
      expect(test.finaliseSale.mock.calls[0]![0]).toMatchObject({ method: 'park-cash', kind: 'cash', amountSatang: 9_000 });
    });
  }

  it('a second refusal in the same words counts again', async () => {
    const test = mount();
    spend.mockRejectedValue(new ApiError(409, 'WALLET_EMPTY', 'This wallet has ฿0 left — take the order in cash or card.'));
    await test.result.current.submit();
    expect(test.result.current.state.creditRefusalSeq).toBe(1);
    await test.result.current.submit();
    expect(test.result.current.state.creditRefusalSeq).toBe(2);
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it('any other failure is not a refusal: the toggle is left alone', async () => {
    const test = mount();
    spend.mockRejectedValueOnce(new ApiError(404, 'WALLET_NOT_FOUND', 'No wallet carries that band or voucher — check the code and scan again.'));
    await test.result.current.submit();
    expect(test.result.current.state.creditRefusalSeq).toBe(0);
    expect(test.result.current.creditRefusal).toBeNull();
  });
});

describe('the F&B credit card takes the toggle off on every refusal', () => {
  function stageWith(creditRefusal: string | null, seq: number) {
    return {
      state: { phase: 'failed', saleId: 'sale-1', method: 'park-cash', kind: 'cash', outstandingSatang: 9_000, amountSatang: 9_000, tenderedSatang: 9_000,
        attempt: null, route: null, qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
        error: creditRefusal, retryable: false, settlements: [], creditSatang: 0, creditSaleId: null,
        creditRefusedSaleId: creditRefusal ? 'sale-1' : null, creditRefusalMessage: creditRefusal, creditRefusalSeq: seq },
      display: { saleId: 'sale-1', amountSatang: 9_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'failed', offline: false, online: true, creditSatang: 0 },
      busy: false, online: true, locked: false, canBack: true, canSubmit: true, creditCoversAll: false, creditPendingSatang: 0,
      creditRefusal, canInquire: false, canConfirm: false,
      selectMethod: vi.fn(), setAmountSatang: vi.fn(), setTenderedSatang: vi.fn(),
      submit: async () => undefined, retry: async () => undefined, inquire: async () => undefined, confirm: async () => undefined, manual: async () => undefined,
    } as unknown as ReturnType<typeof usePaymentStage>;
  }

  it('off on the first refusal, and off again when staff put it back and are refused in the same words', () => {
    // The card's markup is compiled to React.createElement; it is built, never rendered.
    vi.stubGlobal('React', ReactModule);
    vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
    const onUseCreditChange = vi.fn<(useCredit: boolean) => void>();
    const words = 'This wallet has ฿0 left — take the order in cash or card.';
    const props = (stage: ReturnType<typeof usePaymentStage>) => ({
      total: 90, wristband: null, pickupCode: '', stage, onBack: () => undefined, useCredit: true, onUseCreditChange, creditBalanceOverride: 50,
    });
    const first = stageWith(words, 1);
    const hook = renderHook((p: ReturnType<typeof props>) => { FnbPayment(p); }, props(first));
    unmounts.push(hook.unmount);
    expect(onUseCreditChange).toHaveBeenCalledTimes(1);
    expect(onUseCreditChange).toHaveBeenLastCalledWith(false);
    expect(first.setAmountSatang).toHaveBeenCalledWith(9_000);

    // Toggle back on, refused again in the same words: the count moves, the toggle comes off again.
    hook.rerender(props(stageWith(words, 2)));
    expect(onUseCreditChange).toHaveBeenCalledTimes(2);
    // Nothing new: nothing happens.
    hook.rerender(props(stageWith(words, 2)));
    expect(onUseCreditChange).toHaveBeenCalledTimes(2);
  });
});
