// Member calls the till makes that are not on `membersApi` in ./platform.ts,
// which still carries the lookup, the create, the enrich and the children.
import { api } from './client';

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
