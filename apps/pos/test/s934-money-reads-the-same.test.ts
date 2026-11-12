import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { formatBahtAmount, formatTHB, type PaymentAttemptView } from '@oto/shared';
import {
  PARTY_SETTLEMENT_LABEL,
  isPartySettlementSale,
  partyTitleOf,
  refundItemOptions,
  toTxn,
  withChildName,
  type ApiSaleDetail,
  type ApiSaleLine,
  type ApiSaleListItem,
  type HistoryTxn,
} from '@/api/history';
import { tenderLabel } from '@/components/history/SaleDetail';
import { TransactionCard } from '@/components/history/TransactionCard';
import { OrderSummary } from '@/components/till/OrderSummary';
import { PARTY_DEPOSIT_LABEL, PaymentTenderPanel } from '@/components/till/PaymentTenderPanel';
import { StepPayment } from '@/components/till/StepPayment';
import { bahtText, satangText } from '@/lib/bahtText';
import { payNamesBalance, resumedPayLabel } from '@/lib/resumeSale';
import type { PaymentStageController } from '@/lib/usePaymentStage';
import type { CartLine, TicketType } from '@/types';

/**
 * SCRUM-934 AND ITS SIBLINGS — THE STAFF TILL SHOWS THE SAME MONEY, AND NAMES
 * THE SAME PERSON, EVERYWHERE.
 *
 * Found on staging by the proofs of SCRUM-909, 897 and 889:
 *   - a refund's By item rows on a sale with two drop-off children read
 *     "1 Hour Play · 1 ppl" twice, and the sale's item cards named neither
 *     child (SCRUM-934);
 *   - a 10 percent code on ฿1,605 read "-161" on its badge and "1444.5" on
 *     Total, Pay and Amount Due, the same money three ways (SCRUM-933);
 *   - a ticket sale part-paid at its payment step kept "Pay ฿<total>", and
 *     History's card of a part-paid sale named its total only (SCRUM-902);
 *   - a party's deposit read "other" and "Other", and a settlement's card
 *     "No receipt number" and "Ticket sale · Walk-in" (SCRUM-917);
 *   - the cancel dialog said one child "leave the waiting list" (SCRUM-938).
 * Whole-baht figures read exactly as before: those are pinned here too.
 */

// The panels are compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });
// SaleDetail (for its tender words) reads the operator, the station and the router at import.
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', () => undefined] }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som' }, can: () => true, offlineUnlock: null }),
}));

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

// --- SCRUM-933: the one formatter ---------------------------------------------------

describe('SCRUM-933 — one money formatter', () => {
  it('whole baht reads exactly as before: the bare figure, no decimals', () => {
    expect(formatBahtAmount(160_500)).toBe('1605');
    expect(formatBahtAmount(0)).toBe('0');
    expect(formatBahtAmount(1_590_000)).toBe('15900');
    expect(bahtText(1605)).toBe('1605');
    expect(satangText(91_500)).toBe('915');
  });

  it('an amount with satang shows two places, never one and never rounded to the baht', () => {
    expect(formatBahtAmount(144_450)).toBe('1444.50');
    expect(formatBahtAmount(16_050)).toBe('160.50');
    expect(formatBahtAmount(9_450)).toBe('94.50');
    expect(formatBahtAmount(1_250)).toBe('12.50');
    expect(formatBahtAmount(5)).toBe('0.05');
    expect(bahtText(1444.5)).toBe('1444.50');
    expect(bahtText(160.5)).toBe('160.50');
    // A float sum is read to the satang, not printed with its float noise.
    expect(bahtText(0.1 + 0.2)).toBe('0.30');
  });

  it('grouped where a screen already grouped, and formatTHB unchanged for whole baht', () => {
    expect(formatBahtAmount(160_500, { grouped: true })).toBe('1,605');
    expect(formatBahtAmount(144_450, { grouped: true })).toBe('1,444.50');
    expect(formatTHB(1_690_000)).toBe('฿16,900');
    expect(formatTHB(144_450)).toBe('฿1,444.50');
  });
});

// --- SCRUM-933: the order panel and the payment step -----------------------------------

