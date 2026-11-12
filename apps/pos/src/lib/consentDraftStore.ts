import { CONSENT_FORM_STEPS, type ConsentFormStep } from '@oto/shared';

/**
 * SCRUM-874 — THE FAMILY'S FORM SURVIVES A SHORT CONNECTION DROP.
 *
 * On a separate paired display the drop-off and nanny form sends what the
 * family types to the till as they go (SCRUM-857), so the till holds almost
 * all of it. What it does not hold is what they typed in the last moment, or
 * while the line was down: a display that loses the box for long enough shows
 * its paused screen, and one that is reloaded or paired again starts the form
 * from the till's copy. So the form keeps its own draft here, one per visitor
 * (the till's id for this family's form), and a form that opens again for the
 * same visitor lays it back over the till's copy, field by field, as it does
 * any newer copy (`mergeConsentDraft`) — then sends what the till is missing.
 *
 * Kept in this tab's session storage only, never local storage: it is a
 * public screen and the draft holds children's names and care notes. It is
 * cleared when the form is finished, when another visitor's form opens, when
 * the display moves on to another sale's screens, and after half an hour.
 */
const KEY = 'oto.display.consentDraft.v1';
export const CONSENT_DRAFT_TTL_MS = 30 * 60_000;

export interface StoredConsentDraft<Draft> {
  visitorId: string;
  /** The till's copy the draft was last laid over (`base`), and what was sent on it. */
  base: Draft;
  local: Draft;
  sent: Draft[];
  step: ConsentFormStep;
  savedAt: number;
}

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/** The draft kept for this visitor, if it is theirs and recent; any other is cleared. */
export function readConsentDraft<Draft>(visitorId: string, isDraft: (value: unknown) => value is Draft,
  now = Date.now()): StoredConsentDraft<Draft> | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try { raw = store.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = null; }
  const stored = value as Partial<StoredConsentDraft<unknown>> | null;
  const valid = !!stored && typeof stored === 'object' && typeof stored.visitorId === 'string'
    && typeof stored.savedAt === 'number' && CONSENT_FORM_STEPS.includes(stored.step as ConsentFormStep)
    && isDraft(stored.base) && isDraft(stored.local) && Array.isArray(stored.sent) && stored.sent.every(isDraft);
  const savedAt = valid ? stored.savedAt as number : NaN;
  if (!valid || stored.visitorId !== visitorId || !(now - savedAt <= CONSENT_DRAFT_TTL_MS) || savedAt > now + 60_000) {
    clearConsentDraft();
    return null;
  }
  return stored as StoredConsentDraft<Draft>;
}

export function keepConsentDraft<Draft>(draft: StoredConsentDraft<Draft>): void {
  try { storage()?.setItem(KEY, JSON.stringify(draft)); } catch { /* The form still works; only a reload would lose it. */ }
}

export function clearConsentDraft(): void {
  try { storage()?.removeItem(KEY); } catch { /* Nothing kept, or nothing to clear. */ }
}
