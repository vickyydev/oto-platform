import { ArrowRightLeft, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import type { InboxCategoryKey } from '@oto/shared/inbox';
import { Dialog } from '@/components/Dialog';
import { CATEGORY_LABEL } from '@/lib/view';

const CANCEL =
  'rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60';

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
      iconTint="bg-emerald-50 text-emerald-600"
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Yes, mark as handled
          </button>
        </>
      }
    >
      <p className="text-[12.5px] text-slate-500">
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
      iconTint="bg-amber-50 text-amber-600"
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Yes, move to {to}
          </button>
        </>
      }
    >
      {pending && (
        <p className="text-[12.5px] text-slate-700">
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
      iconTint="bg-amber-50 text-amber-600"
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Yes, move to {pending?.toTeamName ?? 'the team'}
          </button>
        </>
      }
    >
      {pending && (
        <p className="text-[12.5px] text-slate-700">
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

/** A refusal from the server, as it was said. */
export function Refusal({ text, tone = 'rose' }: { text: string; tone?: 'rose' | 'amber' }) {
  return (
    <p
      role="alert"
      className={`mt-3 break-words rounded-lg px-3 py-2 text-[12.5px] ring-1 ${
        tone === 'rose' ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-amber-50 text-amber-800 ring-amber-200'
      }`}
    >
      {text}
    </p>
  );
}
