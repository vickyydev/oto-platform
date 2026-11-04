import { useEffect, useState, type ReactNode } from 'react';
import { Calendar, Clock3, Hash, Loader2, MapPin, Phone, Users, Wand2, type LucideIcon } from 'lucide-react';
import { Dialog } from '@/components/Dialog';
import { Refusal } from '@/components/confirms';
import { countOf, type BookDateDraft } from '@/lib/beo';

const CANCEL =
  'rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60';
const INPUT =
  'w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-2.5 py-1.5 text-[13px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-slate-300 dark:focus:border-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-100 dark:focus:ring-amber-500/20';

/** What Save sends: the draft read into the route's fields. */
export interface BookDateValues {
  branchId: string;
  date: string;
  startTime: string;
  kids: number | null;
  adults: number | null;
  contactName: string;
  phone: string | null;
  childName: string | null;
  childAge: number | null;
}

/** The draft as the route takes it, or the first thing a person still has to fix. */
export function readDraft(d: BookDateDraft): { values: BookDateValues } | { problem: string } {
  if (!d.branchId) return { problem: 'Choose the park.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { problem: 'Choose the date.' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.startTime)) return { problem: 'Enter the start time as HH:MM.' };
  const kids = countOf(d.kids);
  const adults = countOf(d.adults);
  const age = countOf(d.childAge);
  if (Number.isNaN(kids) || (kids !== null && kids > 1000)) return { problem: 'Kids is a whole number.' };
  if (Number.isNaN(adults) || (adults !== null && adults > 1000)) return { problem: 'Adults is a whole number.' };
  if (Number.isNaN(age) || (age !== null && age > 30)) return { problem: 'The age is a whole number of years.' };
  if (!d.contactName.trim()) return { problem: 'Enter who is booking.' };
  return {
    values: {
      branchId: d.branchId,
      date: d.date,
      startTime: d.startTime,
      kids,
      adults,
      contactName: d.contactName.trim(),
      phone: d.phone.trim() || null,
      childName: d.childName.trim() || null,
      childAge: age,
    },
  };
}

function Field({
  icon: Icon,
  label,
  full = false,
  hint,
  children,
}: {
  icon: LucideIcon;
  label: string;
  full?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${full ? 'sm:col-span-2' : ''}`}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
        <Icon className="h-3 w-3 text-slate-400" /> {label}
      </span>
      {children}
      {hint}
    </label>
  );
}

/**
 * Book Date's confirm (SCRUM-775): the prototype's BEO modal pre-filled from
 * the chat (`BeoModal`, :2161-2252), cut to what the Events module's event
 * needs — the park, the date and time, the guests, who is booking and the
 * child — on the house Dialog. Save books a TENTATIVE birthday there; the
 * BEO itself is then the Events module's own form (Create BEO).
 *
 * The caller mints the event's id when the dialog opens and sends it on every
 * Save, so a second press, or a Save after a lost answer, is the same event.
 */
export function BookDateDialog({
  open,
  customer,
  initial,
  branches,
  busy,
  error,
  thenOpensBeo,
  onCancel,
  onSave,
}: {
  open: boolean;
  /** The contact's name, for the title. */
  customer: string;
  initial: BookDateDraft;
  branches: readonly { value: string; label: string }[];
  busy: boolean;
  /** The server's refusal, shown as it was said. */
  error: string | null;
  /** Opened from Create BEO: Save books the date, then opens the BEO form. */
  thenOpensBeo: boolean;
  onCancel: () => void;
  onSave: (values: BookDateValues) => void;
}) {
  const [draft, setDraft] = useState<BookDateDraft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  // A fresh reading each time it opens (another conversation, newer lines).
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setProblem(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof BookDateDraft>(k: K, v: BookDateDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    const read = readDraft(draft);
    if ('problem' in read) {
      setProblem(read.problem);
      return;
    }
    setProblem(null);
    onSave(read.values);
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      icon={Calendar}
      iconTint="bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400"
      title={`Book Date — ${customer}`}
      subtitle="Read from the conversation. Check it, then save: the date goes into the Events calendar as tentative."
      wide
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-amber-600 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calendar className="h-3.5 w-3.5" />}
            {thenOpensBeo ? 'Book date and open the BEO' : 'Book date'}
          </button>
        </>
      }
    >
      <div className="mb-3 inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-200 dark:ring-indigo-500/30">
        <Wand2 className="h-3 w-3" /> Read from the chat
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Field
          icon={Calendar}
          label="Date"
          hint={
            draft.dateFrom ? (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">The chat says “{draft.dateFrom}”</span>
            ) : (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">The chat names no date</span>
            )
          }
        >
          <input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} aria-label="Date" className={INPUT} />
        </Field>
        <Field icon={Clock3} label="Start time">
          <input
            type="time"
            value={draft.startTime}
            onChange={(e) => set('startTime', e.target.value)}
            aria-label="Start time"
            className={INPUT}
          />
        </Field>
        <Field icon={MapPin} label="Park" full>
          <select value={draft.branchId} onChange={(e) => set('branchId', e.target.value)} aria-label="Park" className={INPUT}>
            <option value="">Choose the park</option>
            {branches.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field icon={Hash} label="# of kids">
          <input inputMode="numeric" value={draft.kids} onChange={(e) => set('kids', e.target.value)} placeholder="0" aria-label="Kids" className={INPUT} />
        </Field>
        <Field icon={Hash} label="# of adults">
          <input inputMode="numeric" value={draft.adults} onChange={(e) => set('adults', e.target.value)} placeholder="0" aria-label="Adults" className={INPUT} />
        </Field>
        <Field icon={Users} label="Booking name">
          <input value={draft.contactName} onChange={(e) => set('contactName', e.target.value)} aria-label="Booking name" className={INPUT} />
        </Field>
        <Field icon={Phone} label="Phone">
          <input value={draft.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+66…" aria-label="Phone" className={INPUT} />
        </Field>
        <Field icon={Users} label="Child's name">
          <input value={draft.childName} onChange={(e) => set('childName', e.target.value)} placeholder="If the chat says it" aria-label="Child's name" className={INPUT} />
        </Field>
        <Field icon={Hash} label="Turning (age)">
          <input inputMode="numeric" value={draft.childAge} onChange={(e) => set('childAge', e.target.value)} placeholder="—" aria-label="Turning age" className={INPUT} />
        </Field>
      </div>
      {(problem ?? error) && <Refusal text={(problem ?? error)!} />}
    </Dialog>
  );
}
