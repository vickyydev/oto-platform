import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';
import { cancelSettlementOnPlatform, cancelSettlementTakenRefusal } from '@/api/parties';

/**
 * SCRUM-913 — "CANCEL SETTLEMENT" ON A SETTLEMENT PART-PAID IN CASH.
 *
 * The party page offers Cancel settlement on any open settlement. One that
 * took part of its balance at the till cannot be voided: the platform refuses
 * (`SALE_HAS_PAYMENT`, "Money has been taken on this sale — it is refunded,
 * not voided") and its words name no way out. The party page now says it: a
 * manager refunds the money taken from History first, and that refund closes
 * the settlement. Any other refusal keeps the platform's own words.
 */

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = { id: '0190a0a0-0000-7000-8000-0000000e0913', branchId: 'hkt-central' };

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn() } };
});
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', viaLane: (onPlatform: () => unknown) => onPlatform() }));

const postMock = vi.mocked(api.post);

beforeEach(() => {
  postMock.mockReset();
  vi.mocked(api.get).mockReset();
});

describe('SCRUM-913 — the party page names the way out of a settlement that took money', () => {
  it('says how much was taken, and that a manager refunds it from History first', () => {
    expect(cancelSettlementTakenRefusal(100_000)).toBe(
      "฿1,000 was already taken on this settlement, so it can't be cancelled here. Have a manager refund it from History first: the refund closes the settlement. Nothing was changed.",
    );
    expect(cancelSettlementTakenRefusal(12_550)).toMatch(/^฿125\.50 was already taken/);
    expect(cancelSettlementTakenRefusal(null)).toMatch(/^Money was already taken on this settlement/);
  });

  it('the void refused with SALE_HAS_PAYMENT answers those words, with the amount the platform named', async () => {
    postMock.mockRejectedValueOnce(
      new ApiError(409, 'SALE_HAS_PAYMENT', 'Money has been taken on this sale — it is refunded, not voided', {
        attemptIds: ['attempt-cash'],
        takenSatang: 100_000,
      }),
    );
    const outcome = await cancelSettlementOnPlatform({ party: PARTY, saleId: 'sale-1', reason: 'ZZ TEST wrong counts' });
    expect(postMock.mock.calls[0]![0]).toBe('/sales/sale-1/void');
    expect(outcome).toEqual({ ok: false, message: cancelSettlementTakenRefusal(100_000) });
  });

  it('any other refusal keeps the platform\'s own words', async () => {
    postMock.mockRejectedValueOnce(
      new ApiError(409, 'PAYMENT_IN_FLIGHT', 'A payment on this sale is still in progress — finish or cancel it before voiding the sale'),
    );
    const outcome = await cancelSettlementOnPlatform({ party: PARTY, saleId: 'sale-1', reason: 'ZZ TEST wrong counts' });
    expect(outcome).toEqual({ ok: false, message: 'A payment on this sale is still in progress — finish or cancel it before voiding the sale' });
  });
});
