import { describe, expect, it } from 'vitest';
import {
  OfflineMemberTierChangedSchema,
  TIER_PROOF_CHOICES,
  TIER_PROOF_EXPIRY_PROBLEMS,
  tierConfirmationProblem,
  tierProofExpiryProblem,
} from '../src/index';

/**
 * SCRUM-1019 — the expiry date on a rate document (the owner's answer of 19
 * November 2026): required on every kind, Other included. The Thai rate
 * confirmed at the till has no document and no date, as before. One sentence
 * for the till, the platform and the box.
 */

describe('SCRUM-1019 the expiry date on a document check', () => {
  it('is required: the rule takes no kind, so it holds for every one, Other included', () => {
    expect(TIER_PROOF_CHOICES).toContain('Other');
    expect(tierProofExpiryProblem.length).toBe(1);
    expect(tierProofExpiryProblem(undefined)).toBe(TIER_PROOF_EXPIRY_PROBLEMS.missing);
    expect(tierProofExpiryProblem(null)).toBe(TIER_PROOF_EXPIRY_PROBLEMS.missing);
    expect(tierProofExpiryProblem('')).toBe("Enter the document's expiry date.");
    expect(tierProofExpiryProblem('  ')).toBe(TIER_PROOF_EXPIRY_PROBLEMS.missing);
  });

  it('must be a day of the calendar', () => {
    expect(tierProofExpiryProblem('2031-02-29')).toBe(TIER_PROOF_EXPIRY_PROBLEMS.notADate);
    expect(tierProofExpiryProblem('31/12/2031')).toBe(TIER_PROOF_EXPIRY_PROBLEMS.notADate);
    expect(tierProofExpiryProblem('2032-02-29')).toBeNull();
  });

  it('the Thai rate confirmed at the till still takes none', () => {
    expect(tierConfirmationProblem({ toTier: 'thai' })).toBeNull();
    expect(tierConfirmationProblem({ toTier: 'thai', evidenceExpiresAt: '2031-01-01' })).not.toBeNull();
  });

  it('a check an earlier box recorded with no date still parses for replay', () => {
    const parsed = OfflineMemberTierChangedSchema.safeParse({
      direction: 'upgrade',
      memberId: '018f0000-0000-7000-8000-000000001019',
      verificationId: '018f0000-0000-7000-8000-000000001020',
      toTier: 'expat',
      evidenceType: 'Passport',
    });
    expect(parsed.success).toBe(true);
  });
});
