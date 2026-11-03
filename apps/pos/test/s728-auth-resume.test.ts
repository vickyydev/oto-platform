import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';
import { ApiError, NetworkError } from '@/api/client';

const seam = vi.hoisted(() => {
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vi.stubGlobal('window', browser);
  return { browser, me: vi.fn(), unlock: vi.fn(), forgotten: vi.fn(), restored: vi.fn(),
    setLang: vi.fn(), setTheme: vi.fn(), hold: vi.fn() };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getOperatorThemePref: () => null }));
vi.mock('@/lib/themePref', () => ({ staffThemeController: { adopt: vi.fn(), release: vi.fn() }, useCustomerTheme: () => ['light', seam.setTheme] }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ setLang: seam.setLang }) }));
vi.mock('@/api/platform', () => ({ authApi: { me: seam.me, signOut: async () => ({}), lock: async () => ({}) } }));
vi.mock('@/api/bridge', () => ({ setBridgeStaffName: vi.fn(), holdBoxSession: seam.hold, prepareConfiguredBridgeUnlock: () => null,
  bridgeApi: { lock: async () => ({}), unlock: seam.unlock },
}));
vi.mock('@/auth/staffToken', () => ({ readStaffToken: () => null, staffTokenLive: () => false, forgetStaffToken: vi.fn() }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'box', laneStation: () => 'zz-test-station', isBoxLaneTrigger: () => false, noteLaneFailure: vi.fn(), platformNeedsUnlock: () => false }));
vi.mock('@/api/catalogBridge', () => ({ loadCatalogFromApi: async () => undefined, restorePreparedCatalog: seam.restored }));
vi.mock('@/lib/displaySession', () => ({ takeTicketDisplayLeaseForSignOut: async () => null }));
vi.mock('@/auth/offlinePreparation', () => ({ forgetOfflinePreparation: seam.forgotten, prepareOfflineOperator: vi.fn(),
  readOfflinePreparation: () => ({ operator: { id: 'zz-test-person', name: 'ZZ TEST', role: 'staff' },
    catalog: { branch: { code: 'zz-test' } }, station: { id: 'zz-test-station' } }),
}));
Object.assign(globalThis, { React });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('window', seam.browser);
  seam.me.mockRejectedValue(new NetworkError());
  seam.unlock.mockResolvedValue({ accountId: 'zz-test-person', method: 'offline_sign_in', cacheAgeSeconds: 1,
    mustChangePassword: false, permissions: ['pos:sale:read'] });
});
afterEach(() => vi.clearAllMocks());

describe('SCRUM-728: a cold page has a box password door, never a remembered sign-in', () => {
  it.each(['network', 'forwarder'])('HIGH: %s outage restores a locked context; only box authentication supplies permissions', async failure => {
    if (failure === 'forwarder') seam.me.mockRejectedValue(new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Unavailable'));
    const hook = renderHook(() => OperatorProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      expect(value().locked).toBe(true); expect(value().can('pos:sale:read')).toBe(false);
      expect(seam.unlock).not.toHaveBeenCalled();
      await value().unlock('ZZ TEST synthetic input');
      expect(value().locked).toBe(false); expect(value().can('pos:sale:read')).toBe(true);
      expect(value().offlineUnlock?.method).toBe('offline_sign_in');
    } finally { hook.unmount(); }
  });
  it.each([401, 403, 423])('HIGH: platform refusal %s cannot open the cached door', async status => {
    seam.me.mockRejectedValue(new ApiError(status, 'REFUSED', 'Refused'));
    const hook = renderHook(() => OperatorProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      expect(value().operator).toBeNull(); expect(seam.restored).not.toHaveBeenCalled();
      expect(seam.forgotten).toHaveBeenCalled();
    } finally { hook.unmount(); }
  });
  it('HIGH: an ended shift stays locked after a cold reload', async () => {
    seam.unlock.mockRejectedValue(new ApiError(401, 'STAFF_TOKEN_REVOKED', 'This shift was ended by a manager'));
    const hook = renderHook(() => OperatorProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      await expect(value().unlock('ZZ TEST synthetic input')).rejects.toMatchObject({ code: 'STAFF_TOKEN_REVOKED' });
      expect(value().locked).toBe(true); expect(value().can('pos:sale:read')).toBe(false);
    } finally { hook.unmount(); }
  });
  it('HIGH: a response for another person cannot leave a usable box session', async () => {
    seam.unlock.mockResolvedValue({ accountId: 'another-person', permissions: ['pos:sale:read'] });
    const hook = renderHook(() => OperatorProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
    try {
      await vi.waitFor(() => expect(value().sessionResolved).toBe(true));
      await expect(value().unlock('ZZ TEST synthetic input')).rejects.toThrow('another operator');
      expect(seam.hold).toHaveBeenCalledWith(null);
      expect(value().locked).toBe(true); expect(value().can('pos:sale:read')).toBe(false);
    } finally { hook.unmount(); }
  });
});
