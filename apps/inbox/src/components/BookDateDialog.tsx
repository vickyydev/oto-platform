import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Calendar, Check, Clock3, Hash, Loader2, MapPin, Phone, RefreshCw, Users, Wand2, type LucideIcon } from 'lucide-react';
import { Dialog } from '@/components/Dialog';
import { Refusal } from '@/components/confirms';
import type { BookDateProposal } from '@/api/inbox';
import {
  bookDateFetchLine,
  countOf,
  editBookDate,
  fetchBookDateProposal,
  freshBookDate,
  mergeBookDateProposal,
  pendingChoice,
  pickBookDateChoice,
  type BookDateDraft,
  type BookDateState,
  type FieldOption,
  type FieldSource,
  type ProposedField,
} from '@/lib/beo';

const CANCEL =
  'rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60';
/** "Fetch from chat" (SCRUM-826): the Cancel button's language, at the header row's size. */
const FETCH =
  'inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60';
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

/** "from the family" / "from the team": whose line the chat's words are. */
export function SourceMark({ source }: { source: FieldSource['source'] }) {
  if (!source) return null;
  return (
    <span className="ml-1 inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:text-slate-300">
      {source === 'team' ? 'from the team' : 'from the family'}
    </span>
  );
}

const HINT = 'text-[11px] text-slate-500 dark:text-slate-400';

