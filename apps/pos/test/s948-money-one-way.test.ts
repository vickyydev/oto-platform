import * as React from 'react';
import { createElement } from 'react';
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
import { LanguageProvider } from '@/i18n/LanguageContext';

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
  ]) {
    it(`${rel}: no amount written by hand`, () => {
      const text = src(rel);
      expect(text.match(handWritten) ?? []).toEqual([]);
      expect(text).not.toMatch(/\.toFixed\(0\)/);
    });
  }
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
