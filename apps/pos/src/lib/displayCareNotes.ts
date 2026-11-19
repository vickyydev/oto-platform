import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import type { SavedChild } from '@/types';

/**
 * SCRUM-1020 — A SAVED CHILD'S CARE NOTES ON THE CUSTOMER DISPLAY.
 *
 * The owner's answer of 19 November: a saved child's allergy and medical
 * notes are shown to the parent on the customer display, and the parent may
 * update them there. Until now the display said "Saved on your profile, tell
 * the team if anything has changed" and only staff could open the notes.
 *
 * What the till does with it, pure, so the till and its tests read one copy:
 *
 *   - the drop-off and nanny form shows the family the note of each saved
 *     child in care, in the form's own "Allergies / medical" box (the
 *     record's allergy line, the one the band and the registration carry);
 *   - each change the family makes reaches the till as they type it, and the
 *     cashier is told what changed and from what;
 *   - an empty box never replaces a note that had text unless the family
 *     ticked that the child has no allergies or medical needs: without the
 *     tick the till keeps the note, and a tick taken back puts the profile's
 *     note back;
 *   - the change is written to the child's record when the form is written,
 *     on its own, with the customer display named on the audit row
 *     (`displayCareWrite`).
 *
 * Only the children of the family identified at this till are on the form;
 * nothing here adds one.
 */

/** The form shows the family this saved child's care notes: a saved child the form registers. */
export function careShownFor(slot: Pick<SupervisedSlot, 'savedChildId'>, needsConsent: boolean): boolean {
  return !!slot.savedChildId && needsConsent;
}

/** The note on the family's profile for the saved child in this place ('' when there is none). */
export function profileCareNote(
  slot: Pick<SupervisedSlot, 'savedChildId'>,
  savedChildren: readonly Pick<SavedChild, 'id' | 'allergiesMedical'>[],
): string {
  if (!slot.savedChildId) return '';
  return savedChildren.find((child) => child.id === slot.savedChildId)?.allergiesMedical ?? '';
}

/** SCRUM-1020 fix round — the medical notes on the family's profile for the saved child in this place. */
export function profileMedicalNote(
  slot: Pick<SupervisedSlot, 'savedChildId'>,
  savedChildren: readonly Pick<SavedChild, 'id' | 'medicalNotes'>[],
): string {
  if (!slot.savedChildId) return '';
  return savedChildren.find((child) => child.id === slot.savedChildId)?.medicalNotes ?? '';
}

/** The care notes as the family's screen sends them for one child. */
export interface FilledCare {
  allergiesMedical: string;
  allergiesNone?: boolean;
  /** SCRUM-1020 fix round — only where the form showed the medical notes. */
  medicalNotes?: string;
}

/**
 * SCRUM-1020 fix round — the medical notes, on the same rules as the allergy
 * line: text is the family's; an empty box replaces a note only with their
 * "none" tick; empty without it keeps the note; a tick taken back puts the
 * profile's note back.
 */
function displayMedicalPatch(
  slot: Pick<SupervisedSlot, 'medicalNotes' | 'careNoneConfirmed'>,
  filled: FilledCare,
  profileMedical: string,
): Partial<SupervisedSlot> | null {
  if (filled.medicalNotes === undefined) return null;
  const held = slot.medicalNotes ?? '';
  const typed = filled.medicalNotes.slice(0, 500);
  if (typed.trim()) return typed === held ? null : { medicalNotes: typed, careSource: 'display' };
  if (filled.allergiesNone) {
    if (!held.trim() && !profileMedical.trim()) return null;
    return held === '' ? null : { medicalNotes: '', careSource: 'display' };
  }
  if (slot.careNoneConfirmed && held !== profileMedical) return { medicalNotes: profileMedical };
  return null;
}

/**
 * What the till takes from the family's step for a saved child whose care
 * notes the form shows, or null when it takes nothing:
 *
 *   - text: the family's note, marked as theirs;
 *   - empty with their tick: no allergies or medical needs, on their word;
 *   - empty without it where the till holds a note: nothing, the note stays;
 *   - empty without it after a tick they gave: the tick is taken back, and
 *     the profile's note is what the place holds again.
 */