/** The chat's own words for a value, and whose line they are. */
function Says({ text, source }: { text: string; source: FieldSource['source'] }) {
  return (
    <span className={HINT}>
      The chat says “{text}”
      <SourceMark source={source} />
    </span>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A reading's value as a person reads it: "Sat 21 Nov 2026", a park's name, the number. */
function shown(field: ProposedField, value: string, branches: readonly { value: string; label: string }[]): string {
  if (field === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return value;
    const day = new Date(`${value}T12:00:00Z`).getUTCDay();
    return `${DAYS[day] ?? ''} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}`.trim();
  }
  if (field === 'branchId') return branches.find((b) => b.value === value)?.label ?? 'The conversation’s park';
  return value;
}

/** Two readings of one field: the person picks one, or types their own. */
function Choice({
  field,
  options,
  branches,
  onPick,
}: {
  field: ProposedField;
  options: readonly FieldOption[];
  branches: readonly { value: string; label: string }[];
  onPick: (option: FieldOption) => void;
}) {
  return (
    <span className="flex flex-col gap-1" data-choice={field}>
      <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">The chat reads two ways: choose one</span>
      <span className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={`${o.by}-${o.value}`}
            type="button"
            onClick={() => onPick(o)}
            className="inline-flex max-w-full items-center gap-1 rounded-lg border border-amber-200 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-left text-[12px] text-slate-800 dark:text-slate-100 hover:bg-amber-100 dark:hover:bg-amber-500/20"
          >
            <span className="font-medium">{shown(field, o.value, branches)}</span>
            {o.text && <span className="truncate text-slate-500 dark:text-slate-400">“{o.text}”</span>}
            <SourceMark source={o.source} />
          </button>
        ))}
      </span>
    </span>
  );
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
  proposal = null,
  reading = false,
  onFetch,
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
  /**
   * SCRUM-821: the model's reading of the whole chat, once the api answers
   * (null while it reads, or when it could not). Merged into the fields the
   * person has not touched; `unavailable` changes nothing.
   */
  proposal?: BookDateProposal | null;
  /** The model is still reading the chat. */
  reading?: boolean;
  /**
   * SCRUM-826: "Fetch from chat" — the model's reading of the chat as it is
   * now (the same read as `proposal`), on a press. Fills only the fields the
   * person has not typed in; a typed field stays. Without it, no button.
   */
  onFetch?: () => Promise<BookDateProposal>;
}) {
  const branchIds = useMemo(() => branches.map((b) => b.value), [branches]);
  const [state, setState] = useState<BookDateState>(() => mergeBookDateProposal(freshBookDate(initial), proposal, branchIds));
  const [problem, setProblem] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  // A fresh reading each time it opens (another conversation, newer lines).
  useEffect(() => {
    if (open) {
      setState(mergeBookDateProposal(freshBookDate(initial), proposal, branchIds));
      setProblem(null);
      setFetching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // The model's reading, when it answers while the dialog is open.
  useEffect(() => {
    if (open && proposal) setState((s) => mergeBookDateProposal(s, proposal, branchIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);
  // SCRUM-826: the chat read again, as it is now, into the untouched fields.
  const fetchFromChat = async () => {
    if (!onFetch || fetching) return;
    setFetching(true);
    let answer: BookDateProposal | null = null;
    try {
      answer = await onFetch();
    } catch {
      answer = null;
    }
    // The fields as they are at the answer: what the person typed meanwhile is theirs too.
    setState((s) => fetchBookDateProposal(s, answer, branchIds));
    setFetching(false);
  };
  const draft = state.draft;
  const set = <K extends keyof BookDateDraft>(k: K, v: BookDateDraft[K]) => setState((s) => editBookDate(s, k, v));
  const pick = (field: ProposedField, option: FieldOption) => setState((s) => pickBookDateChoice(s, field, option));
  /** A field's line under it: the two readings to pick from, else the chat's words for its value. */
  const hint = (field: ProposedField, otherwise?: ReactNode): ReactNode => {
    const options = state.choices[field];
    if (options) return <Choice field={field} options={options} branches={branches} onPick={(o) => pick(field, o)} />;
    const source = state.sources[field];
    if (source) return <Says text={source.text} source={source.source} />;
    return otherwise;
  };

  const save = () => {
    const pending = pendingChoice(state);
    if (pending) {
      setProblem(pending);
      return;
    }
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-200 dark:ring-indigo-500/30">
          <Wand2 className="h-3 w-3" /> Read from the chat
        </span>
        {reading && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400" data-testid="book-date-reading">
            <Loader2 className="h-3 w-3 animate-spin" /> Reading the whole chat…
          </span>
        )}
        {!reading && proposal?.model === 'ai' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300" data-testid="book-date-read">
            <Check className="h-3 w-3" /> Read the whole chat
          </span>
        )}
        {onFetch && (
          <button
            type="button"
            onClick={() => void fetchFromChat()}
            disabled={busy || reading || fetching}
            className={FETCH}
            title="Read the chat again as it is now. What you typed here stays."
            data-testid="button-fetch-from-chat"
          >
            {fetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {fetching ? 'Fetching from the chat…' : 'Fetch from chat'}
          </button>
        )}
        {onFetch && !fetching && state.fetched && (
          <span className={HINT} data-testid="book-date-fetched">
            {bookDateFetchLine(state.fetched)}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Field
          icon={Calendar}
          label="Date"
          hint={hint(
            'date',
            draft.dateFrom ? <Says text={draft.dateFrom} source={null} /> : <span className={HINT}>The chat names no date</span>,
          )}
        >
          <input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} aria-label="Date" className={INPUT} />
        </Field>
        <Field
          icon={Clock3}
          label="Start time"
          hint={hint('startTime', draft.timeFrom ? <Says text={draft.timeFrom} source={null} /> : undefined)}
        >
          <input
            type="time"
            value={draft.startTime}
            onChange={(e) => set('startTime', e.target.value)}
            aria-label="Start time"
            className={INPUT}
          />
        </Field>
        <Field
          icon={MapPin}
          label="Park"
          full
          hint={hint('branchId', state.parkHint ? <Says text={state.parkHint.text} source={state.parkHint.source} /> : undefined)}
        >
          <select value={draft.branchId} onChange={(e) => set('branchId', e.target.value)} aria-label="Park" className={INPUT}>
            <option value="">Choose the park</option>
            {branches.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field icon={Hash} label="# of kids" hint={hint('kids')}>
          <input inputMode="numeric" value={draft.kids} onChange={(e) => set('kids', e.target.value)} placeholder={reading ? 'reading…' : '0'} aria-label="Kids" className={INPUT} />
        </Field>
        <Field icon={Hash} label="# of adults" hint={hint('adults')}>
          <input inputMode="numeric" value={draft.adults} onChange={(e) => set('adults', e.target.value)} placeholder={reading ? 'reading…' : '0'} aria-label="Adults" className={INPUT} />
        </Field>
        <Field icon={Users} label="Booking name">
          <input value={draft.contactName} onChange={(e) => set('contactName', e.target.value)} aria-label="Booking name" className={INPUT} />
        </Field>
        <Field icon={Phone} label="Phone">
          <input value={draft.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+66…" aria-label="Phone" className={INPUT} />
        </Field>
        <Field icon={Users} label="Child's name" hint={hint('childName')}>
          <input value={draft.childName} onChange={(e) => set('childName', e.target.value)} placeholder={reading ? 'reading…' : 'If the chat says it'} aria-label="Child's name" className={INPUT} />
        </Field>
        <Field icon={Hash} label="Turning (age)" hint={hint('childAge')}>
          <input inputMode="numeric" value={draft.childAge} onChange={(e) => set('childAge', e.target.value)} placeholder={reading ? 'reading…' : '—'} aria-label="Turning age" className={INPUT} />
        </Field>
      </div>
      {(problem ?? error) && <Refusal text={(problem ?? error)!} />}
    </Dialog>
  );
}
