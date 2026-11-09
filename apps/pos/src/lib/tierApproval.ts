/**
 * SCRUM-772 — THE THAI RATE CONFIRMED AT THE TILL, as the till offers and shows it.
 *
 * The owner's rule (6 November 2026): "For the Thai rate, we don't need to
 * show document options or expiry date. Just a verification modal with 2
 * buttons and record staff logs." So the Thai rate's verify step is one
 * confirmation — "Confirm Thai rate" or "Cancel" — with no document list and
 * no expiry. Confirm records a tier claim for the sale with the one reason
 * `TIER_APPROVAL_TILL_REASON` (`confirmTierAtTill` in
 * `lib/thaiRateConfirmation.ts`) and saves the rate to the member as a
 * document check did, with the evidence `TIER_APPROVAL_EVIDENCE`. The Expat
 * rate keeps its document step.
 *
 * The reasons and the rule live in `@oto/shared`, so the till and the
 * platform say the same words and refuse the same text.
 */
import { TIER_APPROVAL_EVIDENCE, tierApprovedByHandLine, tierProofLabel } from '@oto/shared';
import type { TierApprovalReason } from '@oto/shared';
import type { ApiSaleTierClaim } from '@/api/history';
import type { TierVerification } from '@/types';
import { tierLabel } from '@/lib/membership';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';

export {
  TIER_APPROVAL_EVIDENCE,
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_REASONS,
  TIER_APPROVAL_REASON_LABELS,
  TIER_APPROVAL_TEXT_MAX,
  TIER_APPROVAL_TILL_REASON,
  isTierApprovalTier,
  tierApprovalProblem,
  tierApprovalReasonLabel,
} from '@oto/shared';
export type { TierApprovalReason } from '@oto/shared';

/** What a hand approval records: since 6 November, the till's one reason. */
export interface TierApprovalChoice {
  reason: TierApprovalReason;
  /** What staff typed for Other, trimmed; absent otherwise. */
  reasonText?: string;
  /** The optional note, trimmed; absent when none was typed. */
  note?: string;
}

/**
 * The sale's document check when the rate was approved by hand — "Thai rate
 * confirmed at the till by Som" for the till's one reason, or for a claim made
 * from 5 November "Thai rate approved by hand by Som: Thai child with a
 * foreign parent", with the note after a dash when one was added. Null for a
 * document check.
 */
export function approvedByHandLine(claim: Pick<ApiSaleTierClaim, 'toTier' | 'approval'>): string | null {
  const approval = claim.approval;
  if (!approval) return null;
  const line = tierApprovedByHandLine(
    tierLabel(claim.toTier),
    approval.approvedBy,
    approval.reasonLabel,
    approval.reason,
  );
  return approval.note ? `${line} — ${approval.note}` : line;
}

/**
 * How a rate saved to a new member reads in the toast: "Confirmed at the till
 * by Som" for the Thai rate, or the document and its expiry for a document
 * check — "Passport · valid until 2030-01-01".
 */
export function savedRateSummary(verification: TierVerification): string {
  if (verification.proofType === TIER_APPROVAL_EVIDENCE) {
    return `Confirmed at the till by ${verification.verifiedBy}`;
  }
  return `${tierProofLabel(verification.proofType, verification.note)} · valid until ${verification.expiresAt ?? '—'}`;
}

/**
 * Why a Confirm press did not land, in words for the counter. The box keeps
 * no tier claims, so with no platform there is nothing to record a walk-in's
 * rate on: the till says so. A station forced offline for testing
 * (`STATION_FORCED_OFFLINE`, SCRUM-285) is the same fact for this step, so it
 * gets the same sentence rather than the platform's generic one about taking
 * payment.
 */
export function tierApprovalErrorText(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Confirming the Thai rate needs the platform, and it did not answer. Try again in a moment.';
  }
  if (err instanceof ApiError && err.code === 'STATION_FORCED_OFFLINE') {
    return 'Confirming the Thai rate needs the platform, and this till is offline.';
  }
  if (isMissingRoute(err)) {
    return 'This platform cannot record the Thai rate confirmed at the till yet.';
  }
  return err instanceof Error ? err.message : 'The Thai rate could not be recorded.';
}
