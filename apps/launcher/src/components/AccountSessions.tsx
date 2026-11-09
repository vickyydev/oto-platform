import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import type { AccountSessionRow, AccountSessionsPage } from '@/api/platform';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/time';

/**
 * SCRUM-793 — "Sessions on this account", a page at a time.
 *
 * The list used to be every session the account had ever held, all at once,
 * and a session whose end had passed still read "Active". The api now sends
 * one page, newest sign-in first, with the total, and says what each session
 * is now; this draws that page, the count line and the controls to move
 * between pages, and marks the row of the device it is being read on.
 */

/** How many sessions one page shows. */
export const SESSIONS_PAGE_SIZE = 10;

const STATUS_WORDS: Record<AccountSessionRow['status'], string> = {
  active: 'Active',
  locked: 'Locked',
  ended: 'Ended',
};

export function sessionStatusWord(row: AccountSessionRow): string {
  return STATUS_WORDS[row.status];
}

/** "ends …" while the session can still be used, "ended …" once it cannot. */
export function sessionEndWords(row: AccountSessionRow, timezone?: string): string {
  return row.status === 'ended'
    ? `ended ${formatWhen(row.endedAt ?? row.expiresAt, timezone)}`
    : `ends ${formatWhen(row.expiresAt, timezone)}`;
}

/** "Showing 1–10 of 23": which rows of how many this page is. */
export function sessionsCountLine(page: Pick<AccountSessionsPage, 'offset' | 'total'> & { shown: number }): string {
  if (page.shown === 0) return `Showing 0 of ${page.total}`;
  const first = page.offset + 1;
  const last = page.offset + page.shown;
  return `Showing ${first === last ? first : `${first}–${last}`} of ${page.total}`;
}

export function AccountSessionsList({
  page,
  timezone,
  loading,
  onPage,
}: {
  page: AccountSessionsPage;
  timezone?: string;
  /** A different page has been asked for and has not arrived yet. */
  loading: boolean;
  onPage: (offset: number) => void;
}) {
  const { sessions, offset, limit, total } = page;
  const hasNewer = offset > 0;
  const hasOlder = offset + sessions.length < total;
  return (
    <>
      <ul className="flex flex-col divide-y" data-testid="account-sessions">
        {sessions.map((row) => (
          <li
            key={row.id}
            data-status={row.status}
            data-current={row.current ? 'true' : undefined}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="text-sm font-semibold">{sessionStatusWord(row)}</span>
            {row.current && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                This device
              </span>
            )}
            <span className="text-sm text-muted-foreground">
              last used {formatWhen(row.lastSeenAt, timezone)}
            </span>
            <span className="text-sm text-muted-foreground ml-auto">{sessionEndWords(row, timezone)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground tabular-nums" data-testid="account-sessions-count">
          {sessionsCountLine({ offset, total, shown: sessions.length })}
        </p>
        {(hasNewer || hasOlder) && (
          <div className="ml-auto flex items-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
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
