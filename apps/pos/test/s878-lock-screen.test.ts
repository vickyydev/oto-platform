import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * SCRUM-878 — WHAT THE LOCK SCREEN DRAWS WHEN A STAFF SESSION HAS ENDED.
 *
 * A locked till whose session ended on the platform no longer says the person
 * is still signed in, nor answers a correct password with "Not signed in": the
 * sign-in form is drawn where the password was, under one line in the screen's
 * own amber notice saying what happened. Nothing else on the screen changes.
 * A different person signed in over a kept sale is shown who started it and
 * when, with Continue and Discard, in the same layout.
 */
const seam = vi.hoisted(() => ({
  operator: {} as Record<string, unknown>,
  station: { station: { stationId: 'zz-test-station' }, resolved: true } as Record<string, unknown>,
}));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => seam.operator }));
vi.mock('@/station/StationContext', () => ({ useStation: () => seam.station }));
vi.mock('wouter', () => ({ Link: () => null, useLocation: () => ['/', () => undefined] }));
vi.mock('@/api/bridge', () => ({ bridgeApi: { status: vi.fn() } }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string) => key, setLang: vi.fn() }) }));
Object.assign(globalThis, { React });

import { LockScreen } from '@/components/auth/LockScreen';
import { KeptSaleOfferScreen } from '@/components/auth/KeptSaleOffer';
import { keptSaleElsewhere, type KeptSaleOffer } from '@/auth/sessionEnd';

const ANN = { id: 'zz-test-ann', name: 'ZZ TEST Ann', role: 'staff' };
const base = {
  operator: ANN, locked: true, signIn: vi.fn(), unlock: vi.fn(), logout: vi.fn(), handoffError: null, offlineUnlock: null,
  sessionEnded: null, keptOffer: null, continueKept: vi.fn(), discardKept: vi.fn(),
};
const draw = (operator: Record<string, unknown>, element: React.ReactElement = React.createElement(LockScreen)) => {
  seam.operator = operator;
  return renderToStaticMarkup(element);
};
const OFFER: KeptSaleOffer = {
  startedBy: 'ZZ TEST Ann',
  startedAt: new Date(2026, 10, 12, 20, 5).getTime(),
  endedAt: new Date(2026, 10, 12, 20, 31).getTime(),
  stationId: 'zz-test-station',
};

describe('SCRUM-878 — the lock screen of a till whose session has ended', () => {
  it('a live lock is drawn as before: still signed in, the password, Unlock', () => {
    const html = draw(base);
    expect(html).toContain('ZZ TEST Ann is still signed in — enter your password to continue.');
    expect(html).toContain('Unlock');
    expect(html).not.toContain('lock-session-ended');
  }, 60_000);

  it('an ended session: the sign-in form in the password’s place, under one line saying what happened', () => {
    const html = draw({ ...base, sessionEnded: { name: 'ZZ TEST Ann', expired: true, afterHours: 12, saleKept: true } });
    expect(html).toContain('data-testid="lock-session-ended"');
    expect(html).toContain('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on. The sale in progress is kept on this till.');
    // In the screen's own amber notice style.
    const line = html.slice(html.lastIndexOf('<p', html.indexOf('lock-session-ended')), html.indexOf('</p>', html.indexOf('lock-session-ended')));
    expect(line).toContain('border-amber-500/30 bg-amber-400/10');
    // Never "still signed in", never the unlock: the sign-in form, its labels unchanged.
    expect(html).not.toContain('still signed in');
    expect(html).not.toContain('Unlocking');
    expect(html).not.toContain('Sign out and hand over the till');
    expect(html).toContain('Oto POS is locked');
    expect(html).toContain('Sign in with your phone to start your shift.');
    expect(html).toContain('Phone number');
    expect(html).toContain('Sign in');
    expect(html).toContain('Locks automatically after inactivity');
  }, 60_000);

  it('ended from elsewhere: it has ended, with no hours claimed', () => {
    const html = draw({ ...base, sessionEnded: { name: 'ZZ TEST Ann', expired: false, afterHours: 12, saleKept: false } });
    expect(html).toContain('The session of ZZ TEST Ann has ended. Sign in again to carry on.');
    expect(html).not.toContain('twelve hours');
  }, 60_000);

  it('a sign-in screen with no session ended says nothing new', () => {
    const html = draw({ ...base, operator: null, locked: false });
    expect(html).not.toContain('lock-session-ended');
    expect(html).not.toContain('kept-sale-offer');
    expect(html).toContain('Sign in with your phone to start your shift.');
  }, 60_000);
});

describe('SCRUM-878 — the offer to the next person', () => {
  it('names who started the sale and when, with Continue and Discard, and asks for no password', () => {
    const html = draw({ ...base, operator: { id: 'zz-test-ben', name: 'ZZ TEST Ben', role: 'staff' }, keptOffer: OFFER });
    expect(html).toContain('A sale is open on this till');
    expect(html).toContain('data-testid="kept-sale-offer"');
    expect(html).toContain('ZZ TEST Ann started this sale at 20:05. The session of ZZ TEST Ann ended at 20:31.');
    expect(html).toContain('Continue this sale');
    expect(html).toContain('Discard it and start a new sale');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('still signed in');
  }, 60_000);

  it('is drawn by the offer component itself in the lock screen’s layout', () => {
    const html = draw({ ...base, keptOffer: OFFER }, React.createElement(KeptSaleOfferScreen, { offer: OFFER }));
    expect(html).toContain('h-[100dvh] w-full flex flex-col items-center justify-center bg-background');
    expect(html).toContain('rounded-[2rem] bg-primary');
  }, 60_000);

  it('SECURITY: never at another station — let go, or another taken, and the sale goes', () => {
    expect(keptSaleElsewhere(OFFER, { stationId: 'zz-test-station', resolved: true })).toBe(false);
    expect(keptSaleElsewhere(OFFER, { stationId: null, resolved: true })).toBe(true);
    expect(keptSaleElsewhere(OFFER, { stationId: 'zz-test-other-station', resolved: true })).toBe(true);
    // Still being asked: not decided yet.
    expect(keptSaleElsewhere(OFFER, { stationId: null, resolved: false })).toBe(false);
    // A deployment with no fleet has no platform station to compare.
    expect(keptSaleElsewhere({ stationId: null }, { stationId: 'local', resolved: true })).toBe(false);
  });
});
