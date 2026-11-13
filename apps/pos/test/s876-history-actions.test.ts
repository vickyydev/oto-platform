import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { toTxn, type ApiSaleDetail, type ApiSaleListItem, type ApiSaleTotals, type HistoryTxn } from '@/api/history';
import { api } from '@/api/client';
import { stationLinkApi } from '@/station/link';
import { useSaleDetail } from '@/components/history/SaleDetail';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-876 / SCRUM-877 — WHAT HISTORY OFFERS ON A SALE, in each state, from
 * the controller both the desktop page and the phone's detail read
 * (`useSaleDetail`): `tookNoMoney` is the Void button, `refundable` the
 * Refund button, `partPaidOpen` the whole-only refund of a part-paid sale.
 *
 *   closed                 → Refund (what is left), never Void
 *   unpaid, nothing taken  → Void unpaid sale, never Refund
 *   a settlement with only the party's deposit on it → Void: the deposit is
 *                            not the till's money (SCRUM-876)
 *   part-paid, open        → Refund, whole only, for what was taken (SCRUM-877)
 *   a tender in flight     → neither
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

const totals = (grossSatang: number, refundedSatang = 0): ApiSaleTotals => ({
  subtotalSatang: grossSatang,
  manualDiscountSatang: 0,
  promoDiscountSatang: 0,
  discountSatang: 0,
  netSatang: grossSatang,
  serviceChargeSatang: 0,
  taxInclusiveSatang: 0,
  taxExclusiveSatang: 0,
  grossSatang,
  unappliedDiscountSatang: 0,
  refundedSatang,
});

const row = (id: string, status: ApiSaleListItem['status'], gross: number): HistoryTxn =>
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
      receiptNumber: status === 'finalised' ? 'T1-000001' : null,
      receiptSeries: 'T1',
      receiptSeq: 1,
      finalisedAt: status === 'finalised' ? '2026-11-12T06:00:00.000Z' : null,
      note: null,
      totals: totals(gross),
      soldBy: { accountId: 'account-1', name: 'Som' },
      stationName: 'Reception Till 1',
      member: null,
      lineKinds: ['fnb_item'],
      revenueCategories: ['fnb'],
    },
    {},
  );

const attempt = (over: Partial<PaymentAttemptView> & Pick<PaymentAttemptView, 'id' | 'method' | 'status' | 'amountSatang'>): PaymentAttemptView => ({
  saleId: 'sale',
  provider: 'manual',
  tenderedSatang: null,
  changeSatang: null,
  terminalRef: null,
  tid: null,
  approvalCode: null,
  last4: null,
  invoiceNo: null,
  tranRef: null,
  actionId: null,
  offline: false,
  paidAt: '2026-11-12T06:01:00.000Z',
  createdAt: '2026-11-12T06:01:00.000Z',
  ...over,
});

async function open(txn: HistoryTxn, attempts: PaymentAttemptView[], refundableSatang?: number, extra: Partial<ApiSaleDetail> = {}) {
  const detail: ApiSaleDetail = {
    sale: txn.ledger,
    lines: [],
    discounts: [],
    taxBreakdown: null,
    attempts,
    refunds: [],
    printJobs: [],
    ...extra,
    ...(refundableSatang !== undefined ? { refundableSatang } : {}),
  };
  const get = vi.spyOn(api, 'get').mockResolvedValue(detail);
  const link = vi.spyOn(stationLinkApi, 'read').mockResolvedValue({ stationId: 'station-1', boxId: null, offline: false });
  const hook = renderHook(() => useSaleDetail({ txn, onBack: vi.fn() }));
  await settle();
  const state = hook.result.current;
  return {
    state,
    hook,
    done: () => {
      hook.unmount();
      get.mockRestore();
      link.mockRestore();
    },
  };
}

