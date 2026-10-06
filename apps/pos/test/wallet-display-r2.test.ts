import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOX_LANE_REFUSALS, readDisplayFnbCart, readDisplayMerchCart, type DisplayMerchCart, type DisplayTotals } from '@oto/shared';
import { apiSale, cartQuote } from './support/fixtures';
import { api, ApiError, NetworkError } from '@/api/client';
import { fnbDisplayPresentation, type FnbDisplayState } from '@/lib/fnbDisplaySession';
import { merchDisplayPresentation, type MerchDisplayState } from '@/lib/merchDisplaySession';
import type { usePaymentStage } from '@/lib/usePaymentStage';
import { FnbPayment } from '@/components/fnb/FnbPayment';
import { FnbCustomerDisplay } from '@/components/fnb/FnbCustomerDisplay';
import { loadScannedTab } from '@/components/fnb/ScanWristband';
import { PublicMerchCustomerDisplay } from '@/components/merch/PublicMerchCustomerDisplay';
import type { FnbOrder, MerchOrder, Wristband } from '@/types';

/**
 * S2-14a round 2, the gate's fix round — THE SEPARATE DISPLAY SHOWS THE CREDIT
 * (R2-G1) and THE BOX-LANE REFUSAL IS SAID ON THE CARD (R2-G2):
 *
 *   - the F&B and shop stations publish the credit the stage is taking as a
 *     figure on the payment frame, and a thank-you settled with credit as a
 *     `credit` tender — a wallet order is no longer excluded from the device;
 *   - the two public displays draw "From your credit / Left to pay" from that
 *     figure, and the thank-you lists the credit beside cash and card;
 *   - the credit card on the till shows the lane's refusal in its own words;
 *   - a band the platform could not be asked about still loads from the
 *     station's own list, without credit (finding 6).
 */
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ operator: null, can: () => false }) }));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.restoreAllMocks();
});

const payment = { saleId: 'sale-1', amountSatang: 4_000, qrPayload: null, qrImageUrl: null, expiresAt: null,
  status: 'idle' as const, offline: false, online: true, creditSatang: 5_000 };

