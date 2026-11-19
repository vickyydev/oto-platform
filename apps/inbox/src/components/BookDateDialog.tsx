import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/Dialog';
import { Refusal } from '@/components/confirms';
import { BTN_FOOTER_MAIN, BTN_MAIN, BTN_QUIET, BTN_SMALL, FOCUS, HINT, INPUT, LABEL } from '@/components/ui';
import type { BookDateProposal, Prebooking } from '@/api/inbox';
import { newId } from '@oto/shared';
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
import { depositPaidCard, verifiedAt } from '@/lib/list-state';

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
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.startTime))
    return { problem: 'Enter the start time as HH:MM.' };
  const kids = countOf(d.kids);
  const adults = countOf(d.adults);
  const age = countOf(d.childAge);
  if (Number.isNaN(kids) || (kids !== null && kids > 1000))
    return { problem: 'Kids is a whole number.' };
  if (Number.isNaN(adults) || (adults !== null && adults > 1000))
    return { problem: 'Adults is a whole number.' };
  if (Number.isNaN(age) || (age !== null && age > 30))
    return { problem: 'The age is a whole number of years.' };
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
    <span className="ml-1 inline-flex items-center rounded-lg bg-band px-1.5 py-px text-[11px] font-medium text-ink-soft">
      {source === 'team' ? 'from the team' : 'from the family'}
    </span>
  );
}

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

/** "2026-11-21" as a person reads it: "Sat 21 Nov 2026". */
function dayOf(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const day = new Date(`${value}T12:00:00Z`).getUTCDay();
  return `${DAYS[day] ?? ''} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}`.trim();
}

/** A reading's value as a person reads it: "Sat 21 Nov 2026", a park's name, the number. */
function shown(
  field: ProposedField,
  value: string,
  branches: readonly { value: string; label: string }[],
): string {
  if (field === 'date') return dayOf(value);
  if (field === 'branchId')
    return branches.find((b) => b.value === value)?.label ?? 'The conversation’s park';
  return value;
}

/**
 * What Save says (SCRUM-1016, BookDate.dc.html "Book Sat 20 Dec, 14:00"): the
 * day and the time it will book, with the year so a booking is never made
 * for the wrong one; "Book the date" until a date is chosen. Opened from
 * Create BEO, it says the BEO opens after.
 */
export function bookDateSaveLabel(draft: Pick<BookDateDraft, 'date' | 'startTime'>, thenOpensBeo: boolean): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(draft.date) ? dayOf(draft.date) : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.startTime) ? draft.startTime : null;
  const what = date ? `Book ${date}${time ? `, ${time}` : ''}` : 'Book the date';
  return thenOpensBeo ? `${what} and open the BEO` : what;
}

/** The plain question over two readings of one field (BookDate.dc.html "Which start time is right?"). */
const CHOICE_QUESTION: Record<ProposedField, string> = {
  date: 'Which date is right?',
  startTime: 'Which start time is right?',
  branchId: 'Which park is right?',
  kids: 'How many children?',
  adults: 'How many adults?',
  childName: 'What is the birthday child’s name?',
  childAge: 'Which age is the child turning?',
};

