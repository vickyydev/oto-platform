import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCatalogSnapshot } from '@/store/catalogStore';
import { prepareCatalog } from '@/api/catalogBridge';
import { forgetOfflinePreparation, forgetOfflineStation, prepareOfflineOperator, prepareOfflineStation, readOfflinePreparation } from '@/auth/offlinePreparation';
import type { ApiStation } from '@/api/platform';

vi.mock('@/api/catalogBridge', () => ({ prepareCatalog: vi.fn() }));
const accountId = '018f0000-0000-7000-8000-0000000057a1';
const branchId = '018f0000-0000-7000-8000-0000000057a2';
const station: ApiStation = { id: '018f0000-0000-7000-8000-0000000057a3', branchId,
  boxId: '018f0000-0000-7000-8000-0000000057a4', name: 'ZZ TEST prepared till', kind: 'till',
  bridgeOrigin: 'https://counter.example.test', ready: true, devices: [] };
const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  const { branches: _branches, ...catalog } = getCatalogSnapshot();
  vi.mocked(prepareCatalog).mockReturnValue({ branch: { id: branchId, code: 'zz-test', name: 'ZZ TEST park',
    timezone: 'Asia/Bangkok', country: 'TH', archived: false }, catalog });
  forgetOfflinePreparation();
});
afterEach(() => { forgetOfflinePreparation(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const prepare = () => {
  prepareOfflineOperator({ id: accountId, name: 'ZZ TEST staff', role: 'manager' }, true);
  prepareOfflineStation(station, 'zz-test', 'camera');
};

describe('SCRUM-728: remembered context can only lead back to the password screen', () => {
  it('HIGH: changing stations prepares the next one, but a signed-out person cannot prepare either', () => {
    prepare();
    forgetOfflineStation();
    expect(readOfflinePreparation()).toBeNull();
    const next = { ...station, id: '018f0000-0000-7000-8000-0000000057a5', name: 'ZZ TEST next station' };
    prepareOfflineStation(next, 'zz-test');
    expect(readOfflinePreparation()?.station.id).toBe(next.id);
    forgetOfflinePreparation();
    forgetOfflineStation();
    prepareOfflineStation(station, 'zz-test');
    expect(readOfflinePreparation()).toBeNull();
  });
  it('keeps the selected station and public catalogue, with no credential or browser permission grant', () => {
    prepare(); const saved = readOfflinePreparation();
    expect(saved?.station.id).toBe(station.id);
    expect(saved?.operator).toEqual({ id: accountId, name: 'ZZ TEST staff', role: 'staff' });
    expect(saved?.catalog.branch.id).toBe(branchId);
    const raw = [...values.values()][0];
    for (const field of ['password', 'token', 'permissions', 'customers', 'session']) {
      expect(raw).not.toContain(`"${field}"`);
    }
  });
  it.each(['no zone', 'foreign address', 'future', 'too old', 'wrong park', 'not ready', 'malformed', 'devices', 'timezone'])('HIGH: rejects %s preparation', reason => {
    prepare(); const [key, raw] = [...values.entries()][0]; const saved = JSON.parse(raw);
    if (reason === 'no zone') vi.stubEnv('VITE_BOX_BRIDGE_ZONE', '');
    if (reason === 'foreign address') saved.station.bridgeOrigin = 'https://evil.example';
    if (reason === 'future') saved.savedAt = Date.now() + 1_000;
    if (reason === 'too old') saved.savedAt = Date.now() - 31 * 86_400_000;
    if (reason === 'wrong park') saved.station.branchId = accountId;
    if (reason === 'not ready') saved.station.ready = false;
    if (reason === 'malformed') saved.catalog.catalog.ticketTypes = null;
    if (reason === 'devices') saved.station.devices = {};
    if (reason === 'timezone') saved.catalog.branch.timezone = 'not a zone';
    values.set(key, JSON.stringify(saved));
    expect(readOfflinePreparation()).toBeNull();
  });
  it('HIGH: sign-out or a temporary-password/support session clears preparation', () => {
    prepare(); forgetOfflinePreparation(); expect(readOfflinePreparation()).toBeNull();
    prepare(); prepareOfflineOperator({ id: accountId, name: 'ZZ TEST', role: 'manager' }, false);
    expect(readOfflinePreparation()).toBeNull();
    prepareOfflineStation(station, 'zz-test'); expect(readOfflinePreparation()).toBeNull();
  });
  it('HIGH: a new operator cannot inherit the preceding operator preparation', () => {
    prepare(); prepareOfflineOperator({ id: branchId, name: 'ZZ TEST next operator', role: 'staff' }, true);
    expect(readOfflinePreparation()).toBeNull();
  });
});
