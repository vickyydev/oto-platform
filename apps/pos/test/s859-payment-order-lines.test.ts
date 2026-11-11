import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readDisplayTenderCart,
  type DisplayFnbCart, type DisplayMerchCart, type DisplayPayment, type DisplayTenderCart, type DisplayTotals,
  type StationSessionDocument,
} from '@oto/shared';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { FnbCustomerDisplay } from '@/components/fnb/FnbCustomerDisplay';
import { MerchCustomerDisplay } from '@/components/merch/MerchCustomerDisplay';
import { PublicMerchCustomerDisplay } from '@/components/merch/PublicMerchCustomerDisplay';
import { TenderCustomerDisplay } from '@/components/shared/TenderCustomerDisplay';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import type { SupportedLang } from '@/i18n/types';
import { readTicketDisplayView, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import { fnbDisplayPresentation, type FnbDisplayState } from '@/lib/fnbDisplaySession';
import { merchDisplayPresentation, type MerchDisplayState } from '@/lib/merchDisplaySession';
import type { PaymentDisplayState } from '@/lib/usePaymentStage';
import type { CartLine, FnbOrderLine, MerchOrderLine, Sale, Wristband } from '@/types';
import { cartQuote } from './support/fixtures';

// The add-on grid reads a live store with no server snapshot, and says nothing of what is tested here.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-859 — THE CUSTOMER'S PAYMENT SCREEN SHOWS THE FULL ORDER.
 *
 * The owner (8 and 12 November): "The customer-facing payment screen should
 * show the full order details, not just the final amount." Every customer
 * display drew the lines on its order stage and then, at payment, only the
 * amount. Now each draws its order stage's own line cards and footer rows
 * beside the amount block — the figure the till charges, never one worked out
 * again on the display — in one shared frame whose list scrolls inside its own
 * area so a long order never pushes the amount or the QR off the screen.
 *
 * Covered here: the ticket till (cash, QR, complimentary, a 25-line order, the
 * fallbacks that keep today's screen), F&B (captured and legacy, cash, QR,
 * credit), the shop (paired and split-view), the tender display (a named line
 * beside the QR or the card amount; none keeps today's screen), and the paired
 * display's payloads, which already carried the lines at payment and are read
 * back into the same components.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const KID_PRICE = 690;

const ticketLine = (n: number): CartLine => ({
  id: `line-${n}`, tier: 'tourist', kids: 1, adults: 0, socks: 0, addOns: [], lineTotal: KID_PRICE,
  ticketType: { id: `ticket-${n}`, name: `ZZ TEST Play ${n}`, durationLabel: '1 hour', hours: 1,
    prices: { tourist: { weekday: KID_PRICE, weekend: KID_PRICE } }, adultRules: { tourist: { kind: 'free_adults', freeAdults: 1 } } },
});

const sale = (lines: number, overrides: Partial<Sale> = {}): Sale => ({
  id: 'sale-859', operatorId: 'private-staff-id', operatorName: 'Private staff', tier: 'tourist', total: lines * KID_PRICE,
  lines: Array.from({ length: lines }, (_, index) => ticketLine(index + 1)),
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: lines }, createdAt: '', status: 'paid', refunds: [],
  ...overrides,
});

const payment = (amountSatang: number, overrides: Partial<PaymentDisplayState> = {}): PaymentDisplayState => ({
  saleId: 'sale-859', amountSatang, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true,
  creditSatang: 0, ...overrides,
});

const QR_IMAGE = 'https://pay.example.test/zz-test-qr.png';
const EXPIRES = new Date(Date.now() + 5 * 60_000).toISOString();

/** The customer screen as a guest reads it, in `lang`. */
function under(lang: SupportedLang, element: ReactElement): string {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-859', children: element }));
}

/** The markup of one `data-testid` block, by its opening tag onward (the blocks here nest in document order). */
function from(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `${testId} is drawn`).toBeGreaterThan(-1);
  return html.slice(at);
}
function between(html: string, testId: string, nextTestId: string): string {
  const start = from(html, testId);
  const end = start.indexOf(`data-testid="${nextTestId}"`);
  expect(end, `${nextTestId} follows ${testId}`).toBeGreaterThan(0);
  return start.slice(0, end);
}

