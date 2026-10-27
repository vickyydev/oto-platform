import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import type { ImpersonationBanner as Window, MeResponse } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';

/**
 * SCRUM-648 (S2-23) — the fixed, non-dismissible view-as banner on the
 * launcher: on a session that is a support administrator's window, and on the
 * actor's own session while it has one open. No close button; it leaves with
 * the window. Fixed at one height; while it shows, `html.view-as-active`
 * starts the page below it (`index.css`), so it never covers a header control.
 */

/** The class that gives the page the banner's height; on while a banner shows, off when it goes. */
export const VIEW_AS_ACTIVE = 'view-as-active';
export function markViewAsOffset(root: { classList: { toggle(token: string, force?: boolean): unknown } }, on: boolean) {
  root.classList.toggle(VIEW_AS_ACTIVE, on);
}

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
  const { w, viewer } = lines[0]!;
  return (
    <div role="status" aria-live="polite" data-testid="impersonation-banner"
      className="fixed inset-x-0 top-0 z-[60] flex h-9 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-amber-500 bg-amber-400 px-4 text-sm font-semibold text-black">
      <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{bannerLine(w, viewer)}</span>
      <span className="shrink-0 tabular-nums">· ends in {countdown(w.expiresAt, now)}</span>
      {lines.length > 1 && <span className="shrink-0">· {lines.length - 1} more open</span>}
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
  useEffect(() => {
    markViewAsOffset(document.documentElement, live);
    return () => markViewAsOffset(document.documentElement, false);
  }, [live]);
  return <ImpersonationBannerView me={me} now={now} />;
}
