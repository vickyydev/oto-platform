import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOX_STOCK_REFUSALS } from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import { forgetLaneSale, holdLaneSale } from '@/api/boxSales';
import { spendWalletOnSale, type ApiSale } from '@/api/sales';
import { currentLane } from '@/lib/lane';
import * as paymentMethods from '@/lib/payments';
import { isStockRefusalCode, stockRefusalAdvice, stockRefusalWords, STOCK_REFUSAL_CODES } from '@/lib/stockRefusal';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import { withLedgerCost, type ProfitabilityRow } from '@/lib/reporting';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * S2-14b ROUND 4 — handover Q1: ON THE BOX LANE THE TILL SAYS THE BOX'S STOCK
 * REFUSALS IN THE BOX'S WORDS. The counter's box guards the cart against its
 * stock snapshot at the money press — cash, a card on its terminal, credit —
 * and refuses with `STOCK_SHORT` ("Only 3 Grip Socks S left"),
 * `STOCK_SIZE_REQUIRED`, `BOX_STOCK_UNKNOWN` or `BOX_STOCK_STALE`. Each took
 * nothing: the stage shows the words exactly as they came, fails without a
 * retry (the same cart meets the same shelf), and a credit press refused this
 * way releases the sale's credit lane and leaves the credit toggle alone (the
 * wallet did not refuse anything).
 *
 * And the profitability seam (round 4): cost of goods from the ledger's
 * frozen cost per product.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, spendWalletOnSale: vi.fn() };
});
vi.mock('@/lib/lane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane')>();
  return { ...actual, currentLane: vi.fn(() => 'box' as const) };
});

const platformSpend = vi.mocked(spendWalletOnSale);
const lane = vi.mocked(currentLane);
const unmounts: (() => void)[] = [];
const METHODS = [
  { id: 'park-cash', kind: 'cash' as const, label: 'Cash', enabled: true, sortOrder: 0 },
  { id: 'park-card', kind: 'card' as const, label: 'Card', enabled: true, sortOrder: 1 },
];
const KEY = 'QR-MRKD90Z65F1ESEQMVSPV';

/** The box's refusals, each in the words it is sent in. */
const REFUSALS: Array<[string, string]> = [
  [BOX_STOCK_REFUSALS.short.code, 'Only 3 Grip Socks S left. Nothing was saved.'],
  [BOX_STOCK_REFUSALS.size.code, 'Choose a size for Grip Socks — it comes in S, M, L. Nothing was saved.'],
  [BOX_STOCK_REFUSALS.unknown.code, BOX_STOCK_REFUSALS.unknown.message],
  [BOX_STOCK_REFUSALS.stale.code, BOX_STOCK_REFUSALS.stale.message],
];

beforeEach(() => {
  vi.resetAllMocks();
  lane.mockReturnValue('box');
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  forgetLaneSale('sale-1');
  vi.restoreAllMocks();
});

const outcome = (sale: ApiSale): SaleWriteOutcome => ({ ok: true, written: true, saleId: sale.id, sale, replay: false });

function mount(totalSatang: number, opts: { credit?: boolean; finalise?: PaymentStageOptions['finaliseSale'] } = {}) {
  const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: totalSatang } });
  const options: PaymentStageOptions = {
    scope: 'current',
    isCurrentScope: (scope) => scope === 'current',
    totalSatang,
    prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome(sale)),
    finaliseSale: opts.finalise ?? vi.fn<PaymentStageOptions['finaliseSale']>(),
    onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
    wallet: opts.credit ? { key: KEY, useCredit: true, previewSatang: totalSatang } : null,
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  // Rung up on the counter's box.
  holdLaneSale({
    stationId: 'station-1', saleId: sale.id, actionId: 'pay-press-1', occurredAt: sale.occurredAt,
    cart: { channel: 'shop', expectedTotalSatang: totalSatang } as never, visitId: null, note: null, lane: 'box',
  });
  return { ...hook, options, sale };
}

