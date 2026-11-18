import { INBOX_DAY_TIMEZONE, type InboxDepositSignal, type InboxNextAction } from '@oto/shared/inbox';
import { bahtOf } from '@/lib/view';

export const NEXT_ACTION_LABELS: Record<InboxNextAction, string> = {
  staff_reply_needed: 'Staff reply needed',
  ai_replying: 'AI replying',
  ai_previewing: 'Preparing AI preview · not sent',
  ai_sent: 'AI sent · waiting for customer',
  waiting_customer: 'Waiting for customer',
  shadow_preview: 'AI preview · not sent',
  handled: 'Handled',
  // SCRUM-996: a deposit to book or to check waits on a person, whatever the last line was.
  staff_action_needed: 'Staff action needed',
};
export const NEXT_ACTION_COLOURS: Record<InboxNextAction, string> = {
  staff_reply_needed: 'bg-amber-100 text-amber-950 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700',
  ai_replying: 'bg-indigo-100 text-indigo-950 ring-indigo-300 dark:bg-indigo-950 dark:text-indigo-100 dark:ring-indigo-700',
  ai_previewing: 'bg-violet-100 text-violet-950 ring-violet-300 dark:bg-violet-950 dark:text-violet-100 dark:ring-violet-700',
  ai_sent: 'bg-emerald-100 text-emerald-950 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-700',
  waiting_customer: 'bg-slate-100 text-slate-800 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
  shadow_preview: 'bg-violet-100 text-violet-950 ring-violet-300 dark:bg-violet-950 dark:text-violet-100 dark:ring-violet-700',
  handled: 'bg-slate-100 text-slate-800 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
  staff_action_needed: 'bg-amber-100 text-amber-950 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700',
};

/** SCRUM-996: the deposit's words on the row, for everyone who sees the chat (owner choice 3). */
export const DEPOSIT_SIGNAL_LABELS: Record<InboxDepositSignal, string> = {
  paid: 'Deposit paid · book the date',
  paid_date_passed: 'Deposit paid · date passed, needs staff',
  needs_checking: 'Deposit needs checking',
};
export const DEPOSIT_SIGNAL_COLOURS: Record<InboxDepositSignal, string> = {
  paid: 'bg-teal-100 text-teal-950 ring-teal-400 dark:bg-teal-950 dark:text-teal-100 dark:ring-teal-600',
  paid_date_passed: 'bg-orange-100 text-orange-950 ring-orange-400 dark:bg-orange-950 dark:text-orange-100 dark:ring-orange-600',
  needs_checking: 'bg-rose-100 text-rose-950 ring-rose-300 dark:bg-rose-950 dark:text-rose-100 dark:ring-rose-700',
};

/** The group pinned above the list (owner choice 1): paid and not yet booked; never "needs checking". */
export const READY_TO_BOOK_LABEL = 'Ready to book';
export const isReadyToBook = (signal: InboxDepositSignal | null | undefined): boolean =>
  signal === 'paid' || signal === 'paid_date_passed';

/** The first page's group first, then the page without them: each conversation once. */
export function withReadyToBook<T extends { id: string }>(group: readonly T[] | undefined, rows: readonly T[]): T[] {
  const pinned = group ?? [];
  const ids = new Set(pinned.map((r) => r.id));
  return [...pinned, ...rows.filter((r) => !ids.has(r.id))];
}

/** "16 Nov, 19:00" in the parks' clock. */
const verifiedAt = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: INBOX_DAY_TIMEZONE,
  }).format(new Date(iso));

/**
 * The line beside Book Date for a person who may book (SCRUM-996 plan §2):
 * the amount, the gateway's verification and when, then what to do next. A
 * simulator payment says so first.
 */
export function depositPaidLine(
  draft: { amountSatang: number; paidAt: string | null; simulator: boolean },
  signal: InboxDepositSignal,
): string {
  const when = draft.paidAt ? ` at ${verifiedAt(draft.paidAt)}` : '';
  const paid = `${bahtOf(draft.amountSatang)} paid and gateway verified${when}.`;
  const next =
    signal === 'paid_date_passed'
      ? 'The party date has passed: staff must resolve the paid deposit with the family.'
      : 'Check capacity, then Book Date.';
  return draft.simulator
    ? `Simulator test payment, no real money: deposit ${paid} ${next}`
    : `Deposit ${paid} ${next}`;
}

/** Selection and per-viewer unread remain separately visible in either theme. */
export function conversationRowColour(selected: boolean, unread: number): string {
  return [unread > 0 ? 'border-l-4 border-l-indigo-600 dark:border-l-indigo-400' : 'border-l-4 border-l-transparent',
    selected ? 'bg-emerald-50 ring-2 ring-inset ring-emerald-700 dark:bg-emerald-950 dark:ring-emerald-300'
      : unread > 0 ? 'bg-indigo-50 dark:bg-indigo-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'].join(' ');
}
