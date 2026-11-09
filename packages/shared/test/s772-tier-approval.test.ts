import { describe, expect, it } from 'vitest';
import {
  OfflineMemberTierChangedSchema,
  TIER_APPROVAL_EVIDENCE,
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_REASONS,
  TIER_APPROVAL_REASON_LABELS,
  TIER_APPROVAL_TEXT_MAX,
  TIER_APPROVAL_TIERS,
  TIER_APPROVAL_TILL_REASON,
  TIER_PROOF_CHOICES,
  isTierApprovalReason,
  tierApprovalProblem,
  tierApprovalReasonLabel,
  tierApprovedByHandLine,
  tierConfirmationProblem,
  tierConfirmedAtTillLine,
} from '../src/index';

/**
 * SCRUM-772 — the Thai rate confirmed at the till, with no document (the
 * owner's rule of 6 November 2026): one reason the till records, the reasons
 * offered from 5 November still accepted, never a document number.
 */
describe('SCRUM-772 hand approval reasons', () => {
  it('records the till’s one reason first, keeps the 5 November reasons accepted, for the Thai rate only', () => {
    expect(TIER_APPROVAL_TILL_REASON).toBe('confirmed_at_till');
    expect(TIER_APPROVAL_REASONS).toEqual([
      'confirmed_at_till',
      'thai_child_foreign_parent',
      'thai_id_seen_not_to_hand',
      'other',
    ]);
    expect(TIER_APPROVAL_REASON_LABELS).toEqual({
      confirmed_at_till: 'Confirmed at the till',
      thai_child_foreign_parent: 'Thai child with a foreign parent',
      thai_id_seen_not_to_hand: 'Thai ID seen earlier, not to hand',
      other: 'Other',
    });
    expect(TIER_APPROVAL_TIERS).toEqual(['thai']);
    expect(isTierApprovalReason('confirmed_at_till')).toBe(true);
    expect(isTierApprovalReason('other')).toBe(true);
    expect(isTierApprovalReason('Passport')).toBe(false);
  });

  it('accepts the till’s one reason with nothing typed, and only for the Thai rate', () => {
    expect(tierApprovalProblem({ toTier: 'thai', reason: TIER_APPROVAL_TILL_REASON })).toBeNull();
    expect(tierApprovalProblem({ toTier: 'expat', reason: TIER_APPROVAL_TILL_REASON })).toBe(
      TIER_APPROVAL_PROBLEMS.tier,
    );
    expect(
      tierApprovalProblem({ toTier: 'thai', reason: TIER_APPROVAL_TILL_REASON, reasonText: 'Looks Thai' }),
    ).toBe(TIER_APPROVAL_PROBLEMS.reasonNotOther);
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
    expect(
      tierApprovedByHandLine('Thai', 'Som', 'Thai child with a foreign parent', 'thai_child_foreign_parent'),
    ).toBe('Thai rate approved by hand by Som: Thai child with a foreign parent');
  });

  it('reads a till confirmation as "confirmed at the till by <name>"', () => {
    expect(tierApprovalReasonLabel(TIER_APPROVAL_TILL_REASON)).toBe('Confirmed at the till');
    expect(tierApprovedByHandLine('Thai', 'Som', 'Confirmed at the till', TIER_APPROVAL_TILL_REASON)).toBe(
      'Thai rate confirmed at the till by Som',
    );
    expect(tierConfirmedAtTillLine('Som')).toBe('Confirmed at the till by Som');
    expect(tierConfirmedAtTillLine(null)).toBe('Confirmed at the till by an unnamed account');
  });
});

describe('SCRUM-772 the rate saved to the member with no document', () => {
  it('is the Thai rate only, with nothing filled in', () => {
    expect(tierConfirmationProblem({ toTier: 'thai' })).toBeNull();
    expect(tierConfirmationProblem({ toTier: 'thai', evidenceExpiresAt: null, note: '  ' })).toBeNull();
    expect(tierConfirmationProblem({ toTier: 'expat' })).toBe(TIER_APPROVAL_PROBLEMS.tier);
    expect(tierConfirmationProblem({ toTier: 'thai', evidenceExpiresAt: '2030-01-01' })).toBe(
      TIER_APPROVAL_PROBLEMS.expiry,
    );
    expect(tierConfirmationProblem({ toTier: 'thai', note: 'Mother is Thai' })).toBe(
      TIER_APPROVAL_PROBLEMS.confirmationNote,
    );
  });

  it('travels from a box as the till recorded it, beside the document kinds', () => {
    const parsed = OfflineMemberTierChangedSchema.safeParse({
      direction: 'upgrade',
      memberId: '018f0000-0000-7000-8000-000000000772',
      verificationId: '018f0000-0000-7000-8000-000000000773',
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect(
      OfflineMemberTierChangedSchema.safeParse({
        direction: 'upgrade',
        memberId: '018f0000-0000-7000-8000-000000000772',
        verificationId: '018f0000-0000-7000-8000-000000000774',
        toTier: 'thai',
        evidenceType: 'Looks Thai',
      }).success,
    ).toBe(false);
  });
});
