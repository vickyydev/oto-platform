import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import {
  amountLabelOf,
  badgeOf,
  balanceDueSatang,
  openSaleBadgeOf,
  spentOf,
  toTxn,
  type ApiSaleDetail,
  type ApiSaleListItem,
  type HistoryTxn,
} from '@/api/history';
import { api } from '@/api/client';
import { stationLinkApi } from '@/station/link';
import { useSaleDetail } from '@/components/history/SaleDetail';
import { StatusBadge } from '@/components/history/StatusBadge';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-890 — A PART-PAID SALE IN HISTORY READS AS PARTLY PAID, WITH ITS BALANCE.
 *
 * Found in SCRUM-877's staging proof: an F&B order of ฿175 with ฿50 taken
 * showed "Unpaid" and "Amount due ฿175". A sale still open with money taken
 * on it is partly paid: the badge says so and the figure is what is still to
 * pay (gross less every tender that took money). A party settlement holding
 * only its deposit stays unpaid (SCRUM-876: the deposit is the party's, not
 * the till's), and its figure is unchanged.
 */

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', vi.fn()] }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som' }, can: () => true, offlineUnlock: null }),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
});

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

const row = (
  id: string,
  status: ApiSaleListItem['status'],
  gross: number,
  partPaid?: ApiSaleListItem['partPaid'],
): HistoryTxn =>
  toTxn(
    {
      id,
      branchId: 'branch-1',
      stationId: 'station-1',
      memberId: null,
      visitId: null,
      businessDate: '2026-11-12',
      occurredAt: '2026-11-12T06:00:00.000Z',
      status,
      pricingMode: 'weekday',
      pricingModeReason: 'Weekday',
      customerTier: 'tourist',
      receiptNumber: null,
      receiptSeries: 'T1',
      receiptSeq: 1,
      finalisedAt: null,
      note: null,
      totals: {
        subtotalSatang: gross, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0, netSatang: gross,
        serviceChargeSatang: 0, taxInclusiveSatang: 0, taxExclusiveSatang: 0, grossSatang: gross,
        unappliedDiscountSatang: 0, refundedSatang: 0,
      },
      soldBy: { accountId: 'account-1', name: 'Som' },
      stationName: 'Reception Till 1',
      member: null,
      lineKinds: ['fnb_item'],
      revenueCategories: ['fnb'],
      ...(partPaid !== undefined ? { partPaid } : {}),
    },
    {},
  );

const attempt = (over: Partial<PaymentAttemptView> & Pick<PaymentAttemptView, 'id' | 'method' | 'status' | 'amountSatang'>): PaymentAttemptView => ({
  saleId: 'sale', provider: 'manual', tenderedSatang: null, changeSatang: null, terminalRef: null, tid: null,
  approvalCode: null, last4: null, invoiceNo: null, tranRef: null, actionId: null, offline: false,
  paidAt: '2026-11-12T06:01:00.000Z', createdAt: '2026-11-12T06:01:00.000Z',
  ...over,
});

async function open(txn: HistoryTxn, attempts: PaymentAttemptView[]) {
  const detail: ApiSaleDetail = {
    sale: txn.ledger, lines: [], discounts: [], taxBreakdown: null, attempts, refunds: [], printJobs: [],
  };
  const get = vi.spyOn(api, 'get').mockResolvedValue(detail);
  const link = vi.spyOn(stationLinkApi, 'read').mockResolvedValue({ stationId: 'station-1', boxId: null, offline: false });
  const hook = renderHook(() => useSaleDetail({ txn, onBack: vi.fn() }));
  await settle();
  const state = hook.result.current;
  hook.unmount();
  get.mockRestore();
  link.mockRestore();
  return state;
}

