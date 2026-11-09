/**
 * SCRUM-772 — CONFIRM THAI RATE: what the till does when staff press it.
 *
 * The owner's rule (6 November 2026): the Thai rate shows no document options
 * and no expiry — a confirmation with two buttons, and the staff log is the
 * record. One press does what the document check did, without the document:
 *
 *   1. THE SALE'S CLAIM. `POST /sales/tier-approvals` with the one reason
 *      `confirmed_at_till`: the platform stamps who (the session's account),
 *      where (its branch and till) and when, writes its own action in the log,
 *      and the cart names the claim from here on, so the quote and the sale
 *      are priced at the Thai rate with the evidence "Approved by hand".
 *   2. THE MEMBER'S RATE. Saved as a document check saved it, so the next
 *      visit skips the step: for a member on the till, now
 *      (`POST /members/:id/tier-verification` with the evidence "Approved by
 *      hand"); for a walk-in, held as the pending verification the details
 *      step saves once they give a phone and a name (SCRUM-227), which then
 *      joins the sale already rung up (SCRUM-779).
 *
 * A member's rate is the stronger record, so a member does not depend on the
 * claim: with the platform out of reach, the rate is saved through the
 * counter box and prices the cart there. A walk-in has nothing else to be
 * priced from, so a claim that does not land is a refusal the modal shows.
 */
import { ApiError, NetworkError } from '@/api/client';
import { apiMemberToMember } from '@/api/mappers';
import { membersApi } from '@/api/platform';
import { approveTierByHand } from '@/api/sales';
import { TIER_APPROVAL_EVIDENCE, TIER_APPROVAL_TILL_REASON } from '@/lib/tierApproval';
import type { Member, TierVerification } from '@/types';

/** Members loaded from the platform carry UUID ids, and only those can be written. */
export const isPlatformMemberId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The verification a till confirmation is: the rate, no document, no expiry. */
export function tillConfirmation(
  tier: string,
  confirmedBy: { id: string; name: string },
  at: Date = new Date(),
): TierVerification {
  return {
    tier,
    proofType: TIER_APPROVAL_EVIDENCE,
    verifiedBy: confirmedBy.name,
    verifiedById: confirmedBy.id,
    verifiedAt: at.toISOString(),
  };
}

/** What one Confirm press left behind. */
export interface TillConfirmationResult {
  /**
   * The claim the cart names from here on. Null only for a member when the
   * platform was out of reach: their saved rate prices the cart instead.
   */
  claimActionId: string | null;
  /** The member with the rate now saved on them, when there was one to save it to. */
  member: Member | null;
  /** For a walk-in: the confirmation the details step saves to their profile. */
  pending: TierVerification | null;
  /** Why the save to the member did not land while the claim did: the rate stands on this sale. */
  profileError: string | null;
}

/** The platform did not answer, or this till is held offline: the box is the way. */
function platformOutOfReach(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof ApiError && err.code === 'STATION_FORCED_OFFLINE');
}

/**
 * The rate saved on a member as the till confirmed it: the evidence "Approved
 * by hand", no expiry, no note. Who, the branch and the till are stamped from
 * the session on the platform's side (or the box's, with the link down).
 */
async function saveToMember(saveTo: Member, tier: string): Promise<Member> {
  const res = await membersApi.verifyTier(saveTo.id, { toTier: tier, evidenceType: TIER_APPROVAL_EVIDENCE });
  return { ...saveTo, ...apiMemberToMember(res.member) };
}

/**
 * Confirm Thai rate where there is no sale to claim for — the party tab,
 * which charges to the party's bill: saved to a member as a document check is
 * there, or handed back for a walk-in, whose tier is applied to the order.
 */
export async function confirmTierWithoutSale(input: {
  tier: string;
  member: Member | null;
  confirmedBy: { id: string; name: string };
}): Promise<{ member: Member | null; verification: TierVerification }> {
  const verification = tillConfirmation(input.tier, input.confirmedBy);
  if (!input.member || !isPlatformMemberId(input.member.id)) return { member: input.member, verification };
  const saved = await saveToMember(input.member, input.tier);
  return { member: saved, verification: saved.tierVerification ?? verification };
}

export async function confirmTierAtTill(input: {
  branchId: string;
  tier: string;
  member: Member | null;
  confirmedBy: { id: string; name: string };
}): Promise<TillConfirmationResult> {
  const saveTo = input.member && isPlatformMemberId(input.member.id) ? input.member : null;

  let claimActionId: string | null = null;
  try {
    claimActionId = await approveTierByHand({
      branchId: input.branchId,
      tier: input.tier,
      reason: TIER_APPROVAL_TILL_REASON,
    });
  } catch (err) {
    if (!saveTo || !platformOutOfReach(err)) throw err;
  }

  let member: Member | null = null;
  let profileError: string | null = null;
  if (saveTo) {
    try {
      member = await saveToMember(saveTo, input.tier);
    } catch (err) {
      // Without the claim there is nothing that prices this cart at the rate.
      if (!claimActionId) throw err;
      profileError = err instanceof Error ? err.message : 'Unknown error';
    }
  }

  return {
    claimActionId,
    member,
    pending: input.member ? null : tillConfirmation(input.tier, input.confirmedBy),
    profileError,
  };
}
