import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MoneyCash, MoneyCosts, MoneyDiscounts, MoneyIntegrity, MoneyRefunds, MoneySales, MoneySettlement, MoneyWallets,
} from '@/api/moneyOversight';
import { findSection, sectionForPath, visibleNavigation } from '@/components/consoleSections';
import { MoneyOversight, MoneyOversightContent, type MoneyData } from '@/pages/MoneyOversight';

const session = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({
  state: 'signed-in', authorityEpoch: 1, refreshing: false, isCurrentAuthority: (epoch: number) => epoch === 1,
  me: { isPlatformAdmin: false, branch: null, sessionLocked: false,
    account: { id: 'caller', operatorId: 'operator', status: 'active', mustChangePassword: false },
    operatorContext: { sessionId: '01964700-0000-7000-8000-000000000009', homeOperatorId: 'operator',
      effectiveOperatorId: 'operator', operatorOverride: null, branchId: null, stationId: null, revision: 0 } },
  permissions: [...session.allowed].map((permission) => ({ permission, scopeType: 'operator', scopeId: null })),
  has: (permission: string) => session.allowed.has(permission),
}) }));
vi.mock('@/components/redesign/CommandBar', () => ({ CommandBar: ({ sectionId }: { sectionId: string }) => createElement('h1', null, sectionId) }));
beforeEach(() => { session.allowed = new Set(); });

