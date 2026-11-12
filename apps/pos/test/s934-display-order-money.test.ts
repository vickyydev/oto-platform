import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import { cartQuote } from './support/fixtures';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { readTicketDisplayView, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import type { CartLine, ManualDiscount, Sale, TicketType } from '@/types';

/**
 * SCRUM-934 / SCRUM-933 — THE FAMILY'S HALF OF THE COUNTER READS THE STAFF
 * HALF'S MONEY.
 *
 * The staff till prints every amount through the one formatter (`bahtText`):
 * whole baht as it always was, an amount with satang to two places. The
 * customer display's ORDER stage still wrote baht by hand, so with a 10
 * percent code on ฿1,605 the family read "−฿160.5 · VAT ฿94.5 · Total
 * ฿1444.5" beside the staff panel's "฿1444.50", while the display's own
 * payment stage wrote two places. The order stage's amounts — the rows, the
 * line, the discounts, the code, VAT and the total — now go through the same
 * formatter, on the till's own customer half and on a paired display, which
 * renders the document the till sends it. Whole-baht carts read exactly as
 * before: pinned below.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

/** The display in English, as a person reads it (no React text separators). */
function shown(element: ReactElement): string {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'en', setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test', children: element }))
    .split('<!-- -->')
    .join('');
}

const ticket: TicketType = {
  id: '0190a0a0-0000-7000-8000-00000000c934',
  name: 'ZZ TEST 1 Hour Play',
  durationLabel: '1 hour',
  hours: 1,
  prices: { tourist: { weekday: 535, weekend: 535 } },
};
const line = { id: 'line-934', ticketType: ticket, tier: 'tourist', kids: 3, adults: 0, socks: 0, addOns: [], lineTotal: 1605 } as unknown as CartLine;

const discount = (id: string, scope: 'line' | 'order', amountTHB: number, extra: Record<string, unknown> = {}) =>
  ({
    id, scope, type: 'percent', value: 10, reason: 'ZZ TEST', amountTHB, appliedBy: 'Som', appliedById: 'acc-som', appliedAt: '',
    ...(scope === 'line' ? { targetLineId: 'line-934' } : {}),
    ...extra,
  }) as unknown as ManualDiscount;

const saleOf = (total: number, manualDiscounts: ManualDiscount[] = []): Sale =>
  ({
    id: 'sale-934', operatorId: 'private', operatorName: 'Private', tier: 'tourist', total, lines: [line],
    discounts: [], manualDiscounts, bracelets: { adults: 0, children: 3 }, createdAt: '', status: 'paid', refunds: [],
  }) as unknown as Sale;

/** The till's quote: the code's discount, the total, and VAT inclusive at 7 percent. */
function totalsOf(total: number, opts: { discountAmount?: number; vat: number; manualAmounts?: Record<string, number> }) {
  const quote = cartQuote(total).totals;
  return {
    ...quote,
    discountAmount: opts.discountAmount ?? 0,
    manualAmounts: opts.manualAmounts ?? {},
    taxBreakdown: {
      ...quote.taxBreakdown,
      inclusiveTaxTotal: opts.vat,
      taxTotal: opts.vat,
      categories: [{
        category: 'tickets', base: total, taxMode: 'inclusive', taxName: 'VAT', taxPercent: 7, tax: opts.vat, serviceCharge: 0,
        secondaryTaxMode: 'none', secondaryTaxPercent: 0, secondaryTax: 0, gross: total,
      }],
    },
  } as unknown as typeof quote;
}

const handlers = {
  phone: '', nickname: '', member: null, showGrantQr: false,
  onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined, onCustomerDone: () => undefined,
};

/** The till's own customer half: the sale and the quote the staff panel shows. */
const tillHalf = (sale: Sale, totals: ReturnType<typeof totalsOf>) =>
  shown(createElement(CustomerDisplay, { ...handlers, stage: 'order', sale, totals }));

/** A paired display: the document the till sends, read back and rendered as the display page does. */
function pairedDisplay(sale: Sale, totals: ReturnType<typeof totalsOf>) {
  const state: TicketDisplayState = {
    stage: 'order', step: 3, sessionKey: 'sale-0', tier: 'tourist', phone: '', nickname: '', contactChannel: 'whatsapp',
    member: null, sale, totals, rateMode: 'weekday', online: true, voucherPrize: null, nothingToPay: false,
  };
  const presented = ticketDisplayPresentation(state, 'prompt-1');
  const view = readTicketDisplayView({
    stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
    takeoverCount: 0, updatedAt: '2026-11-12T00:00:00.000Z', ...(presented as Partial<StationSessionDocument>),
  } as StationSessionDocument);
  expect(view === null, 'the display must accept the document').toBe(false);
  return shown(createElement(CustomerDisplay, {
    ...handlers, stage: view!.stage, sale: view!.sale, totals: view!.totals, lineBreakdowns: view!.lineBreakdowns,
  }));
}

const halves = [
  ['the till’s customer half', tillHalf],
  ['a paired display', pairedDisplay],
] as const;

describe.each(halves)('SCRUM-934 — the order stage on %s', (_name, render) => {
  it('a 10 percent code on ฿1,605: the code, VAT and Total to the satang, as the staff panel reads them', () => {
    const html = render(saleOf(1444.5), totalsOf(1444.5, { discountAmount: 160.5, vat: 94.5 }));
    expect(html).toContain('−฿160.50');
    expect(html).toContain('฿94.50');
    expect(html).toContain('>฿1444.50</span>');
    for (const oneDecimal of ['฿160.5<', '฿94.5<', '฿1444.5<']) expect(html.includes(oneDecimal), oneDecimal).toBe(false);
    // The ticket's own rows are whole baht, and read as they always have.
    expect(html).toContain('3 × ฿535');
    expect(html).toContain('>฿1605</span>');
    expect(html).toContain('>฿1605</div>');
  });

  it('staff discounts on a row, on the line and on the order: each to the satang', () => {
    const manual = [
      discount('d-kids', 'line', 160.5, { targetComponent: { kind: 'kids' }, targetLabel: 'Kids × 3' }),
      discount('d-line', 'line', 53.25),
      discount('d-order', 'order', 12.75),
    ];
    const totals = totalsOf(1378.5, { vat: 90.18, manualAmounts: { 'd-kids': 160.5, 'd-line': 53.25, 'd-order': 12.75 } });
    const html = render(saleOf(1378.5, manual), totals);
    expect(html).toContain('−฿160.50');
    expect(html).toContain('−฿53.25');
    expect(html).toContain('−฿12.75');
    expect(html).toContain('฿90.18');
    expect(html).toContain('>฿1378.50</span>');
    expect(html.includes('฿160.5<')).toBe(false);
    expect(html.includes('฿1378.5<')).toBe(false);
  });

  it('a whole-baht cart reads exactly as before: no decimals anywhere', () => {
    const html = render(saleOf(1605), totalsOf(1605, { vat: 105 }));
    expect(html).toContain('<span class="text-5xl font-black text-primary">฿1605</span>');
    expect(html).toContain('<span class="text-lg tabular-nums">฿105</span>');
    expect(html).toContain('3 × ฿535');
    expect(html).toContain('>฿1605</div>');
    expect(html.includes('.00')).toBe(false);
  });

  it('a whole-baht code reads as before: "−฿150", no decimals', () => {
    const html = render(saleOf(1455), totalsOf(1455, { discountAmount: 150, vat: 95.19 }));
    expect(html).toContain('<span class="text-lg font-bold tabular-nums">−฿150</span>');
    expect(html).toContain('>฿1455</span>');
    expect(html.includes('฿150.00')).toBe(false);
    expect(html.includes('฿1455.00')).toBe(false);
  });
});
