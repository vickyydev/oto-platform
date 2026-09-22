/**
 * THE DOCUMENTS RECEPTION CAN RECORD FOR A DISCOUNTED TIER — SCRUM-238.
 *
 * The verification ITSELF is real: `POST /members/:id/tier-verification` writes
 * `member_tier_verification` with the checker stamped from the session, and
 * `GET /members/tier-verifications` reads them back. Only the list of document
 * names was not — it sat in `mockApi.ts` beside the fixture members, which made
 * a working flow look like a demo.
 *
 * NO ROUTE SERVES THIS LIST. The operator cannot configure the choices
 * anywhere, so this is a fixed built-in list, not a read of the park's
 * configuration. The list itself lives in `@oto/shared` (`TIER_PROOF_TYPES`)
 * because the platform's tier-claim route accepts exactly these names and
 * nothing else (SCRUM-307); making it configurable per operator is SCRUM-238's
 * remaining half.
 *
 * 'Other' prompts for a short description of the document, saved with the record.
 */
export { TIER_PROOF_TYPES } from '@oto/shared';

/** What the admin screen says under the picker, so nobody looks for a setting that is not there. */
export const TIER_PROOF_NOTE =
  'This list is built in and cannot be configured per operator yet (SCRUM-238).';
