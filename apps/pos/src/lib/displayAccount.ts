/**
 * SCRUM-964 — WHO IS SIGNED IN AT THIS TILL, as the customer display's
 * publisher holds its lease under (`lib/displaySession.ts`).
 *
 * The box grants a display lease to the ACCOUNT that claimed it
 * (`packages/box-agent/src/station-session.ts`, `heldBy`): nobody else may
 * renew it or publish under it. A selling screen kept under the lock when a
 * session ends stays mounted when a different person signs in and continues
 * the sale (`auth/OperatorContext.tsx`), so its publisher outlives the person
 * it leased for. The operator session says here who is signed in now, and the
 * publisher takes a lease of its own for them when that changes.
 *
 * Memory only. Null while nobody is signed in.
 */
let current: string | null = null;

export const signedInAccount = {
  get: (): string | null => current,
  set(next: string | null): void {
    current = next;
  },
};
