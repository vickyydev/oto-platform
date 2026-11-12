import * as React from 'react';
import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { toTxn, type ApiSaleDetail, type ApiSaleTotals, type HistoryTxn } from '@/api/history';
import { api } from '@/api/client';
import { toast } from '@/hooks/use-toast';
import { stationLinkApi } from '@/station/link';
import { useSaleDetail } from '@/components/history/SaleDetail';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-900 — THE TILL'S HISTORY REFUND SCREEN SAYS WHEN A VOID SLIP COULD NOT
 * GO TO THE KITCHEN OR THE BAR.
 *
 * The refund's answer now carries `printing.notes` as a sale's does, and the
 * screen shows them the way a sale's printing notes are shown: the "Some items
 * not printed" toast (`dispatchPlatformPrinting`). Driven through the
 * controller both History layouts read (`useSaleDetail`), as the press of
 * Refund in the dialog (`RefundModal.tsx`) calls it.
 */

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', vi.fn()] }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som' }, can: () => true, offlineUnlock: null }),
}));

const BAR_NOTE = 'Void slip for the bar not printed — no bar printer at Reception Till 1';

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.mocked(toast).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const totals = (grossSatang: number): ApiSaleTotals => ({
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
  refundedSatang: 0,
});

const txn: HistoryTxn = toTxn(
  {
    id: 'sale-fnb',
    branchId: 'branch-1',
    stationId: 'station-1',
    memberId: null,
    visitId: null,
    businessDate: '2026-11-12',
    occurredAt: '2026-11-12T06:00:00.000Z',
    status: 'finalised',
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday',
    customerTier: 'tourist',
    receiptNumber: 'T1-000042',
    receiptSeries: 'T1',
    receiptSeq: 42,
    finalisedAt: '2026-11-12T06:00:00.000Z',
    note: null,
    totals: totals(9_000),
    soldBy: { accountId: 'account-1', name: 'Som' },
    stationName: 'Reception Till 1',
    member: null,
    lineKinds: ['fnb_item'],
    revenueCategories: ['fnb'],
  },
  {},
);

const cash: PaymentAttemptView = {
  id: 'a1',
  saleId: 'sale-fnb',
  method: 'cash',
  status: 'approved',
  amountSatang: 9_000,
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
} as PaymentAttemptView;

const textOf = (node: unknown): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join(' ')
      : isValidElement(node)
        ? textOf((node.props as { children?: ReactNode }).children)
        : '';

/** Refund the whole sale from History, the platform answering with `printing`. */
async function refundWith(printing: { notes: string[] } | undefined) {
  const detail: ApiSaleDetail = {
    sale: txn.ledger,
    lines: [],
    discounts: [],
    taxBreakdown: null,
    attempts: [cash],
    refunds: [],
    printJobs: [],
    refundableSatang: 9_000,
  };
  vi.spyOn(api, 'get').mockResolvedValue(detail);
  vi.spyOn(stationLinkApi, 'read').mockResolvedValue({ stationId: 'station-1', boxId: null, offline: false });
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    replay: false,
    refund: { id: 'r1', number: 'T1-R-000001', amountSatang: 9_000, tenderAllocation: [] },
    sale: { ...txn.ledger, status: 'refunded' },
    refundStatus: 'refunded',
    refundableSatang: 0,
    requestedSatang: 9_000,
    clamped: false,
    ...(printing ? { printing } : {}),
  });
  const hook = renderHook(() => useSaleDetail({ txn, onBack: vi.fn() }));
  await settle();
  hook.result.current.openRefund();
  await settle();
  await hook.result.current.confirmRefund({
    scope: 'full', amountTHB: 90, creditRestoredTHB: 0, reason: 'Guest left', mode: 'full', amountSatang: 9_000,
  });
  await settle();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[0]).toBe('/sales/sale-fnb/refunds');
  const state = hook.result.current;
  hook.unmount();
  return state;
}

const notPrintedToasts = () =>
  vi.mocked(toast).mock.calls.map(([shown]) => shown).filter((shown) => shown.title === 'Some items not printed');

describe('SCRUM-900 — the refund screen and what the kitchen and the bar were not sent', () => {
  it('shows the void slip the bar was not sent, in the toast a sale’s printing notes use, and records the refund as before', async () => {
    const state = await refundWith({ notes: [BAR_NOTE] });
    expect(state.justRefunded).toMatchObject({ number: 'T1-R-000001' });
    const shown = notPrintedToasts();
    expect(shown).toHaveLength(1);
    expect(textOf(shown[0]?.description)).toContain(BAR_NOTE);
  });

  it('says nothing more when every slip went', async () => {
    await refundWith({ notes: [] });
    expect(notPrintedToasts()).toEqual([]);
  });

  it('says nothing more against an api older than the notes', async () => {
    const state = await refundWith(undefined);
    expect(state.justRefunded).toMatchObject({ number: 'T1-R-000001' });
    expect(notPrintedToasts()).toEqual([]);
  });
});
