import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import type { InboxMe } from '@/api/inbox';

/**
 * SCRUM-648 (S2-23) — the Inbox's fixed, non-dismissible view-as banner. When
 * this session is a support administrator's audited window, `GET /inbox/me`
 * names both people and the end; the banner shows them for the whole window
 * and has no close button. Fixed at one height, and while it shows
 * `html.view-as-active` starts the page below it (`index.css`), so it never
 * covers the header.
 */

export type ViewAsMark = NonNullable<InboxMe['impersonation']>;

export const VIEW_AS_ACTIVE = 'view-as-active';
export function markViewAsOffset(root: { classList: { toggle(token: string, force?: boolean): unknown } }, on: boolean): void {
  root.classList.toggle(VIEW_AS_ACTIVE, on);
}

export function viewAsLine(mark: ViewAsMark): string {
  const actor = mark.actor.name ?? 'A support administrator';
  const subject = mark.subject.name ?? 'a staff account';
  return `${actor} is viewing the Inbox as ${subject} \u2014 ${mark.mode === 'read_only' ? 'read-only, nothing can be sent or changed' : 'changes allowed'}`;
}

export function timeLeft(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
}

export function ImpersonationBannerView({ mark, now }: { mark: ViewAsMark | null | undefined; now: number }) {
  if (!mark) return null;
  return (
    <div role="status" aria-live="polite" data-testid="impersonation-banner"
      className="fixed inset-x-0 top-0 z-[60] flex h-9 items-center justify-center gap-2 overflow-hidden whitespace-nowrap border-b border-amber-500 bg-amber-400 px-4 text-sm font-semibold text-black">
      <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{viewAsLine(mark)}</span>
      <span className="shrink-0 tabular-nums">· ends in {timeLeft(mark.expiresAt, now)}</span>
    </div>
  );
}

export function ImpersonationBanner({ mark }: { mark: ViewAsMark | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  const live = !!mark;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => {
    markViewAsOffset(document.documentElement, live);
    return () => markViewAsOffset(document.documentElement, false);
  }, [live]);
  return <ImpersonationBannerView mark={mark} now={now} />;
}
