import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { ApiError } from '@/api/client';
import { stationsApi } from '@/api/platform';
import * as branchContext from '@/branch/BranchContext';
import * as operatorContext from '@/auth/OperatorContext';
import { setBridgeOrigin } from '@/api/bridge';
import { setLaneStation } from '@/lib/lane';
import { StationProvider, type useStation } from '@/station/StationContext';
import type { Branch } from '@/types';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  ...await import('./support/hooks'),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: vi.fn() }));
Object.assign(globalThis, { React });

/**
 * SCRUM-744 — A TILL LOCKED BY THE TIMEOUT AND THEN RELOADED.
 *
 * The reload comes back signed in and locked, and the station question it
 * asks is refused with 423 SESSION_LOCKED. That refusal is not an answer about
 * stations: the till must stay unresolved behind the lock and ask again at
 * the unlock, taking back the station this device remembers, with no
 * "This session is locked" line left on the picker. A lock in the middle of a
 * shift asks nothing and keeps the station it has.
 */

const STATION = '018f0000-0000-7000-8000-000000000744';
const park = { id: 'park-a', apiId: 'api-a', active: true } as Branch;
const key = `oto.pos.station.${park.id}`;
const record = { id: STATION, branchId: park.id, name: 'ZZ TEST SCRUM-744 till', kind: 'till', boxId: 'box' };
const lockedRefusal = () => new ApiError(423, 'SESSION_LOCKED', 'This session is locked — unlock to continue');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Operator = ReturnType<typeof operatorContext.useOperator>;
type Station = ReturnType<typeof useStation>;
type Picked = Awaited<ReturnType<typeof stationsApi.pick>>;
type List = Awaited<ReturnType<typeof stationsApi.mine>>;

function setUp(locked: boolean, remembered: boolean) {
  const session = { operator: { id: 'operator' }, mustChangePassword: false, offlinePreparation: null, locked };
  vi.spyOn(branchContext, 'useBranch').mockReturnValue({ branch: park, branches: [park], switching: false, setActiveBranchId: () => {} });
  vi.spyOn(operatorContext, 'useOperator').mockImplementation(() => session as unknown as Operator);
  const memory = new Map<string, string>(remembered ? [[key, JSON.stringify({ id: STATION, name: record.name })]] : []);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (name: string) => memory.get(name) ?? null,
      setItem: (name: string, value: string) => memory.set(name, value),
      removeItem: (name: string) => memory.delete(name),
    },
  });
  const hook = renderHook(() => StationProvider({ children: null }));
  const value = () => hook.result.current.props.value as Station;
  const setLocked = (next: boolean) => { session.locked = next; hook.rerender(); };
  return { hook, value, memory, setLocked };
}

const list = { stations: [{ id: STATION, name: record.name }] } as List;
const picked = { station: record, staffToken: null, staffTokenUnavailable: null } as unknown as Picked;

afterEach(() => {
  setBridgeOrigin(null);
  setLaneStation(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SCRUM-744: the station question asked at a locked reload', () => {
  it('HIGH: waits behind the lock, then takes the remembered station back at the unlock', async () => {
    const mine = vi.spyOn(stationsApi, 'mine').mockRejectedValueOnce(lockedRefusal()).mockResolvedValue(list);
    const pick = vi.spyOn(stationsApi, 'pick').mockResolvedValue(picked);
    const { hook, value, memory, setLocked } = setUp(true, true);
    try {
      await flush();
      expect(mine).toHaveBeenCalledTimes(1);
      expect(pick).not.toHaveBeenCalled();
      expect(value().resolved).toBe(false);
      expect(value().station).toBeNull();
      expect(value().error).toBeNull();
      expect(value().notice).toBeNull();
      expect(memory.has(key)).toBe(true);

      setLocked(false);
      await vi.waitFor(() => expect(value().resolved).toBe(true));
      expect(mine).toHaveBeenCalledTimes(2);
      expect(pick.mock.calls).toEqual([[STATION]]);
      expect(value().station?.stationId).toBe(STATION);
      expect(value().stations).toEqual(list.stations);
      expect(value().error).toBeNull();
      expect(value().notice).toBeNull();
      expect(JSON.parse(memory.get(key)!).id).toBe(STATION);
    } finally { hook.unmount(); }
  });

  it('HIGH: a pick refused by the lock keeps the remembered station and takes it at the unlock', async () => {
    vi.spyOn(stationsApi, 'mine').mockResolvedValue(list);
    const pick = vi.spyOn(stationsApi, 'pick').mockRejectedValueOnce(lockedRefusal()).mockResolvedValue(picked);
    const { hook, value, memory, setLocked } = setUp(true, true);
    try {
      await flush();
      expect(pick).toHaveBeenCalledTimes(1);
      expect(value().resolved).toBe(false);
      expect(value().notice).toBeNull();
      expect(value().error).toBeNull();
      expect(memory.has(key)).toBe(true);

      setLocked(false);
      await vi.waitFor(() => expect(value().station?.stationId).toBe(STATION));
      expect(pick).toHaveBeenCalledTimes(2);
      expect(value().resolved).toBe(true);
      expect(value().notice).toBeNull();
      expect(value().error).toBeNull();
    } finally { hook.unmount(); }
  });

  it('a list re-read refused by the lock leaves no locked line and is read again at the unlock', async () => {
    const mine = vi.spyOn(stationsApi, 'mine').mockResolvedValueOnce({ stations: [] } as List)
      .mockRejectedValueOnce(lockedRefusal()).mockResolvedValue(list);
    const pick = vi.spyOn(stationsApi, 'pick');
    const { hook, value, setLocked } = setUp(false, false);
    try {
      await vi.waitFor(() => expect(value().resolved).toBe(true));
      setLocked(true);
      await value().reload();
      expect(value().error).toBeNull();
      expect(value().stations).toEqual([]);

      setLocked(false);
      await vi.waitFor(() => expect(value().stations).toEqual(list.stations));
      expect(mine).toHaveBeenCalledTimes(3);
      expect(pick).not.toHaveBeenCalled();
      expect(value().error).toBeNull();
      expect(value().notice).toBeNull();
    } finally { hook.unmount(); }
  });

  it('a lock in the middle of a shift asks nothing and keeps the station', async () => {
    const mine = vi.spyOn(stationsApi, 'mine').mockResolvedValue(list);
    const pick = vi.spyOn(stationsApi, 'pick').mockResolvedValue(picked);
    const { hook, value, setLocked } = setUp(false, true);
    try {
      await vi.waitFor(() => expect(value().station?.stationId).toBe(STATION));
      setLocked(true);
      await flush();
      setLocked(false);
      await flush();
      expect(mine).toHaveBeenCalledTimes(1);
      expect(pick).toHaveBeenCalledTimes(1);
      expect(value().station?.stationId).toBe(STATION);
      expect(value().resolved).toBe(true);
    } finally { hook.unmount(); }
  });
});
