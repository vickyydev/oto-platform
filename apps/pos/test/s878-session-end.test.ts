import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';
import { ApiError } from '@/api/client';
import { INACTIVITY_TIMEOUT_MS } from '@/auth/timings';
import { getSaleOpen, rungUpSaleOf, saleOpenSince, saleRungUp, setSaleAtStake, setSaleOpen, setSaleRungUp } from '@/pwa/openSale';
import { rememberSaleOnScreen } from '@/lib/saleOnScreen';
import {
  afterSignIn,
  clockTime,
  endedByExpiry,
  hoursInWords,
  KEPT_SALE_RUNG_UP_LINE,
  keptSaleOfferAsk,
  keptSaleOfferLine,
  sessionDeadline,
  sessionEndedLine,
  SESSION_END_SLACK_MS,
  type KeptTill,
} from '@/auth/sessionEnd';

/**
 * SCRUM-878 — A STAFF SESSION THAT ENDS DURING A LONG SHIFT KEEPS THE SALE AND
 * SAYS WHAT HAPPENED.
 *
 * A staff session ends twelve hours after sign-in. Before: the till dropped to
 * the sign-in form with no word of why, the selling screen went with the
 * operator and the cart was lost, and a LOCKED till answered a correct
 * password with a bare "Not signed in" under a line still saying the person
 * was signed in. Now the screen stays under the lock, the sign-in form says
 * the session ended, and the next sign-in on that till carries the sale on —
 * the same person at once, a different person only if they choose to.
 *
 * The twelve-hour mark is reached on a test clock (the session's end comes
 * from `/me`, as the platform gives it), never by waiting. The 401 the till
 * meets is the one its client turns into `oto:unauthorized` (the heartbeat,
 * any poll) or the unlock's own refusal.
 */

const T0 = Date.UTC(2026, 10, 12, 1, 30); // 08:30 at the park
const HOURS_12 = 12 * 3_600_000;
const ANN = { id: 'zz-test-ann', name: 'ZZ TEST Ann' };
const BEN = { id: 'zz-test-ben', name: 'ZZ TEST Ben' };
const PASSWORD = 'ZZ TEST synthetic password';

const seam = vi.hoisted(() => {
  // The page's timers are read when called, so a test that fakes them (the
  // inactivity lock) moves the till's own countdown with the test clock.
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' },
    setTimeout: (run: () => void, ms?: number) => globalThis.setTimeout(run, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    setInterval: (run: () => void, ms?: number) => globalThis.setInterval(run, ms),
    clearInterval: (id?: ReturnType<typeof setInterval>) => globalThis.clearInterval(id),
  });
  vi.stubGlobal('window', browser);
  return {
    browser, me: vi.fn(), permissions: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), onlineUnlock: vi.fn(), lock: vi.fn(),
    setLang: vi.fn(), setTheme: vi.fn(), boxLock: vi.fn(async (_station: string) => undefined),
    getSale: vi.fn(),
  };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getOperatorThemePref: () => null }));
vi.mock('@/lib/themePref', () => ({ staffThemeController: { adopt: vi.fn(), release: vi.fn() }, useCustomerTheme: () => ['light', seam.setTheme] }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ setLang: seam.setLang }) }));
vi.mock('@/api/platform', () => ({ authApi: { me: seam.me, permissions: seam.permissions, unlock: seam.onlineUnlock,
  lock: seam.lock, signIn: seam.signIn, signOut: seam.signOut } }));
vi.mock('@/api/bridge', () => ({ setBridgeStaffName: vi.fn(), holdBoxSession: vi.fn(), prepareConfiguredBridgeUnlock: () => null,
  bridgeApi: { lock: seam.boxLock, unlock: vi.fn() },
}));
vi.mock('@/auth/staffToken', () => ({ readStaffToken: () => null, staffTokenLive: () => false, forgetStaffToken: vi.fn() }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', laneStation: () => 'zz-test-station', isBoxLaneTrigger: () => false,
  noteLaneFailure: vi.fn(), platformNeedsUnlock: () => false, refreshLane: async () => 'platform', platformUnlocked: vi.fn() }));
vi.mock('@/api/catalogBridge', () => ({ loadCatalogFromApi: async () => undefined, restorePreparedCatalog: vi.fn() }));
vi.mock('@/lib/displaySession', () => ({ takeTicketDisplayLeaseForSignOut: async () => null }));
vi.mock('@/api/history', () => ({ getSale: seam.getSale }));
vi.mock('@/auth/offlinePreparation', () => ({ forgetOfflinePreparation: vi.fn(), prepareOfflineOperator: vi.fn(),
  readOfflinePreparation: () => null }));
Object.assign(globalThis, { React });

/** Who `/me` says is signed in, and where. */
let who: { id: string; name: string; branchId: string; operatorId: string; impersonation?: unknown } = {
  ...ANN, branchId: 'zz-test-park', operatorId: 'zz-test-operator',
};
let grants: string[] = ['pos:sale:create', 'pos:sale:read'];
/** The account is on a temporary password (SCRUM-235): issuing one ends every session. */
let owesPasswordChange = false;
/** The platform's own end for the session `/me` describes: twelve hours after the sign-in. */
let signedInAt = T0;