const noop = () => undefined;
const ticket: TicketType = {
  id: '0190a0a0-0000-7000-8000-00000000c934',
  name: 'ZZ TEST 1 Hour Play',
  durationLabel: '1 hour',
  hours: 1,
  prices: { tourist: { weekday: 535, weekend: 535 } },
};
const line = { id: 'line-934', ticketType: ticket, tier: 'tourist', kids: 3, adults: 0, socks: 0, addOns: [], lineTotal: 1605 } as unknown as CartLine;
const emptyBreakdown = {
  netSubtotal: 0, discountTotal: 0, serviceChargeTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, categories: [], grandTotal: 0,
};
const vatBreakdown = (vat: number) => ({
  ...emptyBreakdown,
  inclusiveTaxTotal: vat,
  taxTotal: vat,
  categories: [{
    category: 'tickets', base: 0, taxMode: 'inclusive', taxName: 'VAT', taxPercent: 7, serviceCharge: 0, tax: vat,
    secondaryTaxMode: 'none', secondaryTaxPercent: 0, secondaryTax: 0, gross: 0,
  }],
});

/** The markup without React's text separators, as a person reads it. */
const plain = (html: string) => html.split('<!-- -->').join('');

function panel(totals: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return plain(renderToStaticMarkup(
    createElement(OrderSummary, {
      tier: 'tourist',
      lines: [line],
      discounts: [],
      manualDiscounts: [],
      onUpdateLine: noop,
      onRemoveLine: noop,
      onRemoveDiscount: noop,
      onAddManualDiscount: noop,
      onRemoveManualDiscount: noop,
      onPay: noop,
      onCancel: noop,
      canPay: true,
      totals: totals as never,
      ...extra,
    } as never),
  ));
}

describe('SCRUM-933 — the order panel shows one figure for the same money', () => {
  it('a 10 percent code on ฿1,605: the badge, Total, Pay and VAT all to the satang', () => {
    const html = panel({
      subtotal: 1605,
      scannedDiscounts: [{ code: 'ZZTEN', label: '10% off', type: 'percent', amount: 160.5 }],
      manualAmounts: {},
      total: 1444.5,
      taxBreakdown: vatBreakdown(94.5),
    });
    expect(html).toContain('-฿160.50');
    expect(html.includes('-฿161<')).toBe(false);
    expect(html).toContain('฿1444.50');
    expect(html).toContain('Pay ฿1444.50');
    expect(html).toContain('฿94.50');
    expect(html.includes('1444.5<')).toBe(false);
  });

  it('a whole-baht cart reads exactly as before', () => {
    const html = panel({ subtotal: 1605, scannedDiscounts: [], manualAmounts: {}, total: 1605, taxBreakdown: vatBreakdown(105) });
    expect(html).toContain('Pay ฿1605');
    expect(html).toContain('<span class="text-primary">฿1605</span>');
    expect(html).toContain('฿105');
    expect(html.includes('1605.00')).toBe(false);
    expect(html.includes('105.00')).toBe(false);
  });

  it('SCRUM-902 — a payLabel names the balance the till hands it', () => {
    const html = panel({ subtotal: 1605, scannedDiscounts: [], manualAmounts: {}, total: 1605, taxBreakdown: emptyBreakdown },
      { payLabel: resumedPayLabel(150_500) });
    expect(html).toContain('Pay ฿1505');
    expect(html.includes('Pay ฿1605')).toBe(false);
  });
});

