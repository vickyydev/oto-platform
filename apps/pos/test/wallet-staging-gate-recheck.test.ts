import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOX_WALLET_REFUSALS,
  BRIDGE_WALLET_INTENTS,
  WALLET_TENDER_CODE,
  type BridgeSaleView,
  type BridgeWalletSpendAnswer,
  type PaymentAttemptView,
} from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError, NetworkError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import { forgetLaneSale, holdLaneSale } from '@/api/boxSales';
import { spendWalletOnSale, type ApiSale } from '@/api/sales';
import { guestLeftToPaySatang } from '@/lib/guestPayment';
import { currentLane } from '@/lib/lane';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageController, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * GATE RE-CHECK — staging fix round, the offline seam (F3) and the guest
 * screen (F2), attacked where the round's own suites do not reach:
 *
 *   - a credit press sent to the PLATFORM whose answer was lost is never then
 *     asked of the box when the lane moves (one wallet, two spends);
 *   - the box's 503 "cannot count credit" is a refusal in its words, not a
 *     stuck retry;
 *   - a tab read online (the platform's whole balance) and spent on the box
 *     after the link drops (the box takes only what the cap leaves): the guest
 *     screen never asks for more than the order less the credit, before or
 *     after the press;
 *   - a second press after the box took part of the order spends nothing again.
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

const platformSpend = vi.mocked(spendWalletOnSale);
const lane = vi.mocked(currentLane);
const unmounts: (() => void)[] = [];
const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
];
const KEY = 'T1-NAHQ66';

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

function mount(totalSatang: number, previewSatang: number) {
  const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: totalSatang } });
  const written: SaleWriteOutcome = { ok: true, written: true, saleId: sale.id, sale, replay: false };
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang,
    prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(written),
    finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>().mockResolvedValue({
      ...written, sale: { ...sale, status: 'finalised' }, finalised: true, outstandingSatang: 0,
    }),
    onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
    wallet: { key: KEY, useCredit: true, previewSatang },
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options, sale };
}

function rungUp(sale: ApiSale, laneOf: 'box' | 'platform') {
  holdLaneSale({
    stationId: 'station-1', saleId: sale.id, actionId: 'pay-press-1', occurredAt: sale.occurredAt,
    cart: { channel: 'fnb', expectedTotalSatang: sale.totals.grossSatang } as never, visitId: null, note: null, lane: laneOf,
  });
}

const view = (sale: ApiSale, status: BridgeSaleView['status']): BridgeSaleView => ({
  id: sale.id, status, businessDate: sale.businessDate, occurredAt: sale.occurredAt,
  receiptNumber: null, receiptSeries: null, receiptSeq: null, stationId: 'station-1', boxId: 'box-1',
  pricingMode: 'weekday', customerTier: 'tourist', totals: sale.totals, engineVersion: 'test', origin: 'box',
});

function credit(saleId: string, amountSatang: number, actionId: string): PaymentAttemptView {
  return {
    id: 'box-credit', saleId, method: 'wallet', provider: 'manual', status: 'approved', amountSatang,
    tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null, last4: null,
    invoiceNo: null, tranRef: null, actionId, offline: true, paidAt: '2026-10-01T18:12:17.162Z', createdAt: '2026-10-01T18:12:17.162Z',
  };
}

/** The box's own rule: min(what the cap leaves today, what the order owes). */
function boxSpends(sale: ApiSale, capLeftSatang: number, replay = false) {
  return async (_station: string, _type: string, payload: Record<string, unknown>) => {
    const amount = Math.min(capLeftSatang, sale.totals.grossSatang);
    const owed = sale.totals.grossSatang - amount;
    const actionId = (payload.wallet as { actionId: string }).actionId;
    const result: BridgeWalletSpendAnswer = {
      sale: view(sale, owed === 0 ? 'finalised' : 'tendering'), finalised: owed === 0, outstandingSatang: owed,
      attempt: null, replay, printing: { jobs: [], notes: [] }, drawer: 'not_asked', outboxDepth: 1,
      walletSpend: { walletId: 'wallet-kid', amountSatang: amount, balanceAfterSatang: 124_000 - amount, capLeftSatang: capLeftSatang - amount, offline: true },
      walletAttempt: credit(sale.id, amount, actionId),
    };
    return { document: {} as never, result };
  };
}

/** The guest screen's figure for this frame, as the F&B display computes it from the order total. */
const guestAsked = (stage: PaymentStageController, totalSatang: number) =>
  guestLeftToPaySatang(stage.display, totalSatang);

