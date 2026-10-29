import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { apiSale, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { api } from '@/api/client';
import { paymentsApi, type PaymentAttemptRead } from '@/api/payments';
import { commitSale, finaliseSale, salesApi, type ApiSale } from '@/api/sales';
import type { ApiSaleDetail, ApiSaleDiscount, ApiSaleLine } from '@/api/history';
import type { AddOn, Discount, TicketType } from '@/types';
import * as paymentMethods from '@/lib/payments';
import { pickResumeId, resumableHere, useLeftBehindSales, type LeftBehindSale } from '@/lib/leftBehindSale';
import { rebuildResumedSale, resumedCart } from '@/lib/resumeSale';
import { forgetSaleOnScreen, rememberSaleOnScreen, saleOnScreen } from '@/lib/saleOnScreen';
import { useSaleWriter } from '@/lib/saleWriter';
import { usePaymentStage, type PaymentStageOptions } from '@/lib/usePaymentStage';
import { CANCELLED_AT_THE_TILL } from '@/lib/tillVoucher';

/**
 * RESUMING A RUNG-UP SALE AFTER A RELOAD — the owner's rule: a sale rung up at
 * this till comes back on its payment screen until it is paid, voided or
 * thrown away.
 *
 *   - `lib/leftBehindSale.ts` decides which of the station's unpaid sales this
 *     screen may continue: rung up at THIS station by THIS account, still
 *     `tendering`. Another account's, or another station's, is offered the
 *     void alone, as before; a closed sale is never listed.
 *   - `lib/resumeSale.ts` rebuilds the cart from the platform's read of the
 *     sale and hands the screens the sale's own figures.
 *   - `lib/saleWriter.ts` takes the sale over (`adopt`), so the tender closes
 *     it and Cancel voids it; `lib/usePaymentStage.ts` reads the money already
 *     taken on it (`resumeSaleId`), as it does after a lost reply.
 *   - the browser remembers only WHICH sale was on screen (`lib/saleOnScreen.ts`).
 *
 * The hooks run on the harness in place of React (support/hooks.ts). The calls
 * that reach the platform answer as each test says.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return {
    ...actual,
    commitSale: vi.fn(),
    finaliseSale: vi.fn(),
    salesApi: { ...actual.salesApi, get: vi.fn(), voidSale: vi.fn(), list: vi.fn() },
  };
});

const commit = vi.mocked(commitSale);
const finalise = vi.mocked(finaliseSale);
const getSale = vi.mocked(salesApi.get);
const voidSale = vi.mocked(salesApi.voidSale);
const listSales = vi.mocked(salesApi.list);

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

/** A browser store that lives for one test. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

const AT = { stationId: 'station-1', accountId: 'account-1' };
const soldBy = (accountId: string) => ({ accountId, name: 'Som' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which unpaid sale this screen may resume', () => {
  it('only a tendering sale rung up at this station by this account', () => {
    expect(resumableHere(apiSale({ stationId: 'station-1', soldBy: soldBy('account-1') }), AT)).toBe(true);
    expect(resumableHere(apiSale({ stationId: 'station-1', soldBy: soldBy('account-2') }), AT)).toBe(false);
    expect(resumableHere(apiSale({ stationId: 'station-2', soldBy: soldBy('account-1') }), AT)).toBe(false);
    expect(resumableHere(apiSale({ stationId: 'station-1', soldBy: soldBy('account-1'), status: 'voided' }), AT)).toBe(false);
    expect(resumableHere(apiSale({ stationId: 'station-1', soldBy: soldBy('account-1'), status: 'finalised' }), AT)).toBe(false);
    // An older platform that names no seller offers nothing to resume.
    expect(resumableHere(apiSale({ stationId: 'station-1' }), AT)).toBe(false);
    expect(resumableHere(apiSale({ stationId: 'station-1', soldBy: soldBy('account-1') }), { ...AT, accountId: null })).toBe(false);
  });

  it('opens on the remembered sale when it is still open for this account, else on the only one, else on none', () => {
    const left = (saleId: string, resumable: boolean): LeftBehindSale => ({
      saleId, stationName: null, occurredAt: null, grossSatang: null, resumable,
    });
    expect(pickResumeId([left('a', true)], null)).toBe('a');
    expect(pickResumeId([left('a', true), left('b', false)], null)).toBe('a');
    expect(pickResumeId([left('a', true), left('b', true)], null)).toBeNull();
    expect(pickResumeId([left('a', true), left('b', true)], 'b')).toBe('b');
    // A remembered sale another account rang up, or one the platform no longer lists, is not opened on.
    expect(pickResumeId([left('a', true), left('b', false)], 'b')).toBe('a');
    expect(pickResumeId([left('a', true), left('c', true)], 'gone')).toBeNull();
    expect(pickResumeId([left('a', false)], 'a')).toBeNull();
  });

  it('lists the station’s unpaid sales with the resume offer on this account’s own, and goes straight to it', async () => {
    listSales.mockResolvedValue({
      sales: [
        apiSale({ id: 'mine', stationId: 'station-1', soldBy: soldBy('account-1') }),
        apiSale({ id: 'theirs', stationId: 'station-1', soldBy: soldBy('account-2') }),
        apiSale({ id: 'elsewhere', stationId: 'station-2', soldBy: soldBy('account-1') }),
        apiSale({ id: 'closed', stationId: 'station-1', soldBy: soldBy('account-1'), status: 'finalised' }),
        apiSale({ id: 'on-this-screen', stationId: 'station-1', soldBy: soldBy('account-1') }),
      ],
    });
    const view = renderHook(() =>
      useLeftBehindSales({
        branchId: 'branch-1', stationId: 'station-1', stationName: 'Reception Till 1',
        accountId: 'account-1', enabled: true, ownsSale: (id) => id === 'on-this-screen',
      }),
    );
    await settle();
    expect(listSales).toHaveBeenCalledWith({ branchId: 'branch-1', stationId: 'station-1', status: 'tendering', limit: 10 });
    expect(view.result.current.sales.map((s) => [s.saleId, s.resumable])).toEqual([
      ['mine', true],
      ['theirs', false],
    ]);
    expect(view.result.current.resumeId).toBe('mine');
    // Dismissing the card takes the automatic resume with it.
    view.result.current.dismiss('mine');
    expect(view.result.current.resumeId).toBeNull();
  });

  it('with several of its own open, opens on the one this tab remembers having on screen, and on none otherwise', async () => {
    listSales.mockResolvedValue({
      sales: [
        apiSale({ id: 'first', stationId: 'station-1', soldBy: soldBy('account-1') }),
        apiSale({ id: 'second', stationId: 'station-1', soldBy: soldBy('account-1') }),
      ],
    });
    const mount = () => renderHook(() =>
      useLeftBehindSales({
        branchId: 'branch-1', stationId: 'station-1', stationName: null,
        accountId: 'account-1', enabled: true, ownsSale: () => false,
      }),
    );
    const unremembered = mount();
    await settle();
    expect(unremembered.result.current.sales.every((s) => s.resumable)).toBe(true);
    expect(unremembered.result.current.resumeId).toBeNull();

    rememberSaleOnScreen('station-1', 'second');
    const remembered = mount();
    await settle();
    expect(remembered.result.current.resumeId).toBe('second');
  });

  it('with no account to compare against, every sale is offered the void alone', async () => {
    listSales.mockResolvedValue({ sales: [apiSale({ id: 'mine', stationId: 'station-1', soldBy: soldBy('account-1') })] });
    const view = renderHook(() =>
      useLeftBehindSales({ branchId: 'b', stationId: 'station-1', stationName: null, enabled: true, ownsSale: () => false }),
    );
    await settle();
    expect(view.result.current.sales).toEqual([
      { saleId: 'mine', stationName: null, occurredAt: apiSale().occurredAt, grossSatang: apiSale().totals.grossSatang, resumable: false },
    ]);
    expect(view.result.current.resumeId).toBeNull();
  });
});

describe('what the browser remembers: which sale was on screen, by station', () => {
  it('is kept in this tab first, with a copy the browser keeps, and forgotten when the sale is done', () => {
    rememberSaleOnScreen('station-1', 'sale-1');
    expect(saleOnScreen('station-1')).toBe('sale-1');
    expect(sessionStorage.getItem('oto.till.saleOnScreen.station-1')).toBe('sale-1');
    expect(localStorage.getItem('oto.till.saleOnScreen.station-1')).toBe('sale-1');
    // A closed tab reopened on the same counter finds the browser's copy.
    sessionStorage.removeItem('oto.till.saleOnScreen.station-1');
    expect(saleOnScreen('station-1')).toBe('sale-1');
    expect(saleOnScreen('station-2')).toBeNull();
    forgetSaleOnScreen('station-1');
    expect(saleOnScreen('station-1')).toBeNull();
    expect(localStorage.getItem('oto.till.saleOnScreen.station-1')).toBeNull();
  });

  it('is nothing but the sale id — the sale itself is the platform’s', () => {
    rememberSaleOnScreen('station-1', 'sale-1');
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe('sale-1');
  });
});

// --- The cart, rebuilt from the platform's read of the sale ------------------

const row = (over: Partial<ApiSaleLine> & Pick<ApiSaleLine, 'kind' | 'cartLineId' | 'quantity' | 'unitSatang' | 'grossSatang'>): ApiSaleLine => ({
  id: `row-${over.kind}-${over.cartLineId}`, lineNo: 1, componentKey: null, ticketPackageId: null, label: over.kind,
  revenueCategory: 'tickets', taxableCategory: 'tickets', baseSatang: over.grossSatang, discountSatang: 0,
  netSatang: over.grossSatang, serviceChargeSatang: 0, taxSatang: 0, taxMode: 'inclusive', taxRateBp: 700, taxName: 'VAT',
  customerTier: 'expat', kidCount: 0, adultCount: 0, freeAdultCount: 0, stayHours: null, stayDurationLabel: null,
  ...over,
});

const manualRow: ApiSaleDiscount = {
  id: 'md-1', kind: 'manual', discountType: 'fixed', percentBp: null, valueSatang: 10_000, amountSatang: 10_000,
  scope: 'order', targetLineId: null, targetComponent: null, targetLabel: null, code: null, label: null,
  reason: 'Service recovery', note: 'Queue', appliedByName: 'Som', appliedByAccountId: 'account-1',
  appliedAt: '2026-10-29T03:00:00.000Z',
};
const promoRow: ApiSaleDiscount = {
  id: 'pd-1', kind: 'promo', discountType: 'percent', percentBp: 2_500, amountSatang: 0, targetLabel: null,
  code: 'SONGKRAN25', label: 'Songkran 25%', reason: null, note: null, appliedByName: null,
};
const voucherRow: ApiSaleDiscount = {
  id: 'vd-1', kind: 'promo', discountType: 'fixed', percentBp: null, amountSatang: 15_000, targetLabel: null,
  code: '…47WP', label: '150 THB Voucher (voucher …47WP)', reason: null, note: null, appliedByName: null,
};

function detail(over: Partial<ApiSaleDetail> = {}): ApiSaleDetail {
  return {
    sale: {
      id: 'sale-1', branchId: 'branch-1', stationId: 'station-1', memberId: 'member-1', visitId: null,
      businessDate: '2026-10-29', occurredAt: '2026-10-29T03:10:00.000Z', status: 'tendering',
      pricingMode: 'weekend', pricingModeReason: 'Weekend pricing', customerTier: 'expat', engineVersion: 'engine-1',
      receiptNumber: null, receiptSeries: null, receiptSeq: null, finalisedAt: null, note: null,
      totals: {
        subtotalSatang: 100_000, manualDiscountSatang: 10_000, promoDiscountSatang: 15_000, discountSatang: 25_000,
        netSatang: 70_093, serviceChargeSatang: 0, taxInclusiveSatang: 4_907, taxExclusiveSatang: 0,
        grossSatang: 75_000, unappliedDiscountSatang: 0, refundedSatang: 0,
      },
    },
    taxBreakdown: null,
    lines: [
      row({ kind: 'kids', cartLineId: 'cl-1', quantity: 2, unitSatang: 30_000, grossSatang: 60_000, kidCount: 2,
        ticketPackageId: 'pkg-2h', stayHours: 2, stayDurationLabel: '2 Hours', label: 'Kids' }),
      row({ kind: 'adults_paid', cartLineId: 'cl-1', quantity: 1, unitSatang: 25_000, grossSatang: 25_000, adultCount: 1, ticketPackageId: 'pkg-2h' }),
      row({ kind: 'adults_free', cartLineId: 'cl-1', quantity: 1, unitSatang: 0, grossSatang: 0, freeAdultCount: 1, ticketPackageId: 'pkg-2h' }),
      row({ kind: 'socks', cartLineId: 'cl-1', quantity: 2, unitSatang: 5_000, grossSatang: 10_000, componentKey: 'a-socks', label: 'Regular Socks' }),
      row({ kind: 'addon', cartLineId: 'cl-1', quantity: 1, unitSatang: 5_000, grossSatang: 5_000, componentKey: 'a-grip', label: 'Grip socks',
        variantBreakdown: [{ variantId: 'v-m', variantLabel: 'M', quantity: 1 }] }),
    ],
    discounts: [manualRow, promoRow, voucherRow],
    attempts: [],
    ...over,
  };
}

const twoHours: TicketType = {
  id: 'pkg-2h', name: '2 Hours Play', durationLabel: '2 Hours', hours: 2,
  prices: { expat: { weekday: 300, weekend: 300 } },
  adultRules: { expat: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: { weekday: 250, weekend: 250 } } },
};
const gripSocks: AddOn = { id: 'a-grip', name: 'Grip Socks', price: { weekday: 50, weekend: 50 }, inventoryItemId: 'inv-grip' };
const songkran: Discount = { code: 'SONGKRAN25', label: 'Songkran', type: 'percent', value: 25 };
const catalogue = {
  ticketTypes: [twoHours],
  addOns: [gripSocks],
  discountByCode: (code: string) => (code === 'SONGKRAN25' ? songkran : null),
};

describe('the cart, rebuilt from the platform’s read of the sale', () => {
  it('puts each cart line back together from its ledger rows, at the figures the sale charged', () => {
    const rebuilt = rebuildResumedSale(detail(), catalogue);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.tier).toBe('expat');
    expect(rebuilt!.supervised).toBe(false);
    expect(rebuilt!.lines).toHaveLength(1);
    const [line] = rebuilt!.lines;
    expect(line).toMatchObject({ id: 'cl-1', tier: 'expat', kids: 2, adults: 2, socks: 2, lineTotal: 1000 });
    expect(line!.ticketType).toBe(twoHours);
    expect(line!.addOns).toEqual([
      { id: 'a-grip', name: 'Grip Socks', price: 50, quantity: 1, inventoryItemId: 'inv-grip', variantId: 'v-m' },
    ]);
    // The staff discount as it was applied, by whom; the park code from the till's own list;
    // the voucher stays the platform's and is not held again.
    expect(rebuilt!.manualDiscounts).toEqual([{
      id: 'md-1', scope: 'order', type: 'fixed', value: 100, reason: 'Service recovery', note: 'Queue',
      amountTHB: 100, appliedBy: 'Som', appliedById: 'account-1', appliedAt: '2026-10-29T03:00:00.000Z',
    }]);
    expect(rebuilt!.discounts).toEqual([songkran]);
  });

  it('hands the screens the sale’s own figures, labelled as the platform’s, and never a re-quote', () => {
    const cart = resumedCart(detail());
    expect(cart.pending).toBe(false);
    expect(cart.error).toBeNull();
    expect(cart.quote.source).toBe('platform');
    expect(cart.quote.satang).toBeNull();
    expect(cart.quote.pricingMode).toBe('weekend');
    expect(cart.quote.engineVersion).toBe('engine-1');
    expect(cart.totals).toMatchObject({
      subtotal: 1000, discountAmount: 150, manualDiscountAmount: 100, manualAmounts: { 'md-1': 100 },
      serviceChargeTotal: 0, taxTotal: 49.07, total: 750,
    });
    expect(cart.totals.scannedDiscounts).toEqual([
      { code: 'SONGKRAN25', label: 'Songkran 25%', type: 'percent', amount: 0 },
      { code: '…47WP', label: '150 THB Voucher (voucher …47WP)', type: 'fixed', amount: 150 },
    ]);
    expect(cart.totals.taxBreakdown.grandTotal).toBe(750);
  });

  it('stands in a package the catalogue no longer lists, priced from the sale’s own rows', () => {
    const gone = detail({
      lines: [
        row({ kind: 'kids', cartLineId: 'cl-9', quantity: 1, unitSatang: 20_000, grossSatang: 20_000, ticketPackageId: 'pkg-old',
          stayHours: 1, stayDurationLabel: '1 Hour' }),
        row({ kind: 'adults_paid', cartLineId: 'cl-9', quantity: 2, unitSatang: 15_000, grossSatang: 30_000, ticketPackageId: 'pkg-old' }),
        row({ kind: 'addon', cartLineId: 'cl-9', quantity: 1, unitSatang: 7_000, grossSatang: 7_000, componentKey: 'a-unknown', label: 'Cape' }),
      ],
      discounts: [],
    });
    const rebuilt = rebuildResumedSale(gone, catalogue)!;
    const [line] = rebuilt.lines;
    expect(line).toMatchObject({ id: 'cl-9', kids: 1, adults: 2, socks: 0, lineTotal: 570 });
    expect(line!.ticketType).toMatchObject({
      id: 'pkg-old', name: '1 Hour Play', durationLabel: '1 Hour', hours: 1,
      prices: { expat: { weekday: 200, weekend: 200 } },
      adultRules: { expat: { kind: 'set_price', price: { weekday: 150, weekend: 150 } } },
    });
    expect(line!.addOns).toEqual([{ id: 'a-unknown', name: 'Cape', price: 70, quantity: 1 }]);
    expect(rebuilt.discounts).toEqual([]);
    expect(rebuilt.manualDiscounts).toEqual([]);
  });

  it('marks a supervised child’s line, and refuses an order the ticket till never rang up', () => {
    const supervised = detail({
      lines: [
        ...detail().lines,
        row({ kind: 'kids', cartLineId: 'stay-1', quantity: 1, unitSatang: 30_000, grossSatang: 30_000, ticketPackageId: 'pkg-2h', supervised: true }),
        row({ kind: 'service_fee', cartLineId: 'stay-1', quantity: 1, unitSatang: 10_000, grossSatang: 10_000, label: 'Drop-off service', supervised: true }),
      ],
    });
    const rebuilt = rebuildResumedSale(supervised, catalogue)!;
    expect(rebuilt.supervised).toBe(true);
    expect(rebuilt.lines.map((l) => [l.id, l.lineTotal])).toEqual([['cl-1', 1000], ['stay-1', 400]]);

    const food = detail({ lines: [row({ kind: 'fnb_item', cartLineId: 'f-1', quantity: 1, unitSatang: 12_000, grossSatang: 12_000 })] });
    expect(rebuildResumedSale(food, catalogue)).toBeNull();
    expect(rebuildResumedSale(detail({ lines: [] }), catalogue)).toBeNull();
  });
});

// --- The writer takes the sale over; the payment screen reads its money ------

function cashAttempt(saleId: string): PaymentAttemptView {
  return {
    id: 'attempt-first-part', saleId, method: 'cash', provider: 'manual', status: 'approved',
    amountSatang: 27_000, tenderedSatang: 27_000, changeSatang: 0,
    terminalRef: null, tid: null, approvalCode: null, last4: null,
    invoiceNo: null, tranRef: null, actionId: 'first-part', offline: false,
    paidAt: '2026-09-25T04:20:00.000Z', createdAt: '2026-09-25T04:20:00.000Z',
  };
}
const read = (attempt: PaymentAttemptView, balance: number): PaymentAttemptRead => ({
  qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null,
  attempt, deviceLabel: null, responseText: null, outstandingSatang: balance,
});

describe('the writer takes a rung-up sale over, and the payment screen opens on it', () => {
  const unmounts: (() => void)[] = [];
  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    vi.useRealTimers();
  });

  it('adopts an open sale without writing it, owns it, and refuses a closed or voided one', () => {
    const { result } = renderHook(() => useSaleWriter());
    expect(result.current.adopt(apiSale({ id: 'sale-void', status: 'voided' }))).toBe(false);
    expect(result.current.adopt(apiSale({ id: 'sale-done', status: 'finalised' }))).toBe(false);
    expect(result.current.state).toEqual({ kind: 'idle' });

    expect(result.current.adopt(apiSale({ id: 'sale-1' }))).toBe(true);
    expect(result.current.state).toMatchObject({ kind: 'committed', saleId: 'sale-1' });
    expect(result.current.committed?.id).toBe('sale-1');
    expect(result.current.saleId).toBe('sale-1');
    expect(result.current.ownsSale('sale-1')).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it('opens the payment screen with the money already taken on the sale, then closes it under its own id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T04:00:00.000Z'));
    vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) =>
      id === 'park-cash' ? { id, kind: 'cash', label: id, enabled: true, sortOrder: 0 } : undefined);
    const paid = cashAttempt('sale-1');
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: apiSale(), attempts: [paid] });
    vi.spyOn(paymentsApi, 'read').mockResolvedValue(read(paid, 27_000));
    finalise.mockResolvedValue({
      sale: apiSale({ status: 'finalised', receiptNumber: 'T1-000042' }), replay: false, finalised: true, outstandingSatang: 0,
      attempt: { ...paid, id: 'attempt-rest', amountSatang: 27_000, actionId: 'rest' },
    });

    const writer = renderHook(() => useSaleWriter()).result;
    expect(writer.current.adopt(apiSale({ id: 'sale-1' }))).toBe(true);
    const prepareSale = vi.fn<PaymentStageOptions['prepareSale']>(async () => ({
      ok: true, written: true, sale: writer.current.committed!, replay: true, saleId: 'sale-1',
    }));
    const onComplete = vi.fn<PaymentStageOptions['onComplete']>();
    const stage = renderHook((props: PaymentStageOptions) => usePaymentStage(props), {
      scope: 'resumed', isCurrentScope: (scope) => scope === 'resumed', totalSatang: 54_000,
      resumeSaleId: 'sale-1', prepareSale, finaliseSale: (tender, actionId) => writer.current.finalise(tender, actionId), onComplete,
    });
    unmounts.push(stage.unmount);
    expect(stage.result.current.canSubmit).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledWith('/sales/sale-1');
    // The split cash already recorded shows as recorded — under the method the
    // platform recorded it with — and only the rest is asked for.
    expect(stage.result.current.state.settlements).toEqual([
      { attemptId: 'attempt-first-part', method: 'cash', kind: 'cash', amountSatang: 27_000, tenderedSatang: 27_000, changeSatang: 0 },
    ]);
    expect(stage.result.current.state.outstandingSatang).toBe(27_000);
    expect(stage.result.current.canBack).toBe(false);

    stage.result.current.selectMethod('park-cash');
    await stage.result.current.submit();
    expect(prepareSale).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(finalise).toHaveBeenCalledTimes(1);
    expect(finalise.mock.calls[0]![0]).toBe('sale-1');
    expect(finalise.mock.calls[0]![2]).toEqual({ method: 'park-cash', kind: 'cash', amountSatang: 27_000, tenderedSatang: 27_000, changeSatang: 0 });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0]).toMatchObject({ id: 'sale-1', status: 'finalised', receiptNumber: 'T1-000042' });
    expect(writer.current.state).toMatchObject({ kind: 'written', saleId: 'sale-1' });
  });

  it('Cancel on a resumed sale voids it, as Cancel on the payment screen does', async () => {
    voidSale.mockImplementation(async (saleId, reason) => ({
      replay: false, sale: apiSale({ id: saleId, status: 'voided' }),
      void: { voidedAt: '2026-09-25T04:20:00.000Z', voidedByAccountId: 'account-1', reason }, releasedVoucherIds: [],
    }));
    const { result } = renderHook(() => useSaleWriter());
    result.current.adopt(apiSale({ id: 'sale-2' }));
    await expect(result.current.cancel(CANCELLED_AT_THE_TILL)).resolves.toEqual({ ok: true, voided: true });
    expect(voidSale).toHaveBeenCalledExactlyOnceWith('sale-2', CANCELLED_AT_THE_TILL);
    expect(getSale).not.toHaveBeenCalled();
  });
});

// --- The till's wiring, pinned in its source --------------------------------

describe('the counter till’s wiring', () => {
  const till = src('pages/Till.tsx');

  it('offers to resume only this account’s own sale at this station, and goes straight to its payment screen', () => {
    expect(till).toContain('accountId: operator?.id ?? null,');
    expect(till).toContain('{...(left.resumable && !resumed');
    expect(till).toContain('onResume: () => void resumeSale(left.saleId)');
    expect(till).toMatch(/const saleId = leftBehind\.resumeId;\s*if \(!saleId \|\| locked \|\| resumed \|\| step !== 1 \|\| lines\.length > 0 \|\| saleWriter\.state\.kind !== 'idle'\) return;\s*void resumeSale\(saleId\);/);
    // A sale that is no longer open, or at another till, is never resumed.
    expect(till).toContain("if (sale.status !== 'tendering' || sale.stationId !== stationId) {");
    expect(till).toContain('if (!saleWriter.adopt(adopted)) return;');
    expect(till).toContain('setStep(5);\n      leftBehind.dismiss(saleId);\n      rememberSaleOnScreen(stationId, saleId);');
  });

  it('writes nothing again for a resumed sale, reads its money, and shows the platform’s figures', () => {
    expect(till).toContain("if (locked || step !== 5 || resumed) return;");
    expect(till).toContain('...(resumed ? { resumeSaleId: resumed.saleId } : {}),');
    expect(till).toContain('const cart: CartQuoteState = resumed?.cart ?? liveCart;');
    expect(till).toContain('lines: resumed ? NO_LINES : lines,');
    expect(till).toMatch(/if \(resumed\) \{\s*const held = saleWriter\.committed;\s*if \(held && held\.id === resumed\.saleId\) \{\s*return \{ ok: true, written: true, sale: held, replay: true, saleId: held\.id \};/);
    expect(till).toContain('data-testid="resumed-sale-notice"');
  });

  it('keeps the resumed order as the platform holds it: every edit is refused, Cancel voids, a reset forgets it', () => {
    for (const handler of ['handleRemoveLine', 'handleApplyManualDiscount', 'handleRemoveManualDiscount', 'handleApplyPromoCode', 'handleRemoveDiscount', 'handleConfigureLine', 'handleUpdateLine', 'handlePaymentBack']) {
      const start = till.indexOf(`const ${handler} = `);
      expect(start, handler).toBeGreaterThan(-1);
      expect(till.slice(start, start + 600), handler).toContain('if (orderFrozen()) return;');
    }
    expect(till).toContain('onAddManualDiscount={() => { if (!orderFrozen()) setShowManualDiscountModal(true); }}');
    expect(till).toMatch(/const resetSale = \(\) => \{\s*saleEpochRef\.current \+= 1;\s*saleWriter\.reset\(\);\s*setResumed\(null\);\s*if \(station\?\.stationId\) forgetSaleOnScreen\(station\.stationId\);/);
    // The remembered sale is only ever an id, written while the sale is rung up and unpaid on the payment screen.
    expect(till).toContain('if (rungUpSaleId && step === 5) rememberSaleOnScreen(stationId, rungUpSaleId);');
  });

  it('the card gains the resume press beside the void, for a resumable sale only', () => {
    const card = src('components/till/RedeemVoucher.tsx');
    expect(card).toContain('data-testid="resume-sale"');
    expect(card).toContain('Resume this sale');
    expect(card).toContain('{...(onResume ? { onResume } : {})}');
    expect(card).toMatch(/\{onResume && \(\s*<Button/);
  });
});

/** Keep the sales fixture honest about the fields the resume rule reads. */
void ((): ApiSale => apiSale({ soldBy: soldBy('account-1'), stationName: 'Reception Till 1' }));
