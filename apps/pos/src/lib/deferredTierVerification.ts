import { ApiError } from '@/api/client';
import { membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import type { ContactChannel, Member, TierVerification } from '@/types';

/**
 * Save a discount that was verified before the visitor gave their details.
 *
 * The ordinary walk-in order at the counter is: check the document, price the
 * order at the discounted rate, then hand the display over for a phone number
 * and a name. Until SCRUM-227 that second half wrote the member and the
 * verification into browser memory, so the evidence for a discount that had
 * already been given was gone on the next refresh — the one record the
 * evidence rules exist to produce.
 *
 * This takes the same two steps against the platform: find or create the
 * member, then record the verification through the route that writes the
 * evidence row and the tier in one transaction, stamping the verifier from the
 * session. It throws rather than returning a half-result — the caller keeps
 * the pending verification so pressing Done again retries it.
 */
export async function saveDeferredVerification(input: {
  phone: string;
  nickname: string;
  channel?: ContactChannel;
  verification: TierVerification;
}): Promise<Member> {
  const phone = input.phone.trim();
  const nickname = input.nickname.trim();
  const { verification } = input;

  const found = (await membersApi.lookup(phone)).member;
  let target = found;

  if (!target) {
    if (!nickname) {
      throw new Error(
        'Add a name for this visitor — the discounted rate cannot be saved to a profile without one.',
      );
    }
    try {
      target = (
        await membersApi.create({
          phone,
          nickname,
          ...(input.channel ? { preferredChannel: input.channel } : {}),
        })
      ).member;
    } catch (err) {
      // Somebody else created this phone between the lookup and the create.
      // The conflict carries the id of the member that exists, so the
      // verification still lands on the right profile.
      const existingId =
        err instanceof ApiError && err.code === 'MEMBER_PHONE_EXISTS'
          ? (err.details as { memberId?: string } | undefined)?.memberId
          : undefined;
      if (!existingId) throw err;
      target = (await membersApi.get(existingId)).member;
    }
  }

  const { member } = await membersApi.verifyTier(target.id, {
    toTier: verification.tier,
    evidenceType: verification.proofType,
    // Optional, as in the approved design's verification step.
    ...(verification.expiresAt ? { evidenceExpiresAt: verification.expiresAt } : {}),
  });
  return apiMemberToMember(member);
}
