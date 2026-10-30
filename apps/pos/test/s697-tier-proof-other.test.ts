import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { membersApi, type ApiMember } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { claimVerifiedTier, salesApi } from '@/api/sales';
import { saveDeferredVerification } from '@/lib/deferredTierVerification';
import {
  TIER_PROOF_CHOICES,
  TIER_PROOF_OTHER,
  pricedOnDocument,
  tierProofLabel,
  tierProofNoteProblem,
} from '@/lib/tierProof';
import type { TierVerification } from '@/types';

/**
 * SCRUM-697 — Other on the till's verify-tier step.
 *
 * The step offers the three document kinds and then Other; Other asks what
 * was checked instead of an expiry, with the platform's own rule, and the
 * description travels with the verification to every place it is saved.
 */

vi.mock('@/api/platform', () => ({
  membersApi: {
    lookup: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    verifyTier: vi.fn(),
  },
}));

const MEMBER = '018f0000-0000-7000-8000-000000000697';
const DESCRIPTION = 'Thai driving licence';

function apiMember(over: Partial<ApiMember> = {}): ApiMember {
  return {
    id: MEMBER,
    phone: '+66636970697',
    nickname: 'Other Proof',
    name: null,
    email: null,
    tierCode: 'thai',
    preferredChannel: null,
    notes: null,
    tierVerification: {
      tier: 'thai',
      proofType: 'Other',
      note: DESCRIPTION,
      verifiedAt: '2026-10-30T00:00:00.000Z',
      verifiedBy: 'Reception',
      expiresAt: null,
    },
    children: [],
    ...over,
  } as ApiMember;
}

const otherCheck: TierVerification = {
  tier: 'thai',
  proofType: 'Other',
  note: DESCRIPTION,
  verifiedBy: 'Reception',
  verifiedById: 'r',
  verifiedAt: '2026-10-30T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(membersApi.lookup).mockReset();
  vi.mocked(membersApi.verifyTier).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SCRUM-697 — what the verify step offers and accepts', () => {
  it('offers the three kinds, then Other', () => {
    expect(TIER_PROOF_CHOICES).toEqual(['Passport', 'Residence certificate', 'School card', 'Other']);
  });

  it('confirms Other only with a two-word description that is not a number', () => {
    expect(tierProofNoteProblem('', TIER_PROOF_OTHER)).not.toBeNull();
    expect(tierProofNoteProblem('Licence', TIER_PROOF_OTHER)).not.toBeNull();
    expect(tierProofNoteProblem('licence 1234567890123', TIER_PROOF_OTHER)).toBe(
      'Describe the document, never its number.',
    );
    expect(tierProofNoteProblem(DESCRIPTION, TIER_PROOF_OTHER)).toBeNull();
    expect(tierProofNoteProblem('', 'Passport')).toBeNull();
  });
});

describe('SCRUM-697 — the description travels with the verification', () => {
  it('reads it back onto the till member, and the profile line names it', () => {
    const member = apiMemberToMember(apiMember());
    expect(member.tierVerification).toMatchObject({ proofType: 'Other', note: DESCRIPTION });
    expect(member.tierVerification?.expiresAt).toBeUndefined();
    expect(tierProofLabel(member.tierVerification!.proofType, member.tierVerification!.note)).toBe(
      'Other (Thai driving licence)',
    );
  });

  it('carries no note for a named kind', () => {
    const member = apiMemberToMember(
      apiMember({
        tierVerification: {
          tier: 'thai',
          proofType: 'Passport',
          note: null,
          verifiedAt: '2026-10-30T00:00:00.000Z',
          verifiedBy: 'Reception',
          expiresAt: null,
        },
      }),
    );
    expect(member.tierVerification && 'note' in member.tierVerification).toBe(false);
  });

  it('sends it when a new visitor’s verification is saved after their details', async () => {
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: apiMember({ tierVerification: null }) });
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember() });
    await saveDeferredVerification({ phone: '0636970697', nickname: 'Other Proof', verification: otherCheck });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER, {
      toTier: 'thai',
      evidenceType: 'Other',
      note: DESCRIPTION,
    });
  });

  it('sends it on a walk-in’s claim, with no expiry', async () => {
    const tierClaim = vi
      .spyOn(salesApi, 'tierClaim')
      .mockResolvedValue({ claim: { id: 'c', actionId: 'a', branchId: 'b', toTier: 'thai', expiresAt: 'x' } });
    const actionId = await claimVerifiedTier({
      branchId: 'b',
      tier: 'thai',
      proofType: 'Other',
      note: DESCRIPTION,
    });
    expect(tierClaim.mock.calls[0]![0]).toEqual({
      actionId,
      branchId: 'b',
      toTier: 'thai',
      evidenceType: 'Other',
      note: DESCRIPTION,
    });
  });

  it('names it in History’s sentence', () => {
    expect(pricedOnDocument('Other', DESCRIPTION)).toBe('other (Thai driving licence)');
    expect(pricedOnDocument('Passport', null)).toBe('passport');
    expect(pricedOnDocument('Other')).toBe('other');
  });
});