describe('the stations publish the credit to the separate display', () => {
  const fnbState = (overrides: Partial<FnbDisplayState> = {}): FnbDisplayState => ({
    sessionKey: 'g', stage: 'payment', online: true, excluded: false,
    lines: [{ id: 'food-1', menuItem: { id: 'menu-1', name: 'Fries', category: 'c', price: { weekday: 90, weekend: 90 }, modifierGroups: [] },
      qty: 1, selectedModifiers: [], lineTotal: 90 }], orderNote: '', manualDiscounts: [],
    quote: cartQuote(90, { lineTotals: { 'food-1': 90 }, itemPresentation: { 'food-1': { name: 'Fries', basePrice: 90, modifiers: [] } } }),
    pending: false, quoteFailed: false, payment, completedOrder: null, platformSale: null, ...overrides,
  });
  const merchState = (overrides: Partial<MerchDisplayState> = {}): MerchDisplayState => ({
    sessionKey: 'g', stage: 'payment', online: true, excluded: false,
    lines: [{ id: 'shop-1', merchItem: { id: 'item-1', name: 'Socks', active: true, price: { weekday: 90, weekend: 90 } }, qty: 1, lineTotal: 90 }],
    manualDiscounts: [],
    quote: cartQuote(90, { lineTotals: { 'shop-1': 90 }, itemPresentation: { 'shop-1': { name: 'Socks', basePrice: 90, modifiers: [] } } }),
    pending: false, quoteFailed: false, payment, completedOrder: null, platformSale: null, ...overrides,
  });
  const written = apiSale({ status: 'finalised', totals: { ...apiSale().totals, grossSatang: 9_000 } });

  it('F&B: the payment frame keeps the figure; a thank-you paid ฿50 credit + ฿40 cash lists both', () => {
    const frame = fnbDisplayPresentation(fnbState());
    expect(frame.cart.supported).toBe(true);
    expect(frame.payment).toMatchObject({ amountSatang: 4_000, creditSatang: 5_000 });
    expect(readDisplayFnbCart(frame.cart, 'payment')).not.toBeNull();
    const completed = { id: 'o', status: 'paid', pickupCode: 'G-1', total: 90, payment: { creditUsed: 50, cash: 40, card: 0, promptpay: 0 },
      wristband: { id: 'w', code: 'T1-7KMQ4X', customerNickname: 'Guest', creditBalanceTHB: 0, gateAccess: false } } as unknown as FnbOrder;
    const thanks = fnbDisplayPresentation(fnbState({ stage: 'thankyou', platformSale: written, completedOrder: completed }));
    expect(thanks.cart.completion).toEqual({ saleId: written.id, pickupCode: 'G-1', total: 90, payment: { cash: 40, card: 0, promptpay: 0, credit: 50 } });
    expect(JSON.stringify(thanks)).not.toMatch(/T1-7KMQ4X|Guest|creditBalance/);
    // A tender that does not add up is still refused.
    const short = { ...completed, payment: { ...completed.payment, cash: 30 } } as FnbOrder;
    expect(fnbDisplayPresentation(fnbState({ stage: 'thankyou', platformSale: written, completedOrder: short })).cart.supported).toBe(false);
  });

  it('shop: a purchase paid wholly with credit publishes its thank-you', () => {
    expect(merchDisplayPresentation(merchState()).payment).toMatchObject({ creditSatang: 5_000 });
    const completed = { id: 'o', status: 'paid', total: 90, payment: { creditUsed: 90, cash: 0, card: 0, promptpay: 0 },
      wristband: { id: 'w', code: 'T1-7KMQ4X', customerNickname: 'Guest', creditBalanceTHB: 0, gateAccess: false } } as unknown as MerchOrder;
    const thanks = merchDisplayPresentation(merchState({ stage: 'thankyou', platformSale: written, completedOrder: completed }));
    expect(thanks.cart.completion).toEqual({ saleId: written.id, total: 90, payment: { cash: 0, card: 0, promptpay: 0, credit: 90 } });
    expect(readDisplayMerchCart(thanks.cart, 'thankyou')?.completion?.payment.credit).toBe(90);
    expect(JSON.stringify(thanks)).not.toMatch(/T1-7KMQ4X|Guest/);
  });
});

describe('the public displays draw the rows from the figure', () => {
  const totals: DisplayTotals = { manualAmounts: {}, discountAmount: 0, total: 90, taxBreakdown: { serviceChargeTotal: 0, categories: [] } };
  const cart: DisplayMerchCart = { kind: 'merch', supported: true, lines: [{ id: 'l', name: 'Socks', qty: 1, unitPrice: 90, lineTotal: 90 }],
    manualDiscounts: [], completion: null };

  it('shop, payment: ฿50 from your credit, ฿40 left to pay; without credit, to pay', () => {
    const html = renderToStaticMarkup(React.createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart, totals, payment }));
    expect(html).toContain('merch.payment.fromCredit');
    expect(html).toContain('merch.payment.leftToPay');
    expect(html).toContain('฿50');
    expect(html).toContain('฿40');
    const plain = renderToStaticMarkup(React.createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart, totals,
      payment: { ...payment, amountSatang: 9_000, creditSatang: undefined } }));
    expect(plain).not.toContain('merch.payment.fromCredit');
    expect(plain).toContain('merch.payment.toPay');
    const qr = renderToStaticMarkup(React.createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart, totals,
      payment: { ...payment, status: 'pending', qrPayload: '00020101' } }));
    expect(qr).toContain('merch.payment.paidFromCredit');
  });

  it('shop, thank-you: the credit beside the cash', () => {
    const done: DisplayMerchCart = { ...cart, completion: { saleId: 's', total: 90, payment: { cash: 40, card: 0, promptpay: 0, credit: 50 } } };
    const html = renderToStaticMarkup(React.createElement(PublicMerchCustomerDisplay, { stage: 'thankyou', cart: done, totals }));
    expect(html).toContain('common.credit');
    expect(html).toContain('common.cash');
    expect(html).toContain('฿50');
    expect(html).toContain('฿40');
  });

  it('F&B, from the captured frame: payment rows and the thank-you credit', () => {
    const fnbCart = { kind: 'fnb' as const, supported: true, lines: [{ id: 'l', name: 'Fries', qty: 1, basePrice: 90, lineTotal: 90, modifiers: [] }],
      orderNote: '', manualDiscounts: [], completion: null };
    const html = renderToStaticMarkup(React.createElement(FnbCustomerDisplay, { stage: 'payment', presentation: { cart: fnbCart, totals }, payment }));
    expect(html).toContain('fnb.payment.fromCredit');
    expect(html).toContain('fnb.payment.leftToPay');
    const thanks = renderToStaticMarkup(React.createElement(FnbCustomerDisplay, { stage: 'thankyou', presentation: {
      cart: { ...fnbCart, completion: { saleId: 's', pickupCode: 'G-1', total: 90, payment: { cash: 40, card: 0, promptpay: 0, credit: 50 } } }, totals } }));
    expect(thanks).toContain('fnb.thankyou.fnbCredit');
    expect(thanks).toContain('฿50');
  });
});

