import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALLET_TENDER_CODE, type PaymentAttemptView } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { NetworkError } from '@/api/client';
import { spendWalletOnSale, type SaleFinaliseResult } from '@/api/sales';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * S2-14a round 2 — the RE-CHECK gate's till reproductions (invariant 6).
 *
 * A credit press whose answer is lost (the platform committed the spend, the
 * till saw a NetworkError) is retried with the SAME wallet action, and the
 * platform answers it as a replay: `walletAttempt` is the attempt it wrote,
 * `walletSpend` is null (nothing new was taken). The till must still count the
 * credit it holds the attempt for — the settlement, the "฿X taken from credit"
 * line and the display's "From your credit" row all read the same figure.
 *
 * FIXED in round 3 (was it.fails): the stage added `walletSpend.amountSatang` (null on a
 * replay) to `creditSatang`, so after the retry the till card reads "applies
 * ฿40" instead of "฿50 taken from credit" and the guest display drops its
 * "From your credit" row, while the settlement and the receipt are right.
 * Fix: count `walletAttempt.amountSatang` when the attempt is newly settled.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, spendWalletOnSale: vi.fn() };
});

const spend = vi.mocked(spendWalletOnSale);
const unmounts: (() => void)[] = [];
const METHODS = [{ id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 }];

function creditAttempt(amountSatang: number): PaymentAttemptView {
  return {
    id: 'credit-attempt', saleId: 'sale-1', method: 'wallet', provider: 'manual', status: 'approved',
    amountSatang, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: null, tranRef: null, actionId: 'press:wallet', offline: false,
    paidAt: '2026-10-01T05:00:00.000Z', createdAt: '2026-10-01T05:00:00.000Z',
  };
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

describe('a credit press retried after a lost answer', () => {
  it('counts the credit the replay names — the till and the display agree with the settlement', async () => {
    vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
    vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
    const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: 9_000 } });
    const outcome: SaleWriteOutcome = { ok: true, written: true, saleId: sale.id, sale, replay: false };
    const options: PaymentStageOptions = {
      scope: 'current', isCurrentScope: (s) => s === 'current', totalSatang: 9_000,
      prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome),
      finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>(),
      onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
      wallet: { key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: true, previewSatang: 5_000 },
    };
    const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
    unmounts.push(hook.unmount);

    // The spend committed on the platform; the answer never reached the till.
    spend.mockRejectedValueOnce(new NetworkError());
    await hook.result.current.submit();
    expect(hook.result.current.state).toMatchObject({ phase: 'blocked', retryable: true });

    // "Check again": the same wallet action, answered as a replay.
    const replay: SaleFinaliseResult = {
      sale: { ...sale, status: 'tendering' }, replay: true, finalised: false, outstandingSatang: 4_000,
      walletAttempt: creditAttempt(5_000), walletSpend: null,
    };
    spend.mockResolvedValueOnce(replay);
    await hook.result.current.retry();
    expect(spend).toHaveBeenCalledTimes(2);
    expect(spend.mock.calls[0]![1]).toBe(spend.mock.calls[1]![1]);

    // The settlement holds the credit attempt…
    expect(hook.result.current.state.settlements).toEqual([
      expect.objectContaining({ attemptId: 'credit-attempt', method: WALLET_TENDER_CODE, amountSatang: 5_000 }),
    ]);
    expect(hook.result.current.state.outstandingSatang).toBe(4_000);
    // …and so must the stage's credit figure and the guest display's row.
    expect(hook.result.current.state.creditSatang).toBe(5_000);
    expect(hook.result.current.display.creditSatang).toBe(5_000);
  });
});