/**
 * Two readings of one field, asked plainly with both options under the
 * fields they belong to: the person picks one, or types their own in the
 * field above. `data-choice` names the field for the tests.
 */
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
    <fieldset
      data-choice={field}
      className="col-span-2 m-0 flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-ask-line bg-ask px-3 pb-3 pt-1"
    >
      <legend className="px-1 text-[13px] font-bold text-ask-ink">{CHOICE_QUESTION[field]}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => (
          <button
            key={`${o.by}-${o.value}`}
            type="button"
            onClick={() => onPick(o)}
            className={`flex min-h-12 min-w-0 flex-col items-center justify-center rounded-xl border border-field bg-card px-2 py-1.5 text-center text-ink hover:border-ink ${FOCUS}`}
          >
            <span className="max-w-full truncate text-[14px] font-bold">{shown(field, o.value, branches)}</span>
            <span className="max-w-full truncate text-[11.5px] font-medium text-ink-soft">
              {o.text ? `“${o.text}” · ` : ''}
              {o.source === 'team' ? 'from the team' : o.source === 'family' ? 'from the family' : 'from the chat'}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A field as BookDate.dc.html draws it: its label over a 48 px box, the
 * chat's words under it. A field the chat reads two ways wears the amber
 * edge and says so; the question itself is asked below the row.
 */
function Field({
  label,
  full = false,
  hint,
  children,
}: {
  label: string;
  full?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${full ? 'col-span-2' : ''}`}>
      <span className={LABEL}>{label}</span>
      {children}
      {hint}
    </label>
  );
}

/** A field's box, with the amber edge while the chat reads it two ways. */
const boxOf = (twoWays: boolean): string => (twoWays ? INPUT.replace('border border-field', 'border-2 border-ask-edge') : INPUT);

/**
 * Book Date's confirm (SCRUM-775): the prototype's BEO modal pre-filled from
 * the chat (`BeoModal`, :2161-2252), cut to what the Events module's event
 * needs — the park, the date and time, the guests, who is booking and the
 * child — on the house Dialog. Save books a TENTATIVE birthday there; the
 * BEO itself is then the Events module's own form (Create BEO).
 *
 * Laid out as BookDate.dc.html (SCRUM-1016): the deposit first, then the
 * line that the fields were filled in from the chat, then large fields, and
 * where the chat reads a field two ways the question asked plainly with both
 * options before Save; Save names the day and time it books.
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
  onReadDeposit,
  onRequestDeposit,
  initialDeposit = null,
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
  onReadDeposit?: () => Promise<Prebooking>;
  onRequestDeposit?: (
    values: BookDateValues,
    amountSatang: number,
    requestId: string,
  ) => Promise<Prebooking>;
  /** A server-read receipt supplied by a containing view, otherwise fetched on opening. */
  initialDeposit?: Prebooking['draft'];
}) {
  const branchIds = useMemo(() => branches.map((b) => b.value), [branches]);
  const [state, setState] = useState<BookDateState>(() =>
    mergeBookDateProposal(freshBookDate(initial), proposal, branchIds),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [deposit, setDeposit] = useState<Prebooking['draft']>(initialDeposit);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositBusy, setDepositBusy] = useState(false);
  const depositRequestId = useRef(newId());
  const depositOpening = useRef(0);
  useEffect(() => {
    const asked = ++depositOpening.current;
    if (!open) return;
    setDeposit(initialDeposit);
    setDepositAmount(initialDeposit ? String(initialDeposit.amountSatang / 100) : '');
    depositRequestId.current = newId();
    if (!onReadDeposit) return;
    setDepositBusy(true);
    void onReadDeposit()
      .then((answer) => {
        if (asked !== depositOpening.current) return;
        setDeposit(answer.draft);
        if (answer.draft) {
          const b = answer.draft.booking;
          setDepositAmount(String(answer.draft.amountSatang / 100));
          setState(
            freshBookDate({
              ...initial,
              date: b.date,
              dateFrom: '',
              startTime: b.startTime,
              timeFrom: '',
              branchId: b.branchId,
              kids: b.kids === null ? '' : String(b.kids),
              adults: b.adults === null ? '' : String(b.adults),
              contactName: b.contactName,
              phone: b.phone ?? '',
              childName: b.childName ?? '',
              childAge: b.childAge === null ? '' : String(b.childAge),
            }),
          );
        }
      })
      .catch((err: unknown) => {
        if (asked === depositOpening.current)
          setProblem(err instanceof Error ? err.message : 'The deposit could not be read.');
      })
      .finally(() => {
        if (asked === depositOpening.current) setDepositBusy(false);
      });
    // An opening owns its asynchronous answer; parent callbacks change on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const refreshDeposit = async () => {
    if (!onReadDeposit || depositBusy) return;
    const asked = depositOpening.current;
    setDepositBusy(true);
    try {
      const answer = await onReadDeposit();
      if (asked === depositOpening.current) setDeposit(answer.draft);
    } catch (err) {
      if (asked === depositOpening.current)
        setProblem(err instanceof Error ? err.message : 'The deposit could not be read.');
    } finally {
      if (asked === depositOpening.current) setDepositBusy(false);
    }
  };
  // Which opening of the dialog this is: the panel keeps it mounted across
  // birthday conversations, so a fetch's answer is taken only by the opening
  // that asked for it (a Cancel and another family's Book Date in between
  // would otherwise take the first family's reading).
  const opening = useRef(0);
  // A fresh reading each time it opens (another conversation, newer lines).
  useEffect(() => {
    opening.current += 1;
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
    const asked = opening.current;
    setFetching(true);
    let answer: BookDateProposal | null = null;
    try {
      answer = await onFetch();
    } catch {
      answer = null;
    }
    // Closed, or opened again (for another conversation, perhaps) while the
    // chat was read: that answer is not this opening's, and changes nothing.
    if (opening.current !== asked) return;
    // The fields as they are at the answer: what the person typed meanwhile is theirs too.
    setState((s) => fetchBookDateProposal(s, answer, branchIds));
    setFetching(false);
  };
  const draft = state.draft;
  const set = <K extends keyof BookDateDraft>(k: K, v: BookDateDraft[K]) =>
    setState((s) => editBookDate(s, k, v));
  const pick = (field: ProposedField, option: FieldOption) =>
    setState((s) => pickBookDateChoice(s, field, option));
  /**
   * A field's line under it: that the chat reads it two ways (the question is
   * asked under the row, `choiceFor`), else the chat's words for its value.
   */
  const hint = (field: ProposedField, otherwise?: ReactNode): ReactNode => {
    if (state.choices[field])
      return <span className="text-[12px] font-semibold text-ask-ink">The chat reads two ways: choose one</span>;
    const source = state.sources[field];
    if (source) return <Says text={source.text} source={source.source} />;
    return otherwise;
  };

  // SCRUM-955: while a field is read two ways and the person has neither
  // picked a reading nor typed their own, Save waits, and says for what.
  const waiting = pendingChoice(state);
  const depositPaid = deposit?.state === 'paid' && deposit.booking.branchId === draft.branchId;
  const requestDeposit = async () => {
    if (!onRequestDeposit || depositBusy || waiting) return;
    const read = readDraft(draft);
    if ('problem' in read) {
      setProblem(read.problem);
      return;
    }
    const baht = Number(depositAmount);
    if (!Number.isSafeInteger(baht) || baht <= 0 || baht > 1_000_000) {
      setProblem('Enter the agreed deposit in whole baht.');
      return;
    }
    const asked = depositOpening.current;
    setDepositBusy(true);
    setProblem(null);
    try {
      const answer = await onRequestDeposit(read.values, baht * 100, depositRequestId.current);
      if (asked !== depositOpening.current) return;
      setDeposit(answer.draft);
      if (answer.draft?.state === 'expired' || answer.draft?.state === 'failed')
        depositRequestId.current = newId();
    } catch (err) {
      if (asked === depositOpening.current)
        setProblem(err instanceof Error ? err.message : 'The deposit could not be requested.');
    } finally {
      if (asked === depositOpening.current) setDepositBusy(false);
    }
  };
  const save = () => {
    if (!depositPaid) {
      setProblem(
        'Request the full agreed deposit and wait for gateway verification before booking.',
      );
      return;
    }
    if (waiting) {
      setProblem(waiting);
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


  const branchName = (id: string) => branches.find((b) => b.value === id)?.label ?? 'another park';
  /** The question over a field's two readings, under the row it belongs to. */
  const choiceFor = (field: ProposedField): ReactNode => {
    const options = state.choices[field];
    return options ? (
      <Choice key={`choice-${field}`} field={field} options={options} branches={branches} onPick={(o) => pick(field, o)} />
    ) : null;
  };
  const twoWays = (field: ProposedField) => Boolean(state.choices[field]);
  const paidCard = deposit?.state === 'paid' ? depositPaidCard(deposit, 'paid') : null;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Book the date"
      subtitle={`${customer} · birthday party`}
      closeLabel="Close without booking"
      wide
      footer={
        <>
          {waiting && (
            <span
              className={`min-w-0 basis-full self-center text-[12.5px] font-semibold text-ask-ink md:flex-1 md:basis-auto`}
              data-testid="book-date-waiting"
            >
              {waiting}
            </span>
          )}
          <button type="button" onClick={onCancel} disabled={busy} className={BTN_QUIET}>
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || depositBusy || waiting !== null || !depositPaid}
            data-testid="book-date-save"
            className={`${BTN_FOOTER_MAIN} text-center leading-tight`}
          >
            {busy && <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" />}
            {bookDateSaveLabel(draft, thenOpensBeo)}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {/* The deposit first (BookDate.dc.html): paid and verified on the green ground, else where it stands and what may be done. */}
        <section
          aria-label="Deposit"
          data-testid="prebooking-deposit"
          className={`flex flex-col gap-2 rounded-[14px] border px-3 py-2.5 text-[13.5px] ${
            paidCard
              ? 'border-money-line bg-money text-money-ink'
              : deposit?.state === 'needs_review'
                ? 'border-needs bg-needs text-needs-ink'
                : 'border-line bg-card text-ink'
          }`}
        >
          {deposit?.simulator && (
            <p className="font-semibold">Simulator test payment: no real bank deposit has been received.</p>
          )}
          {paidCard ? (
            <p className="flex items-start gap-2.5">
              <CheckCircle2 aria-hidden className="mt-px h-5 w-5 shrink-0" />
              <span className="min-w-0">
                <strong className="font-bold">{paidCard.title}</strong>
                {deposit?.paidAt ? ` · verified ${verifiedAt(deposit.paidAt)}` : ''}
                <span className="block">Full deposit: Gateway verified — check park capacity before booking.</span>
                {!depositPaid && deposit && (
                  <span className="block font-semibold">
                    Paid for {branchName(deposit.booking.branchId)}: booking unlocks at that park only.
                  </span>
                )}
              </span>
            </p>
          ) : (
            <>
              {!onRequestDeposit && (
                <p>A manager requests the agreed deposit. The birthdays team can book after gateway verification.</p>
              )}
              <p>
                Full deposit:{' '}
                {deposit?.state === 'needs_review'
                  ? 'Payment needs staff resolution. No booking has been created.'
                  : deposit?.state === 'expired' || deposit?.state === 'failed'
                    ? 'The payment request ended unpaid. Request a new link.'
                    : 'Gateway verification required. A payment slip or staff receipt does not unlock booking.'}
              </p>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className={LABEL}>Agreed deposit (฿)</span>
                <input
                  aria-label="Agreed deposit (baht)"
                  inputMode="numeric"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  disabled={deposit !== null || depositBusy || !onRequestDeposit}
                  className={`${INPUT} max-w-[14rem]`}
                />
              </label>
            </>
          )}
          {((onRequestDeposit && !paidCard) || onReadDeposit || deposit?.paymentLink) && (
            <div className="flex flex-wrap items-center gap-2">
              {onRequestDeposit && !paidCard && (
                <button
                  type="button"
                  className={BTN_MAIN}
                  onClick={() => void requestDeposit()}
                  disabled={
                    busy ||
                    depositBusy ||
                    waiting !== null ||
                    deposit?.state === 'paid' ||
                    deposit?.state === 'needs_review'
                  }
                >
                  Request deposit
                </button>
              )}
              {onReadDeposit && (
                <button
                  type="button"
                  className={BTN_SMALL}
                  onClick={() => void refreshDeposit()}
                  disabled={busy || depositBusy}
                >
                  {depositBusy && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                  Check payment
                </button>
              )}
              {deposit?.paymentLink && (
                <a
                  href={deposit.paymentLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 font-semibold text-coral-ink underline underline-offset-2 md:min-h-8 ${FOCUS}`}
                >
                  Open payment page
                  <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          )}
        </section>

        {/* Filled in from the chat (SCRUM-821, 826): how the fields were read, and the way to read it again. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-teal">
            {reading ? (
              <span className="inline-flex items-center gap-2" data-testid="book-date-reading">
                <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> Reading the whole chat…
              </span>
            ) : (
              <>
                <Sparkles aria-hidden className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  {proposal?.model === 'ai' && (
                    <span className="font-semibold" data-testid="book-date-read">
                      Read the whole chat.{' '}
                    </span>
                  )}
                  Filled in from the chat. Check each line before you book.
                </span>
              </>
            )}
          </p>
          {onFetch && (
            <button
              type="button"
              onClick={() => void fetchFromChat()}
              disabled={busy || reading || fetching}
              className={BTN_SMALL}
              title="Read the chat again as it is now. What you typed here stays."
              data-testid="button-fetch-from-chat"
            >
              {fetching ? (
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              )}
              {fetching ? 'Fetching from the chat…' : 'Fetch from chat'}
            </button>
          )}
          {onFetch && !fetching && state.fetched && (
            <span className={`${HINT} basis-full`} data-testid="book-date-fetched">
              {bookDateFetchLine(state.fetched)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          <Field
            label="Date"
            hint={hint(
              'date',
              draft.dateFrom ? (
                <Says text={draft.dateFrom} source={null} />
              ) : (
                <span className={HINT}>The chat names no date</span>
              ),
            )}
          >
            <input
              type="date"
              value={draft.date}
              onChange={(e) => set('date', e.target.value)}
              aria-label="Date"
              className={boxOf(twoWays('date'))}
            />
          </Field>
          <Field
            label="Start time"
            hint={hint(
              'startTime',
              draft.timeFrom ? (
                <Says text={draft.timeFrom} source={null} />
              ) : draft.startTime ? undefined : (
                <span className={HINT}>The chat names no start time</span>
              ),
            )}
          >
            <input
              type="time"
              value={draft.startTime}
              onChange={(e) => set('startTime', e.target.value)}
              aria-label="Start time"
              className={boxOf(twoWays('startTime'))}
            />
          </Field>
          {choiceFor('date')}
          {choiceFor('startTime')}
          <Field
            label="Park"
            full
            hint={hint(
              'branchId',
              state.parkHint ? <Says text={state.parkHint.text} source={state.parkHint.source} /> : undefined,
            )}
          >
            <select
              value={draft.branchId}
              onChange={(e) => set('branchId', e.target.value)}
              aria-label="Park"
              className={boxOf(twoWays('branchId'))}
            >
              <option value="">Choose the park</option>
              {branches.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
          {choiceFor('branchId')}
          {/* SCRUM-955: an empty count shows the window's dash (as the age does), never a 0 that reads as none. */}
          <Field label="Children" hint={hint('kids')}>
            <input
              inputMode="numeric"
              value={draft.kids}
              onChange={(e) => set('kids', e.target.value)}
              placeholder={reading ? 'reading…' : '—'}
              aria-label="Children"
              className={boxOf(twoWays('kids'))}
            />
          </Field>
          <Field label="Adults" hint={hint('adults')}>
            <input
              inputMode="numeric"
              value={draft.adults}
              onChange={(e) => set('adults', e.target.value)}
              placeholder={reading ? 'reading…' : '—'}
              aria-label="Adults"
              className={boxOf(twoWays('adults'))}
            />
          </Field>
          {choiceFor('kids')}
          {choiceFor('adults')}
          <Field label="Birthday child" hint={hint('childName')}>
            <input
              value={draft.childName}
              onChange={(e) => set('childName', e.target.value)}
              placeholder={reading ? 'reading…' : 'If the chat says it'}
              aria-label="Birthday child"
              className={boxOf(twoWays('childName'))}
            />
          </Field>
          <Field label="Turning" hint={hint('childAge')}>
            <input
              inputMode="numeric"
              value={draft.childAge}
              onChange={(e) => set('childAge', e.target.value)}
              placeholder={reading ? 'reading…' : '—'}
              aria-label="Turning"
              className={boxOf(twoWays('childAge'))}
            />
          </Field>
          {choiceFor('childName')}
          {choiceFor('childAge')}
          <Field label="Booking name">
            <input
              value={draft.contactName}
              onChange={(e) => set('contactName', e.target.value)}
              aria-label="Booking name"
              className={INPUT}
            />
          </Field>
          <Field label="Phone">
            <input
              value={draft.phone}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="+66…"
              aria-label="Phone"
              inputMode="tel"
              className={INPUT}
            />
          </Field>
        </div>

        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Booking puts the party in the Events calendar as tentative; a draft reserves no date. Payment never
          creates the booking automatically. If the date cannot be accommodated, staff must resolve the paid deposit
          with the family.
        </p>
        {(problem ?? error) && <Refusal text={(problem ?? error)!} />}
      </div>
    </Dialog>
  );
}
