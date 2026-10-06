import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOX_WALLET_REFUSALS,
  BRIDGE_CHECKIN_INTENTS,
  BRIDGE_WALLET_INTENTS,
  walletOfflineCapMessage,
  type BridgeWalletBalance,
  type DisplayMerchCart,
  type DisplayTotals,
} from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import type { ApiSalePrintJob } from '@/api/history';
import type { IssuableDefinition } from '@/api/vouchers';
import { reportsCreditVoucher } from '@/lib/salePrinting';
import { currentLane, noteLaneFailure, setLaneStation } from '@/lib/lane';
import { VOUCHER_AFTER_PAY, VOUCHER_NEEDS_TIER, VOUCHER_NOT_COMBINABLE, ticketTillVoucherBlock } from '@/lib/tillVoucher';
import type { usePaymentStage } from '@/lib/usePaymentStage';
import { FnbCustomerDisplay } from '@/components/fnb/FnbCustomerDisplay';
import { FnbPayment } from '@/components/fnb/FnbPayment';
import { loadScannedTab } from '@/components/fnb/ScanWristband';
import { PublicMerchCustomerDisplay } from '@/components/merch/PublicMerchCustomerDisplay';
import { IssueVoucherRow, definitionUsedUp } from '@/components/till/RedeemVoucher';
import { paymentSubmitLabel } from '@/components/till/PaymentTenderPanel';
import * as paymentMethods from '@/lib/payments';

