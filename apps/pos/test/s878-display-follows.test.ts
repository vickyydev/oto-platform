import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import { renderHook } from './support/hooks';

/**
 * SCRUM-878 — THE CUSTOMER DISPLAY FOLLOWS THE SALE AGAIN ONCE THE SESSION IS
 * CARRIED ON.
 *
 * A staff session that ends keeps the till's screen under the lock, and the
 * till publishes to its paired display only while it is not locked (`Till.tsx`
 * passes `!locked` to `useTicketDisplay`). So while nobody is signed in the
 * display is told nothing new, and once the same person signs in again on
 * that till the display follows the same screen at the same station, with
 * the lease the till already held.
 *
 * The operator's session (`OperatorContext`) and the display publisher
 * (`lib/displaySession`) are the real ones; the platform and the counter's
 * box are fakes keeping their contracts (the box's compare-and-set, as
 * `test/s720-publisher.test.ts` keeps it).
 */

const T0 = Date.UTC(2026, 10, 12, 1, 30);
const STATION = 'zz-test-station';
const ANN = { id: 'zz-test-ann', name: 'ZZ TEST Ann' };

const seam = vi.hoisted(() => {
  // The page's timers are read when called, so they run on the test clock.
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' },
    setTimeout: (run: () => void, ms?: number) => globalThis.setTimeout(run, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    setInterval: (run: () => void, ms?: number) => globalThis.setInterval(run, ms),
    clearInterval: (id?: ReturnType<typeof setInterval>) => globalThis.clearInterval(id),
  });
  vi.stubGlobal('window', browser);
  return {
    browser, me: vi.fn(), permissions: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), lock: vi.fn(), unlock: vi.fn(),
    setLang: vi.fn(), setTheme: vi.fn(), get: vi.fn(),
    box: { lease: vi.fn(), renew: vi.fn(), session: vi.fn(), publish: vi.fn(), release: vi.fn(), watch: vi.fn(),
      displays: vi.fn(), lock: vi.fn(async () => undefined), unlock: vi.fn() },
  };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getOperatorThemePref: () => null }));
vi.mock('@/lib/themePref', () => ({ staffThemeController: { adopt: vi.fn(), release: vi.fn() }, useCustomerTheme: () => ['light', seam.setTheme] }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ setLang: seam.setLang }) }));
vi.mock('@/api/platform', () => ({ authApi: { me: seam.me, permissions: seam.permissions, unlock: seam.unlock,
  lock: seam.lock, signIn: seam.signIn, signOut: seam.signOut } }));
vi.mock('@/api/bridge', () => ({ bridgeApi: seam.box, watchBridgeSnapshots: seam.box.watch, hasBridgeOrigin: () => false,
  setBridgeStaffName: vi.fn(), holdBoxSession: vi.fn(), prepareConfiguredBridgeUnlock: () => null }));
vi.mock('@/api/client', async () => ({ ...await vi.importActual<typeof import('@/api/client')>('@/api/client'), api: { get: seam.get } }));
vi.mock('@/auth/staffToken', () => ({ readStaffToken: () => null, staffTokenLive: () => false, forgetStaffToken: vi.fn() }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', laneStation: () => STATION, isBoxLaneTrigger: () => false,
  noteLaneFailure: vi.fn(), platformNeedsUnlock: () => false, refreshLane: async () => 'platform', platformUnlocked: vi.fn() }));
vi.mock('@/api/catalogBridge', () => ({ loadCatalogFromApi: async () => undefined, restorePreparedCatalog: vi.fn() }));
vi.mock('@/auth/offlinePreparation', () => ({ forgetOfflinePreparation: vi.fn(), prepareOfflineOperator: vi.fn(),
  readOfflinePreparation: () => null }));

import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';
import { DISPLAY_HANDOVER_WAIT, useTicketDisplay, type TicketDisplayState } from '@/lib/displaySession';
import { ApiError } from '@/api/client';
import { lockedFamilyForm, lockedFamilyFormLine, useLockedFamilyFormWatch } from '@/lib/lockedFamilyForm';
import { setSaleAtStake } from '@/pwa/openSale';

Object.assign(globalThis, { React });

/** The station's document on the box, with its compare-and-set. */
let box: StationSessionDocument;
let leases = 0;
let signedInAt = T0;

