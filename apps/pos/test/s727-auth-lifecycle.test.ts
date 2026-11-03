import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';

const seam = vi.hoisted(() => {
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vi.stubGlobal('window', browser);
  return { browser, setLang: vi.fn(), setTheme: vi.fn() };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getOperatorThemePref: () => null }));
vi.mock('@/lib/themePref', () => ({ staffThemeController: { adopt: vi.fn(), release: vi.fn() }, useCustomerTheme: () => ['light', seam.setTheme] }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ setLang: seam.setLang }) }));
vi.mock('@/api/platform', () => ({ authApi: {
  me: async () => ({ account: { id: 'zz-test-person', phone: 'ZZ TEST', mustChangePassword: false }, employee: { name: 'ZZ TEST person' }, sessionLocked: false }),
  permissions: async () => ({ permissions: [] }), signIn: async () => ({}), lock: async () => ({}),
} }));
vi.mock('@/api/bridge', () => ({ setBridgeStaffName: vi.fn(), prepareConfiguredBridgeUnlock: () => null,
  bridgeApi: { lock: async () => ({}), unlock: async () => ({ method: 'offline_sign_in', cacheAgeSeconds: 1 }) },
}));
vi.mock('@/auth/staffToken', () => ({ readStaffToken: () => null, staffTokenLive: () => false, forgetStaffToken: vi.fn() }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'box', laneStation: () => 'zz-test-station', isBoxLaneTrigger: () => false, noteLaneFailure: vi.fn() }));
vi.mock('@/api/catalogBridge', () => ({ loadCatalogFromApi: async () => undefined }));
vi.mock('@/lib/displaySession', () => ({ takeTicketDisplayLeaseForSignOut: async () => null }));
Object.assign(globalThis, { React });
beforeEach(() => vi.stubGlobal('window', seam.browser));
afterEach(() => vi.clearAllMocks());

describe('SCRUM-727: the offline notice describes only the current authenticated session', () => {
  it.each(['session ended', 'new online sign-in'])('clears the old offline sign-in after %s', async ending => {
    const hook = renderHook(() => OperatorProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof useOperator>;
    try {
      await vi.waitFor(() => expect(value().operator?.id).toBe('zz-test-person'));
      value().lockNow(); await value().unlock('ZZ TEST synthetic input');
      expect(value().offlineUnlock?.method).toBe('offline_sign_in');
      if (ending === 'session ended') window.dispatchEvent(new Event('oto:unauthorized'));
      else await value().signIn('ZZ TEST', 'ZZ TEST synthetic input');
      expect(value().offlineUnlock).toBeNull();
    } finally { hook.unmount(); }
  });
});