/** Each store a browser has; every write is recorded, to prove nothing of a kept sale is written. */
const writes: Array<{ store: string; key: string; value: string }> = [];
function fakeStore(store: string) {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push({ store, key, value }); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  vi.stubGlobal('window', seam.browser);
  vi.stubGlobal('localStorage', fakeStore('localStorage'));
  vi.stubGlobal('sessionStorage', fakeStore('sessionStorage'));
  writes.length = 0;
  who = { ...ANN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
  grants = ['pos:sale:create', 'pos:sale:read'];
  owesPasswordChange = false;
  signedInAt = T0;
  seam.me.mockImplementation(async () => ({
    account: { id: who.id, phone: 'ZZ TEST', mustChangePassword: owesPasswordChange, operatorId: who.operatorId },
    employee: { name: who.name }, branch: { id: who.branchId, code: 'zz-test-park' }, sessionLocked: false,
    impersonation: who.impersonation ?? null,
    sessionEnd: {
      at: new Date(signedInAt + HOURS_12).toISOString(),
      inSeconds: Math.max(0, Math.floor((signedInAt + HOURS_12 - Date.now()) / 1000)),
      afterHours: 12,
    },
  }));
  seam.permissions.mockImplementation(async () => ({ permissions: grants.map((permission) => ({ permission })) }));
  seam.signIn.mockImplementation(async () => { signedInAt = Date.now(); return {}; });
  seam.signOut.mockResolvedValue({});
  seam.lock.mockResolvedValue({});
  seam.onlineUnlock.mockResolvedValue({});
});
afterEach(() => {
  for (const surface of ['till', 'order-station', 'merch-station', 'mobile-till', 'mobile-fnb']) {
    setSaleAtStake(surface, false);
    setSaleRungUp(surface, null);
  }
  setSaleOpen('till', false);
  setSaleOpen('ticket-display', false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('window', seam.browser);
});

function mount() {
  const hook = renderHook(() => OperatorProvider({ children: null }));
  const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
  return { hook, value };
}

async function signedIn() {
  const till = mount();
  await vi.waitFor(() => expect(till.value().operator?.id).toBe(ANN.id));
  expect(till.value().locked).toBe(false);
  expect(till.value().tillSeat).not.toBeNull();
  return till;
}

/** What the till's client does with a 401 from the heartbeat or a poll. */
const refused = () => window.dispatchEvent(new Event('oto:unauthorized'));
/** Twelve hours (and a little) after the sign-in, on the test clock. */
const pastTheMark = () => vi.setSystemTime(signedInAt + HOURS_12 + 5_000);

describe('the sign-in screen’s words (auth/sessionEnd.ts)', () => {
  it('says the session ended after its hours, or that it ended, and that the sale is kept', () => {
    expect(sessionEndedLine({ name: 'ZZ TEST Ann', expired: true, afterHours: 12, saleKept: false }))
      .toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on.');
    expect(sessionEndedLine({ name: 'ZZ TEST Ann', expired: true, afterHours: 12, saleKept: true }))
      .toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on. The sale in progress is kept on this till.');
    // Ended from elsewhere (a manager's Sign out everywhere, a password reset): no hours claimed.
    expect(sessionEndedLine({ name: 'ZZ TEST Ann', expired: false, afterHours: 12, saleKept: false }))
      .toBe('The session of ZZ TEST Ann has ended. Sign in again to carry on.');
    // An api that does not say the session's hours.
    expect(sessionEndedLine({ name: 'ZZ TEST Ann', expired: true, afterHours: null, saleKept: false }))
      .toBe('The session of ZZ TEST Ann has ended. Sign in again to carry on.');
    expect(hoursInWords(12)).toBe('twelve hours');
    expect(hoursInWords(1)).toBe('one hour');
    expect(hoursInWords(24)).toBe('24 hours');
  });

  it('keeps the moment on this device from the seconds the platform said were left', () => {
    expect(sessionDeadline({ inSeconds: 60 }, 1_000)).toBe(61_000);
    expect(sessionDeadline(null, 1_000)).toBeNull();
    expect(sessionDeadline(undefined, 1_000)).toBeNull();
    const deadline = T0 + HOURS_12;
    expect(endedByExpiry(deadline, deadline)).toBe(true);
    expect(endedByExpiry(deadline, deadline - SESSION_END_SLACK_MS)).toBe(true);
    expect(endedByExpiry(deadline, deadline - SESSION_END_SLACK_MS - 1)).toBe(false);
    expect(endedByExpiry(null, deadline + 1)).toBe(false);
  });

  it('the offer names who started the sale and when, and when their session ended', () => {
    const startedAt = new Date(2026, 10, 12, 20, 5).getTime();
    const endedAt = new Date(2026, 10, 12, 20, 31).getTime();
    expect(clockTime(startedAt)).toBe('20:05');
    expect(keptSaleOfferLine({ startedBy: 'ZZ TEST Ann', startedAt, endedAt, stationId: 's' }))
      .toBe('ZZ TEST Ann started this sale at 20:05. The session of ZZ TEST Ann ended at 20:31.');
  });
});

describe('who may carry on the screen an ended session left (afterSignIn)', () => {
  const kept: KeptTill = {
    accountId: ANN.id, name: ANN.name, operatorId: 'op', branchId: 'park', stationId: 'till-1',
    tradingDate: '2026-11-12', saleSince: T0, endedAt: T0 + HOURS_12,
  };
  const next = { accountId: ANN.id, operatorId: 'op', branchId: 'park', tradingDate: '2026-11-12', maySell: true };

  it('the same person carries on; a different person who may sell is asked; nobody kept, a fresh till', () => {
    expect(afterSignIn(kept, next)).toBe('continue');
    expect(afterSignIn(kept, { ...next, accountId: BEN.id })).toBe('offer');
    expect(afterSignIn(null, next)).toBe('fresh');
    // Nothing on screen: nothing to offer anybody else.
    expect(afterSignIn({ ...kept, saleSince: null }, { ...next, accountId: BEN.id })).toBe('fresh');
  });

  it('SECURITY: never across a park, an operator or a trading day, and never to a person who may not sell', () => {
    expect(afterSignIn(kept, { ...next, branchId: 'other-park' })).toBe('fresh');
    expect(afterSignIn(kept, { ...next, operatorId: 'other-operator' })).toBe('fresh');
    expect(afterSignIn(kept, { ...next, tradingDate: '2026-11-13' })).toBe('fresh');
    expect(afterSignIn(kept, { ...next, accountId: BEN.id, maySell: false })).toBe('fresh');
    expect(afterSignIn(kept, { ...next, maySell: false })).toBe('fresh');
  });
});

describe('SCRUM-878 — the twelve-hour mark at the till', () => {
  it('reached while UNLOCKED mid-cart: the screen stays under the lock, the line says why, the same person carries on', async () => {
    const { hook, value } = await signedIn();
    try {
      const seat = value().tillSeat;
      vi.setSystemTime(T0 + 11 * 3_600_000 + 35 * 60_000); // 20:05: the cart is started
      setSaleAtStake('till', true);
      pastTheMark();
      refused(); // the minute's heartbeat comes back 401

      // Not signed out: the same operator holds the screen, locked, able to do nothing.
      expect(value().operator?.id).toBe(ANN.id);
      expect(value().locked).toBe(true);
      expect(value().tillSeat).toBe(seat);
      expect(value().can('pos:sale:create')).toBe(false);
      expect(value().sessionEnded).toEqual({ name: ANN.name, expired: true, afterHours: 12, saleKept: true });
      expect(value().keptOffer).toBeNull();
      expect(sessionEndedLine(value().sessionEnded!))
        .toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on. The sale in progress is kept on this till.');

      // The next heartbeat is refused again: said once, nothing moves.
      refused();
      expect(value().sessionEnded?.expired).toBe(true);
      expect(value().tillSeat).toBe(seat);

      await value().signIn('ZZ TEST phone', PASSWORD);
      expect(seam.signIn).toHaveBeenCalledTimes(1);
      expect(value().locked).toBe(false);
      expect(value().sessionEnded).toBeNull();
      expect(value().keptOffer).toBeNull();
      // The same screen (so the same lines, member, tier, codes and step), at the same station taken again.
      expect(value().tillSeat).toBe(seat);
      expect(value().reseat).toBe(1);
      expect(value().can('pos:sale:create')).toBe(true);
    } finally { hook.unmount(); }
  });

  it('reached while LOCKED: the right password is not answered "Not signed in", the sign-in form says the session ended', async () => {
    const { hook, value } = await signedIn();
    try {
      const seat = value().tillSeat;
      setSaleAtStake('till', true);
      value().lockNow();
      expect(value().locked).toBe(true);
      expect(value().sessionEnded).toBeNull();

      // Before the mark a wrong password is still a wrong password.
      seam.onlineUnlock.mockRejectedValueOnce(new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect'));
      await expect(value().unlock('ZZ TEST wrong')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(value().sessionEnded).toBeNull();
      expect(value().locked).toBe(true);

      pastTheMark();
      // The variant: the password typed and Unlock pressed before the next heartbeat lands.
      seam.onlineUnlock.mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'Not signed in'));
      await expect(value().unlock(PASSWORD)).resolves.toBeUndefined();
      expect(value().sessionEnded).toEqual({ name: ANN.name, expired: true, afterHours: 12, saleKept: true });
      expect(value().locked).toBe(true);
      expect(value().operator?.id).toBe(ANN.id);
      expect(value().tillSeat).toBe(seat);

      // And the heartbeat after it changes nothing.
      refused();
      expect(value().sessionEnded?.expired).toBe(true);
    } finally { hook.unmount(); }
  });

  it('reached while LOCKED with the heartbeat landing first: the same line, before anybody types', async () => {
    const { hook, value } = await signedIn();
    try {
      value().lockNow();
      pastTheMark();
      refused();
      expect(value().locked).toBe(true);
      expect(value().sessionEnded).toEqual({ name: ANN.name, expired: true, afterHours: 12, saleKept: false });
      expect(sessionEndedLine(value().sessionEnded!)).toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on.');
    } finally { hook.unmount(); }
  });

  it('a heartbeat sent with no session just before the sign-in, refused after it, does not end the new session', async () => {
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake('till', true);
      pastTheMark();
      const sentBeforeTheSignIn = Date.now();
      refused();
      vi.setSystemTime(Date.now() + 2_000);
      await value().signIn('ZZ TEST phone', PASSWORD);
      expect(value().locked).toBe(false);
      // The old heartbeat's 401 lands now: it is the old session's.
      window.dispatchEvent(new CustomEvent('oto:unauthorized', { detail: { sentAt: sentBeforeTheSignIn } }));
      expect(value().sessionEnded).toBeNull();
      expect(value().locked).toBe(false);
      // A request sent in the new session and refused is the new session ending.
      vi.setSystemTime(Date.now() + 1_000);
      window.dispatchEvent(new CustomEvent('oto:unauthorized', { detail: { sentAt: Date.now() } }));
      expect(value().locked).toBe(true);
      expect(value().sessionEnded?.expired).toBe(false);
    } finally { hook.unmount(); }
  });

  it('the box session ends with it, once: the ended person’s box bearer is not kept under the sign-in form', async () => {
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake('till', true);
      expect(seam.boxLock).not.toHaveBeenCalled();
      pastTheMark();
      refused();
      // As a lock ends it (offline plan §2.2): the operator and station stay on screen, so nothing else would.
      expect(seam.boxLock).toHaveBeenCalledTimes(1);
      expect(seam.boxLock).toHaveBeenCalledWith('zz-test-station');
      // The next heartbeat refused changes nothing.
      refused();
      expect(seam.boxLock).toHaveBeenCalledTimes(1);
      // The next sign-in opens no box session of its own: the box asks the person now signed in.
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      value().continueKept();
      expect(seam.boxLock).toHaveBeenCalledTimes(1);
    } finally { hook.unmount(); }
  });

  it('the box session ends with it on the unlock’s refusal too', async () => {
    const { hook, value } = await signedIn();
    try {
      value().lockNow();
      // The lock itself ended it once, as before.
      expect(seam.boxLock).toHaveBeenCalledTimes(1);
      pastTheMark();
      seam.onlineUnlock.mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'Not signed in'));
      await value().unlock(PASSWORD);
      expect(value().sessionEnded).not.toBeNull();
      expect(seam.boxLock).toHaveBeenCalledTimes(2);
    } finally { hook.unmount(); }
  });

  it('ended before its time (Sign out everywhere, a password reset): it has ended, with no hours claimed', async () => {
    const { hook, value } = await signedIn();
    try {
      vi.setSystemTime(T0 + 3 * 3_600_000);
      setSaleAtStake('till', true);
      refused();
      expect(value().sessionEnded).toEqual({ name: ANN.name, expired: false, afterHours: 12, saleKept: true });
      expect(sessionEndedLine(value().sessionEnded!)).toBe('The session of ZZ TEST Ann has ended. Sign in again to carry on. The sale in progress is kept on this till.');
    } finally { hook.unmount(); }
  });
});