const PARK = '01964700-0000-7000-8000-00000000000a';
const SALE = '01964700-0000-7000-8000-0000000000b1';
const ATTEMPT = '01964700-0000-7000-8000-0000000000c1';
const scope = { from: '2026-10-01', to: '2026-10-02', branches: [{ branchId: PARK, name: 'ZZ TEST Park' }], omitted: [] };
const zeroRow = {
  businessDate: '2026-10-01', provisional: false, rolledDays: 1, computedAt: null, revenueSatang: 123_400, ticketsSatang: 100_000,
  fnbSatang: 23_400, merchSatang: 0, partiesSatang: 0, dropoffSatang: 0, refundsSatang: 0, discountsSatang: 0, compsSatang: 0, txnCount: 3,
};
const sales: MoneySales = {
  scope, basis: 'stored-daily-summary', total: { ...zeroRow, businessDate: null },
  branches: [{ branchId: PARK, name: 'ZZ TEST Park', source: 'oto_pos', today: '2026-10-28', lastRolledUpAt: null, total: { ...zeroRow, businessDate: null }, days: [zeroRow] }],
};
const trace = (kind: 'sale' | 'payment_attempt', id: string) => ({ kind, id, href: `/support?trace=${id}&kind=${kind}` });
const refunds: MoneyRefunds = {
  scope, basis: 'original-sale-business-date',
  refunds: { count: 1, totalSatang: 40_000, truncated: false, rows: [{
    branchId: PARK, number: 'ZZC-R-000001', amountSatang: 40_000, mode: 'custom', reason: 'Wrong ticket', approvedBy: 'Manager May',
    createdBy: 'Till Tom', pending: false, createdAt: '2026-10-01T06:00:00.000Z',
    sale: { receiptNumber: 'ZZC-000005', businessDate: '2026-10-01', grossSatang: 100_000, status: 'finalised' },
    refundId: null, saleId: null, trace: null,
  }] },
  voids: { count: 0, totalSatang: 0, truncated: false, rows: [] },
};
const discounts: MoneyDiscounts = {
  scope, basis: 'stored-report-facts', compSatang: 1_000, manualDiscountSatang: 2_000, promoSatang: 3_000, freeItemBenefitSatang: 0,
  foregoneSatang: 6_000, promoByType: [], byOperator: [],
};
const cash: MoneyCash = {
  scope, basis: 'pos-end-of-day', toleranceSatang: 100,
  branches: [{ branchId: PARK, name: 'ZZ TEST Park', days: [
    { businessDate: '2026-10-01', available: true, status: 'closed', verdict: 'off', floatSatang: 600_000, countedSatang: 610_500,
      floatLeftSatang: 600_000, paidOutSatang: 0, safeDropSatang: 0, totalExpectedSatang: 10_000, totalActualSatang: 10_500,
      totalDifferenceSatang: 500, linesOff: 1, lines: [], closedBy: 'Manager May', closedAt: '2026-10-01T13:00:00.000Z', provisionalBoxes: 0 },
    { businessDate: '2026-10-02', available: false, code: 'EVENTS_SEAM_MISSING', reason: 'Party money was taken on this day but the OTO App events seam is not on this database' },
  ] }],
};
const settlement: MoneySettlement = {
  scope, basis: 'pos-settlement', gatewayFileFormat: 'fixture_only',
  branches: [{ branchId: PARK, name: 'ZZ TEST Park', days: [{
    businessDate: '2026-10-01', terminals: [], gateway: { state: 'no_file', files: 0 }, matched: 0, unmatchedLines: [], unmatchedAttempts: [],
  }] }],
};
const wallets: MoneyWallets = {
  scope, basis: 'fact-wallet-liability-daily', outstanding: { projectionSatang: 30_000, ledgerSatang: 30_000 },
  branches: [{ branchId: PARK, name: 'ZZ TEST Park', outstanding: { projectionSatang: 30_000, ledgerSatang: 30_000 }, days: [
    { businessDate: '2026-10-01', written: true, grantedSatang: 30_000, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, reactivatedSatang: 0, outstandingSatang: 30_000 },
    { businessDate: '2026-10-02', written: false, reason: 'not_yet_written' },
  ] }],
};
const costs: MoneyCosts = {
  scope,
  booths: { prizeCostSatang: 0, prizeCostIncomplete: false, vouchersIssued: 0, vouchersRedeemed: 0, lastRolledUpAt: null, rows: [] },
  benefits: { totalReliefSatang: 0, appliedSatang: 0, compedSatang: 0, freeItemsSatang: 0, creditSatang: 0, discountSatang: 0, applications: 0, lastRolledUpAt: null, byRole: [] },
};
const integrity: MoneyIntegrity = {
  scope, pendingMinutes: 10, generatedAt: '2026-10-28T00:00:00.000Z',
  checks: [
    { key: 'receipt_gaps', label: 'Receipt-number gaps per station and series', window: 'series_history', truncated: false, rows: [] },
    { key: 'sales_without_payment', label: 'Sales with no settled payment', window: 'business_dates', truncated: false, rows: [{
      branchId: PARK, stationId: null, stationName: 'ZZ Till', title: 'Sale ZZG-000001: ฿500.00 not settled', detail: 'Charged ฿500.00; payments taken ฿0.00.',
      businessDate: '2026-10-01', amountSatang: 50_000, saleId: SALE, attemptId: null, actionId: 'ZZ-action', receiptNumber: 'ZZG-000001', walletId: null,
      trace: trace('sale', SALE),
    }] },
    { key: 'payments_without_sale', label: 'Payments with no sale', window: 'business_dates', truncated: false, rows: [{
      branchId: PARK, stationId: null, stationName: null, title: '฿70.00 promptpay taken with no sale', detail: 'No owner.',
      businessDate: '2026-10-02', amountSatang: 7_000, saleId: null, attemptId: ATTEMPT, actionId: null, receiptNumber: null, walletId: null,
      trace: trace('payment_attempt', ATTEMPT),
    }] },
  ],
};
const ok = <T,>(data: T) => ({ data, error: null });
const full = (overrides: Partial<MoneyData> = {}): MoneyData => ({
  sales: ok(sales), refunds: ok(refunds), discounts: ok(discounts), cash: ok(cash), settlement: ok(settlement),
  wallets: ok(wallets), costs: ok(costs), integrity: ok(integrity), ...overrides,
});
const render = (data: MoneyData) => renderToStaticMarkup(createElement(Router, { ssrPath: '/reports/money',
  children: createElement(MoneyOversightContent, { data, onRetry: () => undefined }) }));

