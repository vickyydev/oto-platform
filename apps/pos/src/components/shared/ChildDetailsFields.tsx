import { AlertTriangle, Salad } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import type { ApiChild } from '@/api/platform';

/**
 * EVERY FIELD A SAVED CHILD CARRIES — SCRUM-231.
 *
 * The database has held all of this since Sprint 1 and no screen showed it: a
 * child on staging carried a medical alert and "No pork" in food restrictions
 * with nowhere in the POS to read either, let alone correct it. The confirm
 * step edited allergies and nothing else. These are the fields the park is
 * trusted with — what a child cannot eat, what a nanny has to watch for — and
 * holding them where nobody can read them is worse than not holding them.
 *
 * The shape is the prototype's, not invented here: a saved child
 * (`imports/oto-pos/artifacts/oto-till/src/types.ts` SavedChild, 98-114, and
 * `mockApi.ts` SavedChildInput, 750-758) carries name, date of birth,
 * allergies/medical, dietary, food restrictions and notes. So is the way it is
 * shown: the prototype's own capture form
 * (`components/shared/AttendeeFormFields.tsx` 137-234) puts the allergy in a
 * red AlertTriangle block with a switch over its detail and the dietary needs
 * in an amber Salad one, and "Food restrictions" is the label its check-in
 * editor uses (`components/dropoff/EditCheckInModal.tsx` 168).
 *
 * Two fields here are ours rather than the prototype's, because they are on
 * the table and not in the mock: the medical ALERT — the boolean a band and
 * the nanny board read — and the medical notes beside the allergy text
 * (`child.medical_alert` / `child.medical_notes`, CLAUDE.md §4). The alert
 * takes the place of the prototype's "has an allergy" switch, on the same
 * block, because that is the switch the saved record actually has.
 *
 * ONE component, used by the administrator's member dialog and by the till's
 * confirm-children step, because the prototype's hard rule for this form is
 * "no copy-paste duplication; one shared source of truth for the captured
 * shape" — two copies of a medical form is how a field ends up saved in one
 * place and dropped in the other.
 */

export interface ChildDetailsDraft {
  name: string;
  /** ISO YYYY-MM-DD; '' when the record has no date of birth. */
  dateOfBirth: string;
  /** Legacy numeric age for records captured before the DOB picker existed. */
  ageYears: number | null;
  allergies: string;
  medicalNotes: string;
  medicalAlert: boolean;
  dietary: string;
  foodRestrictions: string;
  notes: string;
}

/** The draft a child's saved record opens on. */
export function childDetailsDraft(c: ApiChild): ChildDetailsDraft {
  return {
    name: c.name,
    dateOfBirth: c.dateOfBirth ?? '',
    ageYears: c.ageYears,
    allergies: c.allergies ?? '',
    medicalNotes: c.medicalNotes ?? '',
    medicalAlert: c.medicalAlert,
    dietary: c.dietary ?? '',
    foodRestrictions: c.foodRestrictions ?? '',
    notes: c.notes ?? '',
  };
}

const TEXT_FIELDS = [
  'allergies',
  'medicalNotes',
  'dietary',
  'foodRestrictions',
  'notes',
] as const;

/** Trimmed, with an empty box meaning "nothing recorded" rather than "". */
const cleaned = (v: string): string | null => (v.trim() ? v.trim() : null);

/**
 * What actually changed, ready to PATCH — or null when nothing did.
 *
 * Only changed fields are sent. A PATCH that names a field sets it, so
 * re-sending the whole draft would overwrite a note another till wrote while
 * this dialog was open, and would fill the audit row's before/after with
 * fields nobody touched.
 */