describe('SCRUM-878 — a different person signs in over the kept sale', () => {
  async function endedMidCart() {
    const till = await signedIn();
    const seat = till.value().tillSeat;
    vi.setSystemTime(T0 + 11 * 3_600_000 + 35 * 60_000);
    setSaleAtStake('till', true);
    pastTheMark();
    refused();
    expect(till.value().sessionEnded?.saleKept).toBe(true);
    return { ...till, seat };
  }

  it('one who may sell is told who started it and when, and the till stays locked until they choose', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().operator?.id).toBe(BEN.id);
      // Never silently theirs: still locked over the sale, which stays the same screen.
      expect(value().locked).toBe(true);
      expect(value().tillSeat).toBe(seat);
      expect(value().sessionEnded).toBeNull();
      expect(value().keptOffer).toEqual({
        startedBy: ANN.name,
        startedAt: T0 + 11 * 3_600_000 + 35 * 60_000,
        endedAt: T0 + HOURS_12 + 5_000,
        stationId: 'zz-test-station',
      });
      expect(value().reseat).toBe(1);

      value().continueKept();
      expect(value().locked).toBe(false);
      expect(value().keptOffer).toBeNull();
      expect(value().tillSeat).toBe(seat);
    } finally { hook.unmount(); }
  });

  it('a sale already rung up with a payment waiting: the offer says so and offers it to continue only', async () => {
    const till = await signedIn();
    const { hook, value } = till;
    try {
      const seat = value().tillSeat;
      vi.setSystemTime(T0 + 11 * 3_600_000 + 35 * 60_000);
      setSaleAtStake('till', true);
      // Pay pressed: the till says which sale it has rung up, as `Till.tsx` does from its writer.
      // SCRUM-964 — the surface's own mark now, not the stored one (an earlier sale's could be stale).
      setSaleRungUp('till', 'zz-test-sale-878');
      pastTheMark();
      refused();
      expect(value().sessionEnded?.saleKept).toBe(true);

      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().locked).toBe(true);
      expect(value().keptOffer).toEqual({
        startedBy: ANN.name,
        startedAt: T0 + 11 * 3_600_000 + 35 * 60_000,
        endedAt: T0 + HOURS_12 + 5_000,
        stationId: 'zz-test-station',
        rungUpSaleId: 'zz-test-sale-878',
      });
      expect(keptSaleOfferAsk(value().keptOffer!)).toBe('Continue it to read its payment back, then finish it or cancel it.');
      expect(KEPT_SALE_RUNG_UP_LINE).toBe('It is rung up; a payment may be waiting on the customer display.');

      // Continue: the same screen, unlocked, so its payment stage reads the attempt back.
      value().continueKept();
      expect(value().locked).toBe(false);
      expect(value().tillSeat).toBe(seat);
      expect(value().reseat).toBe(1);
    } finally { hook.unmount(); }
  });

  it('a cart not rung up is offered with Discard as before; a remembered sale with nothing on screen is never offered', async () => {
    expect(keptSaleOfferAsk({})).toBe('Continue it, or discard it and start a new sale.');
    const { hook, value } = await signedIn();
    try {
      // A sale remembered from earlier, but nothing on screen now: nothing kept, nothing offered.
      rememberSaleOnScreen('zz-test-station', 'zz-test-sale-earlier');
      pastTheMark();
      refused();
      expect(value().sessionEnded?.saleKept).toBe(false);
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
    } finally { hook.unmount(); }
  });

  it('SECURITY: the offer left alone locks after the same inactivity as any signed-in screen; the password brings it back, the sale untouched', async () => {
    // The countdown itself on the test clock, not only the date.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      const offered = value().keptOffer;
      expect(offered).not.toBeNull();
      expect(value().locked).toBe(true);
      expect(seam.lock).not.toHaveBeenCalled();

      // A touch on the offer is activity, as on any signed-in screen.
      vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS - 1_000);
      expect(value().warningActive).toBe(true);
      window.dispatchEvent(new Event('pointerdown'));
      expect(value().warningActive).toBe(false);
      vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS - 1_000);
      expect(value().keptOffer).toEqual(offered);
      expect(seam.lock).not.toHaveBeenCalled();
      // "Stay" on the warning keeps it open too.
      value().stayActive();
      vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS - 1_000);
      expect(seam.lock).not.toHaveBeenCalled();

      // Left alone past the limit: locked in the ordinary way. The platform
      // session is locked, the offer is not on screen, the password is asked.
      vi.advanceTimersByTime(1_000);
      expect(seam.lock).toHaveBeenCalledTimes(1);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(true);
      expect(value().sessionEnded).toBeNull();
      expect(value().operator?.id).toBe(BEN.id);
      expect(value().tillSeat).toBe(seat);
      // Locked, a touch keeps nothing alive and nothing is answered for anybody.
      window.dispatchEvent(new Event('pointerdown'));
      vi.advanceTimersByTime(10 * INACTIVITY_TIMEOUT_MS);
      expect(seam.lock).toHaveBeenCalledTimes(1);
      expect(value().keptOffer).toBeNull();

      // A wrong password is a wrong password: still locked, no offer.
      seam.onlineUnlock.mockRejectedValueOnce(new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect'));
      await expect(value().unlock('ZZ TEST wrong')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(true);

      // The right one brings the offer back as it was, still locked over the
      // sale until they choose; the unlock never chose for them.
      await value().unlock(PASSWORD);
      expect(value().keptOffer).toEqual(offered);
      expect(value().locked).toBe(true);
      expect(value().tillSeat).toBe(seat);
      // And it is timed again.
      vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
      expect(seam.lock).toHaveBeenCalledTimes(2);
      expect(value().keptOffer).toBeNull();
      await value().unlock(PASSWORD);

      value().continueKept();
      expect(value().locked).toBe(false);
      expect(value().keptOffer).toBeNull();
      expect(value().tillSeat).toBe(seat);
      expect(value().reseat).toBe(1);
    } finally { hook.unmount(); }
  });

  it('the offer locked from elsewhere (a 423 on any request) asks for the password first too', async () => {
    const { hook, value } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      const offered = value().keptOffer;
      window.dispatchEvent(new Event('oto:session-locked'));
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(true);
      await value().unlock(PASSWORD);
      expect(value().keptOffer).toEqual(offered);
      expect(value().locked).toBe(true);
    } finally { hook.unmount(); }
  });

  it('their own session ends before they choose: the sale stays its first owner’s and is offered again, never made theirs', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      const offered = value().keptOffer;
      expect(offered?.startedBy).toBe(ANN.name);

      // Ben's session ends (Sign out everywhere, a password reset) with the offer unanswered.
      vi.setSystemTime(Date.now() + 60_000);
      refused();
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(true);
      expect(value().tillSeat).toBe(seat);
      expect(value().sessionEnded).toEqual({ name: BEN.name, expired: false, afterHours: 12, saleKept: true });

      // Ben signs in again: offered again, as Ann's sale, with Ann's times; still locked over it.
      vi.setSystemTime(Date.now() + 60_000);
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().operator?.id).toBe(BEN.id);
      expect(value().keptOffer).toEqual(offered);
      expect(value().locked).toBe(true);
      expect(value().tillSeat).toBe(seat);

      // It ends again, and Ann signs in: her own sale, carried on at once.
      vi.setSystemTime(Date.now() + 60_000);
      refused();
      who = { ...ANN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
      expect(value().tillSeat).toBe(seat);
    } finally { hook.unmount(); }
  });

  it('once they press Continue the sale is theirs: a later end offers it to the next person as theirs', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      value().continueKept();
      vi.setSystemTime(Date.now() + 60_000);
      refused();
      expect(value().sessionEnded?.name).toBe(BEN.name);
      // Ben again: his own sale now, carried on with no offer.
      vi.setSystemTime(Date.now() + 60_000);
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
      expect(value().tillSeat).toBe(seat);
    } finally { hook.unmount(); }
  });

  it('discarding it starts a fresh till for them', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).not.toBeNull();
      value().discardKept();
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
      expect(value().tillSeat).not.toBe(seat);
      expect(value().tillSeat?.startsWith(`${BEN.id}#`)).toBe(true);
    } finally { hook.unmount(); }
  });

  it('SECURITY: a person who may not sell is not offered it: a fresh till', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      grants = ['pos:sale:read'];
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
      expect(value().tillSeat).not.toBe(seat);
      expect(value().reseat).toBe(0);
    } finally { hook.unmount(); }
  });

  it('SECURITY: never across a park or an operator, even for the same person', async () => {
    for (const elsewhere of [{ branchId: 'zz-test-other-park' }, { operatorId: 'zz-test-other-operator' }]) {
      const { hook, value, seat } = await endedMidCart();
      try {
        who = { ...ANN, branchId: 'zz-test-park', operatorId: 'zz-test-operator', ...elsewhere };
        await value().signIn('ZZ TEST phone', PASSWORD);
        expect(value().keptOffer).toBeNull();
        expect(value().tillSeat).not.toBe(seat);
        expect(value().locked).toBe(false);
      } finally {
        hook.unmount();
        who = { ...ANN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      }
    }
  });

  it('a temporary password issued mid-shift (it ends every session): the same person’s sign-in is a fresh one, the station is not taken again', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      owesPasswordChange = true;
      await value().signIn('ZZ TEST phone', 'ZZ TEST temporary password');
      expect(value().operator?.id).toBe(ANN.id);
      expect(value().mustChangePassword).toBe(true);
      // The change-password form, and nothing else: no line, no offer, a new screen.
      expect(value().locked).toBe(false);
      expect(value().sessionEnded).toBeNull();
      expect(value().keptOffer).toBeNull();
      expect(value().tillSeat).not.toBe(seat);
      expect(value().tillSeat?.startsWith(`${ANN.id}#`)).toBe(true);
      // Never asks the platform for the station while it refuses every station question.
      expect(value().reseat).toBe(0);
    } finally { hook.unmount(); }
  });

  it('a temporary password for a different person: no offer, a fresh screen, no station taken again', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      owesPasswordChange = true;
      await value().signIn('ZZ TEST other phone', 'ZZ TEST temporary password');
      expect(value().operator?.id).toBe(BEN.id);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
      expect(value().tillSeat).not.toBe(seat);
      expect(value().reseat).toBe(0);
    } finally { hook.unmount(); }
  });

  it('the trading day ends: the next morning’s sign-in starts fresh, even for the same person', async () => {
    const { hook, value, seat } = await endedMidCart();
    try {
      vi.setSystemTime(T0 + 24 * 3_600_000);
      await value().signIn('ZZ TEST phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().tillSeat).not.toBe(seat);
      expect(value().locked).toBe(false);
    } finally { hook.unmount(); }
  });
});

