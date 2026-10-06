import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_WALLET_INTENTS,
  type BridgeSaleView,
  type BridgeWalletSpendAnswer,
  type PaymentAttemptView,
} from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { bridgeApi } from '@/api/bridge';
import { forgetLaneSale, holdLaneSale } from '@/api/boxSales';
import { paymentsApi } from '@/api/payments';
import { spendWalletOnSale, type ApiSale } from '@/api/sales';
import { currentLane } from '@/lib/lane';
import * as paymentMethods from '@/lib/payments';
import { SPLIT_CREDIT_OFFLINE_REFUSAL, usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * GATE — staging fix round (F3, the offline seam).
 *
 * The box's `payment.wallet` prices the credit against the WHOLE cart it
 * re-prices (`sale.gross`); it knows nothing of money the platform already took
 * on a sale rung up there. Before F3 a platform-rung split could never be closed
 * on the box (its cash press is refused `split`); F3 routes the CREDIT press of
 * such a sale to the box once the till's lane is the box, and the box's answer
 * then owes the order less the credit — not the order less the credit AND the
 * platform's card — so the stage asks for the platform's part a second time.
 *
 *   order ฿600 · card ฿300 on the platform · link drops · credit ฿300 on the
 *   box · the box says ฿300 still owed · cash ฿300 → the guest pays ฿900.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, spendWalletOnSale: vi.fn() };
});
vi.mock('@/lib/lane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane')>();
  return { ...actual, currentLane: vi.fn(() => 'platform' as const) };
});

const lane = vi.mocked(currentLane);
const platformSpend = vi.mocked(spendWalletOnSale);
const unmounts: (() => void)[] = [];
const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
];
const KEY = 'QR-MRKD90Z65F1ESEQMVSPV';

beforeEach(() => {
  vi.resetAllMocks();
  lane.mockReturnValue('platform');
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  forgetLaneSale(apiSale().id);
  vi.restoreAllMocks();
});

const at = '2026-10-01T18:12:17.162Z';
function attempt(saleId: string, method: PaymentAttemptView['method'], amountSatang: number, offline: boolean): PaymentAttemptView {
  return {
    id: `${method}-attempt`, saleId, method, provider: 'manual', status: 'approved', amountSatang,
    tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null, last4: null,
    invoiceNo: null, tranRef: null, actionId: `${method}-press`, offline, paidAt: at, createdAt: at,
  };
}
const boxView = (sale: ApiSale): BridgeSaleView => ({
  id: sale.id, status: 'tendering', businessDate: sale.businessDate, occurredAt: sale.occurredAt,
  receiptNumber: null, receiptSeries: null, receiptSeq: null, stationId: 'station-1', boxId: 'box-1',
  pricingMode: 'weekday', customerTier: 'tourist', totals: sale.totals, engineVersion: 'test', origin: 'box',
});

