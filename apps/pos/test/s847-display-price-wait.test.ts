import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import type { SupportedLang } from '@/i18n/types';
import { readTicketDisplayView, ticketDisplayCovers, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import type { PaymentDisplayState } from '@/lib/usePaymentStage';
import type { Sale } from '@/types';
import { cartQuote } from './support/fixtures';

// The add-on grid reads a live store with no server snapshot, and says nothing of what is tested here.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-847 — THE CUSTOMER SCREEN WAITS WITH THE STAFF SCREEN.
 *
 * While a Golden Ticket drop-off's price is not back from the platform the
 * staff payment step shows "Amount Due —" (SCRUM-807). The family's screen went
 * on reading "Please pay ฿1315.00 to our staff" — this till's own estimate —
 * for a sale that then came to ฿0.
 *
 * Both customer screens are held for that wait: nothing of the sale is
 * published to a separate display, which shows its own "Please follow the
 * staff screen", and the till's own customer half shows the payment frame with
 * "Waiting for the cashier to confirm…" and no figure. The price arriving, or
 * Back, returns each to exactly what it showed before this change.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const ESTIMATE = 1315;

const sale = (): Sale => ({
  id: 'sale-847', operatorId: 'private-staff-id', operatorName: 'Private staff', tier: 'tourist', total: ESTIMATE,
  lines: [{ id: 'line-1', tier: 'tourist', kids: 1, adults: 0, socks: 0, addOns: [], lineTotal: ESTIMATE,
    ticketType: { id: 'ticket-1', name: 'Full Day Pass', durationLabel: 'All day', hours: 8,
      prices: { tourist: { weekday: 1090, weekend: 1090 } }, adultRules: { tourist: { kind: 'free_adults', freeAdults: 1 } } } }],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 1 }, createdAt: '', status: 'paid', refunds: [],
});

const payment = (amountSatang: number): PaymentDisplayState => ({ saleId: null, amountSatang, qrPayload: null,
  qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true, creditSatang: 0 });

/** The counter till's display state at a step, as `pages/Till.tsx` builds it for `useTicketDisplay`. */
const tillState = (overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => ({
  stage: 'payment', step: 5, sessionKey: 'sale-0', tier: 'tourist', phone: '+66898020001', nickname: 'ZZ TEST guardian',
  contactChannel: 'whatsapp', member: null, sale: sale(), totals: cartQuote(ESTIMATE).totals, rateMode: 'weekday',
  online: true, payment: payment(ESTIMATE * 100), voucherPrize: { nameEn: 'Golden Ticket', nameTh: null },
  nothingToPay: false, ...overrides,
});

const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
  stationId: 'zz-station', boxId: 'box-1', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
  takeoverCount: 0, updatedAt: '2026-11-11T12:00:00.000Z', ...overrides,
});

describe('SCRUM-847: what a separate display is sent while the voucher price is pending', () => {
  it('carries no amount: no sale, no totals and no payment', () => {
    const held = ticketDisplayPresentation(tillState({ pricePending: true }), 'prompt-1');
    // The whole of it: the tier-only cart, marked unsupported — the one such
    // shape the box takes at this stage (`customerDisplayCart`, box-agent).
    expect(held).toEqual({ stage: 'payment', step: 5, cart: { supported: false, sale: { tier: 'tourist' } },
      member: null, totals: null, payment: null, prompt: null });
    // No figure in any form, and no line of the sale.
    const wire = JSON.stringify(held);
    expect(wire).not.toContain(String(ESTIMATE));
    expect(wire).not.toMatch(/\d{3,}/);
    expect(wire).not.toContain('Full Day Pass');
  });

  it('is read by the display as nothing to render, which is its "Please follow the staff screen"', () => {
    const held = ticketDisplayPresentation(tillState({ pricePending: true }), 'prompt-1');
    expect(readTicketDisplayView(document(held))).toBeNull();
    // `pages/Display.tsx` draws its waiting screen for exactly that: no view.
    const page = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Display.tsx'), 'utf8');
    expect(page).toMatch(/<\/> : view && document \? <>[\s\S]*<\/> : <main[\s\S]*t\('display\.idle\.followStaff'\)/);
  });

  it('the price arriving sends the payment screen exactly as it was sent before', () => {
    const priced = { sale: { ...sale(), total: 0 }, totals: cartQuote(0).totals, payment: payment(0), nothingToPay: true };
    const before = ticketDisplayPresentation(tillState(priced), 'prompt-1');
    const after = ticketDisplayPresentation(tillState({ ...priced, pricePending: false }), 'prompt-1');
    expect(after).toEqual(before);
    expect(after.payment?.amountSatang).toBe(0);
    expect(after.cart.supported).toBe(true);
    const view = readTicketDisplayView(document(after));
    expect(view?.stage).toBe('payment');
    expect(view?.nothingToPay).toBe(true);
  });

  it('a sale with no voucher is sent its amount exactly as before', () => {
    const plain = tillState({ voucherPrize: null });
    const sent = ticketDisplayPresentation({ ...plain, pricePending: false }, 'prompt-1');
    expect(sent).toEqual(ticketDisplayPresentation(plain, 'prompt-1'));
    expect(sent.payment?.amountSatang).toBe(ESTIMATE * 100);
    expect(sent.totals?.total).toBe(ESTIMATE);
    expect(readTicketDisplayView(document(sent))?.payment?.amountSatang).toBe(ESTIMATE * 100);
  });

  it('the till keeps its layout for the wait: a connected display still counts as covering the payment step', () => {
    expect(ticketDisplayCovers(tillState())).toBe(true);
    expect(ticketDisplayCovers(tillState({ pricePending: true }))).toBe(true);
    // What makes the till draw the customer half itself is unchanged: a display that is offline, or has no payment state.
    expect(ticketDisplayCovers(tillState({ pricePending: true, online: false }))).toBe(false);
    expect(ticketDisplayCovers(tillState({ online: false }))).toBe(false);
    const unpaid = tillState();
    delete unpaid.payment;
    expect(ticketDisplayCovers(unpaid)).toBe(false);
    const page = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'lib', 'displaySession.ts'), 'utf8');
    expect(page).toContain('supported: ticketDisplayCovers(state),');
  });

  it('only the payment stage is held: Back, and every other stage, is sent in full while the price is still pending', () => {
    for (const [stage, step] of [['input', 4], ['order', 3], ['welcome', 2], ['identify', 1], ['thankyou', 6]] as const) {
      const at = tillState({ stage, step });
      expect(ticketDisplayPresentation({ ...at, pricePending: true }, 'prompt-1'), stage)
        .toEqual(ticketDisplayPresentation(at, 'prompt-1'));
    }
    // Back from payment to the details screen: the contact prompt is there again.
    const back = ticketDisplayPresentation(tillState({ stage: 'input', step: 4, pricePending: true }), 'prompt-1');
    expect(back.cart.supported).toBe(true);
    expect(back.prompt?.kind).toBe('contact');
    expect(readTicketDisplayView(document(back))?.stage).toBe('input');
  });
});

