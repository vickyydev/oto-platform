import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import type { MeResponse } from '@/api/platform';
import { bannerWords, remaining } from '@/lib/supportRules';

/**
 * SCRUM-648 (S2-23) — the fixed, non-dismissible view-as banner. It names the
 * actor and the subject for the whole window: on a session that IS a window
 * (opened into this app), and on the actor's own session while it has one
 * open. There is no close button; it goes when the window does.
 *
 * Fixed at the top at one height, and while it shows `html.view-as-active`
 * moves the page and every sticky or full-height region below it
 * (`index.css`), so it never covers a header control.
 */

/** The class that gives the page the banner's height; on while a banner shows, off when it goes. */
export const VIEW_AS_ACTIVE = 'view-as-active';
export function markViewAsOffset(root: { classList: { toggle(token: string, force?: boolean): unknown } }, on: boolean) {
  root.classList.toggle(VIEW_AS_ACTIVE, on);
}

export function ImpersonationBanner({ me, now }: { me: Pick<MeResponse, 'impersonation' | 'impersonating'>; now?: number }) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const lines = [
    ...(me.impersonation ? [{ id: me.impersonation.id, words: bannerWords(me.impersonation, 'subject_session'), expiresAt: me.impersonation.expiresAt }] : []),
    ...(me.impersonating ?? []).map(w => ({ id: w.id, words: bannerWords(w, 'actor'), expiresAt: w.expiresAt })),
  ];
  const live = lines.length > 0;
  useEffect(() => {
    if (now !== undefined || !live) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [now, live]);
  useEffect(() => {
    markViewAsOffset(document.documentElement, live);
    return () => markViewAsOffset(document.documentElement, false);
  }, [live]);
  if (!live) return null;
  const first = lines[0]!;
  return <div role="status" aria-live="polite" data-testid="impersonation-banner"
    className="fixed inset-x-0 top-0 z-[60] flex h-9 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-[var(--status-warn)] bg-[var(--status-warn)] px-4 text-sm font-semibold text-black">
    <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
    <span className="min-w-0 truncate">{first.words}</span>
    <span className="shrink-0 tabular-nums">· ends in {remaining(first.expiresAt, now ?? clock)}</span>
    {lines.length > 1 && <span className="shrink-0">· {lines.length - 1} more open</span>}
  </div>;
}
