import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';
import { ApiError } from '@/api/client';

/**
 * SCRUM-744, second part — WHAT A LOCKED RELOAD READS BESIDES THE STATION.
 *
 * A reload at the lock screen resumes the session: `/me` and
 * `/me/permissions` answer a locked session, but the park list and the
 * catalogue behind them are refused with 423 SESSION_LOCKED. That refusal is
 * not an answer. The till reads the whole session again at the unlock, or it
 * keeps the POS's built-in sample park with its sample tickets and prices. A
 * lock in the middle of a shift read everything before it locked, so its
 * unlock reads nothing again and the sale under the lock is untouched.
 */

const seam = vi.hoisted(() => {
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vi.stubGlobal('window', browser);
  return { browser, serverLocked: false, me: vi.fn(), permissions: vi.fn(), onlineUnlock: vi.fn(), lock: vi.fn(),
    catalog: vi.fn(), prepared: vi.fn(), setLang: vi.fn(), setTheme: vi.fn() };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getOperatorThemePref: () => null }));
vi.mock('@/lib/themePref', () => ({ staffThemeController: { adopt: vi.fn(), release: vi.fn() }, useCustomerTheme: () => ['light', seam.setTheme] }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ setLang: seam.setLang }) }));
vi.mock('@/api/platform', () => ({ authApi: { me: seam.me, permissions: seam.permissions, unlock: seam.onlineUnlock,
  lock: seam.lock, signIn: async () => ({}), signOut: async () => ({}) } }));
vi.mock('@/api/bridge', () => ({ setBridgeStaffName: vi.fn(), holdBoxSession: vi.fn(), prepareConfiguredBridgeUnlock: () => null,
  bridgeApi: { lock: async () => ({}), unlock: vi.fn() },
}));
vi.mock('@/auth/staffToken', () => ({ readStaffToken: () => null, staffTokenLive: () => false, forgetStaffToken: vi.fn() }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', laneStation: () => 'zz-test-station', isBoxLaneTrigger: () => false,
  noteLaneFailure: vi.fn(), platformNeedsUnlock: () => false, refreshLane: async () => 'platform', platformUnlocked: vi.fn() }));
vi.mock('@/api/catalogBridge', () => ({ loadCatalogFromApi: seam.catalog, restorePreparedCatalog: vi.fn() }));
vi.mock('@/lib/displaySession', () => ({ takeTicketDisplayLeaseForSignOut: async () => null }));
vi.mock('@/auth/offlinePreparation', () => ({ forgetOfflinePreparation: vi.fn(), prepareOfflineOperator: seam.prepared,
  readOfflinePreparation: () => null }));
Object.assign(globalThis, { React });

const lockedRefusal = () => new ApiError(423, 'SESSION_LOCKED', 'This session is locked, unlock to continue');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', seam.browser);
  seam.serverLocked = false;
  seam.me.mockImplementation(async () => ({
    account: { id: 'zz-test-person', phone: 'ZZ TEST', mustChangePassword: false },
    employee: { name: 'ZZ TEST reception' }, branch: { code: 'zz-test-park' }, sessionLocked: seam.serverLocked,
  }));
  seam.permissions.mockResolvedValue({ permissions: [{ permission: 'pos:sale:read' }] });
  // The api refuses the park list and the catalogue to a locked session.
  seam.catalog.mockImplementation(async () => { if (seam.serverLocked) throw lockedRefusal(); });
  seam.onlineUnlock.mockImplementation(async () => { seam.serverLocked = false; return {}; });
  seam.lock.mockImplementation(async () => { seam.serverLocked = true; return {}; });
});
afterEach(() => vi.clearAllMocks());

function mount() {
  const hook = renderHook(() => OperatorProvider({ children: null }));
  const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
  return { hook, value };
}

describe('SCRUM-744: the session a locked reload reads', () => {
  it('HIGH: a catalogue refused by the lock is read again, with the whole session, at the unlock', async () => {
    seam.serverLocked = true;
    const { hook, value } = mount();
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      expect(value().locked).toBe(true);
      expect(value().operator?.id).toBe('zz-test-person');
      expect(seam.catalog).toHaveBeenCalledTimes(1);
      // Not prepared for an outage from the sample catalogue.
      expect(seam.prepared).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'zz-test-person' }), false);

      await value().unlock('ZZ TEST synthetic input');
      expect(seam.onlineUnlock).toHaveBeenCalledExactlyOnceWith('ZZ TEST synthetic input');
      expect(seam.me).toHaveBeenCalledTimes(2);
      expect(seam.permissions).toHaveBeenCalledTimes(2);
      expect(seam.catalog.mock.calls).toEqual([['zz-test-park'], ['zz-test-park']]);
      expect(value().locked).toBe(false);
      expect(value().can('pos:sale:read')).toBe(true);
      expect(seam.prepared).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'zz-test-person' }), true);

      // Read once: the next lock and unlock read nothing again.
      value().lockNow();
      await vi.waitFor(() => expect(seam.serverLocked).toBe(true));
      await value().unlock('ZZ TEST synthetic input');
      expect(seam.me).toHaveBeenCalledTimes(2);
      expect(seam.catalog).toHaveBeenCalledTimes(2);
      expect(value().locked).toBe(false);
    } finally { hook.unmount(); }
  });

  it('HIGH: a lock in the middle of a shift reads nothing again at the unlock', async () => {
    const { hook, value } = mount();
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      expect(value().locked).toBe(false);
      const operator = value().operator;
      expect(seam.catalog).toHaveBeenCalledTimes(1);

      value().lockNow();
      expect(value().locked).toBe(true);
      await vi.waitFor(() => expect(seam.serverLocked).toBe(true));
      await value().unlock('ZZ TEST synthetic input');
      expect(value().locked).toBe(false);
      expect(seam.me).toHaveBeenCalledTimes(1);
      expect(seam.permissions).toHaveBeenCalledTimes(1);
      expect(seam.catalog).toHaveBeenCalledTimes(1);
      // The same operator, so nothing keyed on it starts again.
      expect(value().operator).toBe(operator);
    } finally { hook.unmount(); }
  });

  it('an unlock whose session read cannot finish stays locked and reads again at the next unlock', async () => {
    seam.serverLocked = true;
    const { hook, value } = mount();
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      const failure = new ApiError(503, 'UNAVAILABLE', 'Unavailable');
      seam.me.mockRejectedValueOnce(failure);
      await expect(value().unlock('ZZ TEST synthetic input')).rejects.toBe(failure);
      expect(value().locked).toBe(true);
      expect(seam.catalog).toHaveBeenCalledTimes(1);

      await value().unlock('ZZ TEST synthetic input');
      expect(value().locked).toBe(false);
      expect(seam.catalog).toHaveBeenCalledTimes(2);
      expect(seam.catalog).toHaveBeenLastCalledWith('zz-test-park');
    } finally { hook.unmount(); }
  });
});