describe('History reads a part-paid sale as partly paid, with the balance due', () => {
  it('the proof’s order: ฿175 with ฿50 taken is partly paid, ฿125 still to pay', async () => {
    const state = await open(row('sale-part', 'tendering', 17_500), [
      attempt({ id: 'cash', method: 'cash', status: 'approved', amountSatang: 5_000 }),
    ]);
    expect(state.badge).toBe('part_paid');
    expect(amountLabelOf(state.badge)).toBe('Balance due');
    expect(state.amountShownSatang).toBe(12_500);
    // The refund it offers is unchanged: what was taken, whole only (SCRUM-877).
    expect(state).toMatchObject({ partPaidOpen: true, remainingSatang: 5_000 });
  });

  it('a settlement with only the party’s deposit stays unpaid, its figure as before (SCRUM-876)', async () => {
    const state = await open(row('sale-settlement', 'tendering', 1_690_000), [
      attempt({ id: 'dep', method: 'other', status: 'approved', amountSatang: 100_000, partyDeposit: true }),
    ]);
    expect(state.badge).toBe('unpaid');
    expect(amountLabelOf(state.badge)).toBe('Amount due');
    expect(state.amountShownSatang).toBe(1_690_000);
    expect(state.tookNoMoney).toBe(true);
  });

  it('a settlement part-paid in cash is partly paid, its balance after the deposit and the cash', async () => {
    const state = await open(row('sale-settlement-cash', 'tendering', 1_690_000), [
      attempt({ id: 'dep', method: 'other', status: 'approved', amountSatang: 100_000, partyDeposit: true }),
      attempt({ id: 'cash', method: 'cash', status: 'approved', amountSatang: 500_000 }),
    ]);
    expect(state.badge).toBe('part_paid');
    expect(state.amountShownSatang).toBe(1_090_000);
    expect(state.remainingSatang).toBe(500_000);
  });

  it('an unpaid sale that took nothing, and a closed one, read as before', async () => {
    const unpaid = await open(row('sale-unpaid', 'tendering', 9_000), [
      attempt({ id: 'c', method: 'card', status: 'declined', amountSatang: 9_000 }),
    ]);
    expect([unpaid.badge, unpaid.amountShownSatang, amountLabelOf(unpaid.badge)]).toEqual(['unpaid', 9_000, 'Amount due']);
    const paid = await open(row('sale-paid', 'finalised', 9_000), [
      attempt({ id: 'c', method: 'cash', status: 'approved', amountSatang: 9_000 }),
    ]);
    expect([paid.badge, paid.amountShownSatang, amountLabelOf(paid.badge)]).toEqual(['paid', 9_000, 'Total paid']);
    expect(amountLabelOf('voided')).toBe('Total (voided)');
  });
});

describe('the History list reads the platform’s part-paid row', () => {
  it('the card says Partly paid where the row names money taken, Unpaid where it does not', () => {
    const part = row('sale-part', 'tendering', 17_500, { paidSatang: 5_000, balanceSatang: 12_500 });
    expect(part.badge).toBe('part_paid');
    expect(badgeOf(part.ledger)).toBe('part_paid');
    expect(row('sale-unpaid', 'tendering', 17_500).badge).toBe('unpaid');
    expect(row('sale-null', 'tendering', 17_500, null).badge).toBe('unpaid');
    // A closed or voided sale reads by its own status, whatever else the row carries.
    expect(row('sale-closed', 'finalised', 17_500).badge).toBe('paid');
    expect(row('sale-void', 'voided', 17_500).badge).toBe('voided');
    // Nothing is counted as spend while the sale is open, as before.
    expect(spentOf([part])).toBe(0);
  });

  it('the detail opens on the row’s word and balance, then reads its own tenders', async () => {
    const txn = row('sale-part', 'tendering', 17_500, { paidSatang: 5_000, balanceSatang: 12_500 });
    const state = await open(txn, [attempt({ id: 'cash', method: 'cash', status: 'approved', amountSatang: 5_000 })]);
    expect([state.badge, state.amountShownSatang]).toEqual(['part_paid', 12_500]);
    const desktop = src('components/history/SaleDetail.tsx');
    expect(desktop).toContain("? detail ? openSaleBadgeOf(attempts) : sale.partPaid ? 'part_paid' : 'unpaid'");
    expect(desktop).toContain(': (sale.partPaid?.balanceSatang ?? totals.grossSatang);');
  });
});

describe('the rules, and the badge', () => {
  it('money is the sale’s own when a tender took it; the deposit is the party’s', () => {
    const cash = attempt({ id: 'c', method: 'cash', status: 'approved', amountSatang: 5_000 });
    const declined = attempt({ id: 'd', method: 'card', status: 'declined', amountSatang: 5_000 });
    const deposit = attempt({ id: 'p', method: 'other', status: 'approved', amountSatang: 100_000, partyDeposit: true });
    expect(openSaleBadgeOf([])).toBe('unpaid');
    expect(openSaleBadgeOf([declined])).toBe('unpaid');
    expect(openSaleBadgeOf([deposit])).toBe('unpaid');
    expect(openSaleBadgeOf([deposit, cash])).toBe('part_paid');
    expect(balanceDueSatang(17_500, [cash, declined])).toBe(12_500);
    expect(balanceDueSatang(1_690_000, [deposit, cash])).toBe(1_585_000);
    expect(balanceDueSatang(4_000, [cash])).toBe(0);
  });

  it('the badge reads "Partly paid", in the open sale’s amber', () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status: 'part_paid' }));
    expect(html).toContain('Partly paid');
    expect(html).toContain('text-amber-400');
  });

  it('both detail layouts show the figure and the words the controller chose', () => {
    const desktop = src('components/history/SaleDetail.tsx');
    expect(desktop).toContain('{amountLabelOf(badge)}');
    expect(desktop).toContain('฿{satangText(amountShownSatang)}');
    const phone = src('components/mobile/history/MobileTransactionDetail.tsx');
    expect(phone).toContain('{amountLabelOf(badge)}');
    expect(phone).toContain('฿{satangText(state.amountShownSatang)}');
  });
});