describe('SCRUM-933 — the payment step’s Amount Due', () => {
  const step = (total: number, paymentStage?: PaymentStageController) =>
    plain(renderToStaticMarkup(createElement(StepPayment, {
      total, selectedMethod: null, onSelectMethod: noop, onComplete: noop, onBack: noop, ...(paymentStage ? { paymentStage } : {}),
    })));
  it('to the satang, and a whole figure as before', () => {
    expect(step(1444.5)).toContain('฿1444.50');
    expect(step(1605)).toContain('>฿1605</div>');
  });

  it('SCRUM-902 — a resumed sale’s balance not read yet is a dash, never ฿0 or “No payment needed”', () => {
    const stage = {
      state: { phase: 'blocked', saleId: 'sale-1', method: null, kind: null, outstandingSatang: 0, amountSatang: 0, tenderedSatang: 0,
        attempt: null, route: null, qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
        error: 'Checking the unfinished payment.', retryable: false, settlements: [], creditSatang: 0, creditSaleId: null, creditRefusedSaleId: null,
        cancelRefusal: null, partial: false },
      display: { saleId: 'sale-1', amountSatang: 0, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true },
      busy: false, online: true, locked: true, recovering: true, canBack: false, canSubmit: false, creditCoversAll: false, creditPendingSatang: 0,
      creditRefusal: null, canInquire: false, canConfirm: false, canCancel: false,
      selectMethod: noop, setAmountSatang: noop, setTenderedSatang: noop,
      submit: async () => undefined, retry: async () => undefined, inquire: async () => undefined, confirm: async () => undefined,
      manual: async () => undefined, cancel: async () => false,
    } as unknown as PaymentStageController;
    const html = step(0, stage);
    expect(html).toContain('>—</div>');
    expect(html.includes('฿0')).toBe(false);
    expect(html.includes('No payment needed')).toBe(false);
    // The stage's own note stays on screen while it reads.
    expect(html).toContain('Checking the unfinished payment.');
  });
});

describe('SCRUM-902 — the order panel’s Pay names the balance on a part-paid sale', () => {
  it('at the payment step, once money is taken there, as on a resumed sale', () => {
    expect(payNamesBalance({ resumed: false, step: 5, paidOnScreenSatang: 10_000 })).toBe(true);
    expect(payNamesBalance({ resumed: true, step: 5, paidOnScreenSatang: 0 })).toBe(true);
    expect(payNamesBalance({ resumed: false, step: 5, paidOnScreenSatang: 0 })).toBe(false);
    expect(payNamesBalance({ resumed: false, step: 3, paidOnScreenSatang: 10_000 })).toBe(false);
    expect(resumedPayLabel(150_500)).toBe('Pay ฿1505');
    expect(resumedPayLabel(144_450)).toBe('Pay ฿1444.50');
  });
});

// --- SCRUM-934: the drop-off child on the refund rows and the item cards ------------------

const saleLine = (over: Partial<ApiSaleLine> & Pick<ApiSaleLine, 'id' | 'cartLineId' | 'kind' | 'grossSatang'>): ApiSaleLine => ({
  lineNo: 1, componentKey: null, ticketPackageId: 'pkg-1h', label: 'Kids', revenueCategory: 'tickets', taxableCategory: 'tickets',
  quantity: 1, unitSatang: over.grossSatang, baseSatang: over.grossSatang, discountSatang: 0, netSatang: over.grossSatang,
  serviceChargeSatang: 0, taxSatang: 0, taxMode: 'inclusive', taxRateBp: 700, taxName: 'VAT', customerTier: 'tourist',
  kidCount: 1, adultCount: 0, freeAdultCount: 0, stayHours: 1, stayDurationLabel: '1 Hour Play',
  ...over,
});

/** SCRUM-909's sale: two drop-off children, ฿915 each (the play and the drop-off fee), and a plain ticket. */
const twoChildren: Pick<ApiSaleDetail, 'lines' | 'refunds'> = {
  lines: [
    saleLine({ id: 'a1-kid', cartLineId: 'stay-a1', kind: 'kids', grossSatang: 69_000, childName: 'ZZ TEST Mint' }),
    saleLine({ id: 'a1-fee', cartLineId: 'stay-a1', kind: 'service_fee', label: 'Drop-off service', grossSatang: 22_500, childName: 'ZZ TEST Mint' }),
    saleLine({ id: 'a2-kid', cartLineId: 'stay-a2', kind: 'kids', grossSatang: 69_000, childName: 'ZZ TEST Pang' }),
    saleLine({ id: 'a2-fee', cartLineId: 'stay-a2', kind: 'service_fee', label: 'Drop-off service', grossSatang: 22_500, childName: 'ZZ TEST Pang' }),
    saleLine({ id: 'plain', cartLineId: 'cart-plain', kind: 'kids', grossSatang: 69_000, childName: null }),
  ],
  refunds: [],
};

