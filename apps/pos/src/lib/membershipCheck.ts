import { phoneAsName } from '@oto/shared';
import { ApiError } from '@/api/client';
import { membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { isDefaultTier, soleTierFor, tierNeedsProof } from '@/lib/membership';
import { isTierApprovalTier } from '@/lib/tierApproval';
import type { ContactChannel, CustomerTier, Member } from '@/types';

/**
 * SCRUM-1019 — THE NUMBER AND THE RATE AT THE MEMBERSHIP CHECK (the owner's
 * answers of 19 November 2026, docs/progress/plans/dropoff-beo-20261119/
 * ANSWERS.md §2). The till's rules for it, pure where they can be, so the till
 * and its tests read one copy.
 */

/** The longest name the till hands a new member: the customer screens show 100. */
const NEW_MEMBER_NAME_MAX = 100;

/**
 * A NUMBER THE SYSTEM DOES NOT KNOW CREATES THE CUSTOMER BY ITSELF, with the
 * name the family gave on the first screen (the customer display's nickname).
 * No "New member?" choice is put to staff for it.
 *
 * Null when no name was given: `nameForNewMember` then names the member by
 * the number itself.
 */
export function newMemberName(nickname: string | null | undefined): string | null {
  const name = (nickname ?? '').trim().slice(0, NEW_MEMBER_NAME_MAX).trim();
  return name || null;
}

/**
 * THE NAME A NEW MEMBER IS CREATED WITH (the owner's answer of 19 November,
 * R1): the name the family gave, else the number itself, in the form the till
 * shows a number ("+66 81 895 3926"), until a name is given. A member's name
 * cannot be empty (the record, the platform's create and the box's offline
 * copy all require one), and this needs no new field: whoever next gives a
 * name where a member's name is edited replaces it as any name. So a number
 * with no name meets no "New member?" box either. Null only for a number that
 * does not read as one and a name not given: the platform would refuse that
 * number, so the till goes on as it did before for it.
 */
export function nameForNewMember(nickname: string | null | undefined, phone: string): string | null {
  return newMemberName(nickname) ?? phoneAsName(phone);
}

/**
 * The member for a number the lookup did not find, created from the number and
 * the name. The same normalised number never makes a second member: a create
 * that meets a member made a moment earlier (another counter, a retried press,
 * or the box's own copy offline) is answered with that member, found again by
 * the number on whichever lane is up, rather than failing the check.
 */
export async function createMemberForNumber(input: {
  phone: string;
  name: string;
  channel?: ContactChannel | null;
}): Promise<Member> {
  const channel = input.channel ?? undefined;
  try {
    const { member } = await membersApi.create({
      phone: input.phone,
      nickname: input.name,
      ...(channel ? { preferredChannel: channel } : {}),
    });
    return apiMemberToMember(member);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'MEMBER_PHONE_EXISTS') throw err;
    const found = (await membersApi.lookup(input.phone)).member;
    if (!found) throw err;
    return apiMemberToMember(found);
  }
}

/**
 * A MEMBER WITH A VALID EXPAT RATE SKIPS THE RATE STEP and goes straight to
 * tickets; the rate shows on the order with a "change" link back to the rate
 * step (where "Show all rates" for a guest of the member still lives).
 *
 * "Valid" is the till's existing reading of a verified rate in date
 * (`soleTierFor`, SCRUM-858): verified and not past its recorded expiry. A
 * document recorded before the expiry date was required, with no date, has
 * never expired by that reading and skips as before it showed its one card.
 * "Expat" is the rate checked on a document: one that needs proof and is not
 * the Thai rate confirmed at the till (SCRUM-772), which keeps its step. Null
 * means the rate step is shown, as today: a walk-in, a member with no verified
 * rate, a member whose document has expired, or a Thai-rate member.
 */
export function rateStepSkippedFor(member: Member | null): CustomerTier | null {
  const sole = soleTierFor(member);
  if (!sole || isDefaultTier(sole) || !tierNeedsProof(sole) || isTierApprovalTier(sole)) return null;
  return sole;
}
