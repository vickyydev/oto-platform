import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bahtText, groupedBahtText, groupedSatangText, satangText } from '@/lib/bahtText';
import { PromoCodeEntry } from '@/components/fnb/PromoCodeEntry';
import { StaffBenefitBreakdown } from '@/components/fnb/StaffBenefitBreakdown';
import { RevenueBars } from '@/components/floor/RevenueBars';
import { TenderTotal } from '@/components/shared/TenderLines';
import { CashMovementList } from '@/components/eod/CashMovementList';
import { FnbCustomerDisplay } from '@/components/fnb/FnbCustomerDisplay';
import { MerchCustomerDisplay } from '@/components/merch/MerchCustomerDisplay';
import { PublicMerchCustomerDisplay } from '@/components/merch/PublicMerchCustomerDisplay';
import { LanguageProvider } from '@/i18n/LanguageContext';
import type { DisplayFnbCart, DisplayMerchCart, DisplayPayment, DisplayTotals } from '@oto/shared';
import type { FnbOrderLine, MerchOrderLine } from '@/types';

/**
 * SCRUM-948 — THE F&B AND SHOP TILLS AND THE REMAINING STAFF SCREENS WRITE
 * MONEY ONE WAY.
 *
 * SCRUM-933 put the ticket till's amounts through one formatter
 * (`lib/bahtText.ts`): whole baht bare ("1605"), an amount with satang to two
 * places ("1444.50"). The reviews of 12 November found the rest still writing
 * baht by hand: the F&B and Shop panels ("1444.5", a code's "-161" for
 * ฿160.50), History's extra-time block, the phone's drop-off child detail and
 * F&B order station, booking redeem, and End of Day and Performance
 * ("100.5"); and the customer display's payment stage printed "฿1605.00"
 * under the staff's "฿1605". They go through the same formatter now — End of
 * Day, Performance and redeem grouped by thousands as they always were — and
 * the display's figure is written the prototype's way (`฿{sale.total}`), bare
 * for whole baht. Every whole-baht amount reads exactly as before.
 */
Object.assign(globalThis, { React });

const markup = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

describe('the grouped formatter', () => {
  it('whole baht reads exactly as toLocaleString wrote it', () => {
    for (const baht of [0, 5, 1605, 17_434, 1_234_567]) {
      expect(groupedBahtText(baht)).toBe(baht.toLocaleString('en-US'));
      expect(groupedSatangText(baht * 100)).toBe(baht.toLocaleString('en-US'));
    }
  });

  it('two-place amounts read as before; one satang digit gets its second place, float noise none', () => {
    expect(groupedBahtText(17_434.86)).toBe('17,434.86');
    expect(groupedBahtText(100.5)).toBe('100.50');
    expect(groupedSatangText(10_050)).toBe('100.50');
    expect(groupedBahtText(1000.1 - 0.2)).toBe('999.90');
    expect(groupedBahtText(0.05)).toBe('0.05');
  });

  it('the ungrouped pair is unchanged (SCRUM-933)', () => {
    expect(bahtText(1605)).toBe('1605');
    expect(bahtText(1444.5)).toBe('1444.50');
    expect(satangText(144_450)).toBe('1444.50');
  });
});

