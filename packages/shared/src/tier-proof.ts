/**
 * The documents reception may record for a discounted tier.
 *
 * The till, platform and offline box accept these three kinds for new
 * verifications. Historical records retain their recorded document text.
 * A claim carries the kind of document, never its number.
 *
 * SCRUM-773 (4 November 2026): Driving licence takes the place of Residence
 * certificate, which is no longer offered (`TIER_PROOF_RETIRED`).
 */
export const TIER_PROOF_TYPES = ['Passport', 'Driving licence', 'School card'] as const;
export type TierProofType = (typeof TIER_PROOF_TYPES)[number];

/**
 * SCRUM-697 — a document that is none of the three kinds.
 *
 * Staff pick "Other" and describe what they checked ("Work permit"). The
 * description is the record's note; it is what makes an Other check mean
 * anything, so it is required, and it describes the document, never its
 * number. The document's expiry date is asked for as on the three kinds
 * (SCRUM-773) and, as on them, it is required (SCRUM-1019,
 * `tierProofExpiryProblem`).
 */
export const TIER_PROOF_OTHER = 'Other' as const;

/** What the till offers and the routes accept: the three kinds, then Other. */
export const TIER_PROOF_CHOICES = [...TIER_PROOF_TYPES, TIER_PROOF_OTHER] as const;
export type TierProofChoice = (typeof TIER_PROOF_CHOICES)[number];

/**
 * SCRUM-773 — kinds the till no longer offers, which recorded checks still
 * carry.
 *
 * A verification filed as "Residence certificate" before 4 November reads as
 * it was filed, everywhere it is shown: its `evidence_type` is text, and no
 * screen maps it through this list. Nothing new may pick it — the till, the
 * Console, the box and the routes offer and accept `TIER_PROOF_CHOICES` only.
 */
export const TIER_PROOF_RETIRED = ['Residence certificate'] as const;

/**
 * Every kind a check recorded at a counter may carry: today's choices and the
 * retired ones. Only what a box replays is read against it — a check its till
 * made with the link down, before the box took this list, still files when
 * the link returns rather than waiting in quarantine for a person.
 */
export const TIER_PROOF_RECORDED = [...TIER_PROOF_CHOICES, ...TIER_PROOF_RETIRED] as const;

/** The longest description a check carries, trimmed. */
export const TIER_PROOF_NOTE_MAX = 200;

/**
 * One sentence per problem, so the till and the api say the same words.
 */
export const TIER_PROOF_NOTE_PROBLEMS = {
  missing: 'Say what you checked in at least two words, e.g. Work permit.',
  tooLong: `Keep the description to ${TIER_PROOF_NOTE_MAX} characters.`,
  number: 'Describe the document, never its number.',
} as const;

/** Five or more digits in a row, Arabic or Thai: a document number, not a description. */
const DOCUMENT_NUMBER = /[0-9๐-๙]{5,}/;
/** A word holds at least one letter, in any script. */
const HAS_LETTER = /\p{L}/u;

/**
 * Why a check's description cannot be recorded, or null when it can.
 *
 * For Other the description is required: at least two words (split on
 * whitespace, each holding a letter) and at most `TIER_PROOF_NOTE_MAX`
 * characters. For the three kinds it is optional. Either way a run of five or
 * more digits is refused — the note describes the document, it does not carry
 * its number into a table nothing sweeps.
 */
export function tierProofNoteProblem(
  note: string | null | undefined,
  evidenceType: string,
): string | null {
  const text = (note ?? '').trim();
  if (text !== '' && DOCUMENT_NUMBER.test(text)) return TIER_PROOF_NOTE_PROBLEMS.number;
  if (text.length > TIER_PROOF_NOTE_MAX) return TIER_PROOF_NOTE_PROBLEMS.tooLong;
  if (evidenceType === TIER_PROOF_OTHER) {
    const words = text.split(/\s+/).filter((word) => HAS_LETTER.test(word));
    if (words.length < 2) return TIER_PROOF_NOTE_PROBLEMS.missing;
  }
  return null;
}

/**
 * SCRUM-1019 — THE EXPIRY DATE IS REQUIRED ON EVERY DOCUMENT (the owner's
 * answer of 19 November 2026): on every kind, Other included. His one
 * exception, the Thai ID card ("nationality does not expire"), is not a kind
 * the till offers: the Thai rate is confirmed at the till with no document
 * and no date at all (SCRUM-772, `tierConfirmationProblem`), and stays so.
 *
 * Only a NEW check is held to it, on the till, the platform and the box. A
 * document recorded before the rule with no date stays as it was filed — no
 * backfill, no lock-out — and a box's replay of a check its counter made
 * earlier still files as it was made.
 */
export const TIER_PROOF_EXPIRY_PROBLEMS = {
  missing: "Enter the document's expiry date.",
  notADate: 'That document expiry is not a date.',
} as const;

/** A `YYYY-MM-DD` that names a real day. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/**
 * Why a new document check's expiry date cannot be recorded, or null when it
 * can: it is missing, or it is not a date. Whether it has passed is each
 * writer's own check, in its own words, as before.
 */
export function tierProofExpiryProblem(expiresAt: string | null | undefined): string | null {
  const text = (expiresAt ?? '').trim();
  if (text === '') return TIER_PROOF_EXPIRY_PROBLEMS.missing;
  if (!isCalendarDate(text)) return TIER_PROOF_EXPIRY_PROBLEMS.notADate;
  return null;
}

/**
 * How a recorded check reads on a profile: the kind — a retired one as it was
 * filed — or for Other the description staff typed: "Other (Work permit)".
 */
export function tierProofLabel(proofType: string, note?: string | null): string {
  const text = note?.trim();
  return proofType === TIER_PROOF_OTHER && text ? `${TIER_PROOF_OTHER} (${text})` : proofType;
}