/**
 * THE STAGING WALKTHROUGH'S FINDINGS ON THE TILL'S SURFACES (wallet story):
 *
 *   F1  the "Credit Grants to Print" block is decided from the sale read's
 *       print jobs, which now carry the credit vouchers (subject: the wallet);
 *   F2  the guest displays never ask a guest whose credit covers the order to
 *       pay, and show the rest — not the whole order — on a split;
 *   F3  a band scanned while the counter works through its box is looked up on
 *       the box (`wallet.lookup`), its refusals in the box's words;
 *   F4  a used-up promotion is greyed in the Issue picker;
 *   F6  the ticket till refuses a voucher before a customer type is chosen;
 *   F7  the open Issue row wraps inside the order panel.
 */
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ operator: null, can: () => false }) }));
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.restoreAllMocks();
});
afterEach(() => {
  setLaneStation(null);
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

it('keeps the ticket confirmation wording for cash and no selection while preserving device and completion states', () => {
  vi.spyOn(paymentMethods, 'findPaymentMethod').mockImplementation((id) => ({
    id, label: id, kind: id as 'cash' | 'card' | 'qr', enabled: true, sortOrder: 0,
  }));
  const stage = { busy: false, creditCoversAll: false, state: { method: null, outstandingSatang: 10000 } } as unknown as ReturnType<typeof usePaymentStage>;
  const caption = () => paymentSubmitLabel(stage, 'Confirm Payment Received');
  expect(caption()).toBe('Confirm Payment Received');
  stage.state.method = 'cash';
  expect(caption()).toBe('Confirm Payment Received');
  stage.state.method = 'card';
  expect(caption()).toBe('Start card payment');
  stage.state.method = 'qr';
  expect(caption()).toBe('Show payment QR');
  stage.busy = true;
  expect(caption()).toBe(paymentSubmitLabel(stage));
  expect(caption()).not.toBe('Confirm Payment Received');
  stage.busy = false;
  stage.state.outstandingSatang = 0;
  expect(caption()).toBe(paymentSubmitLabel(stage));
  expect(caption()).not.toBe('Confirm Payment Received');
});

// --- F1 ------------------------------------------------------------------------------

describe('F1 — the Credit Grants block follows the sale read', () => {
  const job = (kind: string, subjectType: string, over: Partial<ApiSalePrintJob> = {}): ApiSalePrintJob =>
    ({ id: `${kind}-${subjectType}`, kind, role: 'receipt', status: 'queued', stationId: null, deviceId: null, deviceLabel: 'Receipt printer',
      subjectType, subjectId: 's', reprintOf: null, reprintReason: null, requestedByName: null, errorCode: null, errorMessage: null,
      queuedAt: '2026-10-01T17:53:10.000Z', finishedAt: null, ...over }) as ApiSalePrintJob;

  it('Eat & Play (the read now carries its credit vouchers): the block shows', () => {
    const read = [job('receipt', 'sale'), job('kids_wristband', 'band'), job('adult_wristband', 'band'),
      job('credit_voucher', 'wallet'), job('credit_voucher', 'wallet', { id: 'v2' })];
    expect(reportsCreditVoucher(read)).toBe(true);
  });

  it('a sale that granted nothing — and the read as staging saw it before the fix — keeps it hidden', () => {
    expect(reportsCreditVoucher([job('receipt', 'sale'), job('kids_wristband', 'band'), job('adult_wristband', 'band')])).toBe(false);
  });
});

// --- F2 ------------------------------------------------------------------------------

describe('F2 — the guest displays: left to pay is the order less the credit', () => {
  const totals = (total: number): DisplayTotals => ({ manualAmounts: {}, discountAmount: 0, total, taxBreakdown: { serviceChargeTotal: 0, categories: [] } });
  const pay = (amountSatang: number, creditSatang?: number) => ({ saleId: 'sale-1', amountSatang, qrPayload: null, qrImageUrl: null,
    expiresAt: null, status: 'idle' as const, offline: false, online: true, ...(creditSatang !== undefined ? { creditSatang } : {}) });
  const fnbCart = { kind: 'fnb' as const, supported: true, lines: [{ id: 'l', name: 'Fries', qty: 1, basePrice: 60, lineTotal: 60, modifiers: [] }],
    orderNote: '', manualDiscounts: [], completion: null };
  const merchCart: DisplayMerchCart = { kind: 'merch', supported: true, lines: [{ id: 'l', name: 'Socks', qty: 1, unitPrice: 60, lineTotal: 60 }],
    manualDiscounts: [], completion: null };
  const fnb = (total: number, payment: ReturnType<typeof pay>) =>
    html(React.createElement(FnbCustomerDisplay, { stage: 'payment', presentation: { cart: fnbCart, totals: totals(total) }, payment }));
  const merch = (total: number, payment: ReturnType<typeof pay>) =>
    html(React.createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchCart, totals: totals(total), payment }));

  it('credit covers the order (the staging frame: ฿60 credit, ฿60 still in the amount): ฿0, and the guest is not asked to pay', () => {
    for (const [out, ns] of [[fnb(60, pay(6_000, 6_000)), 'fnb'], [merch(60, pay(6_000, 6_000)), 'merch']] as const) {
      expect(out).toContain(`${ns}.payment.fromCredit`);
      expect(out).toContain('฿60');
      expect(out).toContain('฿0');
      expect(out).toContain(`${ns}.payment.coveredByCredit`);
      expect(out).not.toContain(`${ns}.payment.confirmWithStaff`);
    }
  });

  it('a split (฿350 credit on ฿360, the whole order still in the amount): left to pay ฿10', () => {
    for (const [out, ns] of [[fnb(360, pay(36_000, 35_000)), 'fnb'], [merch(360, pay(36_000, 35_000)), 'merch']] as const) {
      expect(out).toContain(`${ns}.payment.leftToPay`);
      expect(out).toContain('฿10<');
      expect(out).not.toContain('฿360<');
      expect(out).toContain(`${ns}.payment.confirmWithStaff`);
    }
  });

  it('no credit: to pay, the whole order, as before', () => {
    for (const [out, ns] of [[fnb(360, pay(36_000)), 'fnb'], [merch(360, pay(36_000)), 'merch']] as const) {
      expect(out).toContain(`${ns}.payment.toPay`);
      expect(out).toContain('฿360<');
      expect(out).not.toContain(`${ns}.payment.fromCredit`);
      expect(out).toContain(`${ns}.payment.confirmWithStaff`);
    }
  });
});

// --- F3 ------------------------------------------------------------------------------

const KEY = 'QR-MRKD90Z65F1ESEQMVSPV';
const balance = (over: Partial<BridgeWalletBalance> = {}): BridgeWalletBalance => ({
  walletId: '01a0f899-49d8-70f6-81d8-52e8e5c213ff', balanceSatang: 35_000, capLeftSatang: 30_000, capSatang: 30_000,
  spendableSatang: 30_000, snapshotAt: '2026-10-01T18:10:32.987Z', source: 'snapshot', ...over,
});
const noStay = { stay: null, cacheAppliedAt: '2026-10-01T18:10:32.987Z', prepaidItemsOnlineOnly: true };

/** The till on its box: a station picked, and a dropped link already met. */
function onBoxLane(): void {
  setLaneStation('station-1');
  noteLaneFailure(new NetworkError('offline'));
  expect(currentLane()).toBe('box');
}

