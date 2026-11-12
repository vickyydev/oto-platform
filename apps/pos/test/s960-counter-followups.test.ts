import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FnbPayment } from '@/components/fnb/FnbPayment';
import { FnbCustomerDisplay } from '@/components/fnb/FnbCustomerDisplay';
import { MerchCustomerDisplay } from '@/components/merch/MerchCustomerDisplay';
import { MobileChildCard } from '@/components/mobile/dropoff/MobileChildCard';
import { StrandedList } from '@/components/eod/StrandedList';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { itemPartPaidExit, PAYMENT_IN_FLIGHT } from '@/lib/itemPartPaid';
import { arrivalOverdue } from '@/lib/dropoff';
import { codeDiscountTotal } from '@/lib/customerDisplayCopy';
import { HISTORY_SEARCH_PLACEHOLDER } from '@/lib/historyLookup';
import * as paymentMethods from '@/lib/payments';
import type { PaymentSettlement, usePaymentStage } from '@/lib/usePaymentStage';
import type { EodStrandedRow } from '@oto/shared';
import type { CheckIn, FnbOrderLine, MerchOrderLine } from '@/types';

/**
 * SCRUM-960 — the points of the split view's proof that are not a layout
 * measured in a browser (`s959-split-view-measured.test.ts` has those):
 *
 *   (1) a part-paid F&B or shop order no longer holds the till: "Save as
 *       partly paid" leaves it as it is and the station starts afresh;
 *   (2) one overdue rule for a waiting child on the desk and the phone;
 *   (3) the phone End of Day's band code breaks inside its line;
 *   (4) the customer half names a promo code's discount between the lines
 *       and the total;
 *
 * and SCRUM-959 (8), History's placeholder.
 */