describe('SCRUM-878 — the security rules', () => {
  it('signing out on purpose keeps nothing: no line, no kept sale, nothing offered to the next person', async () => {
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake('till', true);
      value().logout();
      expect(value().operator).toBeNull();
      expect(value().sessionEnded).toBeNull();
      expect(value().keptOffer).toBeNull();
      expect(value().tillSeat).toBeNull();
      // A refusal after the sign-out is nobody's session ending.
      refused();
      expect(value().sessionEnded).toBeNull();

      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
      expect(value().tillSeat?.startsWith(`${BEN.id}#`)).toBe(true);
    } finally { hook.unmount(); }
  });

  it('a sign-out after an ended session ends it for good: the next person is offered nothing', async () => {
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake('till', true);
      pastTheMark();
      refused();
      expect(value().sessionEnded).not.toBeNull();
      value().logout();
      expect(value().sessionEnded).toBeNull();
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
    } finally { hook.unmount(); }
  });

  it('nothing is written anywhere, and no password, token or session value is kept with the sale', async () => {
    const { hook, value } = await endedThenOffered();
    try {
      // SCRUM-964 — the one thing written: this tab's record of the END for a reload at the
      // sign-in form (the line and who may have the screen), never the sale's contents. It said
      // nothing at all was written before the owner asked for the end to survive a reload.
      expect(writes.map((w) => `${w.store}:${w.key}`)).toEqual(['sessionStorage:oto.till.sessionEnded']);
      expect(writes[0]!.value.includes(PASSWORD)).toBe(false);
      expect(writes[0]!.value).not.toMatch(/token|password|cookie|session_?id|phone|nickname|member/i);
      const said = JSON.stringify({ ended: value().sessionEnded, offer: value().keptOffer });
      expect(said.includes(PASSWORD)).toBe(false);
      expect(said).not.toMatch(/token|password|cookie|session_?id/i);
    } finally { hook.unmount(); }

    async function endedThenOffered() {
      const till = await signedIn();
      setSaleAtStake('till', true);
      pastTheMark();
      refused();
      const ended = JSON.stringify(till.value().sessionEnded);
      expect(ended.includes(PASSWORD)).toBe(false);
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await till.value().signIn('ZZ TEST other phone', PASSWORD);
      return till;
    }
  });

  it('nothing of the kept sale is readable before a sign-in: the till stays locked over it and every selling screen draws nothing while locked', async () => {
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake('till', true);
      pastTheMark();
      refused();
      // Locked, with nobody able to do anything: the screen under it renders nothing.
      expect(value().locked).toBe(true);
      expect(value().can('pos:sale:read')).toBe(false);
      // The offer is only ever made to somebody who has signed in.
      expect(value().keptOffer).toBeNull();
    } finally { hook.unmount(); }
    const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
    for (const screen of ['pages/Till.tsx', 'pages/OrderStation.tsx', 'pages/MerchStation.tsx', 'components/mobile/MobileTill.tsx']) {
      expect(src(screen).includes('if (locked) return null;'), screen).toBe(true);
    }
  });

  it('a view-as window that ends goes back to the sign-in form as before: nothing kept', async () => {
    who = { ...ANN, branchId: 'zz-test-park', operatorId: 'zz-test-operator', impersonation: {
      id: 'zz', actor: { accountId: 'a', name: 'ZZ TEST support' }, subject: { accountId: ANN.id, name: ANN.name },
      targetApp: 'pos', mode: 'read_only', expiresAt: new Date(T0 + 3_600_000).toISOString() } };
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake('till', true);
      refused();
      expect(value().operator).toBeNull();
      expect(value().sessionEnded).toBeNull();
      expect(value().tillSeat).toBeNull();
    } finally { hook.unmount(); }
  });
});

