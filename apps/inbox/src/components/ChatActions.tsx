// THE CHAT'S PARTS (SCRUM-1016): what People and actions is built from — a
// sheet on a phone and a tablet (ChatActions.dc.html), the right panel on a
// desktop (Desktop.dc.html) — and the paid deposit's next-step card
// (ChatPaid.dc.html). Presentational only: `ChatPanel` holds every rule (who
// may press what, the confirmations, the api calls) and hands the outcome in.
import type { ReactNode } from 'react';
import { Calendar, CheckCircle2, ChevronRight, Loader2, X } from 'lucide-react';
import type { ConversationDetail, ConversationRow } from '@/api/inbox';
import { sourceLabel } from '@/lib/inboxes';
import { FOCUS_WITHIN } from '@/components/ui';
import type { DepositPaidCard } from '@/lib/list-state';
import { CATEGORY_LABEL, CHANNEL_LABEL, bubbleTime, contactName, handleLabel, langLabel, type Chip } from '@/lib/view';

/** What a manager sees beside the support places (test night U7): they are a manager's to fill. */
export const MANAGERS_ADD_SUPPORT = 'Managers add support';

/** A heading over one group of People and actions, and its card. */
export function ActionSection({ title, children, card = true }: { title: string; children: ReactNode; card?: boolean }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-[13px] font-bold text-ink-soft">{title}</h3>
      {card ? <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-card">{children}</div> : children}
    </section>
  );
}

/**
 * One line of a card: a label, its value, and what may be done with it; a
 * rule above every line but the first. `stacked` sets the label over its
 * value, for the desktop's narrow right panel (Desktop.dc.html), where a
 * label column beside the value left the value a few letters wide.
 */
export function ActionRow({
  label,
  children,
  action,
  title,
  stacked = false,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
  title?: string;
  stacked?: boolean;
}) {
  return (
    <div title={title} className={`relative flex min-h-[52px] items-center gap-3 border-t border-line-soft py-1 pl-3.5 pr-2 first:border-t-0 ${ROW_FOCUS}`}>
      {stacked ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5">
          <span className="text-[12.5px] text-ink-muted">{label}</span>
          <span className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink">{children}</span>
        </span>
      ) : (
        <>
          <span className="w-20 shrink-0 text-[13.5px] text-ink-muted">{label}</span>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[14.5px] font-semibold text-ink">{children}</span>
        </>
      )}
      {action}
    </div>
  );
}

/**
 * A row whose choice is a native select laid over it (`SelectOver` with
 * `cover`): the select is invisible, so the row wears the focus ring while
 * the select holds keyboard focus (SCRUM-1016, inventory §7 item 22).
 */
const ROW_FOCUS =
  'has-[select:focus-visible]:rounded-xl has-[select:focus-visible]:outline-2 has-[select:focus-visible]:-outline-offset-2 has-[select:focus-visible]:outline-coral';

