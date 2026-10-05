import { beforeEach, describe, expect, it, vi } from 'vitest';
import { membersApi, type ApiMember } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { saveDeferredVerification } from '@/lib/deferredTierVerification';
import { resolveAutoTier } from '@/lib/membership';
import { TIER_PROOF_TYPES } from '@oto/shared';

/**
 * SCRUM-494 unit "money", register entry 1 — at the till.
 *
 * The approved design's verification step asks for the proof type only
 * (VerifyTierModal.tsx:43) and a verified rate is held (lib/membership.ts
 * resolveAutoTier). A recorded expiry that has passed reaches the till as
 * `reverifyDue`, and the till still applies the verified tier — the same tier
 * the platform prices the member at.
 */

vi.mock('@/api/platform', () => ({
  membersApi: {
    lookup: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    verifyTier: vi.fn(),
  },
}));

const MEMBER = '018f0000-0000-7000-8000-000000000494';

function apiMember(over: Partial<ApiMember> = {}): ApiMember {
  return {
    id: MEMBER,
    phone: '+66634940494',
    nickname: 'Tier Money',
    name: null,
    email: null,
    tierCode: 'expat',
    preferredChannel: null,
    notes: null,
    tierVerification: {
      tier: 'expat',
      proofType: 'Passport',
      verifiedAt: '2025-01-01T00:00:00.000Z',
      verifiedBy: 'Reception',
      expiresAt: '2024-01-01',
      reverifyDue: true,
    },
    children: [],
    ...over,
  } as ApiMember;
}

describe('s494 money — an expired document keeps the rate and flags re-verify', () => {
  it('offers three document kinds for new checks and still reads historical Other verifications', () => {
    expect(TIER_PROOF_TYPES).toEqual(['Passport', 'Residence certificate', 'School card']);
    const existing = apiMember();
    existing.tierVerification!.proofType = 'Other';
    const mapped = apiMemberToMember(existing);
    expect(mapped.tierVerification?.proofType).toBe('Other');
    expect(resolveAutoTier(mapped)).toBe('expat');
  });

  it('carries the flag onto the till member and still auto-applies the verified tier', () => {
    const member = apiMemberToMember(apiMember());
    expect(member.tierVerification).toMatchObject({ tier: 'expat', reverifyDue: true, expiresAt: '2024-01-01' });
    expect(resolveAutoTier(member)).toBe('expat');
  });

  it('a verification with no expiry carries no flag', () => {
    const member = apiMemberToMember(
      apiMember({
        tierVerification: {
          tier: 'expat',
          proofType: 'Passport',
          verifiedAt: '2025-01-01T00:00:00.000Z',
          verifiedBy: 'Reception',
          expiresAt: null,
        },
      }),
    );
    expect(member.tierVerification?.reverifyDue).toBeUndefined();
    expect(member.tierVerification?.expiresAt).toBeUndefined();
    expect(resolveAutoTier(member)).toBe('expat');
  });
});

describe('s494 money — saving a deferred verification needs no expiry', () => {
  beforeEach(() => {
    vi.mocked(membersApi.lookup).mockReset();
    vi.mocked(membersApi.verifyTier).mockReset();
  });

  it('saves the proof type alone, without inventing an expiry', async () => {
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: apiMember({ tierVerification: null }) });
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember() });
    await saveDeferredVerification({
      phone: '0634940494',
      nickname: 'Tier Money',
      verification: {
        tier: 'expat',
        proofType: 'Passport',
        verifiedBy: 'Reception',
        verifiedById: 'acct',
        verifiedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER, { toTier: 'expat', evidenceType: 'Passport' });
  });

  it('passes a recorded expiry through', async () => {
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: apiMember({ tierVerification: null }) });
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember() });
    await saveDeferredVerification({
      phone: '0634940494',
      nickname: 'Tier Money',
      verification: {
        tier: 'expat',
        proofType: 'Passport',
        verifiedBy: 'Reception',
        verifiedById: 'acct',
        verifiedAt: '2026-10-02T00:00:00.000Z',
        expiresAt: '2030-01-01',
      },
    });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER, {
      toTier: 'expat',
      evidenceType: 'Passport',
      evidenceExpiresAt: '2030-01-01',
    });
  });
});
