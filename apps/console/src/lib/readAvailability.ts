/**
 * SCRUM-645 / planner ruling Q26 — words for a read that did not answer.
 *
 * The api now says, per evidence read on Health and per row on Integrations,
 * whether the read behind it answered: `ok`, `denied` (the database refused
 * it), `failed` (it threw or timed out) or `unknown` (not attempted). A list
 * that is empty because its read failed must never be presented as an empty
 * estate, so these turn the verdict into a sentence the page can put first.
 * Pure, so the unit runner can pin them.
 */
export type ReadAvailability = 'ok' | 'failed' | 'denied' | 'unknown';

export interface EvidenceLike {
  label: string;
  availability: ReadAvailability;
}

export function availabilityWord(availability: ReadAvailability): string {
  switch (availability) {
    case 'ok':
      return 'read';
    case 'denied':
      return 'refused';
    case 'failed':
      return 'failed';
    default:
      return 'not read';
  }
}

/** One problem line per evidence read that did not answer — the verdict above them is unknown, not healthy. */
export function unreadEvidenceProblems(evidence: readonly EvidenceLike[] | undefined): string[] {
  return (evidence ?? [])
    .filter((entry) => entry.availability !== 'ok')
    .map((entry) => `${entry.label} could not be read (${availabilityWord(entry.availability)}), so nothing below can be called healthy.`);
}

/**
 * The line an Integrations card shows when this read of its record did not
 * answer: what is shown is only what could be read, never a fresh green.
 */
export function integrationReadNote(availability: ReadAvailability | undefined): string | null {
  if (!availability || availability === 'ok') return null;
  return `Its record was not read just now (${availabilityWord(availability)}), so this is not a confirmation that it works.`;
}

/** Words for an owner-recorded expiry window. */
export function expiryWords(window: string, daysLeft: number | null, expiresOn: string | null): string {
  if (window === 'not_set' || !expiresOn) return 'No expiry date recorded';
  if (window === 'expired') return `Expired on ${expiresOn}`;
  if (daysLeft === 0) return `Expires today (${expiresOn})`;
  return `Expires on ${expiresOn}, in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}
