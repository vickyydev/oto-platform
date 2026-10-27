// SCRUM-648 (S2-23) — the launcher's view-as banner and the subject's own
// record of windows opened as them, rendered with react-dom/server.
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: { me: null as unknown } }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => session.value }));

const { ImpersonationBanner, ImpersonationBannerView, countdown } = await import('@/components/ImpersonationBanner');
const { ImpersonationHistoryList, endWords } = await import('@/components/ImpersonationHistory');

const NOW = Date.parse('2026-10-28T03:00:00.000Z');
const win = {
  id: '01964800-0000-7000-8000-0000000000c1',
  actor: { accountId: '01964800-0000-7000-8000-0000000000a1', name: 'ZZ Admin' },
  subject: { accountId: '01964800-0000-7000-8000-0000000000a2', name: 'ZZ Reception' },
  targetApp: 'pos' as const, mode: 'read_only' as const, expiresAt: '2026-10-28T03:15:00.000Z',
};

describe('the view-as banner (SCRUM-648)', () => {
  it('names both people and the time left, and offers no way to dismiss it', () => {
    const asActor = renderToStaticMarkup(<ImpersonationBannerView me={{ impersonation: null, impersonating: [win] }} now={NOW} />);
    expect(asActor).toContain('You (ZZ Admin) are viewing POS as ZZ Reception');
    expect(asActor).toContain('ends in 15:00');
    const inWindow = renderToStaticMarkup(<ImpersonationBannerView me={{ impersonation: win, impersonating: [] }} now={NOW} />);
    expect(inWindow).toContain('ZZ Admin is viewing POS as ZZ Reception');
    for (const out of [asActor, inWindow]) {
      expect(out).toContain('data-testid="impersonation-banner"');
      expect(out).not.toMatch(/<button/);
    }
    expect(countdown('2026-10-28T02:00:00.000Z', NOW)).toBe('0:00');
  });

  it('draws nothing without a window, including from an api that predates the fields', () => {
    expect(renderToStaticMarkup(<ImpersonationBannerView me={{ impersonation: null, impersonating: [] }} now={NOW} />)).toBe('');
    expect(renderToStaticMarkup(<ImpersonationBannerView me={{} as never} now={NOW} />)).toBe('');
    expect(renderToStaticMarkup(<ImpersonationBannerView me={null} now={NOW} />)).toBe('');
  });

  it('reads the session and is mounted above every route of the launcher', () => {
    session.value = { me: { impersonation: null, impersonating: [win] } };
    expect(renderToStaticMarkup(<ImpersonationBanner />)).toContain('data-testid="impersonation-banner"');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app.indexOf('<ImpersonationBanner />')).toBeGreaterThan(-1);
    expect(app.indexOf('<ImpersonationBanner />')).toBeLessThan(app.indexOf('<Routes />'));
  });
});

describe('viewed as you (SCRUM-648)', () => {
  const entry = {
    ...win, reason: 'ZZ fix a member', reference: 'SCRUM-648', approvalId: null, startedAt: '2026-10-28T02:00:00.000Z',
    endedAt: '2026-10-28T02:05:00.000Z', endReason: 'actor_signed_out' as const, state: 'ended' as const,
  };
  it('lists who opened which app as you, why, and how it ended', () => {
    const out = renderToStaticMarkup(<ImpersonationHistoryList entries={[entry]} timezone="Asia/Bangkok" />);
    expect(out).toContain('ZZ Admin viewed POS as you');
    expect(out).toContain('read only');
    expect(out).toContain('ended when the administrator signed out');
    expect(out).toContain('ZZ fix a member (SCRUM-648)');
    expect(endWords({ ...entry, state: 'expired', endReason: null, endedAt: null })).toBe('ran out of time');
    expect(renderToStaticMarkup(<ImpersonationHistoryList entries={[]} />)).toContain('Nobody has viewed the suite as this account.');
  });
});