/** What the till publishes for the visitor at its counter (`Till.tsx`), named so a change is visible. */
const screen = (nickname: string): TicketDisplayState => ({ stage: 'identify', step: 1, sessionKey: 'visitor', tier: 'tourist',
  phone: '', nickname, contactChannel: 'whatsapp', member: null, online: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  vi.stubGlobal('window', seam.browser);
  leases = 0;
  signedInAt = T0;
  box = { stationId: STATION, boxId: 'box', schemaVersion: 1, sequence: 100, stage: 'identify', language: 'en', lease: null,
    takeoverCount: 0, updatedAt: '2026-11-12T01:30:00Z' };
  seam.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST display', connected: true }] });
  seam.box.lease.mockImplementation(async () => {
    leases += 1;
    box = { ...box, sequence: box.sequence + 1, lease: { leaseId: `lease-${leases}`, holder: 'till', holderKind: 'till',
      accountId: ANN.id, startedAt: '2026-11-12T01:30:00Z', heartbeatAt: '2026-11-12T01:30:00Z', expiresAt: '2026-11-12T01:31:00Z' } };
    return { lease: { leaseId: box.lease!.leaseId }, document: box };
  });
  seam.box.session.mockImplementation(async () => ({ document: box }));
  seam.box.renew.mockImplementation(async () => ({ document: box }));
  seam.box.publish.mockImplementation(async (_station: string, intent: { leaseId: string; lastSeenSequence: number; payload: Record<string, unknown> }) => {
    box = { ...box, ...intent.payload, sequence: box.sequence + 1 };
    return { document: box };
  });
  seam.box.release.mockResolvedValue({ released: true });
  seam.box.watch.mockImplementation(() => () => undefined);
  seam.me.mockImplementation(async () => ({
    account: { id: ANN.id, phone: 'ZZ TEST', mustChangePassword: false, operatorId: 'zz-test-operator' },
    employee: { name: ANN.name }, branch: { id: 'zz-test-park', code: 'zz-test-park' }, sessionLocked: false, impersonation: null,
    sessionEnd: { at: new Date(signedInAt + 12 * 3_600_000).toISOString(),
      inSeconds: Math.max(0, Math.floor((signedInAt + 12 * 3_600_000 - Date.now()) / 1000)), afterHours: 12 },
  }));
  seam.permissions.mockResolvedValue({ permissions: [{ permission: 'pos:sale:create' }, { permission: 'pos:sale:read' }] });
  seam.signIn.mockImplementation(async () => { signedInAt = Date.now(); return {}; });
  seam.lock.mockResolvedValue({});
});
afterEach(() => {
  setSaleAtStake('till', false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('window', seam.browser);
});

describe('SCRUM-878 — the customer display after a session that ended', () => {
  it('says nothing new while nobody is signed in, and follows the same screen at the same station once the same person carries on', async () => {
    const provider = renderHook(() => OperatorProvider({ children: null }));
    const operator = () => provider.result.current.props.value as ReturnType<typeof useOperator>;
    await vi.advanceTimersByTimeAsync(0);
    expect(operator().operator?.id).toBe(ANN.id);
    const seat = operator().tillSeat;
    // The Tickets screen publishes while the till is not locked, as `Till.tsx` does (`!locked`).
    const display = renderHook((props: { shown: TicketDisplayState; active: boolean }) =>
      useTicketDisplay(STATION, props.shown, vi.fn(), props.active), { shown: screen('ZZ TEST cart'), active: !operator().locked });
    try {
      setSaleAtStake('till', true);
      await vi.advanceTimersByTimeAsync(100);
      expect(box.prompt?.nickname).toBe('ZZ TEST cart');
      expect(seam.box.lease).toHaveBeenCalledOnce();

      // The session ends on the platform: the till locks over its screen, and the display is told nothing.
      vi.setSystemTime(Date.now() + 3 * 3_600_000);
      window.dispatchEvent(new Event('oto:unauthorized'));
      expect(operator().locked).toBe(true);
      expect(operator().sessionEnded?.saleKept).toBe(true);
      display.rerender({ shown: screen('ZZ TEST cart'), active: !operator().locked });
      const publishedBefore = seam.box.publish.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seam.box.publish).toHaveBeenCalledTimes(publishedBefore);

      // The same person signs in again on this till: the same screen, unlocked.
      await operator().signIn('ZZ TEST phone', 'ZZ TEST synthetic password');
      expect(operator().locked).toBe(false);
      expect(operator().tillSeat).toBe(seat);
      display.rerender({ shown: screen('ZZ TEST cart'), active: !operator().locked });
      await vi.advanceTimersByTimeAsync(100);
      // Staff carry on with the sale, and the display follows it at once.
      display.rerender({ shown: screen('ZZ TEST cart, one more line'), active: !operator().locked });
      await vi.advanceTimersByTimeAsync(100);
      expect(box.prompt?.nickname).toBe('ZZ TEST cart, one more line');
      expect(seam.box.publish.mock.calls.length).toBeGreaterThan(publishedBefore);
      // The same station, and the lease the till already held: nobody else's display took over.
      expect(seam.box.publish.mock.calls.every(([station]) => station === STATION)).toBe(true);
      expect(seam.box.lease).toHaveBeenCalledOnce();
      expect(seam.box.release).not.toHaveBeenCalled();
    } finally {
      display.unmount();
      provider.unmount();
    }
  });
});

