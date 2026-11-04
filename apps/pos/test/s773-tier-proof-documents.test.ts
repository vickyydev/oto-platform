import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIER_PROOF_RETIRED } from '@oto/shared';
import { membersApi, type ApiMember } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { claimVerifiedTier, salesApi } from '@/api/sales';
import { saveDeferredVerification } from '@/lib/deferredTierVerification';
import { TIER_PROOF_CHOICES, pricedOnDocument, tierProofLabel } from '@/lib/tierProof';
import type { TierVerification } from '@/types';

/**
 * SCRUM-773 — the documents the till's verify step offers, decided on
 * 4 November 2026.
 *
 * Driving licence takes the place of Residence certificate, and the expiry
 * date is asked for on Other again — optional, as on every kind. A member
 * verified on a Residence certificate before the change still reads as one on
 * the profile and in History.
 */

vi.mock('@/api/platform', () => ({
  membersApi: {
    lookup: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    verifyTier: vi.fn(),
  },
}));

const MEMBER = '018f0000-0000-7000-8000-000000000773';
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

function apiMember(over: Partial<ApiMember> = {}): ApiMember {
  return {
    id: MEMBER,
    phone: '+66637730773',
    nickname: 'Licence Proof',
    name: null,
    email: null,
    tierCode: 'thai',
    preferredChannel: null,
    notes: null,
    tierVerification: {
      tier: 'thai',
      proofType: 'Residence certificate',
      note: null,
      verifiedAt: '2026-10-20T00:00:00.000Z',
      verifiedBy: 'Reception',
      expiresAt: null,
    },
    children: [],
    ...over,
  } as ApiMember;
}

beforeEach(() => {
  vi.mocked(membersApi.lookup).mockReset();
  vi.mocked(membersApi.verifyTier).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SCRUM-773 — what the verify step offers', () => {
  it('offers Driving licence where Residence certificate was, and no longer offers Residence certificate', () => {
    expect(TIER_PROOF_CHOICES).toEqual(['Passport', 'Driving licence', 'School card', 'Other']);
    for (const retired of TIER_PROOF_RETIRED) {
      expect(TIER_PROOF_CHOICES as readonly string[]).not.toContain(retired);
    }
  });
});

describe('SCRUM-773 — a Residence certificate recorded before the change', () => {
  it('reads as it was filed on the till member and the profile line', () => {
    const member = apiMemberToMember(apiMember());
    expect(member.tierVerification?.proofType).toBe('Residence certificate');
    expect(tierProofLabel(member.tierVerification!.proofType, member.tierVerification!.note)).toBe(
      'Residence certificate',
    );
  });

  it('reads as it was filed in History’s sentence', () => {
    expect(pricedOnDocument('Residence certificate', null)).toBe('residence certificate');
    expect(pricedOnDocument('Driving licence', null)).toBe('driving licence');
  });
});

describe('SCRUM-773 — an Other document carries its expiry date', () => {
  const otherCheck: TierVerification = {
    tier: 'thai',
    proofType: 'Other',
    note: 'Work permit',
    expiresAt: NEXT_YEAR,
    verifiedBy: 'Reception',
    verifiedById: 'r',
    verifiedAt: '2026-11-04T00:00:00.000Z',
  };

  it('sends it when a new visitor’s verification is saved after their details', async () => {
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: apiMember({ tierVerification: null }) });
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember() });
    await saveDeferredVerification({ phone: '0637730773', nickname: 'Licence Proof', verification: otherCheck });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER, {
      toTier: 'thai',
      evidenceType: 'Other',
      evidenceExpiresAt: NEXT_YEAR,
      note: 'Work permit',
    });
  });

  it('sends it on a walk-in’s claim', async () => {
    const tierClaim = vi
      .spyOn(salesApi, 'tierClaim')
      .mockResolvedValue({ claim: { id: 'c', actionId: 'a', branchId: 'b', toTier: 'thai', expiresAt: 'x' } });
    const actionId = await claimVerifiedTier({
      branchId: 'b',
      tier: 'thai',
      proofType: 'Other',
      expiresAt: NEXT_YEAR,
      note: 'Work permit',
    });
    expect(tierClaim.mock.calls[0]![0]).toEqual({
      actionId,
      branchId: 'b',
      toTier: 'thai',
      evidenceType: 'Other',
      evidenceExpiresAt: NEXT_YEAR,
      note: 'Work permit',
    });
  });

  it('a Driving licence check sends its expiry the same way', async () => {
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: apiMember({ tierVerification: null }) });
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember() });
    await saveDeferredVerification({
      phone: '0637730773',
      nickname: 'Licence Proof',
      verification: {
        tier: 'thai',
        proofType: 'Driving licence',
        expiresAt: NEXT_YEAR,
        verifiedBy: 'Reception',
        verifiedById: 'r',
        verifiedAt: '2026-11-04T00:00:00.000Z',
      },
    });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER, {
      toTier: 'thai',
      evidenceType: 'Driving licence',
      evidenceExpiresAt: NEXT_YEAR,
    });
  });
});
