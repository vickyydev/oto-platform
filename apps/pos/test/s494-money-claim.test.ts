import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimVerifiedTier, salesApi } from '@/api/sales';

/**
 * SCRUM-494 unit "money", register entry 1 — a walk-in's document check.
 *
 * The approved design's verification step asks for the proof type only
 * (VerifyTierModal.tsx:43), for a visitor with no member yet as for a member.
 * The till records the claim with the expiry when one was entered and without
 * one otherwise; it never invents a date.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('s494 money — a walk-in tier claim needs no expiry', () => {
  it('records the claim with the proof type alone', async () => {
    const tierClaim = vi
      .spyOn(salesApi, 'tierClaim')
      .mockResolvedValue({ claim: { id: 'c', actionId: 'a', branchId: 'b', toTier: 'thai', expiresAt: 'x' } });
    const actionId = await claimVerifiedTier({ branchId: 'b', tier: 'thai', proofType: 'Residence certificate' });
    expect(tierClaim).toHaveBeenCalledTimes(1);
    const body = tierClaim.mock.calls[0]![0];
    expect(body).toEqual({ actionId, branchId: 'b', toTier: 'thai', evidenceType: 'Residence certificate' });
    expect('evidenceExpiresAt' in body).toBe(false);
  });

  it('passes a recorded expiry through', async () => {
    const tierClaim = vi
      .spyOn(salesApi, 'tierClaim')
      .mockResolvedValue({ claim: { id: 'c', actionId: 'a', branchId: 'b', toTier: 'expat', expiresAt: 'x' } });
    await claimVerifiedTier({ branchId: 'b', tier: 'expat', proofType: 'Passport', expiresAt: '2030-01-01' });
    expect(tierClaim.mock.calls[0]![0]).toMatchObject({ evidenceExpiresAt: '2030-01-01' });
  });
});
