import { ChevronLeft, ChevronRight, Loader2, Lock, MonitorSmartphone } from 'lucide-react';
import type { SessionRow, SessionsPage } from '../api/accounts';
import { Button } from '../ui/button';

/**
 * SCRUM-793 — the Sessions dialog's list, a page at a time.
 *
 * The api answers one page of an account's sessions, newest sign-in first,
 * with the total, and says what each session is now. The dialog used to be
 * handed every session at once; with the page it would show the newest ten
 * and say nothing of the rest, so this draws the page, the count line and the
 * controls to move between pages, and marks a session past its end as ended
 * rather than leaving it to read as one that is still signed in.
 */

/** "Showing 1–10 of 23": which rows of how many this page is. */
export function sessionsCountLine(page: Pick<SessionsPage, 'offset' | 'total'> & { shown: number }): string {
  if (page.shown === 0) return `Showing 0 of ${page.total}`;
  const first = page.offset + 1;
  const last = page.offset + page.shown;
  return `Showing ${first === last ? first : `${first}–${last}`} of ${page.total}`;
}

/** "expires …" while the session can still be used, "ended …" once it cannot. */
export function sessionEndWords(row: SessionRow, when: (iso: string) => string): string {
  return row.status === 'ended' ? `ended ${when(row.endedAt ?? row.expiresAt)}` : `expires ${when(row.expiresAt)}`;
}

export function AccountSessionsList({
  page,
  loading,
  onPage,
  when,
}: {
  page: SessionsPage;
  /** Another page has been asked for and has not arrived yet. */
  loading: boolean;
  onPage: (offset: number) => void;
  when: (iso: string) => string;
}) {
  const { sessions, offset, limit, total } = page;
  if (total === 0 && sessions.length === 0) {
    return <p className="text-sm text-foreground/50">No sessions on record.</p>;
  }
  const hasNewer = offset > 0;
  const hasOlder = offset + sessions.length < total;
  return (
    <>
      {sessions.map((s) => (
        <div
          key={s.id}
          data-status={s.status}
          className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 px-3 py-2 text-sm"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              <MonitorSmartphone className="w-4 h-4 text-foreground/40" />
              {s.stationId ? 'Station' : 'Till / browser'}
              {s.status === 'locked' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600">
                  <Lock className="w-3 h-3" />
                  locked
                </span>
              )}
              {s.status === 'ended' && (
                <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-semibold text-foreground/50">
                  ended
                </span>
              )}
            </div>
            <div className="text-xs text-foreground/50 tabular-nums">
              last seen {when(s.lastSeenAt)} · {sessionEndWords(s, when)}
            </div>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-foreground/50 tabular-nums" data-testid="account-sessions-count">
          {sessionsCountLine({ offset, total, shown: sessions.length })}
        </p>
        {(hasNewer || hasOlder) && (
          <div className="ml-auto flex items-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin text-foreground/40" />}
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={loading || !hasNewer}
              onClick={() => onPage(Math.max(0, offset - limit))}
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={loading || !hasOlder}
              onClick={() => onPage(offset + limit)}
            >
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