const ticketDisplay = (props: Partial<Parameters<typeof CustomerDisplay>[0]> & { sale: Sale }, lang: SupportedLang = 'en') =>
  under(lang, createElement(CustomerDisplay, {
    stage: 'payment', phone: '', nickname: 'ZZ TEST guardian', member: null,
    onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined, onCustomerDone: () => undefined,
    totals: cartQuote(props.sale.total).totals, payment: payment(props.sale.total * 100),
    ...props,
  }));

describe('SCRUM-859: the ticket till’s customer screen at the payment stage', () => {
  it('cash: the order’s lines, its total and "Please pay" the charged amount, lines before the amount', () => {
    const html = ticketDisplay({ sale: sale(2, { paymentMethod: 'cash' }) });
    const t = tFor('en');
    expect(html).toContain('data-testid="customer-payment"');
    const lines = between(html, 'payment-order-lines', 'payment-order-summary');
    expect(lines).toContain('ZZ TEST Play 1');
    expect(lines).toContain('ZZ TEST Play 2');
    expect(lines).toContain(`฿${KID_PRICE}`);
    const summary = between(html, 'payment-order-summary', 'payment-amount');
    expect(summary).toContain(t('common.total'));
    expect(summary).toContain(`฿${2 * KID_PRICE}`);
    const amount = from(html, 'payment-amount');
    expect(amount).toContain(t('common.pleasePay'));
    expect(amount).toContain(`฿${(2 * KID_PRICE).toFixed(2)}`);
    expect(amount).toContain(t('common.toStaff'));
    expect(amount).toContain(t('common.payingBy', { method: '' }).trim());
    // The header the order stage draws: the brand and "Your Order".
    expect(html).toContain(t('till.order.yourOrder'));
  });

  it('the lines and the total are the order stage’s own: the same card and the same total row', () => {
    const order = ticketDisplay({ sale: sale(1), stage: 'order' });
    const paid = ticketDisplay({ sale: sale(1, { paymentMethod: 'cash' }) });
    const card = (html: string) => {
      const start = html.indexOf('ZZ TEST Play 1');
      return html.slice(html.lastIndexOf('<div class="bg-foreground/5 rounded-3xl', start), html.indexOf('</div></div></div>', start));
    };
    expect(card(paid)).toBe(card(order));
    const totalRow = `<span class="text-2xl text-foreground/70">${tFor('en')('common.total')}</span><span class="text-5xl font-black text-primary">฿${KID_PRICE}</span>`;
    expect(order).toContain(totalRow);
    expect(paid).toContain(totalRow);
  });

  it('QR: the code and its timer stay drawn, with the lines and the amount', () => {
    const html = ticketDisplay({ sale: sale(2, { paymentMethod: 'promptpay' }),
      payment: payment(2 * KID_PRICE * 100, { status: 'pending', qrImageUrl: QR_IMAGE, expiresAt: EXPIRES }) });
    const t = tFor('en');
    expect(between(html, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Play 2');
    const amount = from(html, 'payment-amount');
    expect(amount).toContain('data-testid="payment-qr"');
    expect(amount).toContain(QR_IMAGE);
    expect(amount).toContain('data-testid="payment-qr-countdown"');
    expect(amount).toContain(t('till.payment.scanToPay'));
    expect(amount).toContain(t('till.payment.timeLeft'));
    expect(amount).toContain(`฿${(2 * KID_PRICE).toFixed(2)}`);
    expect(amount).toContain(t('till.payment.openBankingApp'));
  });

  it('the amount is the stage’s figure, never a sum of the lines drawn beside it', () => {
    // A partial payment: ฿500 still owed on a ฿1380 order. The lines and the
    // total read the order; the block reads the stage.
    const html = ticketDisplay({ sale: sale(2, { paymentMethod: 'cash' }), payment: payment(50_000) });
    expect(between(html, 'payment-order-summary', 'payment-amount')).toContain(`฿${2 * KID_PRICE}`);
    expect(from(html, 'payment-amount')).toContain('฿500.00');
    expect(from(html, 'payment-amount')).not.toContain(`฿${(2 * KID_PRICE).toFixed(2)}`);
  });

  it('a 25-line order scrolls inside its own area and keeps the amount block out of it', () => {
    const html = ticketDisplay({ sale: sale(25, { paymentMethod: 'cash' }) });
    const lines = between(html, 'payment-order-lines', 'payment-order-summary');
    for (let n = 1; n <= 25; n += 1) expect(lines).toContain(`ZZ TEST Play ${n}`);
    // The list: a flex child that may shrink to its minimum and scrolls.
    expect(html).toMatch(/class="flex-1 min-h-0 overflow-y-auto p-8 space-y-4" data-testid="payment-order-lines"/);
    // The order column keeps a minimum of its own; the amount block keeps its
    // size while there is room, and scrolls within itself rather than off the
    // screen when there is not.
    expect(html).toMatch(/class="flex-1 min-h-40 @4xl:min-h-0 min-w-0 flex flex-col" data-testid="payment-order"/);
    expect(html).toMatch(/class="shrink min-h-0 overflow-y-auto @4xl:shrink-0 @4xl:w-\[26rem\][^"]*" data-testid="payment-amount"/);
    // One amount, after every line.
    expect(html.split(`฿${(25 * KID_PRICE).toFixed(2)}`).length - 1).toBe(1);
    expect(html.indexOf('data-testid="payment-amount"')).toBeGreaterThan(html.lastIndexOf('ZZ TEST Play 25'));
    // The frame reads its own width, not the viewport's: two columns from 56rem.
    expect(html).toContain('@container');
    expect(html).toContain('@4xl:flex-row');
  });

  it('nothing to pay: the complimentary block beside the order it covers', () => {
    const free = sale(1, { total: 0 });
    const html = ticketDisplay({ sale: free, totals: cartQuote(0).totals, payment: payment(0), nothingToPay: true,
      voucherPrize: { nameEn: 'Golden Ticket', nameTh: null } });
    expect(html).toContain('data-testid="customer-nothing-to-pay"');
    expect(html).toContain(tFor('en')('till.order.complimentary'));
    expect(html).toContain('Golden Ticket');
    expect(between(html, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Play 1');
  });

  it('a sale with no lines, and a price still pending, keep the screens they had', () => {
    const none = ticketDisplay({ sale: sale(0, { paymentMethod: 'cash' }), totals: cartQuote(0).totals, payment: payment(0) });
    expect(none).not.toContain('data-testid="customer-payment"');
    expect(none).toContain(tFor('en')('common.pleasePay'));
    const pending = ticketDisplay({ sale: sale(2), pricePending: true });
    expect(pending).toContain('data-testid="customer-price-pending"');
    expect(pending).not.toContain('data-testid="customer-payment"');
    expect(pending).not.toContain('ZZ TEST Play 1');
    const paid = ticketDisplay({ sale: sale(2), payment: payment(0, { status: 'paid' }) });
    expect(paid).toContain('data-testid="customer-payment-paid"');
    expect(paid).not.toContain('data-testid="customer-payment"');
  });

  it('reads in the guest’s language, with no English of its own', () => {
    for (const lang of ['th', 'zh', 'ru', 'fr'] as const) {
      const html = ticketDisplay({ sale: sale(1, { paymentMethod: 'cash' }) }, lang);
      expect(html, lang).toContain(tFor(lang)('common.pleasePay'));
      expect(html, lang).toContain(tFor(lang)('till.order.yourOrder'));
      expect(html, lang).not.toContain('Please pay');
      expect(html, lang).not.toContain('Your Order');
    }
  });
});

const fnbCart: DisplayFnbCart = { kind: 'fnb', supported: true, orderNote: 'ZZ TEST no ice', manualDiscounts: [], completion: null,
  lines: [
    { id: 'f-1', name: 'ZZ TEST Fries', qty: 2, basePrice: 90, lineTotal: 230, modifiers: [{ groupName: 'Sauce', optionName: 'Cheese sauce', price: 25 }] },
    { id: 'f-2', name: 'ZZ TEST Cola', qty: 1, basePrice: 60, lineTotal: 60, modifiers: [] },
  ] };
const fnbTotals: DisplayTotals = { manualAmounts: {}, discountAmount: 0, total: 290, taxBreakdown: { serviceChargeTotal: 0, categories: [] } };
const fnbPayment = (overrides: Partial<DisplayPayment> = {}): DisplayPayment => ({ saleId: 'sale-f', amountSatang: 29_000, qrPayload: null,
  qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true, ...overrides });

describe('SCRUM-859: the F&B customer screen at the payment stage', () => {
  const fnb = (props: Partial<Parameters<typeof FnbCustomerDisplay>[0]> = {}) =>
    under('en', createElement(FnbCustomerDisplay, { stage: 'payment', presentation: { cart: fnbCart, totals: fnbTotals }, payment: fnbPayment(), ...props }));

  it('cash: the lines with their options and note, the total, and "Amount to pay"', () => {
    const html = fnb();
    const t = tFor('en');
    const lines = between(html, 'payment-order-lines', 'payment-order-summary');
    expect(lines.split('data-testid="fnb-display-line"').length - 1).toBe(2);
    expect(lines).toContain('ZZ TEST Fries');
    expect(lines).toContain('Cheese sauce');
    expect(lines).toContain('ZZ TEST no ice');
    expect(between(html, 'payment-order-summary', 'payment-amount')).toContain('฿290');
    const amount = from(html, 'payment-amount');
    expect(amount).toContain(t('fnb.payment.amountToPay'));
    expect(amount).toContain(t('fnb.payment.toPay'));
    expect(amount).toContain('฿290');
    expect(amount).toContain(t('fnb.payment.confirmWithStaff'));
    expect(html).toContain(t('fnb.header.yourOrder'));
  });

  it('QR: the code and its timer with the lines; credit: its rows with the lines', () => {
    const qr = fnb({ payment: fnbPayment({ status: 'pending', qrImageUrl: QR_IMAGE, expiresAt: EXPIRES }) });
    expect(between(qr, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Cola');
    const block = from(qr, 'payment-amount');
    expect(block).toContain('data-testid="payment-qr"');
    expect(block).toContain('data-testid="payment-qr-countdown"');
    expect(block).toContain(tFor('en')('fnb.payment.scanToPay'));
    expect(block).toContain('฿290');
    const credit = fnb({ payment: fnbPayment({ creditSatang: 5_000 }) });
    expect(between(credit, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Fries');
    expect(from(credit, 'payment-amount')).toContain(tFor('en')('fnb.payment.fromCredit'));
    expect(from(credit, 'payment-amount')).toContain('฿50');
    expect(from(credit, 'payment-amount')).toContain(tFor('en')('fnb.payment.leftToPay'));
    expect(from(credit, 'payment-amount')).toContain('฿240');
  });

  it('the till’s own harness with a wristband draws the same frame from its own lines', () => {
    const lines: FnbOrderLine[] = [{ id: 'l-1', qty: 1, selectedModifiers: [], lineTotal: 90,
      menuItem: { id: 'm-1', name: 'ZZ TEST Toast', category: 'c', price: { weekday: 90, weekend: 90 }, modifierGroups: [] } }];
    const wristband = { id: 'w', code: 'ZZ-TEST', customerNickname: 'ZZ TEST Guest', creditBalanceTHB: 500, gateAccess: false } as Wristband;
    const html = under('en', createElement(FnbCustomerDisplay, { stage: 'payment', wristband, lines, total: 90,
      taxBreakdown: { netSubtotal: 90, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: 90, serviceChargeTotal: 0, categories: [] },
      payment: fnbPayment({ amountSatang: 9_000 }) }));
    expect(between(html, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Toast');
    expect(from(html, 'payment-amount')).toContain('฿90');
    expect(html).toContain('ZZ TEST Guest');
  });

  it('an order with no lines keeps the amount-only screen', () => {
    const html = fnb({ presentation: { cart: { ...fnbCart, lines: [], orderNote: '' }, totals: fnbTotals } });
    expect(html).not.toContain('data-testid="customer-payment"');
    expect(html).toContain(tFor('en')('fnb.payment.amountToPay'));
  });
});

const merchCart: DisplayMerchCart = { kind: 'merch', supported: true, manualDiscounts: [], completion: null,
  lines: [{ id: 's-1', name: 'ZZ TEST Socks', qty: 2, unitPrice: 90, lineTotal: 180, variantLabel: 'M' },
    { id: 's-2', name: 'ZZ TEST Cap', qty: 1, unitPrice: 250, lineTotal: 250 }] };
const merchTotals: DisplayTotals = { manualAmounts: {}, discountAmount: 0, total: 430, taxBreakdown: { serviceChargeTotal: 0, categories: [] } };

describe('SCRUM-859: the shop’s customer screens at the payment stage', () => {
  it('paired display, cash and QR: the lines, the total and the amount block', () => {
    const cash = under('en', createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchCart, totals: merchTotals,
      payment: fnbPayment({ amountSatang: 43_000 }) }));
    const lines = between(cash, 'payment-order-lines', 'payment-order-summary');
    expect(lines.split('data-testid="merch-display-line"').length - 1).toBe(2);
    expect(lines).toContain('ZZ TEST Socks');
    expect(between(cash, 'payment-order-summary', 'payment-amount')).toContain('฿430');
    expect(from(cash, 'payment-amount')).toContain(tFor('en')('merch.payment.amountToPay'));
    expect(from(cash, 'payment-amount')).toContain('฿430');
    const qr = under('en', createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchCart, totals: merchTotals,
      payment: fnbPayment({ amountSatang: 43_000, status: 'pending', qrImageUrl: QR_IMAGE, expiresAt: EXPIRES }) }));
    expect(between(qr, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Cap');
    expect(from(qr, 'payment-amount')).toContain('data-testid="payment-qr"');
    expect(from(qr, 'payment-amount')).toContain('data-testid="payment-qr-countdown"');
    expect(from(qr, 'payment-amount')).toContain(tFor('en')('merch.payment.scanToPay'));
  });

  it('paired display: a document without totals (an older till) keeps the amount-only screen', () => {
    const html = under('en', createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchCart, payment: fnbPayment({ amountSatang: 43_000 }) }));
    expect(html).not.toContain('data-testid="customer-payment"');
    expect(html).toContain(tFor('en')('merch.payment.amountToPay'));
    expect(html).toContain('฿430');
  });

  it('the till’s own harness with a wristband draws the same frame from its own lines', () => {
    const lines: MerchOrderLine[] = [{ id: 'l-1', qty: 1, lineTotal: 250,
      merchItem: { id: 'i-1', name: 'ZZ TEST Cap', active: true, price: { weekday: 250, weekend: 250 } } }];
    const html = under('en', createElement(MerchCustomerDisplay, { stage: 'payment', wristband: null, lines, manualDiscounts: [], total: 250,
      taxBreakdown: { netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: 250, serviceChargeTotal: 0, categories: [] } as never,
      promptpayAmount: null, completedOrder: null, newBalance: null, payment: fnbPayment({ amountSatang: 25_000 }) }));
    expect(between(html, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Cap');
    expect(between(html, 'payment-order-summary', 'payment-amount')).toContain('฿250');
    expect(from(html, 'payment-amount')).toContain(tFor('en')('merch.payment.toPay'));
  });
});

describe('SCRUM-859: the tender display', () => {
  const tenderPayment: DisplayPayment = { saleId: 'sale-t', amountSatang: 60_000, qrPayload: 'ZZ TEST payload', qrImageUrl: null,
    expiresAt: EXPIRES, status: 'pending', offline: false, online: true };
  const base: DisplayTenderCart = { kind: 'tender', supported: true, subject: 'extra_hour', method: 'qr' };

  it('a named line beside the QR, and beside the card amount; the total is the payment’s own', () => {
    const lines = [{ label: '+1 hour', qty: 2, unitPrice: 300, lineTotal: 600 }];
    const qr = under('en', createElement(TenderCustomerDisplay, { cart: { ...base, lines }, payment: tenderPayment }));
    expect(qr).toContain('data-testid="customer-payment"');
    const drawn = between(qr, 'payment-order-lines', 'payment-order-summary');
    expect(drawn).toContain('data-testid="tender-display-line"');
    expect(drawn).toContain('+1 hour');
    expect(drawn).toContain(tFor('en')('display.price.each', { price: '300' }));
    expect(between(qr, 'payment-order-summary', 'payment-amount')).toContain('฿600');
    expect(from(qr, 'payment-amount')).toContain('data-testid="payment-qr-countdown"');
    expect(from(qr, 'payment-amount')).toContain(tFor('en')('till.payment.scanToPay'));
    expect(from(qr, 'payment-amount')).toContain('฿600');
    const card = under('en', createElement(TenderCustomerDisplay, { cart: { ...base, method: 'card', subject: 'event_pass',
      lines: [{ label: 'ZZ TEST Party', qty: 1, lineTotal: 600 }] }, payment: tenderPayment }));
    expect(between(card, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Party');
    expect(from(card, 'payment-amount')).toContain(tFor('en')('display.tender.payByCard'));
    expect(from(card, 'payment-amount')).toContain('฿600');
    expect(card).not.toContain('data-testid="payment-qr"');
  });

  it('a cart without lines — the party balance, a till built before this — keeps the amount-only screen', () => {
    const older = readDisplayTenderCart({ kind: 'tender', supported: true, subject: 'party_balance', method: 'qr' }, 'payment');
    expect(older).toEqual({ kind: 'tender', supported: true, subject: 'party_balance', method: 'qr' });
    const html = under('en', createElement(TenderCustomerDisplay, { cart: older!, payment: tenderPayment }));
    expect(html).not.toContain('data-testid="customer-payment"');
    expect(html).toContain(tFor('en')('display.tender.partyBalance'));
    expect(html).toContain('data-testid="payment-qr-countdown"');
    expect(html).toContain('฿600');
    // The cart with lines reads back with them; a line the schema cannot read is not a cart at all.
    expect(readDisplayTenderCart({ ...base, lines: [{ label: 'x', qty: 1, lineTotal: 600 }] }, 'payment')?.lines).toEqual([{ label: 'x', qty: 1, lineTotal: 600 }]);
    expect(readDisplayTenderCart({ ...base, lines: [{ label: 'x', qty: 0, lineTotal: 600 }] }, 'payment')).toBeNull();
  });
});

describe('SCRUM-859: the paired display’s payloads carry the lines at payment', () => {
  const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
    stationId: 'zz-station', boxId: 'box-1', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
    takeoverCount: 0, updatedAt: '2026-11-12T12:00:00.000Z', ...overrides,
  });
  const tillState = (overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => ({
    stage: 'payment', step: 5, sessionKey: 'sale-0', tier: 'tourist', phone: '+66898020001', nickname: 'ZZ TEST guardian',
    contactChannel: 'whatsapp', member: null, sale: sale(2, { paymentMethod: 'cash' }), totals: cartQuote(2 * KID_PRICE).totals,
    rateMode: 'weekday', online: true, payment: payment(2 * KID_PRICE * 100), voucherPrize: null, nothingToPay: false, ...overrides,
  });

  it('ticket till: the published document names every line, and the display reads them back into the same screen', () => {
    const sent = ticketDisplayPresentation(tillState(), 'prompt-1');
    expect(sent.stage).toBe('payment');
    expect('sale' in sent.cart && sent.cart.sale && 'lines' in sent.cart.sale ? sent.cart.sale.lines.map(line => line.name) : []).toEqual(['ZZ TEST Play 1', 'ZZ TEST Play 2']);
    expect(sent.payment?.amountSatang).toBe(2 * KID_PRICE * 100);
    const view = readTicketDisplayView(document(sent));
    expect(view?.stage).toBe('payment');
    expect(view?.sale.lines.map(line => line.ticketType.name)).toEqual(['ZZ TEST Play 1', 'ZZ TEST Play 2']);
    expect(Object.keys(view?.lineBreakdowns ?? {})).toEqual(['line-1', 'line-2']);
    expect(view?.payment?.amountSatang).toBe(2 * KID_PRICE * 100);
    // As `pages/Display.tsx` draws it: the view's sale, totals, payment and captured rows into the same component.
    const html = under('en', createElement(CustomerDisplay, {
      stage: view!.stage, sale: view!.sale, phone: '', nickname: view!.nickname, member: view!.member,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined, onCustomerDone: () => undefined,
      totals: view!.totals, payment: view!.payment, lineBreakdowns: view!.lineBreakdowns, voucherPrize: view!.voucherPrize,
      nothingToPay: view!.nothingToPay, showGrantQr: false,
    }));
    expect(between(html, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Play 2');
    expect(from(html, 'payment-amount')).toContain(`฿${(2 * KID_PRICE).toFixed(2)}`);
    const page = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Display.tsx'), 'utf8');
    expect(page).toContain('totals={view.totals} payment={view.payment} lineBreakdowns={view.lineBreakdowns}');
  });

  it('F&B and the shop: the published document carries the lines with the payment, read back into the same screens', () => {
    const paid = { saleId: 'sale-1', amountSatang: 9_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle' as const, offline: false, online: true };
    const fnbState: FnbDisplayState = { sessionKey: 'g', stage: 'payment', online: true, excluded: false, orderNote: '', manualDiscounts: [],
      lines: [{ id: 'food-1', qty: 1, selectedModifiers: [], lineTotal: 90,
        menuItem: { id: 'menu-1', name: 'ZZ TEST Fries', category: 'c', price: { weekday: 90, weekend: 90 }, modifierGroups: [] } }],
      quote: cartQuote(90, { lineTotals: { 'food-1': 90 }, itemPresentation: { 'food-1': { name: 'ZZ TEST Fries', basePrice: 90, modifiers: [] } } }),
      pending: false, quoteFailed: false, payment: paid, completedOrder: null, platformSale: null };
    const fnbSent = fnbDisplayPresentation(fnbState);
    expect(fnbSent.cart.supported && fnbSent.cart.lines.map(line => line.name)).toEqual(['ZZ TEST Fries']);
    expect(fnbSent.payment?.amountSatang).toBe(9_000);
    const fnbHtml = under('en', createElement(FnbCustomerDisplay, { stage: 'payment', presentation: { cart: fnbSent.cart, totals: fnbSent.totals! }, payment: fnbSent.payment! }));
    expect(between(fnbHtml, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Fries');
    expect(from(fnbHtml, 'payment-amount')).toContain('฿90');

    const merchState: MerchDisplayState = { sessionKey: 'g', stage: 'payment', online: true, excluded: false, manualDiscounts: [],
      lines: [{ id: 'shop-1', qty: 1, lineTotal: 90, merchItem: { id: 'item-1', name: 'ZZ TEST Socks', active: true, price: { weekday: 90, weekend: 90 } } }],
      quote: cartQuote(90, { lineTotals: { 'shop-1': 90 }, itemPresentation: { 'shop-1': { name: 'ZZ TEST Socks', basePrice: 90, modifiers: [] } } }),
      pending: false, quoteFailed: false, payment: paid, completedOrder: null, platformSale: null };
    const merchSent = merchDisplayPresentation(merchState);
    expect(merchSent.cart.supported && merchSent.cart.lines.map(line => line.name)).toEqual(['ZZ TEST Socks']);
    const merchHtml = under('en', createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchSent.cart, totals: merchSent.totals!, payment: merchSent.payment! }));
    expect(between(merchHtml, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Socks');
    expect(from(merchHtml, 'payment-amount')).toContain('฿90');
  });
});
