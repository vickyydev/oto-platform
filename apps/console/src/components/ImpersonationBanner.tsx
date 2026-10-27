import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import type { MeResponse } from '@/api/platform';
import { bannerWords, remaining } from '@/lib/supportRules';

/**
 * SCRUM-648 (S2-23) — the fixed, non-dismissible view-as banner. It names the
 * actor and the subject for the whole window: on a session that IS a window
 * (opened into this app), and on the actor's own session while it has one
 * open. There is no close button; it goes when the window does.
 */
export function ImpersonationBanner({ me, now }: { me: Pick<MeResponse, 'impersonation' | 'impersonating'>; now?: number }) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const live = me.impersonation !== null || me.impersonating.length > 0;
  useEffect(() => {
    if (now !== undefined || !live) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [now, live]);
  const at = now ?? clock;
  const lines = [
    ...(me.impersonation ? [{ id: me.impersonation.id, words: bannerWords(me.impersonation, 'subject_session'), expiresAt: me.impersonation.expiresAt }] : []),
    ...me.impersonating.map(w => ({ id: w.id, words: bannerWords(w, 'actor'), expiresAt: w.expiresAt })),
  ];
  if (lines.length === 0) return null;
  return <div role="status" aria-live="polite" data-testid="impersonation-banner"
    className="sticky top-0 z-50 w-full border-b border-[var(--status-warn)] bg-[var(--status-warn)] px-4 py-2 text-sm font-semibold text-black">
    {lines.map(line => <p key={line.id} className="flex flex-wrap items-center gap-x-2">
      <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{line.words}</span>
      <span className="tabular-nums">· ends in {remaining(line.expiresAt, at)}</span>
    </p>)}
  </div>;
}
