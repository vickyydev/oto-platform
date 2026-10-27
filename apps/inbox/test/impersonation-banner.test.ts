// SCRUM-648 (S2-23) — the Inbox's view-as banner: no mark, no banner; a mark,
// both names and the countdown, fixed above the page at one height, with the
// page moved below it and no way to dismiss it. Rendered to markup (Node).
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ImpersonationBannerView, markViewAsOffset, timeLeft, VIEW_AS_ACTIVE, viewAsLine, type ViewAsMark,
} from '@/components/ImpersonationBanner';

const NOW = Date.parse('2026-10-28T03:00:00.000Z');
const mark: ViewAsMark = {
  id: '01964800-0000-7000-8000-0000000000c1',
  actor: { accountId: '01964800-0000-7000-8000-0000000000a1', name: 'ZZ Admin' },
  subject: { accountId: '01964800-0000-7000-8000-0000000000a2', name: 'ZZ Agent' },
  targetApp: 'inbox', mode: 'read_only', expiresAt: '2026-10-28T03:14:59.000Z',
};
const html = (m: ViewAsMark | null | undefined) => renderToStaticMarkup(createElement(ImpersonationBannerView, { mark: m, now: NOW }));

describe('the Inbox view-as banner (SCRUM-648)', () => {
  it('draws nothing on an ordinary session, or from an api that predates the mark', () => {
    expect(html(null)).toBe('');
    expect(html(undefined)).toBe('');
  });

  it('names both people, the mode and the time left, and offers nothing to dismiss', () => {
    const out = html(mark);
    expect(out).toContain('ZZ Admin is viewing the Inbox as ZZ Agent');
    expect(out).toContain('read-only, nothing can be sent or changed');
    expect(out).toContain('ends in 14:59');
    expect(out).toContain('data-testid="impersonation-banner"');
    expect(out).toContain('fixed inset-x-0 top-0');
    expect(out).toContain('h-9');
    expect(out).not.toMatch(/<button/);
    expect(viewAsLine({ ...mark, mode: 'write_allowed' })).toContain('changes allowed');
    expect(timeLeft('2026-10-28T02:00:00.000Z', NOW)).toBe('0:00');
  });

  it('moves the page below the banner while it shows, so the header is never under it', () => {
    const tokens = new Set<string>();
    const root = { classList: { toggle: (token: string, on?: boolean) => { if (on) tokens.add(token); else tokens.delete(token); } } };
    markViewAsOffset(root, true);
    expect([...tokens]).toEqual([VIEW_AS_ACTIVE]);
    markViewAsOffset(root, false);
    expect([...tokens]).toEqual([]);
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(css).toContain('html.view-as-active { --view-as-offset: 2.25rem; }');
    expect(css).toContain('html.view-as-active body { padding-top: var(--view-as-offset); }');
  });

  it('is mounted above the whole Inbox and fed from /inbox/me', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<ImpersonationBanner mark={me.impersonation} />');
    expect(app.indexOf('<ImpersonationBanner')).toBeLessThan(app.indexOf('<Workspace'));
  });
});