describe('F&B and Shop', () => {
  it("a code's discount reads to the satang, never rounded to the baht", () => {
    const html = markup(createElement(PromoCodeEntry, {
      applied: [{ code: 'TEN', label: '10% off', amount: 160.5 }, { code: 'FIFTY', label: '฿50 off', amount: 50 }],
      onApply: () => undefined, onRemove: () => undefined,
    }));
    expect(html).toContain('-฿160.50');
    expect(html).not.toContain('-฿161');
    expect(html).toContain('-฿50<');
  });

  it("a staff benefit's relief reads to the satang; whole baht as before", () => {
    const html = markup(createElement(StaffBenefitBreakdown, {
      data: { scannedOperatorName: 'Som', compedTHB: 0, freeItemsTHB: 0, creditTHB: 0, discountTHB: 17.5, totalReliefTHB: 17.5 },
    }));
    expect(html).toContain('-฿17.50');
    const whole = markup(createElement(StaffBenefitBreakdown, {
      data: { scannedOperatorName: 'Som', compedTHB: 0, freeItemsTHB: 0, creditTHB: 0, discountTHB: 40, totalReliefTHB: 40 },
    }));
    expect(whole).toContain('-฿40<');
  });

  // Every amount on these screens goes through the formatter: no `฿{figure}`
  // or `฿${figure}` written by hand is left (a literal ฿0 is not a figure).
  const handWritten = /฿\{(?!(?:bahtText|satangText|groupedBahtText|groupedSatangText)\()|฿\$\{(?!(?:bahtText|satangText|groupedBahtText|groupedSatangText)\()/g;
  for (const rel of [
    'components/fnb/FnbCart.tsx',
    'components/fnb/FnbPayment.tsx',
    'components/fnb/FnbConfirmation.tsx',
    'components/fnb/PromoCodeEntry.tsx',
    'components/fnb/StaffBenefitBreakdown.tsx',
    'components/merch/MerchCart.tsx',
    'components/merch/MerchConfirmation.tsx',
    'components/history/SaleExtensions.tsx',
    'components/mobile/dropoff/MobileChildDetail.tsx',
    'components/mobile/order-station/MobileFnbCartSheet.tsx',
    'components/mobile/order-station/MobileOrderCustomerScreens.tsx',
    'components/till/RedeemBookingModal.tsx',
    'components/mobile/today/MobileEndOfDayTab.tsx',
    'components/mobile/today/MobilePerformanceTab.tsx',
    'components/eod/CashCountCard.tsx',
    'components/eod/CashMovementList.tsx',
    'components/eod/EndOfDayTab.tsx',
    'components/eod/ReconSummary.tsx',
    'components/eod/ReconTable.tsx',
    'components/floor/PerformanceTab.tsx',
    'components/floor/RevenueBars.tsx',
    'components/shared/TenderCustomerDisplay.tsx',
    'components/shared/TenderLines.tsx',
    'components/shared/PromptPayCustomerScreen.tsx',
    // The second review: the F&B and Shop customer displays (both halves of
    // the split view are on screen together), the pickup-code dialog beside
    // the cart's Charge, the band's credit on the scan list, the menu and shop
    // grids and the modifier sheet, and the order stations' credit lines.
    'components/fnb/PickupCodeModal.tsx',
    'components/fnb/ScanWristband.tsx',
    'components/fnb/FnbCustomerDisplay.tsx',
    'components/fnb/MenuGrid.tsx',
    'components/fnb/ModifierSheet.tsx',
    'components/merch/MerchCustomerDisplay.tsx',
    'components/merch/PublicMerchCustomerDisplay.tsx',
    'components/merch/MerchGrid.tsx',
    'components/mobile/order-station/MobileOrderStation.tsx',
    'pages/OrderStation.tsx',
  ]) {
    it(`${rel}: no amount written by hand`, () => {
      const text = src(rel);
      expect(text.match(handWritten) ?? []).toEqual([]);
      expect(text).not.toMatch(/\.toFixed\(0\)/);
    });
  }
});

describe('the F&B and Shop customer displays write the figure the staff cart writes', () => {
  // A 10% code on ฿1,605: the cart's Charge reads "฿1444.50" (FnbCart), and
  // the customer half beside it in the split view now reads the same.
  const under = (el: ReactElement) => markup(createElement(LanguageProvider, null, el));
  const tax = { netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, serviceChargeTotal: 0, categories: [] };
  const fnbLines = (baht: number): FnbOrderLine[] => [{ id: 'l-1', qty: 1, selectedModifiers: [], lineTotal: baht,
    menuItem: { id: 'm-1', name: 'ZZ TEST Platter', category: 'c', price: { weekday: baht, weekend: baht }, modifierGroups: [] } }];
  const merchLines = (baht: number): MerchOrderLine[] => [{ id: 'l-1', qty: 1, lineTotal: baht,
    merchItem: { id: 'i-1', name: 'ZZ TEST Cap', active: true, price: { weekday: baht, weekend: baht } } }];
  const fnbCart = (baht: number): DisplayFnbCart => ({ kind: 'fnb', supported: true, orderNote: '', manualDiscounts: [], completion: null,
    lines: [{ id: 'f-1', name: 'ZZ TEST Platter', qty: 1, basePrice: baht, lineTotal: baht, modifiers: [] }] });
  const merchCart = (baht: number): DisplayMerchCart => ({ kind: 'merch', supported: true, manualDiscounts: [], completion: null,
    lines: [{ id: 's-1', name: 'ZZ TEST Cap', qty: 1, unitPrice: baht, lineTotal: baht }] });
  const totals = (baht: number): DisplayTotals => ({ manualAmounts: {}, discountAmount: 0, total: baht, taxBreakdown: { serviceChargeTotal: 0, categories: [] } });
  const pay = (overrides: Partial<DisplayPayment>): DisplayPayment => ({ saleId: 'sale-948', amountSatang: 0, qrPayload: null,
    qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true, ...overrides });

  const screens: [string, (baht: number) => string][] = [
    ['the F&B display (till harness)', (baht) => under(createElement(FnbCustomerDisplay, { stage: 'order', lines: fnbLines(baht), total: baht, taxBreakdown: { ...tax, grandTotal: baht } }))],
    ['the F&B display (paired)', (baht) => under(createElement(FnbCustomerDisplay, { stage: 'order', presentation: { cart: fnbCart(baht), totals: totals(baht) } }))],
    ['the Shop display (till harness)', (baht) => under(createElement(MerchCustomerDisplay, { stage: 'order', wristband: null, lines: merchLines(baht), manualDiscounts: [], total: baht,
      taxBreakdown: { ...tax, grandTotal: baht } as never, promptpayAmount: null, completedOrder: null, newBalance: null }))],
    ['the Shop display (paired)', (baht) => under(createElement(PublicMerchCustomerDisplay, { stage: 'order', cart: merchCart(baht), totals: totals(baht) }))],
  ];
  for (const [name, draw] of screens) {
    it(`${name}: an amount with satang to two places`, () => {
      const html = draw(1444.5);
      expect(html).toContain('฿1444.50<');
      expect(html).not.toContain('฿1444.5<');
    });
    it(`${name}: whole baht exactly as before`, () => {
      const html = draw(1605);
      expect(html).toContain('>฿1605<');
      expect(html).not.toContain('1605.00');
    });
  }

  it('the F&B display at payment: credit and the rest to the satang', () => {
    const html = under(createElement(FnbCustomerDisplay, { stage: 'payment', presentation: { cart: fnbCart(1444.5), totals: totals(1444.5) },
      payment: pay({ amountSatang: 144_450, creditSatang: 35_550 }) }));
    expect(html).toContain('฿355.50<');
    expect(html).toContain('>฿1089<');
  });

  it('the Shop display (paired) at payment: the same', () => {
    const html = under(createElement(PublicMerchCustomerDisplay, { stage: 'payment', cart: merchCart(1444.5), totals: totals(1444.5),
      payment: pay({ amountSatang: 144_450, creditSatang: 35_550 }) }));
    expect(html).toContain('฿355.50<');
    expect(html).toContain('>฿1089<');
  });

  it("the pickup-code dialog's Continue and a voucher's wallet credit line", () => {
    expect(src('components/fnb/PickupCodeModal.tsx')).toContain('Continue to Payment • ฿{bahtText(total)}');
    expect(src('pages/OrderStation.tsx')).toContain('`฿${satangText(effect.valueSatang)} wallet credit`');
    expect(satangText(50_050)).toBe('500.50');
    expect(satangText(50_000)).toBe('500');
  });
});

describe('End of Day and Performance, desk and phone', () => {
  it('a paid-out reads grouped, to the satang', () => {
    const html = markup(createElement(CashMovementList, {
      movements: [{ id: 'm1', kind: 'paid_out', amountSatang: 1_234_550, reason: 'ZZ TEST ice', actor: { name: 'Som' }, approver: { name: 'Anan' }, witness: null } as never],
    }));
    expect(html).toContain('−฿12,345.50');
  });

  it('a revenue bar reads grouped, whole baht exactly as before', () => {
    const html = markup(createElement(RevenueBars, {
      buckets: [{ key: 'tickets', label: 'Tickets', amountTHB: 12_345 }, { key: 'fnb', label: 'F&B', amountTHB: 789.1 }] as never,
    }));
    expect(html).toContain('฿12,345<');
    expect(html).toContain('฿789.10<');
  });
});

describe("the customer display's payment stage, the prototype's way", () => {
  it('the ticket till: whole baht bare, satang to two places', () => {
    const display = src('components/till/CustomerDisplay.tsx');
    expect(display).toContain("const figure = unpriced.length > 0 ? '—' : `฿${payment ? satangText(payment.amountSatang) : bahtText(sale.total)}`;");
    expect(display).not.toContain('.toFixed(2)');
  });

  it("a tender's total: the same", () => {
    const total = (amount: number) => markup(createElement(LanguageProvider, null, createElement(TenderTotal, { amount })));
    expect(total(1605)).toContain('>฿1605</span>');
    expect(total(1444.5)).toContain('>฿1444.50</span>');
  });

  it('the staff tender panel keeps its two places (no prototype screen to port: a question for the owner)', () => {
    expect(src('components/till/PaymentTenderPanel.tsx')).toContain('const format = (amount: number) => (amount / 100).toFixed(2);');
  });
});
