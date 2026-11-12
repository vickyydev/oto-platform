import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';
import { ApiError } from '@/api/client';
import { setSaleOpen } from '@/pwa/openSale';
import {
  afterSignIn,
  clockTime,
  endedByExpiry,
  hoursInWords,
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
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vi.stubGlobal('window', browser);
  return {
    browser, me: vi.fn(), permissions: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), onlineUnlock: vi.fn(), lock: vi.fn(),
    setLang: vi.fn(), setTheme: vi.fn(), boxLock: vi.fn(async (_station: string) => undefined),
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
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
    setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
      expect(writes).toEqual([]);
      const said = JSON.stringify({ ended: value().sessionEnded, offer: value().keptOffer });
      expect(said.includes(PASSWORD)).toBe(false);
      expect(said).not.toMatch(/token|password|cookie|session_?id/i);
    } finally { hook.unmount(); }

    async function endedThenOffered() {
      const till = await signedIn();
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
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
      setSaleOpen('till', true);
      refused();
      expect(value().operator).toBeNull();
      expect(value().sessionEnded).toBeNull();
      expect(value().tillSeat).toBeNull();
    } finally { hook.unmount(); }
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