const src = (...rel: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...rel), 'utf8');
const html = (el: ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Stage = ReturnType<typeof usePaymentStage>;

/** A payment stage as the F&B and shop stations hold it, with the given money on it. */
function stageWith(over: { settlements?: Partial<PaymentSettlement>[]; outstandingSatang?: number; locked?: boolean; phase?: string } = {}): Stage {
  const outstanding = over.outstandingSatang ?? 12_500;
  return {
    state: {
      phase: over.phase ?? 'ready', saleId: 'sale-960', method: null, kind: null, outstandingSatang: outstanding, amountSatang: outstanding,
      tenderedSatang: outstanding, attempt: null, route: null, qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
      error: null, retryable: false, settlements: over.settlements ?? [], creditSatang: 0, creditSaleId: null, creditRefusedSaleId: null,
      partial: true,
    },
    display: { saleId: 'sale-960', amountSatang: outstanding, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true, creditSatang: 0 },
    busy: false, online: true, locked: over.locked ?? false, canBack: (over.settlements ?? []).length === 0, canCancel: false,
    canSubmit: false, creditCoversAll: false, creditPendingSatang: 0, creditRefusal: null, canInquire: false, canConfirm: false,
    selectMethod: () => undefined, setAmountSatang: () => undefined, setTenderedSatang: () => undefined, setPartial: () => undefined,
    submit: async () => undefined, retry: async () => undefined, inquire: async () => undefined, confirm: async () => undefined,
    manual: async () => undefined, cancel: async () => false,
  } as unknown as Stage;
}
const CASH_50: Partial<PaymentSettlement> = { kind: 'cash', amountSatang: 5_000 };

describe('SCRUM-960 (1): a part-paid F&B or shop order is left as it is, and the till goes on', () => {
  it('offered once money was taken on this screen and something is still owed', () => {
    expect(itemPartPaidExit(stageWith({ settlements: [CASH_50] }))).toEqual({ shown: true, reason: null, paidSatang: 5_000, balanceSatang: 12_500 });
  });

  it('not offered before anything is paid, once nothing is owed, or when the sale is complete', () => {
    expect(itemPartPaidExit(stageWith()).shown).toBe(false);
    expect(itemPartPaidExit(stageWith({ settlements: [CASH_50], outstandingSatang: 0 })).shown).toBe(false);
    expect(itemPartPaidExit(stageWith({ settlements: [CASH_50], phase: 'complete' })).shown).toBe(false);
  });

  it("a party's deposit, taken before this screen, is not this screen's money", () => {
    expect(itemPartPaidExit(stageWith({ settlements: [{ ...CASH_50, partyDeposit: true }] })).shown).toBe(false);
  });

  it('shut with the till’s own reason while a payment is in flight: the hold that protects it stays', () => {
    expect(itemPartPaidExit(stageWith({ settlements: [CASH_50], locked: true }))).toMatchObject({ shown: true, reason: PAYMENT_IN_FLIGHT });
    expect(PAYMENT_IN_FLIGHT).toBe('A payment is in progress — finish or cancel it first.');
  });

  describe('the payment screen', () => {
    const screen = (stage: Stage, onSavePartPaid?: () => void) => {
      vi.spyOn(paymentMethods, 'getEnabledPaymentMethods').mockReturnValue([
        { id: 'cash', label: 'Cash', kind: 'cash', enabled: true, sortOrder: 0 },
      ] as ReturnType<typeof paymentMethods.getEnabledPaymentMethods>);
      return html(createElement(FnbPayment, {
        total: 175, wristband: null, pickupCode: '84', stage, onBack: () => undefined,
        ...(onSavePartPaid ? { onSavePartPaid } : {}),
      }));
    };

    it('draws the ticket till’s "Save as partly paid" once a part is paid', () => {
      const out = screen(stageWith({ settlements: [CASH_50] }), () => undefined);
      expect(out).toContain('data-testid="item-part-paid"');
      expect(out).toContain('Save as partly paid');
      expect(out).not.toContain('data-testid="item-part-paid-reason"');
    });

    it('draws nothing new before a part is paid, or for a station that offers no way out', () => {
      expect(screen(stageWith(), () => undefined)).not.toContain('Save as partly paid');
      expect(screen(stageWith({ settlements: [CASH_50] }))).not.toContain('Save as partly paid');
    });

    it('shut, with its reason under it, while a payment is in flight', () => {
      const out = screen(stageWith({ settlements: [CASH_50], locked: true }), () => undefined);
      expect(out).toContain(`data-testid="item-part-paid-reason">${PAYMENT_IN_FLIGHT}`);
      expect(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Save as partly paid/s.test(out)).toBe(true);
    });
  });

  it('both counters start afresh with their own reset, which voids nothing', () => {
    for (const page of ['OrderStation.tsx', 'MerchStation.tsx']) {
      const text = src('pages', page);
      expect(text, page).toContain('onSavePartPaid={resetOrder}');
      const reset = text.slice(text.indexOf('const resetOrder = () => {'));
      const body = reset.slice(0, reset.indexOf('\n  };'));
      expect(body, page).not.toMatch(/letOrderGo|\.cancel\(|voidSale|refund/);
    }
  });
});

describe('SCRUM-960 (2): one overdue rule for a waiting child, desk and phone', () => {
  const NOW = Date.parse('2026-11-12T16:13:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('past its time it is overdue; before it, scheduled', () => {
    expect(arrivalOverdue('2026-11-12T16:10:00.000Z', NOW)).toBe(true);
    expect(arrivalOverdue('2026-11-12T16:20:00.000Z', NOW)).toBe(false);
  });

  const child = (id: string, over: Partial<CheckIn> = {}): CheckIn => ({
    id, registrationId: 'zz-test-960', parentName: 'ZZ TEST 884 guardian G', contactMethod: 'whatsapp', phone: '+66898884014',
    childName: `ZZ TEST ${id}`, childAge: 6, status: 'registered', mayOrderFood: false, confirmationsAccepted: true,
    serviceType: 'drop_off', registeredAt: '2026-11-12T10:00:00.000Z', ...over,
  } as CheckIn);
  const card = (family: CheckIn[]) => html(createElement(MobileChildCard, { family, onTap: () => undefined }));

  it("the phone board's family card says Overdue past the time, as the desk's does (staging 12a, 13a1)", () => {
    const late = card([child('mali', { scheduledFor: '2026-11-12T16:10:00.000Z' }), child('nok', { scheduledFor: '2026-11-12T16:10:00.000Z' })]);
    expect(late).toContain('Overdue · ');
    expect(late).not.toContain('Scheduled · ');
    const early = card([child('mali', { scheduledFor: '2026-11-12T16:20:00.000Z' })]);
    expect(early).toContain('Scheduled · ');
    expect(early).not.toContain('Overdue · ');
  });

  it("each child's line on a mixed family follows the same rule", () => {
    const mixed = card([child('mali', { scheduledFor: '2026-11-12T16:10:00.000Z' }), child('nok', { status: 'out', checkedOutAt: '2026-11-12T15:00:00.000Z' })]);
    expect(mixed).toContain('Overdue · ');
  });

  it('the desk card, the phone card and the phone family screen ask the one rule', () => {
    expect(src('components', 'dropoff', 'FamilyCheckInCard.tsx')).toContain('arrivalOverdue(child.scheduledFor)');
    const card = src('components', 'mobile', 'dropoff', 'MobileChildCard.tsx');
    expect(card).toContain('arrivalOverdue(child.scheduledFor)');
    expect(card).toContain('arrivalOverdue(rep.scheduledFor)');
    const detail = src('components', 'mobile', 'dropoff', 'MobileChildDetail.tsx');
    expect(detail).toContain('arrivalOverdue(child.scheduledFor)');
    expect(detail).toContain('arrivalOverdue(rep.scheduledFor)');
    expect(detail).not.toMatch(/>\s*Scheduled · \{fmtTime/);
  });
});

describe("SCRUM-960 (3): the phone End of Day's band code breaks inside its line", () => {
  it('the row that names a band lets it break anywhere, so the card is never wider than the screen', () => {
    const row: EodStrandedRow = {
      kind: 'checkin', subjectId: '01990000-0000-7000-8000-000000000960',
      bandCode: 'Z88401229PF69WPVWDEXKX7PTKWSVQEHH.G8F379S6EPK3M2Q', childName: 'ZZ TEST Mali 884 G', childrenWithBand: 0,
      lastGateEvent: null, checkedInAt: '2026-11-12T16:11:00.000Z', sale: null, guardian: null,
    };
    const out = html(createElement(StrandedList, {
      compact: true, rows: [row], override: null, readOnly: false, resolving: null, error: null, canOverride: false,
      overrideReason: '', onOverrideReason: () => undefined, onResolve: () => undefined,
    }));
    expect(out).toMatch(/<div class="text-xs text-muted-foreground wrap-anywhere">[^<]*Band Z88401229PF69/);
  });
});

describe("SCRUM-960 (4): the customer half names a code's discount", () => {
  const tax = { netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: 157.5, serviceChargeTotal: 0, categories: [] } as never;
  const fries: FnbOrderLine = {
    id: 'l-1', qty: 1, selectedModifiers: [], lineTotal: 175,
    menuItem: { id: 'm-fries', name: 'French fries', category: 'sides', price: { weekday: 175, weekend: 175 } },
  };
  const cap: MerchOrderLine = { id: 'l-1', qty: 1, lineTotal: 175, merchItem: { id: 'i-1', name: 'ZZ TEST Cap', active: true, price: { weekday: 175, weekend: 175 } } };
  const guest = (el: ReactElement) => html(createElement(LanguageProvider, { children: el }));
  const fnb = (stage: 'order' | 'payment', codeDiscount?: number) => guest(createElement(FnbCustomerDisplay, {
    stage, lines: [fries], manualDiscounts: [], total: 157.5, taxBreakdown: tax, ...(codeDiscount === undefined ? {} : { codeDiscount }),
    ...(stage === 'payment' ? { payment: { saleId: 's', amountSatang: 15_750, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle' as const, offline: false, online: true, creditSatang: 0 } } : {}),
  }));
  const shop = (stage: 'order' | 'payment', codeDiscount?: number) => guest(createElement(MerchCustomerDisplay, {
    stage, wristband: null, lines: [cap], manualDiscounts: [], total: 157.5, taxBreakdown: tax, promptpayAmount: null,
    completedOrder: null, newBalance: null, ...(codeDiscount === undefined ? {} : { codeDiscount }),
    ...(stage === 'payment' ? { payment: { saleId: 's', amountSatang: 15_750, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle' as const, offline: false, online: true, creditSatang: 0 } } : {}),
  }));

  for (const [name, draw] of [['F&B', fnb], ['Shop', shop]] as const) {
    it(`${name}: "Discount code −฿17.50" between the line (฿175) and the total (฿157.50), on the order and the payment screens`, () => {
      for (const stage of ['order', 'payment'] as const) {
        const out = draw(stage, 17.5);
        expect(out, stage).toContain('Discount code');
        expect(out, stage).toContain('−฿17.50');
        expect(out.indexOf('Discount code'), stage).toBeLessThan(out.lastIndexOf('฿157.50'));
      }
    });

    it(`${name}: no row with no code on the order`, () => {
      expect(draw('order')).not.toContain('Discount code');
      expect(draw('order', 0)).not.toContain('Discount code');
    });
  }

  it('the codes are summed in satang', () => {
    expect(codeDiscountTotal([{ amount: 16.5 }, { amount: 0.1 }])).toBe(16.6);
    expect(codeDiscountTotal([])).toBe(0);
  });

  it('both counters hand the quote’s code rows to their customer half', () => {
    expect(src('pages', 'OrderStation.tsx')).toContain('codeDiscount={codeDiscountTotal(promoRows)}');
    expect(src('pages', 'MerchStation.tsx')).toContain('codeDiscount={codeDiscountTotal(sale.totals.scannedDiscounts)}');
  });

  it("SCRUM-959 (7): the Shop's header keeps clear of the language button, as the F&B one does", () => {
    const out = shop('order');
    expect(out).toContain('class="py-8 pl-8 pr-36 flex items-center justify-between border-b border-foreground/10 shrink-0"');
  });
});

describe("SCRUM-959 (8): History's placeholder", () => {
  it('fits the field at a desk (measured in s959-split-view-measured), and History reads it from one place', () => {
    expect(HISTORY_SEARCH_PLACEHOLDER).toBe('Search by name, receipt, bracelet…');
    expect(src('pages', 'History.tsx')).toContain('placeholder={HISTORY_SEARCH_PLACEHOLDER}');
  });
});