describe('F3 — a band scanned on the box lane is looked up on the box', () => {
  it('asks the box (wallet.lookup), never the platform, and offers what the box will take here', async () => {
    onBoxLane();
    const get = vi.spyOn(api, 'get');
    const intent = vi.spyOn(bridgeApi, 'intent')
      .mockResolvedValueOnce({ document: {} as never, result: noStay })
      .mockResolvedValueOnce({ document: {} as never, result: { wallet: balance() } });
    const found = await loadScannedTab(KEY);
    expect(get).not.toHaveBeenCalled();
    expect(intent).toHaveBeenCalledWith('station-1', BRIDGE_CHECKIN_INTENTS.bandFood, { key: KEY });
    expect(intent).toHaveBeenCalledWith('station-1', BRIDGE_WALLET_INTENTS.lookup, { key: KEY });
    expect(found.error).toBeNull();
    // ฿350 held, ฿300 under the cap: the tab offers ฿300 and spends by the scanned key.
    expect(found.wristband).toMatchObject({ id: balance().walletId, code: KEY, creditBalanceTHB: 300 });
    expect(found.wristband?.creditNote).toBeUndefined();
  });

  it('a platform call that meets a dropped link moves this scan to the box', async () => {
    setLaneStation('station-1');
    vi.spyOn(api, 'get').mockRejectedValue(new NetworkError('offline'));
    const intent = vi.spyOn(bridgeApi, 'intent')
      .mockResolvedValueOnce({ document: {} as never, result: noStay })
      .mockResolvedValueOnce({ document: {} as never, result: { wallet: balance() } });
    const found = await loadScannedTab(KEY);
    expect(intent).toHaveBeenCalledTimes(2);
    expect(currentLane()).toBe('box');
    expect(found.wristband?.creditBalanceTHB).toBe(300);
  });

  it('the day’s cap reached: the tab opens at ฿0 with the box’s cap sentence, which the credit card shows verbatim', async () => {
    onBoxLane();
    vi.spyOn(bridgeApi, 'intent')
      .mockResolvedValueOnce({ document: {} as never, result: noStay })
      .mockResolvedValueOnce({ document: {} as never,
        result: { wallet: balance({ balanceSatang: 29_000, capLeftSatang: 0, spendableSatang: 0 }) } });
    const found = await loadScannedTab(KEY);
    const words = walletOfflineCapMessage(30_000);
    expect(found.wristband).toMatchObject({ creditBalanceTHB: 0, creditNote: words });
    const stage = {
      state: { phase: 'ready', saleId: null, method: null, kind: null, outstandingSatang: 6_000, amountSatang: 6_000, tenderedSatang: 6_000,
        attempt: null, route: null, qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
        error: null, retryable: false, settlements: [], creditSatang: 0, creditSaleId: null, creditRefusedSaleId: null },
      display: { saleId: null, amountSatang: 6_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true, creditSatang: 0 },
      busy: false, online: true, locked: false, canBack: true, canSubmit: true, creditCoversAll: false, creditPendingSatang: 0,
      creditRefusal: null, canInquire: false, canConfirm: false,
      selectMethod: () => undefined, setAmountSatang: () => undefined, setTenderedSatang: () => undefined,
      submit: async () => undefined, retry: async () => undefined, inquire: async () => undefined, confirm: async () => undefined, manual: async () => undefined,
    } as unknown as ReturnType<typeof usePaymentStage>;
    const out = html(React.createElement(FnbPayment, { total: 60, wristband: found.wristband, pickupCode: '', stage, onBack: () => undefined,
      useCredit: true, onUseCreditChange: () => undefined }));
    expect(out).toContain('data-testid="credit-note"');
    expect(out).toContain(words);
  });

  it('an expired wallet opens at ฿0 with the box’s words; a key the box has no copy of is refused in its words', async () => {
    onBoxLane();
    const expired = "This wallet's credit has expired — only a manager can bring it back. Take the order in cash or card.";
    const intent = vi.spyOn(bridgeApi, 'intent')
      .mockResolvedValueOnce({ document: {} as never, result: noStay })
      .mockRejectedValueOnce(new ApiError(409, 'WALLET_EXPIRED', expired, { walletId: 'w-old' }));
    const old = await loadScannedTab('QR-OLDOLDOLDOLDOLDOLDOL');
    expect(old).toEqual({ wristband: expect.objectContaining({ id: 'w-old', creditBalanceTHB: 0, creditNote: expired }), error: null });

    intent.mockResolvedValueOnce({ document: {} as never, result: noStay }).mockRejectedValueOnce(
      new ApiError(404, BOX_WALLET_REFUSALS.unknown.code, BOX_WALLET_REFUSALS.unknown.message));
    expect(await loadScannedTab('QR-NOTONTHEBOXATALL000')).toEqual({ wristband: null, error: BOX_WALLET_REFUSALS.unknown.message });

    // A band the station holds itself still opens, its notes kept, with the box's words.
    intent.mockResolvedValueOnce({ document: {} as never, result: noStay }).mockRejectedValueOnce(
      new ApiError(404, BOX_WALLET_REFUSALS.unknown.code, BOX_WALLET_REFUSALS.unknown.message));
    const held = await loadScannedTab('1001');
    expect(held.wristband).toMatchObject({ code: '1001', creditBalanceTHB: 0, creditNote: BOX_WALLET_REFUSALS.unknown.message });
  });

  it('the online path is unchanged: the platform answers and the box is not asked', async () => {
    setLaneStation('station-1');
    const intent = vi.spyOn(bridgeApi, 'intent');
    vi.spyOn(api, 'get').mockResolvedValue({
      wallet: { id: 'w', status: 'active', balanceSatang: 35_000, expiresAt: null, holderName: 'Walk-in guest', memberId: null,
        keys: [{ kind: 'voucher_qr', display: KEY }] },
      ledger: [],
    });
    const found = await loadScannedTab(KEY);
    expect(intent).not.toHaveBeenCalled();
    expect(found.wristband).toMatchObject({ id: 'w', creditBalanceTHB: 350 });
  });
});

