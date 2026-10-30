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
 * SCRUM-697 adds Other after the three kinds (`TIER_PROOF_CHOICES`, what the
 * verify step offers): staff describe what they checked, and the description
 * follows the same rule on the till, the box and the platform
 * (`tierProofNoteProblem`).
 */
import { TIER_PROOF_OTHER } from '@oto/shared';

export {
  TIER_PROOF_CHOICES,
  TIER_PROOF_NOTE_MAX,
  TIER_PROOF_OTHER,
  TIER_PROOF_TYPES,
  tierProofLabel,
  tierProofNoteProblem,
} from '@oto/shared';

/** What the admin screen says under the picker, so nobody looks for a setting that is not there. */
export const TIER_PROOF_NOTE =
  'Select the document you checked.';

/**
 * The document a sale was priced on, as History's sentence reads it —
 * "Priced on passport", "Priced on other (Thai driving licence)".
 */
export function pricedOnDocument(kind: string, note?: string | null): string {
  const text = note?.trim();
  return kind === TIER_PROOF_OTHER && text ? `other (${text})` : kind.toLowerCase();
}