describe('RE-CHECK F3 — one wallet, one lane per press', () => {
  it('a platform credit press whose answer was lost is retried on the platform — never moved to the box when the link drops', async () => {
    const t = mount(36_000, 124_000);
    rungUp(t.sale, 'platform');
    platformSpend.mockRejectedValueOnce(new NetworkError('the platform did not answer'));
    const intent = vi.spyOn(bridgeApi, 'intent');
    await t.result.current.submit();
    expect(t.result.current.state).toMatchObject({ phase: 'blocked', retryable: true });
    // The lane arbiter moves the till to its box: the platform may already hold that spend.
    lane.mockReturnValue('box');
    platformSpend.mockRejectedValueOnce(new NetworkError('still down'));
    await t.result.current.retry();
    expect(platformSpend).toHaveBeenCalledTimes(2);
    expect(platformSpend.mock.calls[0]![1]).toBe(platformSpend.mock.calls[1]![1]);
    expect(intent).not.toHaveBeenCalled();
    expect(t.result.current.state).toMatchObject({ phase: 'blocked', creditSatang: 0, settlements: [] });
  });

  it('the box’s 503 "cannot count credit" is its refusal, in its words — not a blocked retry', async () => {
    const t = mount(6_000, 30_000);
    rungUp(t.sale, 'box');
    vi.spyOn(bridgeApi, 'intent').mockRejectedValue(
      new ApiError(503, BOX_WALLET_REFUSALS.noCounter.code, BOX_WALLET_REFUSALS.noCounter.message),
    );
    await t.result.current.submit();
    expect(t.result.current.state).toMatchObject({ phase: 'failed', retryable: false, error: BOX_WALLET_REFUSALS.noCounter.message,
      method: 'park-cash', amountSatang: 6_000 });
    expect(t.result.current.creditRefusal).toBe(BOX_WALLET_REFUSALS.noCounter.message);
    expect(t.result.current.locked).toBe(false);
    expect(platformSpend).not.toHaveBeenCalled();
  });

  it('after the box took part of the order, the next press takes only the cash — the wallet is not asked again', async () => {
    const t = mount(36_000, 30_000);
    rungUp(t.sale, 'box');
    const intent = vi.spyOn(bridgeApi, 'intent').mockImplementation(boxSpends(t.sale, 30_000));
    await t.result.current.submit();
    expect(t.result.current.state).toMatchObject({ phase: 'ready', outstandingSatang: 6_000, creditSatang: 30_000 });
    await t.result.current.submit();
    expect(intent.mock.calls.filter((c) => c[1] === BRIDGE_WALLET_INTENTS.spend)).toHaveLength(1);
    expect(vi.mocked(t.options.finaliseSale).mock.calls).toHaveLength(1);
    expect(vi.mocked(t.options.finaliseSale).mock.calls[0]![0]).toMatchObject({ kind: 'cash', amountSatang: 6_000 });
    const parts = t.result.current.state.settlements;
    expect(parts.filter((p) => p.method === WALLET_TENDER_CODE).map((p) => p.amountSatang)).toEqual([30_000]);
    expect(t.options.onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('RE-CHECK F2 — a tab read online, spent on the box after the link drops', () => {
  it('the guest is never asked for more than the order less the credit, before or after the box’s capped press', async () => {
    const TOTAL = 36_000;
    // Read online: the platform's whole ฿1,240. The box will take only the ฿300 the cap leaves.
    const t = mount(TOTAL, 124_000);
    rungUp(t.sale, 'platform');
    lane.mockReturnValue('box');
    // Before the press: credit is chosen, no tender picked.
    expect(t.result.current.display.amountSatang).toBeLessThanOrEqual(TOTAL - (t.result.current.display.creditSatang ?? 0));
    expect(guestAsked(t.result.current, TOTAL)).toBeLessThanOrEqual(TOTAL - (t.result.current.display.creditSatang ?? 0));
    vi.spyOn(bridgeApi, 'intent').mockImplementation(boxSpends(t.sale, 30_000));
    await t.result.current.submit();
    expect(platformSpend).not.toHaveBeenCalled();
    // After: ฿300 from credit, ฿60 left — the screen says exactly that.
    expect(t.result.current.display).toMatchObject({ amountSatang: 6_000, creditSatang: 30_000 });
    expect(guestAsked(t.result.current, TOTAL)).toBe(6_000);
    // Cash picked with the remainder: still ฿60.
    t.result.current.selectMethod('park-cash');
    expect(guestAsked(t.result.current, TOTAL)).toBe(6_000);
  });
});