describe('SCRUM-934 — By item names the child each row frees', () => {
  it('two drop-off children are two rows that name them; a plain ticket reads as before', () => {
    const rows = refundItemOptions(twoChildren, () => '1 Hour Play');
    expect(rows.map((r) => [r.id, r.label, r.amountSatang])).toEqual([
      ['stay-a1', 'ZZ TEST Mint · 1 Hour Play · 1 ppl', 91_500],
      ['stay-a2', 'ZZ TEST Pang · 1 Hour Play · 1 ppl', 91_500],
      ['cart-plain', '1 Hour Play · 1 ppl', 69_000],
    ]);
  });

  it('an older platform that names no child reads exactly as before', () => {
    const old = { lines: twoChildren.lines.map(({ childName: _gone, ...rest }) => rest as ApiSaleLine), refunds: [] };
    expect(refundItemOptions(old, () => '1 Hour Play').map((r) => r.label)).toEqual([
      '1 Hour Play · 1 ppl', '1 Hour Play · 1 ppl', '1 Hour Play · 1 ppl',
    ]);
  });

  it('the item cards, desk and phone, name the child the same way', () => {
    expect(withChildName('1 Hour Play', twoChildren.lines.slice(0, 2))).toBe('ZZ TEST Mint · 1 Hour Play');
    expect(withChildName('1 Hour Play', twoChildren.lines.slice(4))).toBe('1 Hour Play');
    expect(src('components/history/SaleDetail.tsx')).toContain(
      "const name = withChildName(packageName(first.ticketPackageId) ?? first.stayDurationLabel ?? 'Items', lines);",
    );
    expect(src('components/mobile/history/MobileTransactionDetail.tsx')).toContain(
      "{withChildName(state.packageName(lines[0]?.ticketPackageId ?? null) ?? lines[0]?.label ?? '', lines)}",
    );
  });
});

// --- History's card and detail ------------------------------------------------------------

const listRow = (over: Partial<ApiSaleListItem> & Pick<ApiSaleListItem, 'id' | 'status'>, gross: number): HistoryTxn =>
  toTxn(
    {
      branchId: 'branch-1', stationId: 'station-1', memberId: null, visitId: null, businessDate: '2026-11-12',
      occurredAt: '2026-11-12T06:00:00.000Z', pricingMode: 'weekday', pricingModeReason: 'Weekday', customerTier: 'tourist',
      receiptNumber: null, receiptSeries: 'T1', receiptSeq: 1, finalisedAt: null, note: null,
      totals: {
        subtotalSatang: gross, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0, netSatang: gross,
        serviceChargeSatang: 0, taxInclusiveSatang: 0, taxExclusiveSatang: 0, grossSatang: gross,
        unappliedDiscountSatang: 0, refundedSatang: 0,
      },
      soldBy: { accountId: 'account-1', name: 'Som' }, stationName: 'Reception Till 1', member: null,
      lineKinds: ['kids'], revenueCategories: ['tickets'],
      ...over,
    } as ApiSaleListItem,
    {},
  );

const card = (txn: HistoryTxn) => plain(renderToStaticMarkup(createElement(TransactionCard, { txn, badge: txn.badge, onClick: noop })));

describe('SCRUM-902 — History’s card names a part-paid sale’s balance, with its total', () => {
  it('the proof’s order: ฿175 with ฿50 taken reads Balance due ฿125, of ฿175', () => {
    const txn = listRow({ id: 'sale-part', status: 'tendering', partPaid: { paidSatang: 5_000, balanceSatang: 12_500 } }, 17_500);
    expect(txn.balanceDue).toBe(125);
    const html = card(txn);
    expect(html).toContain('Balance due');
    expect(html).toContain('฿125');
    expect(html).toContain('of ฿175');
    expect(html).toContain('Partly paid');
  });

  it('every other card reads exactly as before', () => {
    const paid = listRow({ id: 'sale-paid', status: 'finalised', receiptNumber: 'T1-000123' }, 17_500);
    expect(paid.balanceDue).toBeUndefined();
    const html = card(paid);
    expect(html).toContain('<span class="text-lg font-bold tabular-nums w-20 text-right">฿175</span>');
    expect(html.includes('Balance due')).toBe(false);
    const unpaid = listRow({ id: 'sale-unpaid', status: 'tendering' }, 17_500);
    expect(unpaid.balanceDue).toBeUndefined();
  });

  it('SCRUM-917 — on the phone the badge sits over the figure; from @md the row is as before', () => {
    const html = card(listRow({ id: 'sale-part', status: 'tendering', partPaid: { paidSatang: 5_000, balanceSatang: 12_500 } }, 17_500));
    expect(html).toContain('@container p-4 flex items-center gap-4');
    expect(html).toContain('flex flex-col items-end gap-1 @md:flex-row @md:items-center @md:gap-3');
    // The date never breaks word by word.
    expect(html).toContain('flex items-center gap-1 whitespace-nowrap');
  });
});

