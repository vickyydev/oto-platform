import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALLET_TENDER_CODE, type PaymentAttemptView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import { spendWalletOnSale, type SaleFinaliseResult } from '@/api/sales';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * S2-14a round 2 — THE STATIONS' CREDIT, through the payment stage the F&B,
 * shop and phone order stations share (plan §2.3).
 *
 * The station hands the stage the scanned wallet; the confirm press spends it
 * FIRST through the platform (`spendWalletOnSale`) and only then tenders the
 * remainder — cash by default (OD-W3). A credit that covers the order closes
 * it with no tender at all; a refusal takes nothing and says why.
 */
vi.mock('react', () => import('./support/hooks'));
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

function creditAttempt(amountSatang: number): PaymentAttemptView {
  return {
    id: 'credit-attempt', saleId: 'sale-1', method: 'wallet', provider: 'manual', status: 'approved',
    amountSatang, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: null, tranRef: null, actionId: 'press:wallet', offline: false,
    paidAt: '2026-10-01T05:00:00.000Z', createdAt: '2026-10-01T05:00:00.000Z',
  };
}

function spent(amountSatang: number, outstandingSatang: number, balanceAfterSatang: number): SaleFinaliseResult {
  const closed = outstandingSatang === 0;
  return {
    sale: apiSale({ status: closed ? 'finalised' : 'tendering' }),
    replay: false,
    finalised: closed,
    outstandingSatang,
    walletAttempt: creditAttempt(amountSatang),
    walletSpend: { walletId: 'wallet-1', amountSatang, balanceAfterSatang },
  };
}

const outcome = (sale = apiSale(), extra: Partial<Extract<SaleWriteOutcome, { written: true }>> = {}): SaleWriteOutcome => ({
  ok: true, written: true, saleId: sale.id, sale, replay: false, ...extra,
});

function mount(balanceSatang: number, totalSatang = 54_000) {
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
  const prepareSale = vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome());
  const finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
    .mockResolvedValue(outcome(apiSale({ status: 'finalised' }), { finalised: true, outstandingSatang: 0 }));
  const onComplete = vi.fn<PaymentStageOptions['onComplete']>();
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang, prepareSale, finaliseSale, onComplete,
    wallet: { key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: true, previewSatang: balanceSatang },
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options, prepareSale, finaliseSale, onComplete };
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

describe('credit at the counter, through the payment stage', () => {
  it('credit covering the order: one press, no tender, the order closes — a ฿0-after-credit order needs no method', async () => {
    const test = mount(60_000);
    expect(test.result.current.creditCoversAll).toBe(true);
    expect(test.result.current.canSubmit).toBe(true);
    expect(test.result.current.display.creditSatang).toBe(54_000);
    spend.mockResolvedValueOnce(spent(54_000, 0, 6_000));
    await test.result.current.submit();
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0]![2]).toEqual({ key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: true });
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    const settlements = test.onComplete.mock.calls[0]![1];
    expect(settlements).toEqual([
      expect.objectContaining({ method: WALLET_TENDER_CODE, amountSatang: 54_000, walletBalanceAfterSatang: 6_000 }),
    ]);
  });

  it('credit short, cash chosen and enough handed over: the credit, then the cash remainder, in the same press', async () => {
    const test = mount(20_000);
    expect(test.result.current.creditCoversAll).toBe(false);
    test.result.current.selectMethod('park-cash');
    test.result.current.setAmountSatang(34_000);
    test.result.current.setTenderedSatang(40_000);
    spend.mockResolvedValueOnce(spent(20_000, 34_000, 0));
    await test.result.current.submit();
    expect(test.finaliseSale).toHaveBeenCalledTimes(1);
    expect(test.finaliseSale.mock.calls[0]![0]).toEqual({ method: 'park-cash', kind: 'cash', amountSatang: 34_000, tenderedSatang: 40_000, changeSatang: 6_000 });
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.result.current.state.creditSatang).toBe(20_000);
  });

  it('credit short with no method chosen: the stage stops on the remainder with CASH preselected (OD-W3)', async () => {
    const test = mount(20_000);
    spend.mockResolvedValueOnce(spent(20_000, 34_000, 0));
    // Nothing chosen: credit alone does not cover, so the press is not offered.
    expect(test.result.current.canSubmit).toBe(false);
    await test.result.current.submit();
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(test.result.current.state).toMatchObject({ phase: 'ready', outstandingSatang: 34_000, amountSatang: 34_000, tenderedSatang: 34_000, method: 'park-cash', kind: 'cash' });
    expect(test.result.current.creditPendingSatang).toBe(0);
    // The credit is taken once: the next press is the remainder only.
    await test.result.current.submit();
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('a refusal (the honest zero) takes nothing, tenders nothing and says why', async () => {
    const test = mount(5_000);
    test.result.current.selectMethod('park-cash');
    test.result.current.setAmountSatang(49_000);
    spend.mockRejectedValueOnce(new ApiError(409, 'WALLET_EMPTY', 'This wallet has ฿0 left — take the order in cash or card.'));
    await test.result.current.submit();
    expect(test.finaliseSale).not.toHaveBeenCalled();
    expect(test.onComplete).not.toHaveBeenCalled();
    expect(test.result.current.state).toMatchObject({ phase: 'failed', error: 'This wallet has ฿0 left — take the order in cash or card.' });
    expect(test.result.current.state.settlements).toEqual([]);
  });

  it('without a wallet the stage is exactly what it was: no credit, no spend', async () => {
    const test = mount(0);
    test.rerender({ ...test.options, wallet: null });
    expect(test.result.current.creditPendingSatang).toBe(0);
    expect(test.result.current.display.creditSatang).toBe(0);
    test.result.current.selectMethod('park-cash');
    await test.result.current.submit();
    expect(spend).not.toHaveBeenCalled();
    expect(test.finaliseSale).toHaveBeenCalledTimes(1);
  });
});