describe('SCRUM-964 — the display follows a DIFFERENT person who continues the kept sale', () => {
  const BEN = { id: 'zz-test-ben', name: 'ZZ TEST Ben' };
  const TTL_MS = 60_000;

  it('B continues A’s kept sale: never renewed or published under A’s lease, then B’s own lease and the sale on the display as B has it', async () => {
    let who = ANN;
    /** The account the till's requests carry (its session cookie); null once the session has ended. */
    let cookie: string | null = ANN.id;
    seam.me.mockImplementation(async () => {
      if (!cookie) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
      return {
        account: { id: who.id, phone: 'ZZ TEST', mustChangePassword: false, operatorId: 'zz-test-operator' },
        employee: { name: who.name }, branch: { id: 'zz-test-park', code: 'zz-test-park' }, sessionLocked: false, impersonation: null,
        sessionEnd: { at: new Date(signedInAt + 12 * 3_600_000).toISOString(), inSeconds: 43_000, afterHours: 12 },
      };
    });
    seam.signIn.mockImplementation(async () => { signedInAt = Date.now(); cookie = who.id; return {}; });
    // The box as `packages/box-agent/src/station-session.ts` answers: a lease is the account's that claimed it.
    const refuse = (status: number, code: string, message: string) => new ApiError(status, code, message, { document: box });
    const live = () => box.lease !== null && Date.parse(box.lease.expiresAt) > Date.now();
    seam.box.lease.mockImplementation(async (_station: string, holder: string) => {
      const held = box.lease;
      const same = held !== null && held.holder === holder && held.accountId === cookie;
      if (live() && !same) throw refuse(409, 'STATION_NO_LEASE', 'Another till is using this station. A manager can take it over.');
      leases += 1;
      box = { ...box, sequence: box.sequence + 1, lease: { leaseId: `lease-${leases}`, holder, holderKind: 'till', accountId: cookie,
        startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString() } };
      return { lease: { leaseId: box.lease!.leaseId }, document: box };
    });
    seam.box.renew.mockImplementation(async (_station: string, leaseId: string) => {
      if (box.lease?.leaseId !== leaseId) throw refuse(409, 'STATION_STALE', 'Session moved to another till.');
      if (box.lease.accountId !== cookie) throw refuse(403, 'STATION_NOT_PERMITTED', 'Another till is holding this station. A manager can take it over.');
      box = { ...box, lease: { ...box.lease, expiresAt: new Date(Date.now() + TTL_MS).toISOString() } };
      return { document: box };
    });
    seam.box.publish.mockImplementation(async (_station: string, intent: { leaseId: string; payload: Record<string, unknown> }) => {
      if (box.lease?.leaseId !== intent.leaseId) throw refuse(409, 'STATION_STALE', 'Session moved to another till.');
      if (box.lease.accountId !== cookie) throw refuse(403, 'STATION_NOT_PERMITTED', 'Another till is holding this station. A manager can take it over.');
      box = { ...box, ...intent.payload, sequence: box.sequence + 1 };
      return { document: box };
    });

    const provider = renderHook(() => OperatorProvider({ children: null }));
    const operator = () => provider.result.current.props.value as ReturnType<typeof useOperator>;
    await vi.advanceTimersByTimeAsync(0);
    const display = renderHook((props: { shown: TicketDisplayState; active: boolean }) =>
      useTicketDisplay(STATION, props.shown, vi.fn(), props.active), { shown: screen('ZZ TEST A’s cart'), active: !operator().locked });
    try {
      setSaleAtStake('till', true);
      await vi.advanceTimersByTimeAsync(100);
      expect(box.lease?.accountId).toBe(ANN.id);
      expect(box.prompt?.nickname).toBe('ZZ TEST A’s cart');

      // A's session is ended from elsewhere: the till locks over the sale; A's calls answer 401.
      cookie = null;
      window.dispatchEvent(new Event('oto:unauthorized'));
      expect(operator().sessionEnded?.saleKept).toBe(true);
      display.rerender({ shown: screen('ZZ TEST A’s cart'), active: !operator().locked });

      // B signs in on the same till and continues the sale.
      who = { id: BEN.id, name: BEN.name };
      await operator().signIn('ZZ TEST other phone', 'ZZ TEST synthetic password');
      expect(operator().keptOffer?.startedBy).toBe(ANN.name);
      operator().continueKept();
      expect(operator().locked).toBe(false);
      const renews = seam.box.renew.mock.calls.length;
      const publishes = seam.box.publish.mock.calls.length;
      display.rerender({ shown: screen('ZZ TEST A’s cart, B’s second kid'), active: !operator().locked });
      await vi.advanceTimersByTimeAsync(200);
      // Nothing under A's lease as B; the till names the wait truthfully.
      expect(seam.box.renew.mock.calls.slice(renews)).toEqual([]);
      expect(seam.box.publish.mock.calls.slice(publishes)).toEqual([]);
      expect(display.result.current.error).toBe(DISPLAY_HANDOVER_WAIT);
      expect(box.lease?.accountId).toBe(ANN.id);

      // The box frees A's lease 60 s after it was last renewed: B's lease, and B's sale on the display.
      await vi.advanceTimersByTimeAsync(TTL_MS - 1_000);
      expect(box.lease?.accountId).toBe(ANN.id);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(box.lease?.accountId).toBe(BEN.id);
      expect(box.prompt?.nickname).toBe('ZZ TEST A’s cart, B’s second kid');
      expect(display.result.current.error).toBeNull();
    } finally {
      display.unmount();
      provider.unmount();
    }
  });
});

