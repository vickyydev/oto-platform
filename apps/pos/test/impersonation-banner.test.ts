// SCRUM-648 (S2-23) — the till's view-as banner, rendered with react-dom/server.
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImpersonationBannerView, markViewAsOffset, timeLeft, VIEW_AS_ACTIVE, viewAsLine } from '@/components/auth/ImpersonationBannerView';

const NOW = Date.parse('2026-10-28T03:00:00.000Z');
const viewAs = {
  id: '01964800-0000-7000-8000-0000000000c1',
  actor: { accountId: '01964800-0000-7000-8000-0000000000a1', name: 'ZZ Admin' },
  subject: { accountId: '01964800-0000-7000-8000-0000000000a2', name: 'ZZ Reception' },
  targetApp: 'pos' as const, mode: 'read_only' as const, expiresAt: '2026-10-28T03:09:05.000Z',
};

describe('the till view-as banner (SCRUM-648)', () => {
  it('names the administrator and the account, the mode and the time left, with nothing to dismiss', () => {
    const out = renderToStaticMarkup(createElement(ImpersonationBannerView, { viewAs, now: NOW }));
    expect(out).toContain('ZZ Admin is viewing the POS as ZZ Reception');
    expect(out).toContain('read-only, nothing can be changed');
    expect(out).toContain('ends in 9:05');
    expect(out).toContain('fixed inset-x-0 top-0');
    expect(out).toContain('h-9');
    expect(out).not.toMatch(/<button/);
    expect(viewAsLine({ ...viewAs, mode: 'write_allowed' })).toContain('changes allowed');
    expect(timeLeft('2026-10-28T02:00:00.000Z', NOW)).toBe('0:00');
  });

  it('draws nothing on an ordinary session', () => {
    expect(renderToStaticMarkup(createElement(ImpersonationBannerView, { viewAs: null, now: NOW }))).toBe('');
  });

  it('moves the till below the banner while it shows, so it covers no header control', () => {
    const tokens = new Set<string>();
    const root = { classList: { toggle: (token: string, on?: boolean) => { if (on) tokens.add(token); else tokens.delete(token); } } };
    markViewAsOffset(root, true);
    expect([...tokens]).toEqual([VIEW_AS_ACTIVE]);
    markViewAsOffset(root, false);
    expect([...tokens]).toEqual([]);
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    // The banner is h-9 (2.25rem): the body starts below it and every full-height screen gives it back.
    expect(css).toContain('html.view-as-active { --view-as-offset: 2.25rem; }');
    expect(css).toContain('html.view-as-active body { padding-top: var(--view-as-offset); }');
    expect(css).toContain('html.view-as-active .h-screen { height: calc(100vh - var(--view-as-offset)); }');
    const banner = readFileSync(new URL('../src/components/auth/ImpersonationBanner.tsx', import.meta.url), 'utf8');
    expect(banner).toContain('markViewAsOffset(document.documentElement, viewAs !== null)');
  });

  it('is mounted over every staff screen and fed from /me', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<ImpersonationBanner />');
    const context = readFileSync(new URL('../src/auth/OperatorContext.tsx', import.meta.url), 'utf8');
    expect(context).toContain('setViewAs(me.impersonation ?? null)');
  });
});
