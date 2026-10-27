import { createElement } from 'react';
import { Eye } from 'lucide-react';
import type { PosImpersonation } from '@/api/platform';

/**
 * SCRUM-648 (S2-23) — the till's fixed, non-dismissible banner for a support
 * administrator's view-as window: who is really here, as whom, read-only or
 * not, and how long is left. It has no close button; it goes when the window
 * does (the session ends and the till returns to the lock screen).
 */

export function viewAsLine(w: PosImpersonation): string {
  const actor = w.actor.name ?? 'A support administrator';
  const subject = w.subject.name ?? 'a staff account';
  return `${actor} is viewing the POS as ${subject} \u2014 ${w.mode === 'read_only' ? 'read-only, nothing can be changed' : 'changes allowed'}`;
}

export function timeLeft(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
}

// Written with createElement: the till's node test runner has no JSX transform (vitest.config.ts).
/**
 * The class that gives the till the banner's height (`index.css`): the body
 * starts below the fixed banner and every full-height screen is shortened by
 * it, so it never covers a header control. On while a window shows, off after.
 */
export const VIEW_AS_ACTIVE = 'view-as-active';
export function markViewAsOffset(root: { classList: { toggle(token: string, force?: boolean): unknown } }, on: boolean): void {
  root.classList.toggle(VIEW_AS_ACTIVE, on);
}

export function ImpersonationBannerView({ viewAs, now }: { viewAs: PosImpersonation | null; now: number }) {
  if (!viewAs) return null;
  return createElement('div', {
    role: 'status', 'aria-live': 'polite', 'data-testid': 'impersonation-banner',
    className: 'fixed inset-x-0 top-0 z-[100] flex h-9 items-center justify-center gap-2 overflow-hidden whitespace-nowrap border-b border-amber-500 bg-amber-400 px-4 text-sm font-semibold text-black',
  },
  createElement(Eye, { className: 'h-4 w-4 shrink-0', 'aria-hidden': 'true' }),
  createElement('span', { className: 'min-w-0 truncate' }, viewAsLine(viewAs)),
  createElement('span', { className: 'shrink-0 tabular-nums' }, `· ends in ${timeLeft(viewAs.expiresAt, now)}`));
}
