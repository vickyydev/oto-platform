// Member calls the till makes that are not on `membersApi` in ./platform.ts,
// which still carries the lookup, the create, the enrich and the children —
// plus that lookup answered in the screens' own `Member` shape.
import type { Member } from '@/types';
import { api } from './client';
import { apiMemberToMember } from './mappers';
import { membersApi } from './platform';

export const childrenApi = {
  /**
   * SCRUM-337 — take a child off the member's saved list.
   *
   * The API archives rather than deletes: the row stays where the visits that
   * named the child still point at it, and stops appearing on the lookup, the
   * member detail and the register. Guarded by `pos:child:update`, the same
   * permission as correcting a child's allergies, which a till session holds.
   *
   * No Idempotency-Key: the route is idempotent in itself — archiving a child
   * that is already archived answers success again and writes nothing — so a
   * second press or a retry needs no replayed body to be safe.
   */
  archive: (childId: string) =>
    api.delete<{ ok: true; alreadyArchived: boolean }>(`/members/children/${childId}`),
};

/**
 * S2-09b (SCRUM-204) — the member the platform holds for this phone, with
 * their saved children, or null when it holds nobody by that number.
 *
 * For the screens that asked `mockApi.getMemberByPhone` until now — the phone
 * till, the party ticket builder and the counter till's drop-off hand-off —
 * so a family found there is the same record the membership check finds, and
 * a sale that names them names a member the platform has.
 *
 * Null is "not found" and nothing else: a refused or unreachable lookup
 * throws, so the caller can tell "nobody by that number" from "could not
 * ask". Needs a signed-in session holding `pos:member:read`; the booking site
 * has neither and asks `publicApi.memberTier` instead.
 */
export async function lookupMember(phone: string): Promise<Member | null> {
  const { member } = await membersApi.lookup(phone);
  return member ? apiMemberToMember(member) : null;
}
