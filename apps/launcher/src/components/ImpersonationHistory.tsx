import type { ImpersonationHistoryEntry } from '@/api/platform';
import { formatWhen } from '@/lib/time';

/**
 * SCRUM-648 (S2-23) — the subject's own record of every view-as window a
 * support administrator opened as them: who, into which app, why, and how it
 * ended. Read with the session alone; nobody needs a permission to see what
 * was done in their name.
 */

const APP_NAMES: Record<ImpersonationHistoryEntry['targetApp'], string> = { pos: 'POS', oto_app: 'OTO App', radar: 'Radar', inbox: 'Inbox' };
const ENDED: Record<NonNullable<ImpersonationHistoryEntry['endReason']>, string> = {
  ended: 'ended by the administrator', actor_signed_out: 'ended when the administrator signed out',
  subject_signed_out: 'ended by signing out inside it',
};

export function endWords(entry: ImpersonationHistoryEntry): string {
  if (entry.state === 'active') return 'open now';
  if (entry.endReason) return ENDED[entry.endReason];
  return entry.state === 'expired' ? 'ran out of time' : 'ended';
}

export function ImpersonationHistoryList({ entries, timezone }: { entries: ImpersonationHistoryEntry[]; timezone?: string }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody has viewed the suite as this account.</p>;
  }
  return (
    <ul className="flex flex-col divide-y" data-testid="impersonation-history">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0" data-state={entry.state}>
          <span className="text-sm font-semibold">
            {entry.actor.name ?? 'A support administrator'} viewed {APP_NAMES[entry.targetApp]} as you
            {' '}— {entry.mode === 'read_only' ? 'read only' : 'with changes allowed'}
          </span>
          <span className="text-sm text-muted-foreground">
            {formatWhen(entry.startedAt, timezone)} · {endWords(entry)}
            {entry.reason ? ` · ${entry.reason}` : ''}{entry.reference ? ` (${entry.reference})` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