describe('SCRUM-878 — a sale is kept only when there is something to lose', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8').replace(/\r\n/g, '\n');

  it('a finished sale still on screen, or a number only typed, is open for the shell update but not kept: nothing said, nothing offered', async () => {
    const { hook, value } = await signedIn();
    try {
      // What every selling screen says for a paid sale's result or a typed number.
      setSaleOpen('till', true);
      setSaleOpen('ticket-display', true);
      expect(getSaleOpen()).toBe(true);
      expect(saleOpenSince()).toBeNull();
      pastTheMark();
      refused();
      expect(value().sessionEnded?.saleKept).toBe(false);
      expect(sessionEndedLine(value().sessionEnded!)).toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on.');
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).toBeNull();
      expect(value().locked).toBe(false);
    } finally { hook.unmount(); }
  });

  it('counts from when the sale first had something at stake, and forgets it when it has none', () => {
    vi.setSystemTime(T0 + 60_000);
    setSaleAtStake('till', true);
    vi.setSystemTime(T0 + 120_000);
    setSaleAtStake('till', true);
    expect(saleOpenSince()).toBe(T0 + 60_000);
    setSaleAtStake('merch-station', true);
    expect(saleOpenSince()).toBe(T0 + 60_000);
    setSaleAtStake('till', false);
    expect(saleOpenSince()).toBe(T0 + 120_000);
    setSaleAtStake('merch-station', false);
    expect(saleOpenSince()).toBeNull();
  });

  it('each selling screen says so for a cart line, a member, a tier, a held voucher or a sale rung up, never for a finished sale', () => {
    const till = src('pages/Till.tsx');
    expect(till).toContain('const saleAtStake = saleResult === null && (rungUpUnpaid || lines.length > 0\n'
      + '    || voucher.held !== null || member !== null || tier !== null);');
    expect(till).toContain("setSaleAtStake('till', saleAtStake);");
    const phone = src('components/mobile/MobileTill.tsx');
    expect(phone).toContain('const saleAtStake = saleResult === null && (lines.length > 0 || member !== null || tier !== null);');
    expect(phone).toContain("setSaleAtStake('mobile-till', saleAtStake);");
    const fnb = src('pages/OrderStation.tsx');
    expect(fnb).toContain('const orderAtStake = completedOrder === null && (cart.length > 0 || voucher.held !== null);');
    expect(fnb).toContain("setSaleAtStake('order-station', orderAtStake);");
    const shop = src('pages/MerchStation.tsx');
    expect(shop).toContain('const saleAtStake = completedOrder === null && cart.length > 0;');
    expect(shop).toContain("setSaleAtStake('merch-station', saleAtStake);");
    // A customer display is never a sale started at the till.
    for (const screen of [till, phone]) expect(screen).not.toMatch(/setSaleAtStake\('[a-z-]*display'/);
  });
});