describe('GATE F3 — a platform split never has its credit priced by the box', () => {
  it('card ฿300 on the platform, then the link drops: credit is not asked of the box, and the guest is never charged past the order', async () => {
    const GROSS = 60_000;
    const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: GROSS } });
    // Rung up on the platform, online.
    holdLaneSale({
      stationId: 'station-1', saleId: sale.id, actionId: 'pay-press-1', occurredAt: sale.occurredAt,
      cart: { channel: 'fnb', expectedTotalSatang: GROSS } as never, visitId: null, note: null, lane: 'platform',
    });
    const outcome: SaleWriteOutcome = { ok: true, written: true, saleId: sale.id, sale, replay: false };
    const options: PaymentStageOptions = {
      scope: 'current', isCurrentScope: (s) => s === 'current', totalSatang: GROSS,
      prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome),
      finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>().mockResolvedValue({
        ...outcome, sale: { ...sale, status: 'finalised' }, finalised: true, outstandingSatang: 0,
      }),
      onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
      wallet: null,
    };
    const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
    unmounts.push(hook.unmount);

    // 1. Half on a card, on the platform, online.
    vi.spyOn(paymentsApi, 'start').mockResolvedValue({
      route: 'card_terminal', attempt: attempt(sale.id, 'card', 30_000, false), replayed: false,
      outstandingSatang: 30_000, qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null,
    });
    hook.result.current.selectMethod('park-card');
    hook.result.current.setAmountSatang(30_000);
    await hook.result.current.submit();
    expect(hook.result.current.state).toMatchObject({ phase: 'ready', outstandingSatang: 30_000 });
    expect(hook.result.current.state.settlements.map((s) => s.amountSatang)).toEqual([30_000]);

    // 2. The link drops; the guest's band holds ฿300 the box will spend; credit for the rest.
    lane.mockReturnValue('box');
    const intent = vi.spyOn(bridgeApi, 'intent').mockImplementation(async (_station, type, payload) => {
      if (type !== BRIDGE_WALLET_INTENTS.spend) throw new Error(`unexpected intent ${type}`);
      // The box's own rule: min(spendable here, what the order — as IT prices it — owes).
      const credit = Math.min(30_000, GROSS);
      const result: BridgeWalletSpendAnswer = {
        sale: boxView(sale), finalised: false, outstandingSatang: GROSS - credit, attempt: null, replay: false,
        printing: { jobs: [], notes: [] }, drawer: 'not_asked', outboxDepth: 1,
        walletSpend: { walletId: 'wallet-1', amountSatang: credit, balanceAfterSatang: 0, capLeftSatang: 0, offline: true },
        walletAttempt: { ...attempt(sale.id, 'wallet', credit, true), actionId: (payload.wallet as { actionId: string }).actionId },
      };
      return { document: {} as never, result };
    });
    hook.rerender({ ...options, wallet: { key: KEY, useCredit: true, previewSatang: 30_000 } });
    hook.result.current.selectMethod('park-cash');
    hook.result.current.setAmountSatang(0);
    hook.result.current.setTenderedSatang(0);
    await hook.result.current.submit();

    expect(platformSpend).not.toHaveBeenCalled();
    // The box would price this credit against the whole ฿600 order.
    expect(intent.mock.calls.filter((c) => c[1] === BRIDGE_WALLET_INTENTS.spend)).toHaveLength(0);
    // However it is refused, the money asked of the guest never passes the order.
    const settled = hook.result.current.state.settlements.reduce((sum, s) => sum + s.amountSatang, 0);
    const owedNow = hook.result.current.state.outstandingSatang;
    expect(settled + owedNow).toBeLessThanOrEqual(GROSS);
    // Refused in the till's words, nothing locked, cash preselected on the remainder.
    expect(hook.result.current.state).toMatchObject({ phase: 'failed', error: SPLIT_CREDIT_OFFLINE_REFUSAL, retryable: false,
      method: 'park-cash', kind: 'cash', outstandingSatang: 30_000, amountSatang: 30_000, tenderedSatang: 30_000, creditSatang: 0 });
    expect(hook.result.current.creditRefusal).toBe(SPLIT_CREDIT_OFFLINE_REFUSAL);
    expect(hook.result.current.locked).toBe(false);
    expect(hook.result.current.creditPendingSatang).toBe(0);
    // The guest screen owes the real remainder, with no credit line.
    expect(hook.result.current.display).toMatchObject({ amountSatang: 30_000, creditSatang: 0 });
    expect(finaliseCalls(options)).toBe(0);

    // Credit off, cash on: the press asks for the remainder only, once.
    hook.rerender({ ...options, wallet: { key: KEY, useCredit: false, previewSatang: 30_000 } });
    expect(hook.result.current.canSubmit).toBe(true);
    await hook.result.current.submit();
    expect(intent).not.toHaveBeenCalled();
    expect(finaliseCalls(options)).toBe(1);
    expect(vi.mocked(options.finaliseSale).mock.calls[0]![0]).toMatchObject({ kind: 'cash', amountSatang: 30_000 });
    expect(options.onComplete).toHaveBeenCalledTimes(1);
  });

  it('a second credit press on the same part-paid sale is refused again, still without a call', async () => {
    const GROSS = 60_000;
    const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: GROSS } });
    holdLaneSale({
      stationId: 'station-1', saleId: sale.id, actionId: 'pay-press-1', occurredAt: sale.occurredAt,
      cart: { channel: 'fnb', expectedTotalSatang: GROSS } as never, visitId: null, note: null, lane: 'platform',
    });
    const outcome: SaleWriteOutcome = { ok: true, written: true, saleId: sale.id, sale, replay: false };
    const options: PaymentStageOptions = {
      scope: 'current', isCurrentScope: (s) => s === 'current', totalSatang: GROSS,
      prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome),
      finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>(),
      onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
      wallet: null,
    };
    const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
    unmounts.push(hook.unmount);
    vi.spyOn(paymentsApi, 'start').mockResolvedValue({
      route: 'card_terminal', attempt: attempt(sale.id, 'card', 30_000, false), replayed: false,
      outstandingSatang: 30_000, qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null,
    });
    hook.result.current.selectMethod('park-card');
    hook.result.current.setAmountSatang(30_000);
    await hook.result.current.submit();
    lane.mockReturnValue('box');
    const intent = vi.spyOn(bridgeApi, 'intent');
    hook.rerender({ ...options, wallet: { key: KEY, useCredit: true, previewSatang: 30_000 } });
    await hook.result.current.submit();
    expect(hook.result.current.state.creditRefusalSeq).toBe(1);
    // The station puts the toggle back on and presses again: refused again, nothing called.
    hook.rerender({ ...options, wallet: { key: KEY, useCredit: true, previewSatang: 30_000 } });
    await hook.result.current.submit();
    expect(hook.result.current.state.creditRefusalSeq).toBe(2);
    expect(intent).not.toHaveBeenCalled();
    expect(platformSpend).not.toHaveBeenCalled();
    expect(hook.result.current.state.outstandingSatang).toBe(30_000);
    expect(hook.result.current.locked).toBe(false);
  });
});

const finaliseCalls = (options: PaymentStageOptions): number => vi.mocked(options.finaliseSale).mock.calls.length;