describe('SCRUM-917 — a party’s settlement reads as one, and names its party', () => {
  it('the card is headed Party settlement while it has no receipt, and names the party', () => {
    const txn = listRow({
      id: 'sale-settlement', status: 'tendering', note: 'Party: ZZ TEST SCRUM-916 party',
      partySettlement: { eventId: 'event-1', settlementId: 'settlement-1' },
    }, 1_690_000);
    expect(txn.reference).toBe(PARTY_SETTLEMENT_LABEL);
    expect(txn.customerLabel).toBe('ZZ TEST SCRUM-916 party');
    expect(partyTitleOf(txn.ledger)).toBe('ZZ TEST SCRUM-916 party');
    expect(isPartySettlementSale(txn.ledger)).toBe(true);
  });

  it('a settled one keeps its receipt number; any other sale reads as before', () => {
    const settled = listRow({ id: 's', status: 'finalised', receiptNumber: 'T1-000200', note: 'Party: Pim', partySettlement: { eventId: 'e', settlementId: 's' } }, 1_690_000);
    expect(settled.reference).toBe('T1-000200');
    const walkIn = listRow({ id: 'w', status: 'tendering' }, 17_500);
    expect([walkIn.reference, walkIn.customerLabel]).toEqual(['No receipt number', undefined]);
    expect(isPartySettlementSale(walkIn.ledger)).toBe(false);
  });

});

describe('SCRUM-917 — the party’s deposit is named as the deposit', () => {
  const attempt = (over: Partial<PaymentAttemptView>): PaymentAttemptView => ({
    id: 'a', saleId: 's', method: 'other', provider: 'manual', status: 'approved', amountSatang: 100_000, tenderedSatang: null,
    changeSatang: null, terminalRef: null, tid: null, approvalCode: null, last4: null, invoiceNo: null, tranRef: null,
    actionId: null, offline: false, paidAt: '2026-11-12T06:00:00.000Z', createdAt: '2026-11-12T06:00:00.000Z', ...over,
  });

  it('in History: "Party deposit" where the platform names it, the ledger’s word otherwise', () => {
    expect(tenderLabel(attempt({ partyDeposit: true }), { note: 'Party: Pim' })).toBe('Party deposit');
    expect(tenderLabel(attempt({}), { note: null })).toBe('Other');
    expect(tenderLabel(attempt({ method: 'cash' }), { note: 'Party: Pim' })).toBe('Cash');
  });

  it('on the settle payment screen’s Recorded payments', () => {
    const stage = {
      state: { phase: 'ready', saleId: 'sale-1', method: null, kind: null, outstandingSatang: 1_590_000, amountSatang: 1_590_000,
        tenderedSatang: 1_590_000, attempt: null, route: null, qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
        error: null, retryable: false, creditSatang: 0, creditSaleId: null, creditRefusedSaleId: null, cancelRefusal: null, partial: false,
        settlements: [{ attemptId: 'dep', method: 'other', kind: 'other', amountSatang: 100_000, partyDeposit: true }] },
      busy: false, online: true, locked: false, canBack: true, canSubmit: false, creditCoversAll: false, creditPendingSatang: 0,
      creditRefusal: null, canInquire: false, canConfirm: false, canCancel: false,
      selectMethod: noop, setAmountSatang: noop, setTenderedSatang: noop,
      submit: async () => undefined, retry: async () => undefined, inquire: async () => undefined, confirm: async () => undefined,
      manual: async () => undefined, cancel: async () => false,
    } as unknown as PaymentStageController;
    const html = plain(renderToStaticMarkup(createElement(PaymentTenderPanel, { stage })));
    expect(PARTY_DEPOSIT_LABEL).toBe('Party deposit');
    expect(html).toContain('Party deposit · ฿1000.00');
    expect(html.includes('other · ')).toBe(false);
  });
});
