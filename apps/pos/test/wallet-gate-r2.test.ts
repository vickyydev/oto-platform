import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOX_LANE_REFUSALS, DisplayPaymentSchema } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { NetworkError } from '@/api/client';
import { spendWalletOnSale } from '@/api/sales';
import { laneSale } from '@/api/boxSales';
import { currentLane } from '@/lib/lane';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * S2-14a round 2 — the FOCUSED GATE's reproductions on the till (invariants
 * 5 and 6), kept. Each was an `it.fails` while the defect stood; both are
 * fixed and now pin the behaviour:
 *
 *   R2-G1  the separate customer display (the production device, CLAUDE.md §7
 *          rule 4) never receives the credit the stage is taking: the wire
 *          schema strips `creditSatang`, so "From your credit / Left to pay"
 *          only ever shows on the in-till harness;
 *   R2-G2  a sale rung up on the BOX lane is still sent to the platform's
 *          wallet spend: offline, the press blocks with "Check again", the
 *          credit card cannot be taken off (the stage is locked) and Back is
 *          disabled — the counter is stuck on the order instead of being told
 *          "credit is online only" and taking cash.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, spendWalletOnSale: vi.fn() };
});
vi.mock('@/api/boxSales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/boxSales')>();
  return { ...actual, laneSale: vi.fn() };
});
vi.mock('@/lib/lane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane')>();
  return { ...actual, currentLane: vi.fn(() => 'platform' as const) };
});

const spend = vi.mocked(spendWalletOnSale);
const onBox = vi.mocked(laneSale);
const lane = vi.mocked(currentLane);
const unmounts: (() => void)[] = [];
const METHODS = [{ id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 }];

beforeEach(() => { vi.resetAllMocks(); lane.mockReturnValue('platform'); });
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.restoreAllMocks();
});

describe('R2-G1 — the separate customer display', () => {
  it('carries the credit the stage is taking, so the real display can say "From your credit"', () => {
    const parsed = DisplayPaymentSchema.parse({
      saleId: null, amountSatang: 4_000, qrPayload: null, qrImageUrl: null, expiresAt: null,
      status: 'idle', offline: false, online: true, creditSatang: 5_000,
    });
    expect((parsed as { creditSatang?: number }).creditSatang).toBe(5_000);
  });
});

describe('R2-G2 — credit on a box-lane sale', () => {
  it('is refused on the till without calling the platform, and the counter can still take cash', async () => {
    vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
    vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
    const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: 9_000 } });
    // The sale this cart was rung up as lives on the box (the lane arbiter moved the till).
    onBox.mockImplementation((id) => (id === sale.id ? ({ id } as unknown as ReturnType<typeof laneSale>) : null));
    spend.mockRejectedValue(new NetworkError());
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
    hook.result.current.selectMethod('park-cash');
    await hook.result.current.submit();
    expect(spend).not.toHaveBeenCalled();
    // Was: blocked, locked, no Back — the credit card could not be taken off.
    expect(hook.result.current.state.phase).not.toBe('blocked');
    expect(hook.result.current.locked).toBe(false);
    expect(hook.result.current.canBack).toBe(true);
    // The lane's own words, cash preselected on the WHOLE amount, no credit pending.
    expect(hook.result.current.state).toMatchObject({ phase: 'failed', error: BOX_LANE_REFUSALS.wallet.message, retryable: false,
      method: 'park-cash', kind: 'cash', amountSatang: 9_000, tenderedSatang: 9_000, settlements: [] });
    expect(hook.result.current.creditRefusal).toBe(BOX_LANE_REFUSALS.wallet.message);
    expect(hook.result.current.creditPendingSatang).toBe(0);
    expect(hook.result.current.creditCoversAll).toBe(false);
    expect(hook.result.current.display.creditSatang).toBe(0);
    // Credit off, cash on: the press closes the sale on the lane it was rung up on.
    options.finaliseSale = vi.fn<PaymentStageOptions['finaliseSale']>()
      .mockResolvedValue({ ok: true, written: true, saleId: sale.id, sale: { ...sale, status: 'finalised' }, replay: false, finalised: true, outstandingSatang: 0 });
    hook.rerender({ ...options, wallet: { ...options.wallet!, useCredit: false } });
    expect(hook.result.current.canSubmit).toBe(true);
    await hook.result.current.submit();
    expect(spend).not.toHaveBeenCalled();
    expect(options.finaliseSale).toHaveBeenCalledTimes(1);
    expect(vi.mocked(options.finaliseSale).mock.calls[0]![0]).toMatchObject({ kind: 'cash', amountSatang: 9_000, tenderedSatang: 9_000 });
    expect(options.onComplete).toHaveBeenCalledTimes(1);
  });

  it('a sale rung up on the platform by a till that has since moved to its box is refused the same way', async () => {
    vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
    vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
    const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: 9_000 } });
    onBox.mockImplementation((id) => (id === sale.id ? ({ id, lane: 'platform' } as unknown as ReturnType<typeof laneSale>) : null));
    lane.mockReturnValue('box');
    const options: PaymentStageOptions = {
      scope: 'current', isCurrentScope: (s) => s === 'current', totalSatang: 9_000,
      prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue({ ok: true, written: true, saleId: sale.id, sale, replay: false }),
      finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>(),
      onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
      wallet: { key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: true, previewSatang: 50_000 },
    };
    const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
    unmounts.push(hook.unmount);
    expect(hook.result.current.creditCoversAll).toBe(true);
    await hook.result.current.submit();
    expect(spend).not.toHaveBeenCalled();
    expect(hook.result.current.state).toMatchObject({ phase: 'failed', error: BOX_LANE_REFUSALS.wallet.message, method: 'park-cash' });
    expect(hook.result.current.locked).toBe(false);
  });

  it('a sale the box does not hold, on the platform lane, still spends through the platform', async () => {
    vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
    vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
    const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: 9_000 } });
    onBox.mockReturnValue(null);
    lane.mockReturnValue('platform');
    spend.mockResolvedValue({ sale: { ...sale, status: 'finalised' }, replay: false, finalised: true, outstandingSatang: 0,
      walletAttempt: null, walletSpend: { walletId: 'w', amountSatang: 9_000, balanceAfterSatang: 41_000 } });
    const options: PaymentStageOptions = {
      scope: 'current', isCurrentScope: (s) => s === 'current', totalSatang: 9_000,
      prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue({ ok: true, written: true, saleId: sale.id, sale, replay: false }),
      finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>(),
      onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
      wallet: { key: 'QR-ABCDEFGHJKMNPQRSTVWX', useCredit: true, previewSatang: 50_000 },
    };
    const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
    unmounts.push(hook.unmount);
    await hook.result.current.submit();
    expect(spend).toHaveBeenCalledTimes(1);
    expect(hook.result.current.creditRefusal).toBeNull();
    expect(options.onComplete).toHaveBeenCalledTimes(1);
  });
});
