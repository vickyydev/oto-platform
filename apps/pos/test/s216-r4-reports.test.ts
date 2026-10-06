import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscountReport, DiscountTransactions, ProfitabilityReport, SalesReport, TaxReceipts, VatReport } from '@oto/shared';
import { api } from '@/api/client';
import { analyticsReportsApi } from '@/api/analyticsReports';
import { guardCsvFormula, toCsv } from '@/lib/csv';
import { SalesReportView, EMPTY_SALES_REPORT } from '@/components/admin/reports/SalesReportPanel';
import { ProfitabilityReportView } from '@/components/admin/reports/ProfitabilityReportPanel';
import { DiscountCompReportView } from '@/components/admin/reports/DiscountCompReportPanel';
import {
  TaxVatReportView,
  filterTaxReceipts,
  taxReceiptPaymentMethodsOf,
} from '@/components/admin/reports/TaxVatReportPanel';
import { adminPanelsById } from '@/components/admin/adminSections';

/**
 * S2-15b round 4 — Admin > Reports drawn from the platform's answers: the
 * prototype's cards, titles, words and columns with the figures the report
 * routes answered; the requests the panels make; and the CSV exports, guarded
 * against formula injection as the settlement export is.
 */

Object.assign(globalThis, { React });

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const text = (el: React.ReactElement) => markup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const filters = { startDate: '2026-10-01', endDate: '2026-10-07', branchId: 'all' };
const scope = { from: '2026-10-01', to: '2026-10-07', branches: [], omitted: [] };

afterEach(() => vi.restoreAllMocks());

describe('the CSV exports', () => {
  it('writes a cell a spreadsheet would run as a formula as text, and leaves numbers alone', () => {
    expect(guardCsvFormula('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(guardCsvFormula('+66812345678')).toBe("'+66812345678");
    expect(guardCsvFormula('-2+3')).toBe("'-2+3");
    expect(guardCsvFormula('@cmd')).toBe("'@cmd");
    expect(guardCsvFormula('  =1+1')).toBe("'  =1+1");
    expect(guardCsvFormula('\tTAB')).toBe("'\tTAB");
    expect(guardCsvFormula('-125.50')).toBe('-125.50');
    expect(guardCsvFormula('1250.00')).toBe('1250.00');
    expect(guardCsvFormula(-3)).toBe('-3');
    expect(guardCsvFormula('Pad Thai')).toBe('Pad Thai');
  });

  it('quotes a cell with a comma, a quote or a line break, after guarding it', () => {
    expect(toCsv(['Reason', 'Note', 'Amount'], [['Birthday, staff', '=HYPERLINK("x")', '-50.00']])).toBe(
      'Reason,Note,Amount\n"Birthday, staff","\'=HYPERLINK(""x"")",-50.00',
    );
    expect(toCsv(['A'], [['two\nlines']])).toBe('A\n"two\nlines"');
  });
});

describe('the requests', () => {
  it('asks the report routes for the branches and business dates, every park when none is named', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(EMPTY_SALES_REPORT);
    await analyticsReportsApi.sales({ from: '2026-10-01', to: '2026-10-07' });
    await analyticsReportsApi.profitability({ branches: ['b-1'], from: '2026-10-01', to: '2026-10-07' });
    await analyticsReportsApi.discounts({ branches: ['b-1'], from: '2026-10-01', to: '2026-10-07' });
    await analyticsReportsApi.discountTransactions({ branches: ['b-1'], from: '2026-10-01', to: '2026-10-07' });
    await analyticsReportsApi.vat({ branches: ['b-1', 'b-2'], from: '2026-10-01', to: '2026-10-07' }, 'month');
    await analyticsReportsApi.taxReceipts({ from: '2026-10-01', to: '2026-10-07' });
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      '/analytics/reports/sales?from=2026-10-01&to=2026-10-07',
      '/analytics/reports/profitability?branches=b-1&from=2026-10-01&to=2026-10-07',
      '/analytics/reports/discounts?branches=b-1&from=2026-10-01&to=2026-10-07',
      '/analytics/reports/discounts/transactions?branches=b-1&from=2026-10-01&to=2026-10-07',
      '/analytics/reports/tax/vat?branches=b-1%2Cb-2&from=2026-10-01&to=2026-10-07&period=month',
      '/analytics/reports/tax/receipts?from=2026-10-01&to=2026-10-07',
    ]);
  });

  it('offers the four panels as server-backed now, to analytics:read', () => {
    for (const id of ['reports-sales', 'reports-profitability', 'reports-discounts', 'reports-tax']) {
      expect(adminPanelsById[id]!.localOnly, id).toBeFalsy();
      expect(adminPanelsById[id]!.permission, id).toBe('analytics:read');
    }
  });
});