describe('the credit card on the till says the lane’s refusal', () => {
  it('shows the words, unselected, with the whole amount owed in cash', () => {
    const wristband = { id: 'w', code: 'T1-7KMQ4X', customerNickname: 'Guest', creditBalanceTHB: 500, gateAccess: false } as Wristband;
    const stage = {
      state: { phase: 'failed', saleId: 'sale-1', method: 'cash', kind: 'cash', outstandingSatang: 9_000, amountSatang: 9_000, tenderedSatang: 9_000,
        attempt: null, route: null, qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
        error: BOX_LANE_REFUSALS.wallet.message, retryable: false, settlements: [], creditSatang: 0, creditSaleId: null, creditRefusedSaleId: 'sale-1' },
      display: { saleId: 'sale-1', amountSatang: 9_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'failed', offline: false, online: true, creditSatang: 0 },
      busy: false, online: true, locked: false, canBack: true, canSubmit: true, creditCoversAll: false, creditPendingSatang: 0,
      creditRefusal: BOX_LANE_REFUSALS.wallet.message, canInquire: false, canConfirm: false,
      selectMethod: () => undefined, setAmountSatang: () => undefined, setTenderedSatang: () => undefined,
      submit: async () => undefined, retry: async () => undefined, inquire: async () => undefined, confirm: async () => undefined, manual: async () => undefined,
    } as unknown as ReturnType<typeof usePaymentStage>;
    const html = renderToStaticMarkup(React.createElement(FnbPayment, { total: 90, wristband, pickupCode: '', stage, onBack: () => undefined,
      useCredit: false, onUseCreditChange: () => undefined }));
    expect(html).toContain(BOX_LANE_REFUSALS.wallet.message.replace(/'/g, '&#x27;').replace(/’/g, '’'));
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('covers full order');
  });
});

describe('a band the platform could not be asked about (finding 6)', () => {
  it('loads from the station’s own list without credit; a band it does not hold is refused in the right words', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new NetworkError('offline'));
    const held = await loadScannedTab('1001');
    expect(held.error).toBeNull();
    expect(held.wristband).toMatchObject({ code: '1001', creditBalanceTHB: 0 });
    const unknown = await loadScannedTab('9999');
    expect(unknown.wristband).toBeNull();
    expect(unknown.error).toContain('Could not reach the platform');
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This station may not read wallets'));
    const refused = await loadScannedTab('9999');
    expect(refused.error).toContain('This station may not read wallets');
    // A key no wallet carries is the unknown-code path, never an error.
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'WALLET_NOT_FOUND', 'No wallet'));
    expect(await loadScannedTab('9999')).toEqual({ wristband: null, error: null });
  });
});