export function displayCarePatch(
  slot: Pick<SupervisedSlot, 'allergiesMedical' | 'careNoneConfirmed' | 'medicalNotes'>,
  filled: FilledCare,
  profileNote: string,
  profileMedical = '',
): Partial<SupervisedSlot> | null {
  const allergy = displayAllergyPatch(slot, filled, profileNote);
  const medical = displayMedicalPatch(slot, filled, profileMedical);
  if (!allergy && !medical) return null;
  const patch: Partial<SupervisedSlot> = { ...medical, ...allergy };
  // The family's "none" stands for whichever box it emptied: the allergy line
  // or the medical notes (the write then carries their word with it).
  const allergiesAfter = patch.allergiesMedical ?? slot.allergiesMedical;
  const medicalAfter = patch.medicalNotes ?? slot.medicalNotes ?? '';
  const none = filled.allergiesNone === true
    && (!allergiesAfter.trim() || (filled.medicalNotes !== undefined && !medicalAfter.trim()));
  return {
    ...patch,
    careNoneConfirmed: none,
    ...(allergy?.careSource === 'display' || medical?.careSource === 'display' ? { careSource: 'display' as const } : {}),
  };
}

function displayAllergyPatch(
  slot: Pick<SupervisedSlot, 'allergiesMedical' | 'careNoneConfirmed'>,
  filled: FilledCare,
  profileNote: string,
): Partial<SupervisedSlot> | null {
  const typed = filled.allergiesMedical.slice(0, 500);
  if (typed.trim()) {
    if (typed === slot.allergiesMedical && !slot.careNoneConfirmed) return null;
    return { allergiesMedical: typed, careNoneConfirmed: false, careSource: 'display' };
  }
  if (filled.allergiesNone) {
    if (slot.careNoneConfirmed && !slot.allergiesMedical.trim()) return null;
    if (!slot.allergiesMedical.trim() && !profileNote.trim()) return null;
    return { allergiesMedical: '', careNoneConfirmed: true, careSource: 'display' };
  }
  if (slot.careNoneConfirmed) return { allergiesMedical: profileNote, careNoneConfirmed: false, careSource: undefined };
  return null;
}

const quoted = (note: string) => `“${note.trim()}”`;

/**
 * What the cashier is told while the family changes a saved child's care
 * notes on the display, the way SCRUM-1014 tells them of a removal or a new
 * child; null when the place holds the profile's note. Staff's own English.
 */
export function displayCareLine(
  slot: Pick<SupervisedSlot, 'name' | 'allergiesMedical' | 'careSource' | 'careNoneConfirmed' | 'medicalNotes'>,
  profileNote: string,
  profileMedical = '',
): string | null {
  if (slot.careSource !== 'display') return null;
  const medicalChanged = slot.medicalNotes !== undefined && slot.medicalNotes.trim() !== profileMedical.trim();
  if (slot.allergiesMedical.trim() === profileNote.trim()) {
    if (!medicalChanged) return null;
    const who = slot.name.trim() || 'A child';
    const was = profileMedical.trim() ? `was ${quoted(profileMedical)}` : 'there was no note';
    return slot.medicalNotes!.trim()
      ? `The family updated ${who}'s medical notes on the customer display: now ${quoted(slot.medicalNotes!)} (${was}).`
      : `The family confirmed on the customer display that ${who} has no medical notes (${was}).`;
  }
  const who = slot.name.trim() || 'A child';
  const was = profileNote.trim() ? `was ${quoted(profileNote)}` : 'there was no note';
  if (!slot.allergiesMedical.trim()) {
    return `The family confirmed on the customer display that ${who} has no allergies or medical needs (${was}).`;
  }
  return `The family updated ${who}'s allergies / medical notes on the customer display: now ${quoted(slot.allergiesMedical)} (${was}).`;
}

/** What the till writes for a saved child's care notes the family changed on the display. */
export interface DisplayCare {
  allergies?: string | null;
  /** SCRUM-1020 fix round — the medical notes, when the family changed them. */
  medicalNotes?: string | null;
  confirmedNone?: true;
}

/**
 * The write of a saved child's changes, split: the care notes the family
 * changed on the display go on their own, so their audit row names the
 * customer display and nothing staff changed; the rest goes as before. With
 * no change of the family's in the patch, the whole patch is the rest.
 */
export function displayCareWrite(
  slot: Pick<SupervisedSlot, 'careSource' | 'careNoneConfirmed'>,
  patch: Record<string, unknown>,
): { care: DisplayCare | null; rest: Record<string, unknown> | null } {
  if (slot.careSource !== 'display' || !('allergies' in patch || 'medicalNotes' in patch)) return { care: null, rest: patch };
  const { allergies, medicalNotes, ...others } = patch;
  const textOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const care: DisplayCare = {
    ...('allergies' in patch ? { allergies: textOf(allergies) } : {}),
    ...('medicalNotes' in patch ? { medicalNotes: textOf(medicalNotes) } : {}),
  };
  const emptied = ('allergies' in patch && care.allergies === null) || ('medicalNotes' in patch && care.medicalNotes === null);
  if (emptied && slot.careNoneConfirmed) care.confirmedNone = true;
  return { care, rest: Object.keys(others).length > 0 ? others : null };
}
