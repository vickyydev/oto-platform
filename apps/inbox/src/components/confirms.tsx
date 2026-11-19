import { ArrowRightLeft, CheckCircle2, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import type { InboxCategoryKey } from '@oto/shared/inbox';
import { Dialog } from '@/components/Dialog';
import { BTN_DANGER, BTN_FOOTER_MAIN, BTN_QUIET } from '@/components/ui';
import { CATEGORY_LABEL } from '@/lib/view';

/** Cancel in every confirmation: the quiet words (BookDate.dc.html). */
const CANCEL = BTN_QUIET;
/** A confirmation's words, readable at arm's length on a phone. */
const SAYS = 'text-[14px] leading-relaxed md:text-[13px]';

/**
 * "Mark as handled for everyone?" — the prototype's confirmation (:1734-1764),
 * word for word, on the house Dialog. Opened from the chat's Mark as Handled,
 * the status picker and the list row's hover button.
 */
export function HandleConfirm({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  /** The server's refusal, shown as it was said. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      icon={CheckCircle2}
      tone="money"
      title="Mark as handled for everyone?"
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={BTN_FOOTER_MAIN}
          >
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, mark as handled
          </button>
        </>
      }
    >
      <p className={`${SAYS} text-ink-soft`}>
        This conversation will leave Active Messages for the whole team and move to the Handled tab. It returns
        automatically only if the customer sends a new message — or a manager reopens it.
      </p>
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

export interface PendingPrimaryMove {
  /** Who was picked, for the sentence's subject. */
  name: string;
  fromCategory: InboxCategoryKey | null;
  toCategory: InboxCategoryKey | null;
  toTeamName: string | null;
}

/**
 * "Change primary owner?" (:1699-1730): the server refused the replacement
 * with 409 `CATEGORY_MOVE_UNCONFIRMED` — the prototype's "Changing primary
 * owner will move this conversation to the new department. Continue?". The
 * dialog says the move it means once, with the names from the 409's details
 * (the server's generic sentence said the same thing a second time; test
 * night 2026-10-21, U6), and repeats the request with `confirmMove: true` on
 * "Yes".
 */
export function PrimaryMoveConfirm({
  pending,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  pending: PendingPrimaryMove | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const to = pending?.toCategory ? CATEGORY_LABEL[pending.toCategory] : (pending?.toTeamName ?? 'the new department');
  return (
    <Dialog
      open={pending !== null}
      onClose={onCancel}
      icon={ShieldAlert}
      tone="ask"
      title="Change primary owner?"
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={BTN_FOOTER_MAIN}
          >
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, move to {to}
          </button>
        </>
      }
    >
      {pending && (
        <p className={`${SAYS} text-ink`}>
          Setting <strong>{pending.name}</strong> as primary will move this conversation
          {pending.fromCategory && (
            <>
              {' '}
              from <strong>{CATEGORY_LABEL[pending.fromCategory]}</strong>
            </>
          )}{' '}
          to <strong>{pending.toTeamName ?? to}</strong>. The current support assignees will stay. Continue?
        </p>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

export interface PendingTeamMove {
  /** Where the badge was set to ("Marketing", "Reception · Central Floresta"). */
  toTeamName: string;
  fromTeamName: string | null;
}

/**
 * "Move to another team?" (test night 2026-10-21, U6): the team badge moved a
 * thread with no confirmation, and the move's routing seated a new primary
 * and added the GM as support without a word. The move has no dry run, so the
 * line is generic — the api's answer names who was seated, and the strip says
 * so afterwards (`moveOutcome`).
 */
export function TeamMoveConfirm({
  pending,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  pending: PendingTeamMove | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={pending !== null}
      onClose={onCancel}
      icon={ArrowRightLeft}
      tone="ask"
      title="Move to another team?"
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={BTN_FOOTER_MAIN}
          >
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, move to {pending?.toTeamName ?? 'the team'}
          </button>
        </>
      }
    >
      {pending && (
        <p className={`${SAYS} text-ink`}>
          Moving this conversation
          {pending.fromTeamName && (
            <>
              {' '}
              from <strong>{pending.fromTeamName}</strong>
            </>
          )}{' '}
          to <strong>{pending.toTeamName}</strong> hands it to that team’s routing: its default owner becomes primary
          and its backup is added as support. Everyone on it now is released.
        </p>
      )}
      {error && <Refusal text={error} />}
    </Dialog>
  );
}

/**
 * A refusal from the server, as it was said: red, or the amber of a polite
 * "not on your access" on the settings pages; both tested token pairs.
 */
export function Refusal({ text, tone = 'danger' }: { text: string; tone?: 'danger' | 'ask' }) {
  return (
    <p
      role="alert"
      className={`mt-3 break-words rounded-xl px-3 py-2 text-[13px] ring-1 ${
        tone === 'danger' ? 'bg-danger text-danger-ink ring-danger-line' : 'bg-ask text-ask-ink ring-ask-line'
      }`}
    >
      {text}
    </p>
  );
}

/** SCRUM-908: the header button's name and the dialog's title. */
export const START_OVER_LABEL = 'Start over';

/**
 * "Start over with this number?" (SCRUM-908) — a conversation of the WhatsApp
 * TEST LINE only: the owner's "an option to delete the chat so he can try
 * again with a new message acting as a new customer". Said plainly before the
 * press, because it cannot be undone.
 */
export function StartOverConfirm({
  open,
  busy,
  error,
  lineName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  /** The test line's name, as the rail shows it. */
  lineName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      icon={RotateCcw}
      tone="danger"
      title="Start over with this number?"
      subtitle={lineName}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={CANCEL}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={BTN_DANGER}
          >
            {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            Yes, start over
          </button>
        </>
      }
    >
      <p className={`${SAYS} text-ink-soft`}>
        This test conversation leaves the inbox and its messages are erased. The assistant forgets this number: the
        next message from it starts a new conversation, as from a new customer. This cannot be undone.
      </p>
      {error && <Refusal text={error} />}
    </Dialog>
  );
}
