import { describe, expect, it } from 'vitest';
import {
  OfflineMemberTierChangedSchema,
  TIER_PROOF_CHOICES,
  TIER_PROOF_NOTE_PROBLEMS,
  TIER_PROOF_OTHER,
  TIER_PROOF_RECORDED,
  TIER_PROOF_RETIRED,
  TIER_PROOF_TYPES,
  tierProofLabel,
  tierProofNoteProblem,
} from '../src/index';

/**
 * SCRUM-773 — the tier proof documents, decided on 4 November 2026: Driving
 * licence replaces Residence certificate in the list, and Other takes an
 * expiry date again, optional as on every kind.
 */

describe('SCRUM-773 the document list', () => {
  it('offers Passport, Driving licence and School card, then Other', () => {
    expect(TIER_PROOF_TYPES).toEqual(['Passport', 'Driving licence', 'School card']);
    expect(TIER_PROOF_CHOICES).toEqual(['Passport', 'Driving licence', 'School card', 'Other']);
  });

  it('retires Residence certificate: never offered, still a kind a recorded check may carry', () => {
    expect(TIER_PROOF_RETIRED).toEqual(['Residence certificate']);
    expect(TIER_PROOF_CHOICES as readonly string[]).not.toContain('Residence certificate');
    expect(TIER_PROOF_RECORDED).toEqual([...TIER_PROOF_CHOICES, 'Residence certificate']);
  });

  it('reads a retired kind on a profile as it was filed', () => {
    expect(tierProofLabel('Residence certificate', null)).toBe('Residence certificate');
    expect(tierProofLabel('Driving licence', null)).toBe('Driving licence');
  });

  it('asks a Driving licence for no description, as the other named kinds', () => {
    expect(tierProofNoteProblem(undefined, 'Driving licence')).toBeNull();
    expect(tierProofNoteProblem('Licence AB12345678', 'Driving licence')).toBe(TIER_PROOF_NOTE_PROBLEMS.number);
  });

  it('points Other at a document that has no button of its own', () => {
    expect(TIER_PROOF_NOTE_PROBLEMS.missing).toBe('Say what you checked in at least two words, e.g. Work permit.');
    expect(tierProofNoteProblem('Work permit', TIER_PROOF_OTHER)).toBeNull();
  });
});

describe('SCRUM-773 the offline tier change a box replays', () => {
  const upgrade = (over: Record<string, unknown>) =>
    OfflineMemberTierChangedSchema.safeParse({
      direction: 'upgrade',
      memberId: '018f0000-0000-7000-8000-000000000773',
      verificationId: '018f0000-0000-7000-8000-000000000774',
      toTier: 'thai',
      ...over,
    });

  it('carries a Driving licence with its expiry', () => {
    const parsed = upgrade({ evidenceType: 'Driving licence', evidenceExpiresAt: '2030-01-31' });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('carries an Other check with its description and its expiry', () => {
    const parsed = upgrade({ evidenceType: 'Other', note: 'Work permit', evidenceExpiresAt: '2030-01-31' });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect(parsed.data).toMatchObject({ evidenceType: 'Other', evidenceExpiresAt: '2030-01-31' });
  });

  it('still parses a Residence certificate check a box recorded before the list changed', () => {
    const parsed = upgrade({ evidenceType: 'Residence certificate' });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('refuses a kind that was never on the list', () => {
    expect(upgrade({ evidenceType: 'Passport AA1234567' }).success).toBe(false);
  });
});