// --- F4 / F7 ---------------------------------------------------------------------------

describe('F4 / F7 — the Issue a voucher row', () => {
  const def = (over: Partial<IssuableDefinition>): IssuableDefinition => ({
    id: 'd', code: 'c', nameEn: 'Promotion', nameTh: null, kind: 'discount', valueSatang: 10_000, valueBp: null,
    validFrom: null, validUntil: null, usageLimit: null, redeemed: 0, ...over,
  }) as IssuableDefinition;
  const row = (options: IssuableDefinition[], chosen = '') => html(React.createElement(IssueVoucherRow, {
    options, chosen, busy: false, answer: null, onChoose: () => undefined, onIssue: () => undefined, onClose: () => undefined,
  }));

  it('F4: a used-up promotion is greyed (disabled) and cannot be issued; one with uses left can', () => {
    const usedUp = def({ id: 'used', nameEn: 'ZZ TEST Wallet credit 100', usageLimit: 1, redeemed: 1 });
    const open = def({ id: 'open', nameEn: 'Open', usageLimit: 5, redeemed: 1 });
    expect(definitionUsedUp(usedUp)).toBe(true);
    expect(definitionUsedUp(open)).toBe(false);
    expect(definitionUsedUp(def({ usageLimit: null, redeemed: 99 }))).toBe(false);
    const out = row([usedUp, open]);
    expect(out).toMatch(/<option value="used" disabled="">ZZ TEST Wallet credit 100 \(1\/1 used\)<\/option>/);
    expect(out).toMatch(/<option value="open">Open \(1\/5 used\)<\/option>/);
    // Chosen anyway (a stale pick): the Issue button stays off.
    expect(row([usedUp], 'used')).toMatch(/<button[^>]*disabled=""[^>]*>Issue &amp; print<\/button>/);
  });

  it('F7: the row wraps inside the panel — the select can shrink, the buttons drop to their own line', () => {
    const out = row([def({ nameEn: 'A very long promotion name that is wider than the order panel itself (0/1 used)', usageLimit: 1 })]);
    const rowTag = /<div class="([^"]*)" data-testid="issue-voucher-row"/.exec(out)?.[1] ?? '';
    expect(rowTag.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'min-w-0']));
    const selectTag = /<select[^>]*class="([^"]*)"/.exec(out)?.[1] ?? '';
    expect(selectTag.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    const outer = /<div class="([^"]*)" data-testid="issue-voucher"/.exec(out)?.[1] ?? '';
    expect(outer.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
  });
});

// --- F6 --------------------------------------------------------------------------------

describe('F6 — no voucher before a customer type', () => {
  const at = (over: Partial<Parameters<typeof ticketTillVoucherBlock>[0]> = {}) =>
    ticketTillVoucherBlock({ typed: 'T1DH6NYG4W9', isPromoCode: false, afterPay: false, hasDiscounts: false, tierChosen: true, ...over });

  it('refused, in the till’s words, until the type is chosen — then asked of the platform', () => {
    expect(at({ tierChosen: false })).toBe(VOUCHER_NEEDS_TIER);
    expect(at()).toBeNull();
  });

  it('the earlier refusals keep their order', () => {
    expect(at({ isPromoCode: true, tierChosen: false })).toBe('"T1DH6NYG4W9" is a promo code — enter it in the promo code box');
    expect(at({ afterPay: true, tierChosen: false })).toBe(VOUCHER_AFTER_PAY);
    expect(at({ hasDiscounts: true, tierChosen: false })).toBe(VOUCHER_NOT_COMBINABLE);
  });
});
