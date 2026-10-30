import { describe, expect, it } from 'vitest';
import {
  OfflineMemberTierChangedSchema,
  TIER_PROOF_CHOICES,
  TIER_PROOF_NOTE_MAX,
  TIER_PROOF_NOTE_PROBLEMS,
  TIER_PROOF_OTHER,
  TIER_PROOF_TYPES,
  tierProofLabel,
  tierProofNoteProblem,
} from '../src/index';

/**
 * SCRUM-697 — "Other" on the verify-tier step: a description of what was
 * checked, never its number.
 */
describe('SCRUM-697 tier proof choices', () => {
  it('offers the three kinds, then Other, and leaves the three kinds as they were', () => {
    expect(TIER_PROOF_TYPES).toEqual(['Passport', 'Residence certificate', 'School card']);
    expect(TIER_PROOF_CHOICES).toEqual([...TIER_PROOF_TYPES, 'Other']);
    expect(TIER_PROOF_OTHER).toBe('Other');
  });
});

describe('SCRUM-697 tierProofNoteProblem', () => {
  it('accepts a two-word description for Other', () => {
    expect(tierProofNoteProblem('Thai driving licence', 'Other')).toBeNull();
    expect(tierProofNoteProblem('  Work permit  ', 'Other')).toBeNull();
    expect(tierProofNoteProblem('ใบขับขี่ ไทย', 'Other')).toBeNull();
  });

  it('requires at least two words, each holding a letter, for Other', () => {
    for (const note of [undefined, null, '', '   ', 'Licence', 'Licence -', 'ID 1234']) {
      expect(tierProofNoteProblem(note, 'Other'), String(note)).toBe(TIER_PROOF_NOTE_PROBLEMS.missing);
    }
  });

  it('refuses a run of five or more digits, Arabic or Thai, for every kind', () => {
    expect(tierProofNoteProblem('licence 1234567890123', 'Other')).toBe(TIER_PROOF_NOTE_PROBLEMS.number);
    expect(tierProofNoteProblem('Thai licence ๑๒๓๔๕', 'Other')).toBe(TIER_PROOF_NOTE_PROBLEMS.number);
    expect(tierProofNoteProblem('Passport AA1234567', 'Passport')).toBe(TIER_PROOF_NOTE_PROBLEMS.number);
    expect(TIER_PROOF_NOTE_PROBLEMS.number).toBe('Describe the document, never its number.');
    // Four digits are a year or a class, not a document number.
    expect(tierProofNoteProblem('School card 2026 intake', 'Other')).toBeNull();
  });

  it(`caps the description at ${TIER_PROOF_NOTE_MAX} characters`, () => {
    const atMax = `Thai ${'a'.repeat(TIER_PROOF_NOTE_MAX - 5)}`;
    expect(atMax).toHaveLength(TIER_PROOF_NOTE_MAX);
    expect(tierProofNoteProblem(atMax, 'Other')).toBeNull();
    expect(tierProofNoteProblem(`${atMax}b`, 'Other')).toBe(TIER_PROOF_NOTE_PROBLEMS.tooLong);
  });

  it('leaves the note optional for the three kinds', () => {
    for (const kind of TIER_PROOF_TYPES) {
      expect(tierProofNoteProblem(undefined, kind)).toBeNull();
      expect(tierProofNoteProblem('', kind)).toBeNull();
      expect(tierProofNoteProblem('Renewed', kind)).toBeNull();
    }
  });
});

describe('SCRUM-697 tierProofLabel', () => {
  it('reads an Other check by its description and every other kind by its name', () => {
    expect(tierProofLabel('Other', 'Thai driving licence')).toBe('Other (Thai driving licence)');
    expect(tierProofLabel('Other', null)).toBe('Other');
    expect(tierProofLabel('Passport', 'Renewed')).toBe('Passport');
  });
});

describe('SCRUM-697 offline tier change contract', () => {
  it('carries Other and its note, as it did before', () => {
    const parsed = OfflineMemberTierChangedSchema.safeParse({
      direction: 'upgrade',
      memberId: '018f0000-0000-7000-8000-000000000697',
      verificationId: '018f0000-0000-7000-8000-000000000698',
      toTier: 'thai',
      evidenceType: 'Other',
      note: 'Thai driving licence',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});
