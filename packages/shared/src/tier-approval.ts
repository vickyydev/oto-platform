import { TIER_PROOF_NOTE_MAX, TIER_PROOF_NOTE_PROBLEMS, TIER_PROOF_OTHER, tierProofNoteProblem } from './tier-proof';

/**
 * SCRUM-772 — the Thai rate approved by hand, for the cases a document check
 * does not fit.
 *
 * The document check stays the normal path. Beside it the till offers
 * "Special case, approve by hand": the staff member on the till picks a reason
 * from this short list, may add a note, and the rate applies to THAT SALE
 * ONLY. Nobody else confirms it, so the customer does not wait; what makes it
 * answerable is the record — who approved it (the signed-in account), the
 * reason, the note, the time and the sale — and the Console's count of
 * approvals per staff member.
 *
 * It never marks the member: the member's profile holds a verified tier only
 * when a document was checked, so the next visit asks again.
 */

/** The reasons, in the order the till offers them. Stored as these codes. */
export const TIER_APPROVAL_REASONS = [
  'thai_child_foreign_parent',
  'thai_id_seen_not_to_hand',
  'other',
] as const;
export type TierApprovalReason = (typeof TIER_APPROVAL_REASONS)[number];

/** How each reason reads on the till, on the sale and in the Console. */
export const TIER_APPROVAL_REASON_LABELS: Record<TierApprovalReason, string> = {
  thai_child_foreign_parent: 'Thai child with a foreign parent',
  thai_id_seen_not_to_hand: 'Thai ID seen earlier, not to hand',
  other: 'Other',
};

/**
 * The tiers a hand approval may apply. The reasons are about Thai nationality,
 * so only the Thai rate is offered; every other discounted rate still needs
 * its document.
 */
export const TIER_APPROVAL_TIERS = ['thai'] as const;

/**
 * `evidence_type` on the sale's tier claim when the rate was approved by hand:
 * the claim's kind, so a reader of the row never takes it for a document.
 */
export const TIER_APPROVAL_EVIDENCE = 'Approved by hand' as const;

/** The longest typed reason or note an approval carries, trimmed. */
export const TIER_APPROVAL_TEXT_MAX = TIER_PROOF_NOTE_MAX;

/** One sentence per problem, so the till and the api say the same words. */
export const TIER_APPROVAL_PROBLEMS = {
  reason: 'Choose why the rate is approved by hand.',
  tier: 'Only the Thai rate can be approved by hand. Other rates need their document.',
  reasonMissing: 'Say why in at least two words, e.g. Thai grandparent with the family.',
  reasonNotOther: 'A typed reason goes with Other only.',
  reasonTooLong: `Keep the reason to ${TIER_APPROVAL_TEXT_MAX} characters.`,
  noteTooLong: `Keep the note to ${TIER_APPROVAL_TEXT_MAX} characters.`,
  number: 'Never type a document number here.',
} as const;

export function isTierApprovalReason(value: unknown): value is TierApprovalReason {
  return typeof value === 'string' && (TIER_APPROVAL_REASONS as readonly string[]).includes(value);
}

export function isTierApprovalTier(value: unknown): boolean {
  return typeof value === 'string' && (TIER_APPROVAL_TIERS as readonly string[]).includes(value);
}

export interface TierApprovalInput {
  toTier: string;
  reason: string;
  /** What staff typed when the reason is Other. */
  reasonText?: string | null;
  /** An optional note on any reason. */
  note?: string | null;
}

/**
 * Why a hand approval cannot be recorded, or null when it can.
 *
 * The typed reason for Other follows SCRUM-697's rule for an Other document
 * word for word (`tierProofNoteProblem`): at least two words, at most
 * `TIER_APPROVAL_TEXT_MAX` characters, never a run of five or more digits.
 * The note is optional and follows the same length and digit rule.
 */
export function tierApprovalProblem(input: TierApprovalInput): string | null {
  if (!isTierApprovalTier(input.toTier)) return TIER_APPROVAL_PROBLEMS.tier;
  if (!isTierApprovalReason(input.reason)) return TIER_APPROVAL_PROBLEMS.reason;
  const reasonText = (input.reasonText ?? '').trim();
  if (input.reason === 'other') {
    const problem = tierProofNoteProblem(reasonText, TIER_PROOF_OTHER);
    if (problem === TIER_PROOF_NOTE_PROBLEMS.number) return TIER_APPROVAL_PROBLEMS.number;
    if (problem === TIER_PROOF_NOTE_PROBLEMS.tooLong) return TIER_APPROVAL_PROBLEMS.reasonTooLong;
    if (problem !== null) return TIER_APPROVAL_PROBLEMS.reasonMissing;
  } else if (reasonText !== '') {
    return TIER_APPROVAL_PROBLEMS.reasonNotOther;
  }
  const noteProblem = tierProofNoteProblem(input.note, TIER_APPROVAL_EVIDENCE);
  if (noteProblem === TIER_PROOF_NOTE_PROBLEMS.number) return TIER_APPROVAL_PROBLEMS.number;
  if (noteProblem !== null) return TIER_APPROVAL_PROBLEMS.noteTooLong;
  return null;
}

/** The reason as it reads: the list's words, or for Other what staff typed. */
export function tierApprovalReasonLabel(reason: string, reasonText?: string | null): string {
  const text = reasonText?.trim();
  if (reason === 'other') return text ? text : TIER_APPROVAL_REASON_LABELS.other;
  return isTierApprovalReason(reason) ? TIER_APPROVAL_REASON_LABELS[reason] : reason;
}

/**
 * The sale's document check when the rate was approved by hand:
 * "Thai rate approved by hand by Som: Thai child with a foreign parent".
 */
export function tierApprovedByHandLine(
  tierName: string,
  approvedBy: string | null | undefined,
  reasonLabel: string,
): string {
  return `${tierName} rate approved by hand by ${approvedBy?.trim() || 'an unnamed account'}: ${reasonLabel}`;
}
