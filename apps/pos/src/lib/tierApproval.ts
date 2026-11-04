/**
 * SCRUM-772 — THE THAI RATE APPROVED BY HAND, as the till offers and shows it.
 *
 * The document check stays the normal path on the verify step. Beside it,
 * "Special case, approve by hand" lets the staff member on the till apply the
 * Thai rate with a reason from a short list and an optional note — alone, so
 * the customer does not wait. It applies to THIS SALE ONLY: the platform
 * records it as a tier claim the cart names (`approveTierByHand` in
 * `api/sales.ts`), never as a verification on the member, so the next visit
 * asks again.
 *
 * The reasons and the rule live in `@oto/shared`, so the till and the
 * platform say the same words and refuse the same text.
 */
import { tierApprovedByHandLine } from '@oto/shared';
import type { TierApprovalReason } from '@oto/shared';
import type { ApiSaleTierClaim } from '@/api/history';
import { tierLabel } from '@/lib/membership';
import { NetworkError, isMissingRoute } from '@/api/client';

export {
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_REASONS,
  TIER_APPROVAL_REASON_LABELS,
  TIER_APPROVAL_TEXT_MAX,
  isTierApprovalTier,
  tierApprovalProblem,
  tierApprovalReasonLabel,
} from '@oto/shared';
export type { TierApprovalReason } from '@oto/shared';

/** What staff chose on the special-case step. */
export interface TierApprovalChoice {
  reason: TierApprovalReason;
  /** What staff typed for Other, trimmed; absent otherwise. */
  reasonText?: string;
  /** The optional note, trimmed; absent when none was typed. */
  note?: string;
}

/**
 * The sale's document check when the rate was approved by hand —
 * "Thai rate approved by hand by Som: Thai child with a foreign parent",
 * with the note after a dash when one was added. Null for a document check.
 */
export function approvedByHandLine(claim: Pick<ApiSaleTierClaim, 'toTier' | 'approval'>): string | null {
  const approval = claim.approval;
  if (!approval) return null;
  const line = tierApprovedByHandLine(tierLabel(claim.toTier), approval.approvedBy, approval.reasonLabel);
  return approval.note ? `${line} — ${approval.note}` : line;
}

/**
 * Why an approval press did not land, in words for the counter. The box keeps
 * no tier claims, so with no platform there is nothing to record it on: the
 * till says so and points at the document check, which is still there.
 */
export function tierApprovalErrorText(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Approving by hand needs the platform, and it did not answer. Try again, or check a document instead.';
  }
  if (isMissingRoute(err)) {
    return 'This platform cannot record an approval by hand yet. Check a document instead.';
  }
  return err instanceof Error ? err.message : 'The approval could not be recorded.';
}