describe('History offers Void or Refund by what the sale took', () => {
  it('a closed sale: Refund for what is left, never Void', async () => {
    const txn = row('sale-closed', 'finalised', 9_000);
    const { state, done } = await open(txn, [attempt({ id: 'a1', method: 'cash', status: 'approved', amountSatang: 9_000 })], 9_000);
    expect(state.badge).toBe('paid');
    expect(state).toMatchObject({ closed: true, refundable: true, partPaidOpen: false, tookNoMoney: false, remainingSatang: 9_000 });
    done();
  });

  it('an unpaid sale that took nothing: Void unpaid sale, never Refund', async () => {
    const txn = row('sale-unpaid', 'tendering', 9_000);
    const { state, done } = await open(txn, [attempt({ id: 'a1', method: 'card', status: 'declined', amountSatang: 9_000 })]);
    expect(state.badge).toBe('unpaid');
    expect(state).toMatchObject({ closed: false, refundable: false, partPaidOpen: false, tookNoMoney: true });
    done();
  });

  it('a settlement with only the party\'s deposit on it is an unpaid sale: Void, never Refund (SCRUM-876)', async () => {
    const txn = row('sale-settlement', 'tendering', 1_690_000);
    const deposit = attempt({ id: 'dep', method: 'other', status: 'approved', amountSatang: 200_000, partyDeposit: true });
    const { state, done } = await open(txn, [deposit]);
    expect(state).toMatchObject({ closed: false, refundable: false, partPaidOpen: false, tookNoMoney: true });
    done();
  });

  it('a part-paid open sale: Refund, whole only, for exactly what was taken, and the press sends mode "whole" (SCRUM-877)', async () => {
    const txn = row('sale-part', 'tendering', 9_000);
    const { state, hook, done } = await open(txn, [
      attempt({ id: 'w', method: 'wallet', status: 'approved', amountSatang: 5_000 }),
      attempt({ id: 'c', method: 'card', status: 'declined', amountSatang: 4_000 }),
    ]);
    // SCRUM-890 - money taken and still open reads as partly paid, no longer unpaid.
    expect(state.badge).toBe('part_paid');
    expect(state).toMatchObject({ closed: false, refundable: true, partPaidOpen: true, tookNoMoney: false, remainingSatang: 5_000 });
    // Nothing to pick by item: the dialog is locked to the whole sale.
    expect(state.refundOptions).toEqual([]);

    const post = vi.spyOn(api, 'post').mockResolvedValue({
      replay: false,
      refund: { id: 'r1', number: 'T1-R-000001', amountSatang: 5_000, tenderAllocation: [] },
      sale: { ...txn.ledger, status: 'voided' },
    });
    hook.result.current.openRefund();
    await settle();
    await hook.result.current.confirmRefund({ scope: 'full', amountTHB: 50, creditRestoredTHB: 50, reason: 'Guest could not pay', mode: 'full', amountSatang: 5_000 });
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('/sales/sale-part/refunds');
    expect(post.mock.calls[0]?.[1]).toMatchObject({ mode: 'whole', reason: 'Guest could not pay' });
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('amountSatang');
    post.mockRestore();
    done();
  });

  it('a settlement part-paid in cash is refundable for the cash alone; the deposit is never counted', async () => {
    const txn = row('sale-settlement-cash', 'tendering', 1_690_000);
    const { state, done } = await open(txn, [
      attempt({ id: 'dep', method: 'other', status: 'approved', amountSatang: 200_000, partyDeposit: true }),
      attempt({ id: 'cash', method: 'cash', status: 'approved', amountSatang: 100_000 }),
    ]);
    expect(state).toMatchObject({ refundable: true, partPaidOpen: true, tookNoMoney: false, remainingSatang: 100_000 });
    done();
  });

  it('a tender still in flight: neither Void nor Refund until it is finished', async () => {
    const txn = row('sale-flight', 'tendering', 9_000);
    const { state, done } = await open(txn, [
      attempt({ id: 'w', method: 'wallet', status: 'approved', amountSatang: 5_000 }),
      attempt({ id: 'c', method: 'card', status: 'sent_to_terminal', amountSatang: 4_000 }),
    ]);
    expect(state).toMatchObject({ refundable: false, partPaidOpen: false, tookNoMoney: false });
    done();
  });
});

describe('SCRUM-910 retained-deposit History state', () => {
  it.each([0, 1_490_000])('a closed party refunded by %i reads refunded even below original gross', async (refunded) => {
    const txn = row('retained-closed', 'refunded', 1_690_000);
    txn.ledger.totals.refundedSatang = refunded;
    const { state, done } = await open(txn, [], 0);
    expect(state).toMatchObject({ badge: 'refunded', refundable: false, remainingSatang: 0, tookNoMoney: false });
    done();
  });
  it('a deposit-only finalised party keeps the whole closure action with zero cash', async () => {
    const txn = row('retained-zero', 'finalised', 1_690_000);
    const { state, done } = await open(txn, [attempt({ id: 'dep', method: 'other', status: 'approved', amountSatang: 1_690_000, partyDeposit: true })], 0, { canCloseWithRetainedDeposit: true, partyDepositRetainableSatang: 1_690_000 });
    expect(state).toMatchObject({ badge: 'paid', refundable: true, remainingSatang: 0 });
    done();
  });
  it('an unresolved historical return cannot offer another refund', async () => {
    const txn = row('retained-review', 'finalised', 1_690_000);
    const { state, done } = await open(txn, [], 0, { partyDepositReviewRequired: true });
    expect(state.refundable).toBe(false);
    done();
  });
});
