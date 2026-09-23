import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { MOCK_MUTATOR_TICKETS, type MockMutatorName } from '@/store/CatalogStoreContext';

/**
 * The shell every "this is not real yet" banner in the admin area uses.
 *
 * It is deliberately the same amber as the reporting shells: the admin area
 * already uses that colour for exactly this meaning, and a second dialect would
 * just be another thing to learn. It sits above the controls rather than under
 * the table, because the person it has to reach is about to press Save.
 */
export function AdminNoticeBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

interface NotSavedNoticeProps {
  /**
   * The in-memory store mutators this screen calls. The ticket in the notice is
   * read from the classification in `CatalogStoreContext` rather than typed
   * here, so the notice cannot name a different ticket from the one that owns
   * the work — and when a mutator is wired and leaves that map, this stops
   * compiling and points at the notice that has to change with it.
   */
  mutators: readonly MockMutatorName[];
  /**
   * What this screen edits, as the object of "Changes to …": lower case, no
   * trailing stop — "menu items, their prices and their categories".
   */
  what: string;
}

/** The banner a screen carries when its edits do not reach the database (SCRUM-236). */
export function NotSavedNotice({ mutators, what }: NotSavedNoticeProps) {
  const tickets = [...new Set(mutators.map((m) => MOCK_MUTATOR_TICKETS[m]))].sort();
  return (
    <AdminNoticeBanner>
      <strong className="font-semibold">Not saved yet — {tickets.join(' · ')}.</strong>{' '}
      Changes to {what} stay in this browser tab: the till sees them, the database
      never does, and a page reload discards them.
    </AdminNoticeBanner>
  );
}