describe('the panels, drawn from the platform', () => {
  it('Sales keeps its cards, titles and columns, with the answer’s figures', () => {
    const report: SalesReport = {
      ...scope,
      categories: [
        { category: 'tickets', grossRevenueSatang: 180_000, taxCollectedSatang: 11_776, serviceChargeSatang: 0, count: 4, pctShare: 75 },
        { category: 'fnb', grossRevenueSatang: 60_000, taxCollectedSatang: 3_925, serviceChargeSatang: 0, count: 2, pctShare: 25 },
      ],
      payments: [{ method: 'wallet_credit', amountSatang: 20_000, count: 1 }],
      tiers: [{ tier: 'tourist', ticketRevenueSatang: 157_500, dropOffRevenueSatang: 22_500, saleCount: 4 }],
      ticketTypes: [{ ticketTypeId: 'p-2h', name: '2 Hours Play', lineCount: 3, kids: 4, adults: 3, revenueSatang: 150_000 }],
      weekdayWeekend: [{ mode: 'weekend', saleCount: 4, revenueSatang: 180_000 }],
      dropOffNanny: [{ service: 'drop_off', sessionCount: 1, totalHours: 2, feesSatang: 22_500 }],
      fnbItems: Array.from({ length: 17 }, (_, i) => ({ itemId: `f-${i}`, name: `Dish ${i}`, qty: 1, revenueSatang: 1_000 })),
      merchItems: [{ itemId: 'm-1', name: 'Oto Mascot Plush', qty: 1, revenueSatang: 45_000 }],
    };
    const words = text(React.createElement(SalesReportView, { filters, onFiltersChange: () => undefined, report }));
    expect(words).toContain('Revenue by category — ฿2,400.00 total');
    for (const heading of ['Payment method mix', 'Ticket sales by tier', 'Ticket type breakdown', 'Weekday / weekend split', 'Drop-off / nanny sessions', 'Event / camp revenue (estimate)', 'Top F&B items', 'Top merch items']) {
      expect(words, heading).toContain(heading);
    }
    expect(words).toContain('Tickets ฿1,800.00 75.0% ฿117.76 ฿0.00 4');
    expect(words).toContain('wallet credit ฿200.00 1');
    expect(words).toContain('tourist ฿1,575.00 ฿225.00 4');
    expect(words).toContain('2 Hours Play 3 4 3 ฿1,500.00');
    expect(words).toContain('drop off 1 2 ฿225.00');
    // The top fifteen F&B items, as the prototype slices them.
    expect(words).toContain('Dish 14');
    expect(words).not.toContain('Dish 15');
    // No event or camp pass is sold on the platform yet: the card stays, empty.
    expect(markup(React.createElement(SalesReportView, { filters, onFiltersChange: () => undefined, report }))).toContain('No data in this range.');
  });

  it('Sales says why it is empty when the platform refused', () => {
    const words = text(
      React.createElement(SalesReportView, { filters, onFiltersChange: () => undefined, report: EMPTY_SALES_REPORT, error: 'Missing permission analytics:read' }),
    );
    expect(words).toContain('The figures could not be loaded from the platform — Missing permission analytics:read');
    expect(words).toContain('Revenue by category — ฿0.00 total');
  });

  it('Profitability flags an item with no cost and keeps its totals line', () => {
    const report: ProfitabilityReport = {
      ...scope,
      fnb: [
        { itemId: 'j', name: 'Fresh Orange Juice', qty: 5, revenueSatang: 35_000, cogsSatang: 0, marginSatang: 35_000, marginPercent: 100, costTracked: false },
        { itemId: 'p', name: 'Pad Thai', qty: 2, revenueSatang: 30_000, cogsSatang: 12_000, marginSatang: 18_000, marginPercent: 60, costTracked: true },
      ],
      merch: [],
    };
    const words = text(React.createElement(ProfitabilityReportView, { filters, onFiltersChange: () => undefined, report }));
    expect(words).toContain('Revenue ฿650.00 · COGS ฿120.00 · Margin ฿530.00');
    expect(words).toContain('no cost set');
    expect(words).toContain('Some items sold in this range have no cost-to-park set in the catalog.');
    expect(words).toContain('Pad Thai 2 ฿300.00 ฿120.00 ฿180.00 60.0%');
  });

  it('Discounts & Comps draws the five tiles, by type, by operator and the two lists', () => {
    const report: DiscountReport = {
      ...scope,
      compSatang: 30_000,
      manualDiscountSatang: 5_000,
      promoSatang: 15_000,
      freeItemBenefitSatang: 0,
      promoByType: [{ type: 'fixed', count: 1, amountSatang: 15_000 }],
      byOperator: [{ appliedBy: 'Nok', compCount: 1, compTotalSatang: 30_000, discountCount: 1, discountTotalSatang: 5_000 }],
    };
    const lists: DiscountTransactions = {
      ...scope,
      rows: [
        { source: 'sale', transactionId: 'HKT1-000012', createdAt: '2026-10-06T06:00:00.000Z', operatorName: 'Nok', type: 'comp', reason: 'Staff / family', note: null, amountSatang: 30_000, appliedBy: 'Nok' },
      ],
      promoRows: [
        { transactionId: 'HKT1-000010', createdAt: '2026-10-06T05:00:00.000Z', operatorName: 'Nok', code: '…47WP', label: '150 THB Voucher (voucher …47WP)', type: 'fixed', amountSatang: 15_000 },
      ],
    };
    const words = text(
      React.createElement(DiscountCompReportView, { filters, onFiltersChange: () => undefined, report, transactions: lists }),
    );
    expect(words).toContain('Total comps ฿300.00');
    expect(words).toContain('Manual discounts ฿50.00');
    expect(words).toContain('Promo codes ฿150.00');
    expect(words).toContain('Free-item benefit ฿0.00');
    expect(words).toContain('Total impact ฿500.00');
    expect(words).toContain('Nok 1 ฿300.00 1 ฿50.00');
    expect(words).toContain('Promo code impact (1)');
    expect(words).toContain('Transactions (1)');
    expect(words).toContain('sale/HKT1-000012');
    expect(words).toContain('…47WP');
  });

  it('Tax & VAT draws the summary and the receipts, narrowed by category and tender as before', () => {
    const vat: VatReport = {
      ...scope,
      period: 'range',
      rows: [{ category: 'tickets', period: null, netBaseSatang: 168_224, serviceChargeSatang: 0, exclusiveTaxSatang: 0, inclusiveTaxSatang: 11_776, grossSatang: 180_000 }],
    };
    const receipt = (over: Partial<TaxReceipts['rows'][number]>): TaxReceipts['rows'][number] => ({
      kind: 'ticket',
      transactionId: 'HKT1-000001',
      createdAt: '2026-10-06T03:00:00.000Z',
      branchId: '018f0000-0000-7000-8000-000000000001',
      branchName: 'Oto Play Park, Central Floresta',
      operatorName: 'Nok',
      netSubtotalSatang: 93_458,
      serviceChargeSatang: 0,
      taxTotalSatang: 6_542,
      grandTotalSatang: 100_000,
      taxSummaryLabel: 'VAT included ฿65.42',
      categories: ['tickets'],
      paymentMethod: 'cash',
      ...over,
    });
    const receipts: TaxReceipts = {
      ...scope,
      rows: [
        receipt({}),
        receipt({ transactionId: 'HKT1-000002', kind: 'fnb', categories: ['fnb'], paymentMethod: 'split' }),
        receipt({ transactionId: 'HKT1-000003', paymentMethod: 'paid_online' }),
      ],
    };
    expect(taxReceiptPaymentMethodsOf(receipts.rows)).toEqual(['cash', 'paid_online', 'split']);
    expect(filterTaxReceipts(receipts.rows, 'fnb', 'all').map((r) => r.transactionId)).toEqual(['HKT1-000002']);
    expect(filterTaxReceipts(receipts.rows, 'tickets', 'paid_online').map((r) => r.transactionId)).toEqual(['HKT1-000003']);
    const words = text(
      React.createElement(TaxVatReportView, {
        filters,
        onFiltersChange: () => undefined,
        period: 'range',
        onPeriodChange: () => undefined,
        vat,
        receipts,
      }),
    );
    expect(words).toContain('VAT summary — ฿117.76 tax on ฿1,800.00 gross');
    expect(words).toContain('Tickets ฿1,682.24 ฿0.00 ฿0.00 ฿117.76 ฿1,800.00');
    expect(words).toContain('Bulk tax-receipt export (3 transactions)');
    expect(words).toContain('ticket/HKT1-000001');
  });
});