describe('Q1 — the box’s stock refusals reach the till verbatim', () => {
  it.each(REFUSALS)('cash press refused %s: failed, the words exactly, no retry', async (code, words) => {
    const finalise = vi.fn<PaymentStageOptions['finaliseSale']>().mockResolvedValue({
      ok: false, saleId: 'sale-1', code, message: words, retryable: false,
    });
    const t = mount(6_000, { finalise });
    t.result.current.selectMethod('park-cash');
    await t.result.current.submit();
    expect(t.result.current.state).toMatchObject({ phase: 'failed', error: words, retryable: false, settlements: [] });
    // Retry does not send the same cart at the same shelf again.
    await t.result.current.retry();
    expect(finalise).toHaveBeenCalledTimes(1);
    expect(t.options.onComplete).not.toHaveBeenCalled();
  });

  it.each(REFUSALS)('card press on the box refused %s: the words exactly, nothing charged', async (code, words) => {
    const t = mount(6_000);
    const intent = vi.spyOn(bridgeApi, 'intent').mockRejectedValue(new ApiError(409, code, words));
    t.result.current.selectMethod('park-card');
    await t.result.current.submit();
    expect(intent).toHaveBeenCalledTimes(1);
    expect(t.result.current.state).toMatchObject({ phase: 'failed', error: words, retryable: false, settlements: [] });
    await t.result.current.retry();
    expect(intent).toHaveBeenCalledTimes(1);
  });

  it.each(REFUSALS)('credit press on the box refused %s: the words exactly; the credit toggle is not refused', async (code, words) => {
    const t = mount(6_000, { credit: true });
    vi.spyOn(bridgeApi, 'intent').mockRejectedValue(new ApiError(409, code, words));
    await t.result.current.submit();
    expect(platformSpend).not.toHaveBeenCalled();
    expect(t.result.current.state).toMatchObject({ phase: 'failed', error: words, retryable: false, creditSatang: 0 });
    // The wallet refused nothing: the stage does not take the toggle off.
    expect(t.result.current.creditRefusal).toBeNull();
    expect(t.result.current.state.creditRefusedSaleId).toBeNull();
  });

  it('the four codes, and the advice the sale panel gives with them', () => {
    expect([...STOCK_REFUSAL_CODES].sort()).toEqual(['BOX_STOCK_STALE', 'BOX_STOCK_UNKNOWN', 'STOCK_SHORT', 'STOCK_SIZE_REQUIRED']);
    expect(isStockRefusalCode('STOCK_SHORT')).toBe(true);
    expect(isStockRefusalCode('WALLET_OFFLINE_CAP')).toBe(false);
    expect(isStockRefusalCode(undefined)).toBe(false);
    expect(stockRefusalWords(new ApiError(409, 'STOCK_SHORT', 'Only 3 Grip Socks S left. Nothing was saved.'))).toBe(
      'Only 3 Grip Socks S left. Nothing was saved.',
    );
    expect(stockRefusalWords(new ApiError(409, 'PAYMENT_IN_FLIGHT', 'x'))).toBeNull();
    expect(stockRefusalAdvice('STOCK_SHORT')).toBe('Change the order — fewer, or another size — and press Pay again. Nothing was charged.');
    expect(stockRefusalAdvice('BOX_STOCK_STALE')).toBe(
      'Take the item off this order and sell it when the connection is back — nothing was charged.',
    );
  });
});

describe('the profitability seam — cost of goods from the ledger’s frozen cost', () => {
  const row = (itemId: string, qty: number, revenueSatang: number, cogsSatang = 0, costTracked = false): ProfitabilityRow => ({
    itemId, name: itemId, qty, revenueSatang, cogsSatang, marginSatang: revenueSatang - cogsSatang,
    marginPercent: revenueSatang > 0 ? ((revenueSatang - cogsSatang) / revenueSatang) * 100 : 0, costTracked,
  });

  it('the units agree: exactly the ledger’s figure; otherwise its cost per unit over the row’s units; else the catalogue’s', () => {
    const ledger = new Map([
      ['shirt', { quantity: 5, cogsSatang: 60_000, costTracked: true }],
      ['cap', { quantity: 4, cogsSatang: 36_000, costTracked: true }],
      ['water', { quantity: 2, cogsSatang: 2_400, costTracked: false }],
    ]);
    const [shirt, cap, water, plush] = withLedgerCost(
      [row('shirt', 5, 125_000), row('cap', 2, 50_000), row('water', 2, 4_000), row('plush', 1, 30_000, 16_000, true)],
      ledger,
    );
    expect(shirt).toMatchObject({ cogsSatang: 60_000, marginSatang: 65_000, costTracked: true });
    expect(cap).toMatchObject({ cogsSatang: 18_000, marginSatang: 32_000, costTracked: true });
    // Some units sold with no frozen cost: the figure is understated, and says so.
    expect(water).toMatchObject({ cogsSatang: 2_400, costTracked: false });
    // Not on the ledger: the catalogue's cost stands.
    expect(plush).toMatchObject({ cogsSatang: 16_000, costTracked: true });
    // No ledger to read: the rows as they were.
    expect(withLedgerCost([row('shirt', 5, 125_000)], null)).toEqual([row('shirt', 5, 125_000)]);
  });
});
