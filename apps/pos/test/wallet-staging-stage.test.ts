import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOX_LANE_REFUSALS,
  BOX_WALLET_REFUSALS,
  BRIDGE_WALLET_INTENTS,
  WALLET_TENDER_CODE,
  walletOfflineCapMessage,
  type BridgeSaleView,
  type BridgeWalletSpendAnswer,
  type PaymentAttemptView,
} from '@oto/shared';
import { apiSale } from './support/fixtures';
import { renderHook } from './support/hooks';
import { ApiError, NetworkError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import { forgetLaneSale, holdLaneSale, laneSale } from '@/api/boxSales';
import { spendWalletOnSale, type ApiSale, type SaleFinaliseResult } from '@/api/sales';
import { currentLane } from '@/lib/lane';
import * as paymentMethods from '@/lib/payments';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';

/**
 * THE STAGING WALKTHROUGH'S FINDINGS ON THE PAYMENT STAGE (wallet story):
 *
 *   F2  the guest display's "Left to pay" is the order less the credit from
 *       the moment credit is chosen — ฿0 when credit covers it, the rest on a
 *       split — not the whole order until a tender is picked;
 *   F3  a box-lane sale's credit is spent by the BOX (`payment.wallet`, under
 *       the offline cap, one spend per press), its refusals said in its own
 *       words, the rest by the box lane's cash; the round-2 sentence that
 *       refused credit on the box lane outright is gone from this path.
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
const KEY = 'QR-MRKD90Z65F1ESEQMVSPV';

beforeEach(() => {
  vi.resetAllMocks();
  lane.mockReturnValue('platform');
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => METHODS.find((m) => m.id === id));
  vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue(METHODS);
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  forgetLaneSale('sale-1');
  vi.restoreAllMocks();
});

const outcome = (sale: ApiSale, extra: Partial<Extract<SaleWriteOutcome, { written: true }>> = {}): SaleWriteOutcome => ({
  ok: true, written: true, saleId: sale.id, sale, replay: false, ...extra,
});

function mount(totalSatang: number, previewSatang: number | null) {
  const sale = apiSale({ totals: { ...apiSale().totals, grossSatang: totalSatang } });
  const options: PaymentStageOptions = {
    scope: 'current', isCurrentScope: (scope) => scope === 'current', totalSatang,
    prepareSale: vi.fn<PaymentStageOptions['prepareSale']>().mockResolvedValue(outcome(sale)),
    finaliseSale: vi.fn<PaymentStageOptions['finaliseSale']>()
      .mockResolvedValue(outcome({ ...sale, status: 'finalised' }, { finalised: true, outstandingSatang: 0 })),
    onComplete: vi.fn<PaymentStageOptions['onComplete']>(),
    wallet: previewSatang === null ? null : { key: KEY, useCredit: true, previewSatang },
  };
  const hook = renderHook((props: PaymentStageOptions) => usePaymentStage(props), options);
  unmounts.push(hook.unmount);
  return { ...hook, options, sale };
}

// --- F2 ------------------------------------------------------------------------------

describe('F2 — the display says what is left to pay from the moment credit is chosen', () => {
  it('credit covers the order: left to pay ฿0, the credit ฿60 — before any tender is picked', () => {
    const { result } = mount(6_000, 130_000);
    expect(result.current.creditCoversAll).toBe(true);
    // The tender panel's amount is still the whole order (nothing set it yet)…
    expect(result.current.state.amountSatang).toBe(6_000);
    // …but the guest is not asked for it.
    expect(result.current.display).toMatchObject({ amountSatang: 0, creditSatang: 6_000 });
  });

  it('a split: ฿350 of credit on a ฿360 order leaves ฿10 — not ฿360 until Cash is chosen', () => {
    const { result } = mount(36_000, 35_000);
    expect(result.current.display).toMatchObject({ amountSatang: 1_000, creditSatang: 35_000 });
    result.current.selectMethod('park-cash');
    expect(result.current.display).toMatchObject({ amountSatang: 1_000, creditSatang: 35_000 });
  });

  it('no credit: the whole order, exactly as before', () => {
    const { result } = mount(36_000, null);
    expect(result.current.display).toMatchObject({ amountSatang: 36_000, creditSatang: 0 });
  });
});

// --- F3 ------------------------------------------------------------------------------

const boxView = (sale: ApiSale, status: BridgeSaleView['status']): BridgeSaleView => ({
  id: sale.id, status, businessDate: sale.businessDate, occurredAt: sale.occurredAt,
  receiptNumber: status === 'finalised' ? 'T1-000045' : null, receiptSeries: status === 'finalised' ? 'T1' : null,
  receiptSeq: status === 'finalised' ? 45 : null, stationId: 'station-1', boxId: 'box-1', pricingMode: 'weekday',
  customerTier: 'tourist', totals: sale.totals, engineVersion: 'test', origin: 'box',
});

function creditAttempt(saleId: string, amountSatang: number, actionId: string): PaymentAttemptView {
  return {
    id: 'box-credit-attempt', saleId, method: 'wallet', provider: 'manual', status: 'approved',
    amountSatang, tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null, approvalCode: null,
    last4: null, invoiceNo: null, tranRef: null, actionId, offline: true,
    paidAt: '2026-10-01T18:12:17.162Z', createdAt: '2026-10-01T18:12:17.162Z',
  };
}

function boxAnswer(sale: ApiSale, amountSatang: number, actionId: string, opts: { replay?: boolean } = {}): BridgeWalletSpendAnswer {
  const outstandingSatang = sale.totals.grossSatang - amountSatang;
  const finalised = outstandingSatang === 0;
  return {
    sale: boxView(sale, finalised ? 'finalised' : 'tendering'), finalised, outstandingSatang, attempt: null,
    replay: opts.replay ?? false, printing: { jobs: [], notes: [] }, drawer: 'not_asked', outboxDepth: 1,
    walletSpend: { walletId: 'wallet-1', amountSatang, balanceAfterSatang: 35_000 - amountSatang, capLeftSatang: 30_000 - amountSatang, offline: true },
    walletAttempt: creditAttempt(sale.id, amountSatang, actionId),
  };
}

/** The sale as the till rang it up on its box. */
function onTheBox(sale: ApiSale, lane: 'box' | 'platform' = 'box') {
  holdLaneSale({
    stationId: 'station-1', saleId: sale.id, actionId: 'pay-press-1', occurredAt: sale.occurredAt,
    cart: { channel: 'fnb', expectedTotalSatang: sale.totals.grossSatang } as never, visitId: null, note: null, lane,
  });
}

type IntentCall = [string, string, Record<string, unknown>, { actionId?: string } | undefined];

describe('F3 — credit on the box lane is the box’s', () => {
  it('spent under the cap: payment.wallet to the box with the press’s own key; the platform is never asked', async () => {
    const t = mount(6_000, 30_000);
    onTheBox(t.sale);
    const intent = vi.spyOn(bridgeApi, 'intent').mockImplementation(async (_s, _t, payload) => ({
      document: {} as never,
      result: boxAnswer(t.sale, 6_000, (payload.wallet as { actionId: string }).actionId),
    }));
    await t.result.current.submit();
    expect(platformSpend).not.toHaveBeenCalled();
    expect(intent).toHaveBeenCalledTimes(1);
    const [station, type, payload, opts] = intent.mock.calls[0] as IntentCall;
    expect([station, type]).toEqual(['station-1', BRIDGE_WALLET_INTENTS.spend]);
    // The box's payload exactly: the sale under the till's ids, and the press.
    expect(payload).toMatchObject({ saleId: t.sale.id, actionId: 'pay-press-1', cart: { channel: 'fnb' } });
    const press = payload.wallet as { key: string; actionId: string; useCredit: boolean };
    expect(press).toMatchObject({ key: KEY, useCredit: true });
    expect(press.actionId).not.toBe('pay-press-1');
    expect(opts?.actionId).toBe(press.actionId);
    // Credit covered it: closed on the box, one credit settlement, nothing else tendered.
    expect(t.options.onComplete).toHaveBeenCalledTimes(1);
    expect(t.options.finaliseSale).not.toHaveBeenCalled();
    expect(t.result.current.state.settlements).toEqual([
      expect.objectContaining({ method: WALLET_TENDER_CODE, amountSatang: 6_000, walletBalanceAfterSatang: 29_000 }),
    ]);
  });

  it('credit short of the order: ฿300 by credit, the ฿60 rest by the box lane’s cash, and the sale stays on the box', async () => {
    const t = mount(36_000, 30_000);
    onTheBox(t.sale, 'platform');
    vi.spyOn(bridgeApi, 'intent').mockImplementation(async (_s, _t, payload) => ({
      document: {} as never,
      result: boxAnswer(t.sale, 30_000, (payload.wallet as { actionId: string }).actionId),
    }));
    // A platform-rung sale on a till that moved to its box.
    lane.mockReturnValue('box');
    await t.result.current.submit();
    expect(platformSpend).not.toHaveBeenCalled();
    expect(t.result.current.state).toMatchObject({ phase: 'ready', outstandingSatang: 6_000, amountSatang: 6_000, method: 'park-cash', creditSatang: 30_000 });
    expect(t.result.current.display).toMatchObject({ amountSatang: 6_000, creditSatang: 30_000 });
    // From the credit on, the rest follows the sale to the box.
    expect(laneSale(t.sale.id)?.lane).toBe('box');
    await t.result.current.submit();
    expect(t.options.finaliseSale).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.options.finaliseSale).mock.calls[0]![0]).toMatchObject({ kind: 'cash', amountSatang: 6_000 });
  });

  it('the cap refusal is shown verbatim; cash is preselected on the whole amount; nothing locked', async () => {
    const t = mount(6_000, 30_000);
    onTheBox(t.sale);
    const words = walletOfflineCapMessage(30_000);
    expect(words).toBe('Credit is online only above ฿300 per day while this counter is offline — take the rest in cash or card.');
    vi.spyOn(bridgeApi, 'intent').mockRejectedValue(new ApiError(409, BOX_WALLET_REFUSALS.cap.code, words));
    await t.result.current.submit();
    expect(t.result.current.creditRefusal).toBe(words);
    expect(t.result.current.state).toMatchObject({ phase: 'failed', error: words, method: 'park-cash', amountSatang: 6_000, settlements: [] });
    expect(t.result.current.locked).toBe(false);
    expect(t.result.current.canBack).toBe(true);
    expect(t.result.current.creditPendingSatang).toBe(0);
  });

  it.each([
    ['WALLET_EXPIRED', "This wallet's credit has expired — only a manager can bring it back. Take the order in cash or card."],
    [BOX_WALLET_REFUSALS.unknown.code, BOX_WALLET_REFUSALS.unknown.message],
    [BOX_WALLET_REFUSALS.stale.code, BOX_WALLET_REFUSALS.stale.message],
  ])('the box’s %s is shown in its words', async (code, words) => {
    const t = mount(6_000, 30_000);
    onTheBox(t.sale);
    vi.spyOn(bridgeApi, 'intent').mockRejectedValue(new ApiError(409, code, words));
    await t.result.current.submit();
    expect(t.result.current.creditRefusal).toBe(words);
    expect(t.result.current.state.error).toBe(words);
    expect(JSON.stringify(t.result.current.state)).not.toContain(BOX_LANE_REFUSALS.wallet.message);
  });

  it('a press whose answer was lost is sent again with the SAME key — the box spends it once — and never moves to the platform', async () => {
    const t = mount(6_000, 30_000);
    onTheBox(t.sale);
    const keys: string[] = [];
    const intent = vi.spyOn(bridgeApi, 'intent')
      .mockImplementationOnce(async (_s, _t, payload) => {
        keys.push((payload.wallet as { actionId: string }).actionId);
        throw new NetworkError('the box did not answer');
      })
      .mockImplementationOnce(async (_s, _t, payload) => {
        const actionId = (payload.wallet as { actionId: string }).actionId;
        keys.push(actionId);
        return { document: {} as never, result: boxAnswer(t.sale, 6_000, actionId, { replay: true }) };
      });
    await t.result.current.submit();
    expect(t.result.current.state).toMatchObject({ phase: 'blocked', retryable: true });
    // The link came back meanwhile: still the box, the press it already holds.
    lane.mockReturnValue('platform');
    await t.result.current.retry();
    expect(intent).toHaveBeenCalledTimes(2);
    expect(keys[0]).toBe(keys[1]);
    expect(platformSpend).not.toHaveBeenCalled();
    expect(t.result.current.state.settlements.filter((p) => p.method === WALLET_TENDER_CODE)).toHaveLength(1);
    expect(t.result.current.state.creditSatang).toBe(6_000);
    expect(t.options.onComplete).toHaveBeenCalledTimes(1);
  });

  it('the online path is unchanged: a sale the box does not hold spends on the platform, the box is not asked', async () => {
    const t = mount(6_000, 30_000);
    const intent = vi.spyOn(bridgeApi, 'intent');
    const answer: SaleFinaliseResult = { sale: { ...t.sale, status: 'finalised' }, replay: false, finalised: true, outstandingSatang: 0,
      walletAttempt: creditAttempt(t.sale.id, 6_000, 'x'), walletSpend: { walletId: 'w', amountSatang: 6_000, balanceAfterSatang: 29_000 } };
    platformSpend.mockResolvedValue(answer);
    await t.result.current.submit();
    expect(platformSpend).toHaveBeenCalledTimes(1);
    expect(intent).not.toHaveBeenCalled();
    expect(t.options.onComplete).toHaveBeenCalledTimes(1);
  });
});
