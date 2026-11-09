import { TIER_PROOF_NOTE_MAX, TIER_PROOF_NOTE_PROBLEMS, TIER_PROOF_OTHER, tierProofNoteProblem } from './tier-proof';

/**
 * SCRUM-772 — the Thai rate confirmed at the till, with no document.
 *
 * THE OWNER'S RULE (6 November 2026): "For the Thai rate, we don't need to
 * show document options or expiry date. Just a verification modal with 2
 * buttons and record staff logs." Not every Thai customer needs a passport
 * check; staff confirm the rate and the record says who did, where and when.
 *
 * So the Thai rate has no document step at all: the till shows one
 * confirmation, "Confirm Thai rate" or "Cancel". Confirm records a tier claim
 * for the sale with the evidence `TIER_APPROVAL_EVIDENCE` and the one reason
 * `TIER_APPROVAL_TILL_REASON`, and saves the rate to the member the same way
 * a document check did — now, for a member, or once a walk-in gives their
 * details (SCRUM-227, SCRUM-779) — as a verification whose evidence is
 * `TIER_APPROVAL_EVIDENCE`, so the next visit does not ask again. The Expat
 * rate keeps its document check and expiry (SCRUM-773).
 *
 * Nobody else confirms it, so the customer does not wait; what makes it
 * answerable is the record — the signed-in account, the station, the time
 * and the sale — and the Console's count of confirmations per staff member.
 *
 * Before this rule (5 November) the till offered "Special case, approve by
 * hand" beside the document list, with a reason from a short list. Those
 * reasons stay recorded and accepted (`TIER_APPROVAL_REASONS`); the till no
 * longer offers a choice.
 */

/** The one reason the till records since 6 November: no chooser is shown. */
export const TIER_APPROVAL_TILL_REASON = 'confirmed_at_till' as const;

/**
 * Every reason a claim may record, stored as these codes. The till sends
 * `TIER_APPROVAL_TILL_REASON` only; the three after it were offered from
 * 5 November and stay accepted, so a claim filed under one still reads and a
 * till still on that build is not refused.
 */
export const TIER_APPROVAL_REASONS = [
  TIER_APPROVAL_TILL_REASON,
  'thai_child_foreign_parent',
  'thai_id_seen_not_to_hand',
  'other',
] as const;
export type TierApprovalReason = (typeof TIER_APPROVAL_REASONS)[number];

/** How each reason reads on the till, on the sale and in the Console. */
export const TIER_APPROVAL_REASON_LABELS: Record<TierApprovalReason, string> = {
  confirmed_at_till: 'Confirmed at the till',
  thai_child_foreign_parent: 'Thai child with a foreign parent',
  thai_id_seen_not_to_hand: 'Thai ID seen earlier, not to hand',
  other: 'Other',
};

/**
 * The tiers confirmed at the till without a document: the Thai rate only.
 * Every other discounted rate still needs its document.
 */
export const TIER_APPROVAL_TIERS = ['thai'] as const;

/**
 * `evidence_type` on the sale's tier claim, and on the member's verification,
 * when the Thai rate was confirmed at the till: the record's kind, so a reader
 * of the row never takes it for a document.
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
  /** A member verification confirmed at the till names no document date. */
  expiry: 'The Thai rate confirmed at the till carries no expiry date.',
  /** …and no description: there is no document to describe. */
  confirmationNote: 'The Thai rate confirmed at the till carries no note.',
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

/**
 * Why a MEMBER verification whose evidence is `TIER_APPROVAL_EVIDENCE` cannot
 * be recorded, or null when it can: the Thai rate only, with no expiry date
 * and no note — the owner's rule leaves nothing to fill in. The verifier,
 * branch, station and time are the session's, never the caller's.
 */
export function tierConfirmationProblem(input: {
  toTier: string;
  evidenceExpiresAt?: string | null;
  note?: string | null;
}): string | null {
  if (!isTierApprovalTier(input.toTier)) return TIER_APPROVAL_PROBLEMS.tier;
  if (input.evidenceExpiresAt) return TIER_APPROVAL_PROBLEMS.expiry;
  if ((input.note ?? '').trim() !== '') return TIER_APPROVAL_PROBLEMS.confirmationNote;
  return null;
}

/** "Confirmed at the till by Som": how a till confirmation reads in the Console. */
export function tierConfirmedAtTillLine(confirmedBy: string | null | undefined): string {
  return `Confirmed at the till by ${confirmedBy?.trim() || 'an unnamed account'}`;
}

/** The reason as it reads: the list's words, or for Other what staff typed. */
export function tierApprovalReasonLabel(reason: string, reasonText?: string | null): string {
  const text = reasonText?.trim();
  if (reason === 'other') return text ? text : TIER_APPROVAL_REASON_LABELS.other;
  return isTierApprovalReason(reason) ? TIER_APPROVAL_REASON_LABELS[reason] : reason;
}

/**
 * The sale's document check when the rate was approved by hand:
 * "Thai rate approved by hand by Som: Thai child with a foreign parent", and
 * for the till's one reason since 6 November, "Thai rate confirmed at the till
 * by Som".
 */
export function tierApprovedByHandLine(
  tierName: string,
  approvedBy: string | null | undefined,
  reasonLabel: string,
  reason?: string,
): string {
  const who = approvedBy?.trim() || 'an unnamed account';
  if (reason === TIER_APPROVAL_TILL_REASON) return `${tierName} rate confirmed at the till by ${who}`;
  return `${tierName} rate approved by hand by ${who}: ${reasonLabel}`;
}
