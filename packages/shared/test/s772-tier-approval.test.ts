import { describe, expect, it } from 'vitest';
import {
  TIER_APPROVAL_EVIDENCE,
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_REASONS,
  TIER_APPROVAL_REASON_LABELS,
  TIER_APPROVAL_TEXT_MAX,
  TIER_APPROVAL_TIERS,
  TIER_PROOF_CHOICES,
  isTierApprovalReason,
  tierApprovalProblem,
  tierApprovalReasonLabel,
  tierApprovedByHandLine,
} from '../src/index';

/**
 * SCRUM-772 — the Thai rate approved by hand: a reason from a short list, an
 * optional note, never a document number.
 */
describe('SCRUM-772 hand approval reasons', () => {
  it('offers the two named reasons, then Other, for the Thai rate only', () => {
    expect(TIER_APPROVAL_REASONS).toEqual([
      'thai_child_foreign_parent',
      'thai_id_seen_not_to_hand',
      'other',
    ]);
    expect(TIER_APPROVAL_REASON_LABELS).toEqual({
      thai_child_foreign_parent: 'Thai child with a foreign parent',
      thai_id_seen_not_to_hand: 'Thai ID seen earlier, not to hand',
      other: 'Other',
    });
    expect(TIER_APPROVAL_TIERS).toEqual(['thai']);
    expect(isTierApprovalReason('other')).toBe(true);
    expect(isTierApprovalReason('Passport')).toBe(false);
  });

  it('is not one of the document choices, so the document list stays as it is', () => {
    expect(TIER_PROOF_CHOICES as readonly string[]).not.toContain(TIER_APPROVAL_EVIDENCE);
  });
});

describe('SCRUM-772 tierApprovalProblem', () => {
  it('accepts each named reason with no typed text and no note', () => {
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'thai_child_foreign_parent' })).toBeNull();
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'thai_id_seen_not_to_hand', note: '  ' })).toBeNull();
    expect(
      tierApprovalProblem({ toTier: 'thai', reason: 'thai_id_seen_not_to_hand', note: 'Mother showed it last month' }),
    ).toBeNull();
  });

  it('refuses a tier other than Thai, and a reason not on the list', () => {
    expect(tierApprovalProblem({ toTier: 'expat', reason: 'other', reasonText: 'Lives here now' })).toBe(
      TIER_APPROVAL_PROBLEMS.tier,
    );
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'looks_thai' })).toBe(TIER_APPROVAL_PROBLEMS.reason);
  });

  it('asks Other for at least two words, as SCRUM-697 asks an Other document', () => {
    for (const reasonText of [undefined, '', 'Grandma', '  ', '12 34']) {
      expect(tierApprovalProblem({ toTier: 'thai', reason: 'other', reasonText })).toBe(
        TIER_APPROVAL_PROBLEMS.reasonMissing,
      );
    }
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'other', reasonText: 'Thai grandparent present' })).toBeNull();
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'other', reasonText: 'ยาย คนไทย' })).toBeNull();
  });

  it('refuses a typed reason on a named reason', () => {
    expect(
      tierApprovalProblem({ toTier: 'thai', reason: 'thai_child_foreign_parent', reasonText: 'Father is Thai' }),
    ).toBe(TIER_APPROVAL_PROBLEMS.reasonNotOther);
  });

  it('never takes a document number, in the reason or in the note', () => {
    expect(
      tierApprovalProblem({ toTier: 'thai', reason: 'other', reasonText: 'Thai ID 1101700203451' }),
    ).toBe(TIER_APPROVAL_PROBLEMS.number);
    expect(
      tierApprovalProblem({ toTier: 'thai', reason: 'thai_id_seen_not_to_hand', note: 'card ๑๒๓๔๕๖' }),
    ).toBe(TIER_APPROVAL_PROBLEMS.number);
  });

  it('keeps the reason and the note to the length a check description has', () => {
    const long = `${'word '.repeat(50)}x`;
    expect(long.trim().length).toBeGreaterThan(TIER_APPROVAL_TEXT_MAX);
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'other', reasonText: long })).toBe(
      TIER_APPROVAL_PROBLEMS.reasonTooLong,
    );
    expect(tierApprovalProblem({ toTier: 'thai', reason: 'thai_child_foreign_parent', note: long })).toBe(
      TIER_APPROVAL_PROBLEMS.noteTooLong,
    );
  });
});

describe('SCRUM-772 how an approval reads', () => {
  it('names the reason, or what staff typed for Other', () => {
    expect(tierApprovalReasonLabel('thai_child_foreign_parent')).toBe('Thai child with a foreign parent');
    expect(tierApprovalReasonLabel('other', '  Thai grandparent present ')).toBe('Thai grandparent present');
    expect(tierApprovalReasonLabel('other', null)).toBe('Other');
  });

  it('reads on the sale as the owner wrote it', () => {
    expect(tierApprovedByHandLine('Thai', 'Som', 'Thai child with a foreign parent')).toBe(
      'Thai rate approved by hand by Som: Thai child with a foreign parent',
    );
  });
});