/** A person's round face on their chip's tint (ChatActions.dc.html, 32 px). */
export function PersonFace({ chip }: { chip: Chip }) {
  return (
    <span
      aria-hidden
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold ${chip.tint}`}
    >
      {chip.initials}
    </span>
  );
}

/**
 * A person on the conversation: their face, their name, their place on it,
 * and what may be done. `stacked` (the desktop's right panel) puts the action
 * words on their own line under the name, so neither the name nor the words
 * are squeezed into the panel's width; the role keeps one line there.
 */
export function PersonRow({
  chip,
  role,
  children,
  stacked = false,
}: {
  chip: Chip;
  role: string;
  children?: ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="flex items-start gap-3 border-t border-line-soft py-2.5 pl-3.5 pr-2 first:border-t-0" data-person-row="stacked">
        <PersonFace chip={chip} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span title={chip.name} className="truncate text-[14.5px] font-semibold text-ink">{chip.name}</span>
          <span title={role} className="truncate text-[12.5px] text-ink-muted">{role}</span>
          {/* The words' own padding lines their text up with the name above them. */}
          {children && <span className="-ml-3 mt-0.5 flex flex-wrap items-center">{children}</span>}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-h-14 items-center gap-3 border-t border-line-soft py-1.5 pl-3.5 pr-2 first:border-t-0">
      <PersonFace chip={chip} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14.5px] font-semibold text-ink">{chip.name}</span>
        <span className="text-[12.5px] text-ink-muted">{role}</span>
      </span>
      {children}
    </div>
  );
}

/** The coral word of an action in a card ("Change", "Remove", "Resume"): 44 px tall. */
export const ACTION_WORD =
  'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[14px] font-semibold text-coral-ink hover:bg-wash disabled:opacity-60';

/**
 * A choice behind a word (the prototype's pickers, a native select laid over
 * the badge, :950-958): the visible part is `children`, the select covers it,
 * so the phone's own list opens and the accessible name is the select's.
 * `cover` lays the select over the whole row it sits in (an `ActionRow`), so
 * the row is the target, as ChatActions.dc.html draws it. The select is
 * invisible, so the part a person sees wears the focus ring for it.
 */
export function SelectOver({
  label,
  value,
  disabled,
  onChange,
  children,
  options,
  className = ACTION_WORD,
  cover = false,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
  options: ReactNode;
  className?: string;
  cover?: boolean;
}) {
  return (
    <span className={`${cover ? '' : `relative ${FOCUS_WITHIN} `}${className}`}>
      {children}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-pointer rounded-[inherit] opacity-0 disabled:cursor-wait"
      >
        {options}
      </select>
    </span>
  );
}

/** A chevron after a row's value: the row opens a choice. */
export function RowChevron() {
  return <ChevronRight aria-hidden className="h-[18px] w-[18px] shrink-0 text-ink-muted" />;
}

/**
 * The paid deposit's next step (SCRUM-996, laid out as ChatPaid.dc.html):
 * the amount and the gateway's verification on the green ground, Book the
 * date as the one main button and Create BEO beside it. Only ever handed in
 * for a person who may book; `data-testid="deposit-paid-line"` is on the part
 * that carries the amount and the time.
 */
export function NextStepCard({
  card,
  busy,
  beoBusy,
  onBook,
  onBeo,
  stacked = false,
  className = '',
}: {
  card: DepositPaidCard;
  busy: boolean;
  beoBusy: boolean;
  onBook: () => void;
  onBeo: () => void;
  /** The desktop panel stacks the two buttons; the chat sets them side by side. */
  stacked?: boolean;
  className?: string;
}) {
  return (
    <section aria-label="Next step" className={`flex flex-col gap-3 rounded-2xl border border-money-line bg-money p-3.5 ${className}`}>
      <div className="flex items-start gap-2.5 text-money-ink" data-testid="deposit-paid-line">
        <CheckCircle2 aria-hidden className="mt-px h-[22px] w-[22px] shrink-0" />
        <span className="flex min-w-0 flex-col gap-0.5">
          {/* The spaces keep the words apart for a screen reader; the column sets them on their own lines. */}
          {card.simulator && (
            <>
              <span className="text-[12.5px] font-semibold">{card.simulator}</span>{' '}
            </>
          )}
          <span className="text-[15px] font-bold">{card.title}</span>{' '}
          <span className="text-[13px]">{card.detail}</span>
        </span>
      </div>
      <div className={stacked ? 'flex flex-col gap-2' : 'grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2'}>
        <button
          type="button"
          onClick={onBook}
          disabled={busy}
          title="Block this date in the Events calendar"
          className="inline-flex h-[46px] items-center justify-center gap-2 rounded-[13px] bg-coral px-3 text-[15px] font-bold text-on-coral hover:bg-coral/90 disabled:opacity-60"
        >
          <Calendar aria-hidden className="h-[18px] w-[18px]" />
          Book the date
        </button>
        <button
          type="button"
          onClick={onBeo}
          disabled={busy}
          title="Book the date, then open its BEO in the OTO App"
          className={`${SECONDARY_BUTTON} h-[46px]`}
        >
          {beoBusy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
          Create BEO
        </button>
      </div>
    </section>
  );
}

/** An outlined button on the card (Create BEO, Mark as handled on a desktop): the edge token, the ink. */
export const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-[13px] border border-edge bg-card px-3 text-[14.5px] font-semibold text-ink hover:bg-wash disabled:opacity-60';

/** What an action did, or why it could not (test night U6, U9): the green note and the red refusal, each dismissable. */
export function ActionFeedback({
  error,
  note,
  onDismissError,
  onDismissNote,
  className = '',
}: {
  error: string | null;
  note: string | null;
  onDismissError: () => void;
  onDismissNote: () => void;
  className?: string;
}) {
  if (!error && !note) return null;
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-2xl bg-danger py-1 pl-3.5 pr-1 text-[13px] text-danger-ink ring-1 ring-danger-line">
          <span className="min-w-0 flex-1 break-words py-1.5">{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss" className={DISMISS}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
      )}
      {note && (
        <div role="status" className="flex items-center gap-2 rounded-2xl bg-money py-1 pl-3.5 pr-1 text-[13px] text-money-ink ring-1 ring-money-line">
          <span className="min-w-0 flex-1 break-words py-1.5">{note}</span>
          <button type="button" onClick={onDismissNote} aria-label="Dismiss" className={DISMISS}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

const DISMISS = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full opacity-80 hover:opacity-100 md:h-8 md:w-8';

/**
 * Who this is and where the conversation stands (the old details dialog,
 * :1911, now the end of People and actions): the contact, the number it came
 * in on and its channel, the language, the topic and the intent, the linked
 * member — by name and child count only, allergy text stays on the till
 * (plan §3.3) — and when it started, was first answered, handled, reopened.
 * The team, the park and the status are rows above, with their controls.
 */
export function ConversationFacts({
  row,
  detail,
  now,
}: {
  row: ConversationRow;
  detail: ConversationDetail | null;
  now: Date;
}) {
  const d = detail?.id === row.id ? detail : null;
  const when = (iso: string | null | undefined) => (iso ? bubbleTime(iso, now) : '—');
  const lines: [string, string][] = [
    ['Contact', contactName(row.contact)],
    // A Facebook or Instagram id reads like a phone number (test night U9).
    [handleLabel(row.channel) ?? 'Handle', row.contact.handle],
    ['Phone', row.contact.phone ?? '—'],
    // The number it came in on (SCRUM-220 playbook), the channel on its own line.
    ['Source', sourceLabel(row.channel, row.channelAccountName)],
    ['Channel', CHANNEL_LABEL[row.channel]],
    ['Language', langLabel(row.language)],
    ['Topic', CATEGORY_LABEL[row.category]],
    ['Intent', row.intent ?? '—'],
    ['Member', d?.member ? `${d.member.name} · ${d.member.childCount} child${d.member.childCount === 1 ? '' : 'ren'}` : 'Not linked'],
    ['Started', when(row.createdAt)],
    ['First reply', when(d?.firstResponseAt)],
    ['Handled', row.status === 'handled' ? when(row.handledAt) : '—'],
    ['Reopened', when(d?.reopenedAt)],
  ];
  return (
    <dl className="grid grid-cols-[6.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-1 text-[13.5px]">
      {lines.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The sheet's line under the contact's name (ChatActions.dc.html): the channel, the language, the member link. */
export function actionsSubtitle(row: ConversationRow, detail: ConversationDetail | null): string {
  const d = detail?.id === row.id ? detail : null;
  return [CHANNEL_LABEL[row.channel], langLabel(row.language), d?.member ? 'member' : 'not a member yet'].join(' · ');
}
