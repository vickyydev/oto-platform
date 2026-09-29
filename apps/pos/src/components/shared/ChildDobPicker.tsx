import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  MAX_CHILD_AGE,
  MONTH_LABELS,
  ageFromDob,
  daysInMonth,
  dobFromPickedAge,
  formatDob,
} from '@/lib/childDob';
import { Cake, Calendar, Check, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ChildDobPickerProps {
  // Stored ISO date of birth (preferred source of truth). When present the
  // displayed age is derived against referenceDate when supplied, otherwise today.
  dateOfBirth?: string;
  // Fallback numeric age for legacy records that have no DOB yet.
  age?: number | null;
  // Emitted on confirm: a real DOB plus the age at the reference date (callers
  // keep their existing numeric-age field in sync from this).
  onChange: (next: { dateOfBirth: string; age: number }) => void;
  maxAge?: number;
  // Visual size of the trigger button.
  size?: 'sm' | 'md';
  className?: string;
  // Accessible label / placeholder when nothing is set yet.
  placeholder?: string;
  disabled?: boolean;
  // The child this picker edits — each picker is always for ONE child, so the
  // age prompt is singular. When a name is known it personalizes the question.
  childName?: string;
  // An independent display uses the staff-selected visit date, rather than its own clock.
  referenceDate?: string;
}

type Step = 'age' | 'month' | 'day' | 'confirm';

// The low-tap (3-tap) child date-of-birth picker — Age → Month → Day — with a
// confirm summary. No keyboard, no scrolling: every choice is a big touch target.
// One shared component reused at every child age-entry point in the till.
export function ChildDobPicker({
  dateOfBirth,
  age,
  onChange,
  maxAge = MAX_CHILD_AGE,
  size = 'md',
  className,
  placeholder = 'Tap to set age',
  disabled,
  childName,
  referenceDate,
}: ChildDobPickerProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('age');
  const [pickedAge, setPickedAge] = useState<number | null>(null);
  const [pickedMonth, setPickedMonth] = useState<number | null>(null);
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const asOf = useMemo(() => {
    if (!referenceDate) return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(referenceDate);
    if (!match) return undefined;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }, [referenceDate]);

  // The age shown on the trigger: derived from DOB when present, else the legacy
  // numeric age, else nothing.
  const displayAge = useMemo(() => {
    if (dateOfBirth) return ageFromDob(dateOfBirth, asOf);
    return age ?? null;
  }, [dateOfBirth, age, asOf]);

  // Seed the draft from the current value whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep('age');
    const m = dateOfBirth ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth) : null;
    if (m) {
      setPickedAge(ageFromDob(dateOfBirth!, asOf));
      setPickedMonth(Number(m[2]));
      setPickedDay(Number(m[3]));
    } else {
      setPickedAge(age ?? null);
      setPickedMonth(null);
      setPickedDay(null);
    }
  }, [open, dateOfBirth, age, asOf]);

  const handlePickAge = (a: number) => {
    setPickedAge(a);
    setStep('month');
  };
  const handlePickMonth = (mo: number) => {
    setPickedMonth(mo);
    // A day already chosen for a prior month may now be out of range — clamp it.
    if (pickedDay != null) {
      const maxD = daysInMonth(mo, (asOf ?? new Date()).getFullYear());
      if (pickedDay > maxD) setPickedDay(null);
    }
    setStep('day');
  };
  const handlePickDay = (d: number) => {
    setPickedDay(d);
    setStep('confirm');
  };

  const previewDob =
    pickedAge != null && pickedMonth != null && pickedDay != null
      ? dobFromPickedAge(pickedAge, pickedMonth, pickedDay, asOf)
      : null;
  const previewAge = previewDob ? ageFromDob(previewDob, asOf) : null;

  const handleConfirm = () => {
    if (!previewDob || previewAge == null) return;
    onChange({ dateOfBirth: previewDob, age: previewAge });
    setOpen(false);
  };

  // Keep the default non-leap grid. A public visit date supplies its calendar year;
  // dobFromPickedAge still clamps the day to the inferred birth-year length.
  const dayCount = pickedMonth ? daysInMonth(pickedMonth, asOf?.getFullYear() ?? 2025) : 31;

  const triggerSizing =
    size === 'sm' ? 'h-12 px-3 text-base' : 'h-14 px-4 text-xl';

  // Always singular — one picker, one child. Personalized when a name is known.
  const ageTitle = childName?.trim()
    ? `How old is ${childName.trim()}?`
    : 'How old is this child?';

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-xl border border-foreground/15 bg-foreground/5 font-semibold text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50',
          triggerSizing,
          className,
        )}
      >
        <Cake className="h-5 w-5 text-primary" />
        {displayAge != null ? (
          <span>
            {displayAge} <span className="text-foreground/50">yrs</span>
          </span>
        ) : (
          <span className="text-foreground/40">{placeholder}</span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 border-foreground/10 bg-background p-0">
          {/* Header + step breadcrumb (tap a completed step to re-pick). */}
          <div className="flex items-center gap-3 border-b border-foreground/10 px-5 py-4">
            {step !== 'age' && (
              <button
                type="button"
                onClick={() =>
                  setStep(step === 'confirm' ? 'day' : step === 'day' ? 'month' : 'age')
                }
                className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground/5 text-foreground/70 hover:bg-foreground/10"
                aria-label="Back"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div className="flex flex-1 flex-wrap items-center gap-1.5 text-sm font-semibold">
              <Crumb
                label={pickedAge != null ? `${pickedAge} yrs` : 'Age'}
                active={step === 'age'}
                done={pickedAge != null}
                onClick={() => setStep('age')}
              />
              <span className="text-foreground/30">›</span>
              <Crumb
                label={pickedMonth != null ? MONTH_LABELS[pickedMonth - 1] : 'Month'}
                active={step === 'month'}
                done={pickedMonth != null}
                onClick={() => pickedAge != null && setStep('month')}
              />
              <span className="text-foreground/30">›</span>
              <Crumb
                label={pickedDay != null ? String(pickedDay) : 'Day'}
                active={step === 'day'}
                done={pickedDay != null}
                onClick={() => pickedMonth != null && setStep('day')}
              />
            </div>
          </div>

          <div className="px-5 py-5">
            {step === 'age' && (
              <Section icon={Cake} title={ageTitle}>
                <div className="grid grid-cols-4 gap-2.5">
                  {Array.from({ length: maxAge + 1 }, (_, a) => a).map((a) => {
                    const prominent = a >= 2 && a <= 10;
                    return (
                      <GridButton
                        key={a}
                        selected={pickedAge === a}
                        prominent={prominent}
                        onClick={() => handlePickAge(a)}
                      >
                        {a}
                      </GridButton>
                    );
                  })}
                </div>
              </Section>
            )}

            {step === 'month' && (
              <Section icon={Calendar} title="Birthday month?">
                <div className="grid grid-cols-3 gap-2.5">
                  {MONTH_LABELS.map((label, i) => (
                    <GridButton
                      key={label}
                      selected={pickedMonth === i + 1}
                      prominent
                      onClick={() => handlePickMonth(i + 1)}
                    >
                      {label}
                    </GridButton>
                  ))}
                </div>
              </Section>
            )}

            {step === 'day' && (
              <Section icon={Calendar} title="Birthday day?">
                <div className="grid grid-cols-7 gap-1.5">
                  {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
                    <GridButton
                      key={d}
                      selected={pickedDay === d}
                      prominent
                      compact
                      onClick={() => handlePickDay(d)}
                    >
                      {d}
                    </GridButton>
                  ))}
                </div>
              </Section>
            )}

            {step === 'confirm' && previewDob && previewAge != null && (
              <div className="flex flex-col items-center gap-4 py-2 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Cake className="h-8 w-8" />
                </div>
                <div>
                  <div className="text-4xl font-black text-foreground">{previewAge} years old</div>
                  <div className="mt-1 text-lg text-foreground/60">
                    Born {formatDob(previewDob)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-4 text-xl font-bold text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="h-6 w-6" /> Confirm
                </button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Crumb({
  label,
  active,
  done,
  onClick,
}: {
  label: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!done && !active}
      className={cn(
        'rounded-full px-2.5 py-1 transition-colors',
        active
          ? 'bg-primary/20 text-primary'
          : done
            ? 'text-foreground/70 hover:bg-foreground/10'
            : 'text-foreground/30',
      )}
    >
      {label}
    </button>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Cake;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-center gap-2 text-lg font-bold text-foreground">
        <Icon className="h-5 w-5 text-primary" />
        {title}
      </div>
      {children}
    </div>
  );
}

function GridButton({
  children,
  selected,
  prominent,
  compact,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  prominent?: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center rounded-xl border font-bold transition-colors',
        compact ? 'h-11 text-base' : 'h-14 text-xl',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : prominent
            ? 'border-foreground/15 bg-foreground/10 text-foreground hover:border-primary/50 hover:bg-primary/10'
            : 'border-foreground/10 bg-foreground/5 text-foreground/55 hover:bg-foreground/10',
      )}
    >
      {children}
    </button>
  );
}
