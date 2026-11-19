import { INBOX_DAY_TIMEZONE, type InboxDepositSignal, type InboxNextAction } from '@oto/shared/inbox';
import { bahtOf } from '@/lib/view';

/**
 * What happens next, in the row's one badge (SCRUM-992; the shorter words of
 * SCRUM-1016, owner choice 1, approved as drawn). The deposit's words below do
 * not change.
 */
export const NEXT_ACTION_LABELS: Record<InboxNextAction, string> = {
  staff_reply_needed: 'Needs reply',
  ai_replying: 'Assistant replying',
  ai_previewing: 'Assistant preview · not sent',
  ai_sent: 'Assistant answered',
  waiting_customer: 'Waiting for customer',
  shadow_preview: 'Assistant preview · not sent',
  handled: 'Handled',
  // SCRUM-996: a deposit to book or to check waits on a person, whatever the last line was.
  staff_action_needed: 'Needs action',
};
/**
 * The badge's ground and ink (SCRUM-1016): a person is needed in coral, the
 * assistant at work in mint and teal, waiting in the tab band. Tokens only, so
 * both themes follow (test/list-state-992.test.ts measures each pair).
 */
export const NEXT_ACTION_COLOURS: Record<InboxNextAction, string> = {
  staff_reply_needed: 'bg-needs text-needs-ink',
  ai_replying: 'bg-mint text-teal',
  ai_previewing: 'bg-mint text-teal',
  ai_sent: 'bg-mint text-teal',
  waiting_customer: 'bg-band text-ink-soft',
  shadow_preview: 'bg-mint text-teal',
  handled: 'bg-band text-ink-soft',
  staff_action_needed: 'bg-needs text-needs-ink',
};

/** SCRUM-996: the deposit's words on the row, for everyone who sees the chat (owner choice 3). */
export const DEPOSIT_SIGNAL_LABELS: Record<InboxDepositSignal, string> = {
  paid: 'Deposit paid · book the date',
  paid_date_passed: 'Deposit paid · date passed, needs staff',
  needs_checking: 'Deposit needs checking',
};
/** Money in green (Main.dc.html); a deposit that needs a person in the coral of "needs reply". */
export const DEPOSIT_SIGNAL_COLOURS: Record<InboxDepositSignal, string> = {
  paid: 'bg-money-badge text-money-ink',
  paid_date_passed: 'bg-needs text-needs-ink',
  needs_checking: 'bg-needs text-needs-ink',
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

/** The words of the next-step card for a paid deposit (SCRUM-1016, ChatPaid.dc.html). */
export interface DepositPaidCard {
  /** "Deposit ฿3,000 paid". */
  title: string;
  /** The gateway's verification and when, then what to do next. */
  detail: string;
  /** Said first for a simulator payment: no real money moved. */
  simulator: string | null;
}

/** Said first on the card when the payment came from the simulator (SCRUM-996). */
export const SIMULATOR_PAYMENT_LINE = 'Simulator test payment, no real money.';

/**
 * The next-step card for a person who may book (SCRUM-996 plan §2, laid out
 * as ChatPaid.dc.html by SCRUM-1016): the amount, the gateway's verification
 * and when, then what to do next. A simulator payment says so first; a date
 * that has passed says the deposit is staff's to resolve with the family.
 */
export function depositPaidCard(
  draft: { amountSatang: number; paidAt: string | null; simulator: boolean },
  signal: InboxDepositSignal,
): DepositPaidCard {
  const when = draft.paidAt ? ` at ${verifiedAt(draft.paidAt)}` : '';
  const next =
    signal === 'paid_date_passed'
      ? 'The party date has passed: staff must resolve the paid deposit with the family.'
      : 'Check capacity, then book the date.';
  return {
    title: `Deposit ${bahtOf(draft.amountSatang)} paid`,
    detail: `Gateway verified${when}. ${next}`,
    simulator: draft.simulator ? SIMULATOR_PAYMENT_LINE : null,
  };
}

/**
 * A row's ground (SCRUM-1016): selected is the tab band's ground with a 2 px
 * ink ring (never a bar at the edge); a "Ready to book" row keeps its green
 * ground under the ring. Unread is not a ground: the row's name and preview
 * are heavier and it carries the coral count, so selection and unread never
 * share a marker.
 */
export function conversationRowColour(selected: boolean, ready = false): string {
  const ground = ready ? 'bg-money' : selected ? 'bg-band' : 'hover:bg-wash';
  return selected ? `${ground} ring-2 ring-inset ring-ink` : ground;
}