describe('Money oversight page (SCRUM-647)', () => {
  it('offers explicitly loaded-row attention views without changing the overview totals or date bases', () => {
    const html = render(full());
    expect(html).toContain('Only cash days needing attention');
    expect(html).toContain('Only settlement days needing attention');
    expect(html).toContain('loaded park and date range');
    expect(html).toContain('Money at a glance');
    expect(html).toContain('฿1,234');
    expect(html).toContain('original sale');
  });

  it('is refused without console:money:read and lives under Reports at /money and /reports/money', () => {
    const refused = renderToStaticMarkup(createElement(MoneyOversight));
    expect(refused).toContain('This page is not on your access');
    expect(refused).toContain('console:money:read');
    session.allowed.add('console:money:read');
    expect(renderToStaticMarkup(createElement(MoneyOversight))).not.toContain('This page is not on your access');
    expect(findSection('money')).toMatchObject({ path: '/reports/money', permission: 'console:money:read' });
    expect(sectionForPath('/money')).toEqual(findSection('money'));
    const nav = visibleNavigation((permission) => permission === 'console:money:read', false);
    expect(nav.map((area) => area.id)).toEqual(['reports']);
    expect(nav[0]!.sections.map((page) => page.id)).toEqual(['money']);
    expect(visibleNavigation((permission) => permission === 'analytics:read', false)[0]!.sections.map((page) => page.id)).not.toContain('money');
  });

  it('renders the figures from what was read, in satang through the shared formatter', () => {
    const html = render(full());
    expect(html).toContain('Money at a glance');
    expect(html).toContain('฿1,234');
    expect(html).toContain('ZZC-R-000001');
    expect(html).toContain('Approved by Manager May');
    expect(html).toContain('ZZC-000005');
    expect(html).toContain('฿60');
    expect(html).toContain('owed ฿300');
  });

  it('draws a source that is not there as not available, never as a zero', () => {
    const html = render(full());
    const refused = html.slice(html.indexOf('data-cash-day="2026-10-02"'));
    expect(html).toContain('data-available="false"');
    expect(refused.slice(0, 800)).toContain('Not available');
    expect(refused.slice(0, 800)).toContain('End of Day could not read this day');
    expect(refused.slice(0, 800)).not.toMatch(/expected ฿0/);
    expect(html).toContain('No 2C2P file imported');
    expect(html).toContain('not written yet');
    expect(html).toContain('the real provider file is not mapped yet');
    // Every one of them carries the same distinct mark.
    expect((html.match(/not-available/g) ?? []).length).toBe(3);
  });

  it('shows the integrity panel only to an investigator, with every row linked to its support trace by identifier', () => {
    const withPanel = render(full());
    expect(withPanel).toContain('Money integrity');
    expect(withPanel).toContain(`href="/support?trace=${SALE}&amp;kind=sale"`);
    expect(withPanel).toContain(`href="/support?trace=${ATTEMPT}&amp;kind=payment_attempt"`);
    expect(withPanel).toContain(`data-trace-id="${SALE}"`);
    expect(withPanel).toContain('Support trace');
    expect(withPanel).toContain(`sale ${SALE}`);
    expect(withPanel).toContain('receipt ZZG-000001');
    expect(withPanel).toContain('None found');
    const withoutPanel = render(full({ integrity: null }));
    expect(withoutPanel).not.toContain('Money integrity');
    expect(withoutPanel).not.toContain('/support?');
  });

  it('a section that could not be read says so instead of an empty all-clear', () => {
    const html = render(full({ cash: { data: null, error: 'ZZ TEST cash unavailable' } }));
    expect(html).toContain('ZZ TEST cash unavailable');
    expect(html).toContain('Cash days could not be read');
    expect(html).toContain('Not read');
  });

  it('offers nothing that moves money', () => {
    const html = render(full());
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Refund|Void|Settle|Import|Close day|Reactivate|Capture)/i);
    expect(html).not.toContain('<form');
  });
});
