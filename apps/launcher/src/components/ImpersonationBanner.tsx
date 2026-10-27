import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import type { ImpersonationBanner as Window, MeResponse } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';

/**
 * SCRUM-648 (S2-23) — the fixed, non-dismissible view-as banner on the
 * launcher: on a session that is a support administrator's window, and on the
 * actor's own session while it has one open. No close button; it leaves with
 * the window.
 */

const APP_NAMES: Record<Window['targetApp'], string> = { pos: 'POS', oto_app: 'OTO App', radar: 'Radar', inbox: 'Inbox' };

export function bannerLine(w: Window, viewer: 'actor' | 'window'): string {
  const app = APP_NAMES[w.targetApp];
  const subject = w.subject.name ?? 'a staff account';
  const actor = w.actor.name ?? 'A support administrator';
  const mode = w.mode === 'read_only' ? 'read-only' : 'changes allowed';
  return viewer === 'actor'
    ? `You (${actor}) are viewing ${app} as ${subject} \u2014 ${mode}`
    : `${actor} is viewing ${app} as ${subject} \u2014 ${mode}`;
}

export function countdown(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
}

export function ImpersonationBannerView({ me, now }: { me: Pick<MeResponse, 'impersonation' | 'impersonating'> | null; now: number }) {
  const lines = [
    ...(me?.impersonation ? [{ w: me.impersonation, viewer: 'window' as const }] : []),
    ...(me?.impersonating ?? []).map(w => ({ w, viewer: 'actor' as const })),
  ];
  if (lines.length === 0) return null;
  return (
    <div role="status" aria-live="polite" data-testid="impersonation-banner"
      className="sticky top-0 z-50 w-full border-b border-amber-500 bg-amber-400 px-4 py-2 text-sm font-semibold text-black">
      {lines.map(({ w, viewer }) => (
        <p key={w.id} className="flex flex-wrap items-center gap-x-2">
          <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{bannerLine(w, viewer)}</span>
          <span className="tabular-nums">· ends in {countdown(w.expiresAt, now)}</span>
        </p>
      ))}
    </div>
  );
}

export function ImpersonationBanner() {
  const { me } = useSession();
  const [now, setNow] = useState(() => Date.now());
  const live = !!me?.impersonation || (me?.impersonating?.length ?? 0) > 0;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return <ImpersonationBannerView me={me} now={now} />;
}