export function childDetailsPatch(
  before: ChildDetailsDraft,
  after: ChildDetailsDraft,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const name = after.name.trim();
  if (name && name !== before.name.trim()) patch.name = name;
  if (after.dateOfBirth !== before.dateOfBirth) {
    patch.dateOfBirth = after.dateOfBirth || null;
    // The picker always yields a real date and the age it derives to today;
    // keeping the numeric column in step means a reader that predates DOB
    // (the box cache, a printed band) does not go stale.
    if (after.ageYears !== null) patch.ageYears = after.ageYears;
  }
  for (const key of TEXT_FIELDS) {
    if (cleaned(after[key]) !== cleaned(before[key])) patch[key] = cleaned(after[key]);
  }
  if (after.medicalAlert !== before.medicalAlert) patch.medicalAlert = after.medicalAlert;
  /**
   * When the patch carries an allergy and not the alert, the API derives the
   * alert from the text — which is what the counter wants when nobody touched
   * the switch, and wrong when somebody deliberately turned it off. Sending
   * the switch's own state alongside the allergy settles it here, where the
   * staff member's choice is visible on screen.
   */
  if (patch.allergies !== undefined && patch.medicalAlert === undefined) {
    patch.medicalAlert = after.medicalAlert;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** A one-line summary of what is recorded, for a collapsed child row. */
export function childDetailsSummary(draft: ChildDetailsDraft): string {
  const parts = [draft.allergies, draft.medicalNotes, draft.dietary, draft.foodRestrictions]
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.join(' · ');
}

export function ChildDetailsFields({
  draft,
  onChange,
  idPrefix,
  /** The name is fixed where a child is being re-confirmed rather than edited. */
  showName = true,
}: {
  draft: ChildDetailsDraft;
  onChange: (patch: Partial<ChildDetailsDraft>) => void;
  idPrefix: string;
  showName?: boolean;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {showName && (
          <div className="space-y-1.5">
            <Label htmlFor={id('name')}>Child's name</Label>
            <Input
              id={id('name')}
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Full name"
              autoComplete="off"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={id('age')}>Age</Label>
          <ChildDobPicker
            dateOfBirth={draft.dateOfBirth || undefined}
            age={draft.ageYears}
            childName={draft.name}
            onChange={({ dateOfBirth, age }) => onChange({ dateOfBirth, ageYears: age })}
            size="sm"
          />
        </div>
      </div>

      {/* Allergy / medical. The switch is the medical alert the band and the
          nanny board read, so it is shown where the prototype shows the
          allergy flag — on the block that holds the detail. */}
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={id('alert')} className="flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            Medical alert
          </Label>
          <Switch
            id={id('alert')}
            checked={draft.medicalAlert}
            onCheckedChange={(v) => onChange({ medicalAlert: v })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id('allergies')}>Allergies / medical</Label>
          <Textarea
            id={id('allergies')}
            value={draft.allergies}
            onChange={(e) => onChange({ allergies: e.target.value })}
            placeholder="Details (staff-only, shown on the bracelet)"
            rows={2}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id('medical-notes')}>Medical notes</Label>
          <Textarea
            id={id('medical-notes')}
            value={draft.medicalNotes}
            onChange={(e) => onChange({ medicalNotes: e.target.value })}
            placeholder="e.g. Inhaler in the blue bag"
            rows={2}
          />
        </div>
      </div>

      {/* Dietary. Two fields because a saved child carries two: what they eat
          by choice or belief, and what they must not be given. */}
      <div className="space-y-2 rounded-lg border p-3">
        <Label className="flex items-center gap-1.5">
          <Salad className="w-4 h-4 text-amber-400" />
          Dietary restriction
        </Label>
        <Textarea
          id={id('dietary')}
          value={draft.dietary}
          onChange={(e) => onChange({ dietary: e.target.value })}
          placeholder="e.g. Vegetarian — no meat or fish"
          rows={2}
        />
        <div className="space-y-1.5">
          <Label htmlFor={id('food')}>Food restrictions</Label>
          <Input
            id={id('food')}
            value={draft.foodRestrictions}
            onChange={(e) => onChange({ foodRestrictions: e.target.value })}
            placeholder="e.g. No pork"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={id('notes')}>Notes</Label>
        <Textarea
          id={id('notes')}
          value={draft.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="Anything staff should know"
          rows={2}
        />
      </div>
    </div>
  );
}
