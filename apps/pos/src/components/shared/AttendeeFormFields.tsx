import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { PhoneInput } from '@/components/shared/PhoneInput';
import type { NewEventAttendeeInput } from '@/mockApi';
import { AlertTriangle, Salad } from 'lucide-react';

// The editable attendee draft captured for an event pass / camp / event sign-up.
// Shared by the reception door modal (AddAttendeeModal) and the public booking
// site so both render ONE identical set of fields (app hard rule: no copy-paste
// duplication; one shared source of truth for the captured shape).
export interface AttendeeForm {
  name: string;
  age: string;
  // ISO YYYY-MM-DD captured via the low-tap picker; `age` is kept in sync from it.
  dateOfBirth?: string;
  language: string;
  parentName: string;
  parentPhone: string;
  emergencyContact: string;
  allergyFlag: boolean;
  allergyDetail: string;
  dietaryFlag: boolean;
  dietaryDetail: string;
  notes: string;
  parentAttending: boolean;
  registerProperly: boolean;
}

export const emptyAttendeeForm: AttendeeForm = {
  name: '',
  age: '',
  dateOfBirth: undefined,
  language: '',
  parentName: '',
  parentPhone: '',
  emergencyContact: '',
  allergyFlag: false,
  allergyDetail: '',
  dietaryFlag: false,
  dietaryDetail: '',
  notes: '',
  parentAttending: false,
  registerProperly: false,
};

export type SetAttendeeField = <K extends keyof AttendeeForm>(key: K, value: AttendeeForm[K]) => void;

// Build the captured attendee input the mockApi mutators expect from the form
// (id / attendanceDays / check-in state are derived by the mutator, not here).
export function buildAttendeeInput(form: AttendeeForm): NewEventAttendeeInput {
  const ageNum = form.age.trim() ? Number(form.age) : undefined;
  return {
    name: form.name.trim(),
    age: ageNum != null && !Number.isNaN(ageNum) ? ageNum : undefined,
    dateOfBirth: form.dateOfBirth,
    language: form.language.trim() || undefined,
    allergyFlag: form.allergyFlag,
    allergyDetail: form.allergyFlag ? form.allergyDetail.trim() || undefined : undefined,
    dietaryFlag: form.dietaryFlag,
    dietaryDetail: form.dietaryFlag ? form.dietaryDetail.trim() || undefined : undefined,
    notes: form.notes.trim() || undefined,
    parentName: form.parentName.trim(),
    parentPhone: form.parentPhone.trim() || undefined,
    emergencyContact: form.emergencyContact.trim() || undefined,
    parentAttending: form.parentAttending,
  };
}

// The minimum a sign-up needs to be persisted: a named child + named guardian.
export const attendeeFormValid = (form: AttendeeForm): boolean =>
  form.name.trim().length > 0 && form.parentName.trim().length > 0;

// Shared attendee fields. `idPrefix` keeps duplicated inputs (staff vs customer
// pane) from colliding on DOM ids. `showStaffControls` switches to operational
// wording + the camp full-range register toggle; `showParentAttending` (default
// = showStaffControls) shows the parent-band toggle on its own so the booking
// site can capture parentAttending without the staff-only camp register toggle.
export function AttendeeFormFields({
  form,
  set,
  isCamp,
  idPrefix,
  showStaffControls,
  showParentAttending = showStaffControls,
}: {
  form: AttendeeForm;
  set: SetAttendeeField;
  isCamp: boolean;
  idPrefix: string;
  showStaffControls: boolean;
  showParentAttending?: boolean;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="px-6 py-5 space-y-5">
      {/* Attendee */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={id('name')}>Child's name *</Label>
          <Input
            id={id('name')}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Full name"
            autoComplete="off"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={id('age')}>Age</Label>
            <ChildDobPicker
              dateOfBirth={form.dateOfBirth}
              age={form.age.trim() ? Number(form.age) : null}
              childName={form.name}
              onChange={({ dateOfBirth, age }) => {
                set('dateOfBirth', dateOfBirth);
                set('age', String(age));
              }}
              size="sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('lang')}>Language</Label>
            <Input
              id={id('lang')}
              value={form.language}
              onChange={(e) => set('language', e.target.value)}
              placeholder="e.g. Thai / English"
            />
          </div>
        </div>
      </div>

      {/* Allergy / medical */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={id('allergy')} className="flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            Allergy / medical note
          </Label>
          <Switch
            id={id('allergy')}
            checked={form.allergyFlag}
            onCheckedChange={(v) => set('allergyFlag', v)}
          />
        </div>
        {form.allergyFlag && (
          <Textarea
            value={form.allergyDetail}
            onChange={(e) => set('allergyDetail', e.target.value)}
            placeholder={
              showStaffControls
                ? 'Details (kept staff-only, shown on the bracelet)'
                : 'Tell us about any allergies or medical needs'
            }
            rows={2}
          />
        )}
      </div>

      {/* Dietary */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={id('diet')} className="flex items-center gap-1.5">
            <Salad className="w-4 h-4 text-amber-400" />
            Dietary restriction
          </Label>
          <Switch
            id={id('diet')}
            checked={form.dietaryFlag}
            onCheckedChange={(v) => set('dietaryFlag', v)}
          />
        </div>
        {form.dietaryFlag && (
          <Textarea
            value={form.dietaryDetail}
            onChange={(e) => set('dietaryDetail', e.target.value)}
            placeholder="e.g. Vegetarian — no meat or fish"
            rows={2}
          />
        )}
      </div>

      {/* Parent / guardian */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={id('parent')}>Parent / guardian *</Label>
          <Input
            id={id('parent')}
            value={form.parentName}
            onChange={(e) => set('parentName', e.target.value)}
            placeholder="Full name"
            autoComplete="off"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <PhoneInput
              value={form.parentPhone ?? ''}
              onChange={(v) => set('parentPhone', v)}
              label="Phone"
              translate={!showStaffControls}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('emergency')}>Emergency contact</Label>
            <Input
              id={id('emergency')}
              value={form.emergencyContact}
              onChange={(e) => set('emergencyContact', e.target.value)}
              placeholder="Name — phone"
            />
          </div>
        </div>
        {showParentAttending && (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <Label htmlFor={id('parent-attending')}>
              {showStaffControls ? 'Parent attending (print parent band)' : 'A parent is attending too'}
            </Label>
            <Switch
              id={id('parent-attending')}
              checked={form.parentAttending}
              onCheckedChange={(v) => set('parentAttending', v)}
            />
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor={id('notes')}>Notes</Label>
        <Textarea
          id={id('notes')}
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Anything staff should know"
          rows={2}
        />
      </div>

      {/* Add mode (camps only — events/parties are single-day). Operational, so
          staff-only. */}
      {isCamp && showStaffControls && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="min-w-0">
            <Label htmlFor={id('register')}>Also register for the full camp</Label>
            <p className="text-xs text-muted-foreground mt-1">
              On: added to every remaining camp day. Off: quick-add for today's session only.
            </p>
          </div>
          <Switch
            id={id('register')}
            checked={form.registerProperly}
            onCheckedChange={(v) => set('registerProperly', v)}
          />
        </div>
      )}
    </div>
  );
}