describe('SCRUM-964 (point 2) — the family form line under an ENDED session, through the real path', () => {
  const FAMILY_LINE = 'A family is filling in the drop-off form on the display.';

  it('the session ends while the family fills the form: the presence read is refused 401, the till locks, and the line is on the sign-in form', async () => {
    // The box's status read, which a locked till asks: refused too once the session has gone.
    const status = vi.fn(async () => { throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in'); });
    Object.assign(seam.box, { status });
    const provider = renderHook(() => OperatorProvider({ children: null }));
    const operator = () => provider.result.current.props.value as ReturnType<typeof useOperator>;
    await vi.advanceTimersByTimeAsync(0);
    // The family's form on the paired display, as `Till.tsx` composes it: open while the
    // display link covers it (no error, a display watching), and watched while locked.
    const till = renderHook((props: { locked: boolean; ended: boolean }) => {
      const linked = useTicketDisplay(STATION, screen('ZZ TEST family typing'), vi.fn(), !props.locked);
      const inlineDisplay = !linked.connected.length || !linked.supported || !!linked.error;
      useLockedFamilyFormWatch({ locked: props.locked, stationId: STATION, formOpen: !inlineDisplay, ended: props.ended });
      return linked;
    }, { locked: false, ended: false });
    try {
      setSaleAtStake('till', true);
      await vi.advanceTimersByTimeAsync(100);
      expect(till.result.current.connected).toHaveLength(1);
      expect(lockedFamilyForm.get()).toBeNull();

      // The platform ends the session: the next platform read is refused 401, which the till's
      // client turns into `oto:unauthorized` before it throws (`api/client.ts`), as on staging.
      seam.get.mockImplementation(async () => {
        window.dispatchEvent(new CustomEvent('oto:unauthorized', { detail: { sentAt: Date.now() } }));
        throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(operator().locked).toBe(true);
      expect(operator().sessionEnded).not.toBeNull();
      till.rerender({ locked: operator().locked, ended: !!operator().sessionEnded });
      expect(lockedFamilyFormLine(lockedFamilyForm.get())).toBe(FAMILY_LINE);
      // Read over 12 s, as the proof did: the status reads are refused and the line stands.
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(4_000);
        expect(lockedFamilyFormLine(lockedFamilyForm.get())).toBe(FAMILY_LINE);
      }
      expect(status).toHaveBeenCalled();

      // The same person signs in: the till shows the form itself, and the line goes.
      seam.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST display', connected: true }] });
      await operator().signIn('ZZ TEST phone', 'ZZ TEST synthetic password');
      till.rerender({ locked: operator().locked, ended: !!operator().sessionEnded });
      expect(lockedFamilyForm.get()).toBeNull();
    } finally {
      till.unmount();
      provider.unmount();
    }
    expect(lockedFamilyForm.get()).toBeNull();
  });

  it('discarded by the next person, the kept screen goes and the line with it', async () => {
    const provider = renderHook(() => OperatorProvider({ children: null }));
    const operator = () => provider.result.current.props.value as ReturnType<typeof useOperator>;
    await vi.advanceTimersByTimeAsync(0);
    const till = renderHook((props: { locked: boolean; ended: boolean }) => {
      useLockedFamilyFormWatch({ locked: props.locked, stationId: null, formOpen: !props.locked, ended: props.ended });
    }, { locked: false, ended: false });
    setSaleAtStake('till', true);
    window.dispatchEvent(new Event('oto:unauthorized'));
    till.rerender({ locked: operator().locked, ended: !!operator().sessionEnded });
    expect(lockedFamilyFormLine(lockedFamilyForm.get())).toBe(FAMILY_LINE);
    // Discard gives a fresh seat: `App.tsx` mounts a new till, and the kept one goes.
    till.unmount();
    expect(lockedFamilyForm.get()).toBeNull();
    provider.unmount();
  });
});