describe('SCRUM-847: the till’s own customer half while the voucher price is pending', () => {
  const under = (lang: SupportedLang, props: { pricePending?: boolean; nothingToPay?: boolean; total?: number; payment?: PaymentDisplayState }) => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => lang, setItem: () => undefined },
      location: { search: '' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const total = props.total ?? ESTIMATE;
    return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-847', children: createElement(CustomerDisplay, {
      stage: 'payment', sale: { ...sale(), total }, phone: '', nickname: 'ZZ TEST guardian', member: null,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined, totals: cartQuote(total).totals, payment: props.payment ?? payment(total * 100),
      voucherPrize: { nameEn: 'Golden Ticket', nameTh: null },
      ...(props.nothingToPay === undefined ? {} : { nothingToPay: props.nothingToPay }),
      ...(props.pricePending === undefined ? {} : { pricePending: props.pricePending }),
    }) }));
  };

  it('asks for no money and shows no figure, in the guest’s language', () => {
    for (const lang of ['en', 'th', 'zh', 'ru', 'fr'] as const) {
      const html = under(lang, { pricePending: true });
      expect(html, lang).toContain('data-testid="customer-price-pending"');
      expect(html, lang).toContain(tFor(lang)('common.waitingForStaff'));
      expect(html, lang).not.toContain(tFor(lang)('common.pleasePay'));
      expect(html, lang).not.toContain(tFor(lang)('common.toStaff'));
      expect(html, lang).not.toContain('฿');
      expect(html, lang).not.toContain(String(ESTIMATE));
      // The customer's name stays in the header, as on every other screen of the sale.
      expect(html, lang).toContain('ZZ TEST guardian');
    }
    expect(tFor('en')('common.waitingForStaff')).toBe('Waiting for the cashier to confirm…');
  });

  it('does not promise a free sale from a pending zero either', () => {
    const html = under('en', { pricePending: true, nothingToPay: true, total: 0 });
    expect(html).toContain('data-testid="customer-price-pending"');
    expect(html).not.toContain('data-testid="customer-nothing-to-pay"');
    expect(html).not.toContain(tFor('en')('till.order.complimentary'));
  });

  it('once the price is in, the screens are the ones that were there before', () => {
    const free = under('en', { pricePending: false, nothingToPay: true, total: 0 });
    expect(free).toContain('data-testid="customer-nothing-to-pay"');
    expect(free).toContain(tFor('en')('till.order.complimentary'));
    expect(free).not.toContain('data-testid="customer-price-pending"');
    expect(free).toBe(under('en', { nothingToPay: true, total: 0 }));
  });

  it('a sale with no voucher shows its amount exactly as before', () => {
    const html = under('en', {});
    expect(html).toContain(tFor('en')('common.pleasePay'));
    expect(html).toContain('฿1315.00');
    expect(html).toContain(tFor('en')('common.toStaff'));
    expect(html).not.toContain('data-testid="customer-price-pending"');
    expect(html).toBe(under('en', { pricePending: false }));
  });

  it('a payment already taken still reads as paid', () => {
    const html = under('en', { pricePending: true, payment: { ...payment(0), status: 'paid' } });
    expect(html).toContain('data-testid="customer-payment-paid"');
  });
});