describe('SCRUM-878 — the gate keys the selling screen by its seat', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

  it('the counter, F&B and shop stations and the phone shell are kept by the seat, not by who is signed in', () => {
    const app = src('App.tsx');
    expect(app).toContain('const seat = tillSeat ?? operator.id;');
    expect(app).toContain('<Till key={`${seat}:${station?.branchId ?? \'\'}:${station?.stationId ?? \'legacy\'}`} />');
    expect(app).toContain('<OrderStation key={`${seat}:');
    expect(app).toContain('<MerchStation key={`${seat}:');
    expect(app).toContain('<div key={seat} className="contents" hidden={locked} inert={locked}');
    expect(app).not.toContain('key={`${operator.id}:');
  });
});

describe('SCRUM-964 — a rung-up sale on every selling surface, and a mark that is never stale', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8').replace(/\r\n/g, '\n');

  it.each([
    ['order-station', 'the counter’s F&B'],
    ['merch-station', 'the Shop, desk and phone'],
    ['mobile-fnb', 'the phone’s F&B'],
    ['mobile-till', 'the phone’s till'],
  ])('a sale rung up on %s (%s) is offered to another person to continue only, as the ticket till’s is', async (surface) => {
    const { hook, value } = await signedIn();
    try {
      setSaleAtStake(surface, true);
      setSaleRungUp(surface, `zz-test-${surface}-sale`);
      pastTheMark();
      refused();
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer?.rungUpSaleId).toBe(`zz-test-${surface}-sale`);
      expect(keptSaleOfferAsk(value().keptOffer!)).toBe('Continue it to read its payment back, then finish it or cancel it.');
    } finally { hook.unmount(); }
  });

  it('a mark stored for an earlier sale never makes a plain cart Continue-only, and a closed sale’s mark goes with it', async () => {
    const { hook, value } = await signedIn();
    try {
      // The ticket till remembered an earlier rung-up sale for a reload; the cart now is a plain one.
      rememberSaleOnScreen('zz-test-station', 'zz-test-sale-earlier');
      // The F&B order was rung up, then finished (its writer closed it): the mark goes.
      setSaleAtStake('order-station', true);
      setSaleRungUp('order-station', 'zz-test-fnb-finished');
      setSaleRungUp('order-station', null);
      setSaleAtStake('till', true);
      expect(saleRungUp()).toBeNull();
      pastTheMark();
      refused();
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await value().signIn('ZZ TEST other phone', PASSWORD);
      expect(value().keptOffer).not.toBeNull();
      expect(value().keptOffer?.rungUpSaleId).toBeUndefined();
      expect(keptSaleOfferAsk(value().keptOffer!)).toBe('Continue it, or discard it and start a new sale.');
    } finally { hook.unmount(); }
  });

  it('only a surface with a sale at stake names its rung-up sale; the writer’s states that are rung up', () => {
    setSaleRungUp('merch-station', 'zz-test-left-alone');
    expect(saleRungUp()).toBeNull();
    setSaleAtStake('merch-station', true);
    expect(saleRungUp()).toEqual({ surface: 'merch-station', saleId: 'zz-test-left-alone' });
    for (const kind of ['writing', 'committed', 'finalising']) expect(rungUpSaleOf({ kind, saleId: 's' })).toBe('s');
    expect(rungUpSaleOf({ kind: 'failed', saleId: 's', stage: 'finalise' })).toBe('s');
    for (const state of [{ kind: 'idle' }, { kind: 'written', saleId: 's' }, { kind: 'failed', saleId: 's', stage: 'commit' }, { kind: 'unwritten', saleId: 's' }]) {
      expect(rungUpSaleOf(state)).toBeNull();
    }
  });

  it('every selling surface says its rung-up sale from its own writer; the phone’s F&B is kept under a lock and says its sale at stake', () => {
    for (const [file, surface] of [
      ['pages/Till.tsx', 'till'], ['pages/OrderStation.tsx', 'order-station'], ['pages/MerchStation.tsx', 'merch-station'],
      ['components/mobile/MobileTill.tsx', 'mobile-till'], ['components/mobile/order-station/MobileOrderStation.tsx', 'mobile-fnb'],
    ] as const) {
      const text = src(file);
      expect(text, file).toContain('const rungUpNow = rungUpSaleOf(saleWriter.state);');
      expect(text, file).toContain(`setSaleRungUp('${surface}', rungUpNow);`);
    }
    const phoneFnb = src('components/mobile/order-station/MobileOrderStation.tsx');
    expect(phoneFnb).toContain("setSaleAtStake('mobile-fnb', orderAtStake);");
    expect(phoneFnb).toContain("setSaleOpen('mobile-fnb', orderOnScreen);");
    expect(phoneFnb).toContain('paused: locked,');
    const lockedReturn = phoneFnb.indexOf('if (locked) return null;');
    expect(lockedReturn).toBeGreaterThan(phoneFnb.indexOf('usePaymentStage({'));
    // No hook after it in the station itself (the small parts below it are components of their own).
    const stationEnd = phoneFnb.indexOf('\nfunction ', lockedReturn);
    expect(phoneFnb.slice(lockedReturn, stationEnd > 0 ? stationEnd : undefined)).not.toMatch(/\buse[A-Z]\w*\(/);
    expect(src('App.tsx')).toContain("const phoneOrderStation = isMobile && location === '/order-station';");
    // The offer reads the surfaces' own mark, never the one stored for a reload.
    expect(src('auth/OperatorContext.tsx')).not.toContain('saleOnScreen(');
  });
});

