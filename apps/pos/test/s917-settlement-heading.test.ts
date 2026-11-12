import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toTxn, type ApiSaleDetail, type ApiSaleListItem } from '@/api/history';
import { api } from '@/api/client';
import { stationLinkApi } from '@/station/link';
import { useSaleDetail } from '@/components/history/SaleDetail';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-917 — A PARTY'S SETTLEMENT IS HEADED AS ONE IN HISTORY.
 *
 * Its detail read "Ticket sale · Walk-in". The settlement sale carries its
 * party on the list's row (`partySettlement`) and its title on the note the
 * settlement writes ("Party: <title>"): the detail is headed "Party
 * settlement", and the customer line names the party where no member does.
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

const row = (over: Partial<ApiSaleListItem>) =>
  toTxn(
    {
      id: 'sale-settlement', branchId: 'branch-1', stationId: 'station-1', memberId: null, visitId: null,
      businessDate: '2026-11-12', occurredAt: '2026-11-12T06:00:00.000Z', status: 'tendering', pricingMode: 'weekday',
      pricingModeReason: 'Weekday', customerTier: 'tourist', receiptNumber: null, receiptSeries: 'T1', receiptSeq: 1,
      finalisedAt: null, note: null,
      totals: {
        subtotalSatang: 1_690_000, manualDiscountSatang: 0, promoDiscountSatang: 0, discountSatang: 0, netSatang: 1_690_000,
        serviceChargeSatang: 0, taxInclusiveSatang: 0, taxExclusiveSatang: 0, grossSatang: 1_690_000,
        unappliedDiscountSatang: 0, refundedSatang: 0,
      },
      soldBy: { accountId: 'account-1', name: 'Som' }, stationName: 'Reception Till 1', member: null,
      lineKinds: ['kids', 'addon'], revenueCategories: ['tickets'],
      ...over,
    } as ApiSaleListItem,
    {},
  );

async function headingOf(txn: ReturnType<typeof row>) {
  const detail: ApiSaleDetail = { sale: txn.ledger, lines: [], discounts: [], taxBreakdown: null, attempts: [], refunds: [], printJobs: [] };
  const get = vi.spyOn(api, 'get').mockResolvedValue(detail);
  const link = vi.spyOn(stationLinkApi, 'read').mockResolvedValue({ stationId: 'station-1', boxId: null, offline: false });
  const hook = renderHook(() => useSaleDetail({ txn, onBack: vi.fn() }));
  await settle();
  const heading = hook.result.current.heading;
  hook.unmount();
  get.mockRestore();
  link.mockRestore();
  return heading;
}

describe('SCRUM-917 — the settlement detail', () => {
  it('is headed Party settlement and names the party', async () => {
    const txn = row({ note: 'Party: ZZ TEST SCRUM-916 party', partySettlement: { eventId: 'e', settlementId: 's' } });
    expect(await headingOf(txn)).toBe('Party settlement');
    expect(txn.customerLabel).toBe('ZZ TEST SCRUM-916 party');
  });

  it('an ordinary ticket sale is headed as before', async () => {
    expect(await headingOf(row({ id: 'sale-ticket' }))).toBe('Ticket sale');
  });
});