describe('SCRUM-964 — a reload at the sign-in form an ended session left', () => {
  /** The page goes and comes back: a new provider over the same tab's storage, with no session behind it. */
  async function reloaded() {
    seam.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in'));
    const page = mount();
    await vi.waitFor(() => expect(page.value().sessionResolved).toBe(true));
    // The next sign-in has a session again.
    seam.me.mockImplementation(async () => ({
      account: { id: who.id, phone: 'ZZ TEST', mustChangePassword: false, operatorId: who.operatorId },
      employee: { name: who.name }, branch: { id: who.branchId, code: 'zz-test-park' }, sessionLocked: false, impersonation: null,
      sessionEnd: { at: new Date(signedInAt + HOURS_12).toISOString(), inSeconds: 43_000, afterHours: 12 },
    }));
    return page;
  }

  async function endedRungUp() {
    const till = await signedIn();
    vi.setSystemTime(T0 + 11 * 3_600_000 + 35 * 60_000);
    setSaleAtStake('till', true);
    setSaleRungUp('till', 'zz-test-sale-964');
    pastTheMark();
    refused();
    expect(till.value().sessionEnded?.saleKept).toBe(true);
    // The tab reloads: the page and its memory go.
    till.hook.unmount();
    setSaleAtStake('till', false);
    setSaleRungUp('till', null);
    return reloaded();
  }

  it('the form still says the session ended; a sale the counter till rang up is still offered, and Continue opens it from the platform', async () => {
    const page = await endedRungUp();
    try {
      expect(page.value().operator).toBeNull();
      expect(page.value().sessionEnded).toEqual({ name: ANN.name, expired: true, afterHours: 12, saleKept: true });
      expect(sessionEndedLine(page.value().sessionEnded!))
        .toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on. The sale in progress is kept on this till.');
      seam.getSale.mockResolvedValue({ sale: { id: 'zz-test-sale-964', status: 'tendering', stationId: 'zz-test-station' } });
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await page.value().signIn('ZZ TEST other phone', PASSWORD);
      expect(seam.getSale).toHaveBeenCalledWith('zz-test-sale-964');
      expect(page.value().keptOffer).toMatchObject({ startedBy: ANN.name, rungUpSaleId: 'zz-test-sale-964', stationId: 'zz-test-station' });
      expect(page.value().keptResume).toBeNull();
      page.value().continueKept();
      expect(page.value().locked).toBe(false);
      expect(page.value().keptResume).toBe('zz-test-sale-964');
      page.value().takeKeptResume();
      expect(page.value().keptResume).toBeNull();
    } finally { page.hook.unmount(); }
  });

  it('the same person after the reload carries on: no offer, and the till opens the sale again', async () => {
    const page = await endedRungUp();
    try {
      seam.getSale.mockResolvedValue({ sale: { id: 'zz-test-sale-964', status: 'tendering', stationId: 'zz-test-station' } });
      await page.value().signIn('ZZ TEST phone', PASSWORD);
      expect(page.value().keptOffer).toBeNull();
      expect(page.value().locked).toBe(false);
      expect(page.value().keptResume).toBe('zz-test-sale-964');
    } finally { page.hook.unmount(); }
  });

  it('a sale paid or voided meanwhile is not offered: a fresh till', async () => {
    const page = await endedRungUp();
    try {
      seam.getSale.mockResolvedValue({ sale: { id: 'zz-test-sale-964', status: 'finalised', stationId: 'zz-test-station' } });
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await page.value().signIn('ZZ TEST other phone', PASSWORD);
      expect(page.value().keptOffer).toBeNull();
      expect(page.value().keptResume).toBeNull();
      expect(page.value().locked).toBe(false);
    } finally { page.hook.unmount(); }
  });

  it('an unwritten cart cannot survive the reload: the form says the session ended and never that a sale is kept; nothing is offered', async () => {
    const till = await signedIn();
    setSaleAtStake('till', true);
    pastTheMark();
    refused();
    expect(till.value().sessionEnded?.saleKept).toBe(true);
    till.hook.unmount();
    setSaleAtStake('till', false);
    const page = await reloaded();
    try {
      expect(page.value().sessionEnded).toEqual({ name: ANN.name, expired: true, afterHours: 12, saleKept: false });
      expect(sessionEndedLine(page.value().sessionEnded!)).toBe('The session of ZZ TEST Ann ended after twelve hours. Sign in again to carry on.');
      who = { ...BEN, branchId: 'zz-test-park', operatorId: 'zz-test-operator' };
      await page.value().signIn('ZZ TEST other phone', PASSWORD);
      expect(page.value().keptOffer).toBeNull();
      expect(page.value().locked).toBe(false);
      expect(seam.getSale).not.toHaveBeenCalled();
    } finally { page.hook.unmount(); }
  });

  it('an F&B order rung up cannot be opened again after a reload: the form says only that the session ended', async () => {
    const till = await signedIn();
    setSaleAtStake('order-station', true);
    setSaleRungUp('order-station', 'zz-test-fnb');
    pastTheMark();
    refused();
    till.hook.unmount();
    setSaleAtStake('order-station', false);
    setSaleRungUp('order-station', null);
    const page = await reloaded();
    try {
      expect(page.value().sessionEnded?.saleKept).toBe(false);
    } finally { page.hook.unmount(); }
  });

  it('a sign-in takes the end, and a sign-out keeps nothing of it', async () => {
    const till = await signedIn();
    setSaleAtStake('till', true);
    setSaleRungUp('till', 'zz-test-sale-964');
    pastTheMark();
    refused();
    expect(sessionStorage.getItem('oto.till.sessionEnded')).not.toBeNull();
    await till.value().signIn('ZZ TEST phone', PASSWORD);
    expect(sessionStorage.getItem('oto.till.sessionEnded')).toBeNull();
    till.value().logout();
    expect(sessionStorage.getItem('oto.till.sessionEnded')).toBeNull();
    till.hook.unmount();
  });
});
