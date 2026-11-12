import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { ApiError, NetworkError } from '@/api/client';
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
 * SCRUM-878 — THE STATION, WHEN A NEW SESSION CARRIES ON THE SCREEN AN ENDED
 * ONE LEFT UNDER THE LOCK.
 *
 * The platform knows the new session at no station. Before, the till started
 * the whole station question over at every sign-in, and the selling screen was
 * unmounted while it was asked — that is how the cart was lost. Now a sign-in
 * that carries the screen on keeps the station on screen and takes the SAME
 * station again for the new session; a refusal lets it go (the picker asks,
 * the kept sale never moves to another station), and no answer keeps it. Any
 * other sign-in (a new seat) asks the whole question again, as before.
 */

const STATION = '018f0000-0000-7000-8000-000000000878';
const park = { id: 'park-a', apiId: 'api-a', active: true } as Branch;
const key = `oto.pos.station.${park.id}`;
const record = { id: STATION, branchId: park.id, name: 'ZZ TEST SCRUM-878 till', kind: 'till', boxId: 'box' };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Operator = ReturnType<typeof operatorContext.useOperator>;
type Station = ReturnType<typeof useStation>;
type Picked = Awaited<ReturnType<typeof stationsApi.pick>>;
type List = Awaited<ReturnType<typeof stationsApi.mine>>;

function setUp() {
  const session = {
    operator: { id: 'zz-test-ann' }, mustChangePassword: false, offlinePreparation: null, locked: false,
    tillSeat: 'zz-test-ann#1', reseat: 0,
  };
  vi.spyOn(branchContext, 'useBranch').mockReturnValue({ branch: park, branches: [park], switching: false, setActiveBranchId: () => {} });
  vi.spyOn(operatorContext, 'useOperator').mockImplementation(() => session as unknown as Operator);
  const memory = new Map<string, string>([[key, JSON.stringify({ id: STATION, name: record.name })]]);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (name: string) => memory.get(name) ?? null,
      setItem: (name: string, value: string) => memory.set(name, value),
      removeItem: (name: string) => memory.delete(name),
    },
  });
  const hook = renderHook(() => StationProvider({ children: null }));
  const value = () => hook.result.current.props.value as Station;
  const set = (patch: Partial<typeof session>) => { Object.assign(session, patch); hook.rerender(); };
  return { hook, value, memory, set };
}

const list = { stations: [{ id: STATION, name: record.name }] } as List;
const picked = { station: record, staffToken: null, staffTokenUnavailable: null } as unknown as Picked;

afterEach(() => {
  setBridgeOrigin(null);
  setLaneStation(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function atTheStation() {
  vi.spyOn(stationsApi, 'mine').mockResolvedValue(list);
  const pick = vi.spyOn(stationsApi, 'pick').mockResolvedValue(picked);
  const till = setUp();
  await vi.waitFor(() => expect(till.value().station?.stationId).toBe(STATION));
  expect(pick).toHaveBeenCalledTimes(1);
  return { ...till, pick };
}

describe('SCRUM-878 — the station of a screen carried on by a new session', () => {
  it('the session ends and the same person signs in again: the station stays on screen and is taken again for the new session', async () => {
    const { hook, value, pick, set } = await atTheStation();
    try {
      // The session ends: the till locks over the screen; the station stays.
      set({ locked: true });
      await flush();
      expect(value().station?.stationId).toBe(STATION);
      // A new session for the same seat.
      set({ locked: false, reseat: 1 });
      // Never unresolved, never without its station, while it is asked.
      expect(value().resolved).toBe(true);
      expect(value().station?.stationId).toBe(STATION);
      await vi.waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
      expect(pick.mock.calls[1]).toEqual([STATION]);
      await flush();
      expect(value().station?.stationId).toBe(STATION);
      expect(value().resolved).toBe(true);
      expect(value().notice).toBeNull();
      expect(stationsApi.mine).toHaveBeenCalledTimes(1);
    } finally { hook.unmount(); }
  });

  it('a different person continuing the sale: the seat is the same, so the station is taken again rather than asked over', async () => {
    const { hook, value, pick, set } = await atTheStation();
    try {
      set({ locked: true });
      set({ operator: { id: 'zz-test-ben' }, reseat: 1 });
      expect(value().station?.stationId).toBe(STATION);
      await vi.waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
      expect(stationsApi.mine).toHaveBeenCalledTimes(1);
      expect(value().station?.stationId).toBe(STATION);
    } finally { hook.unmount(); }
  });

  it('SECURITY: refused for the new session — the station is let go and the picker asks; the sale never moves to another station', async () => {
    const { hook, value, pick, memory, set } = await atTheStation();
    try {
      pick.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Missing permission pos:station:use'));
      set({ operator: { id: 'zz-test-ben' }, reseat: 1 });
      await vi.waitFor(() => expect(value().station).toBeNull());
      expect(value().notice).toBe('ZZ TEST SCRUM-878 till is no longer yours to work. Pick another station.');
      expect(memory.has(key)).toBe(false);
    } finally { hook.unmount(); }
  });

  it('no answer at all keeps the station, as the first question does', async () => {
    const { hook, value, pick, set } = await atTheStation();
    try {
      pick.mockRejectedValueOnce(new NetworkError());
      set({ reseat: 1 });
      await vi.waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
      await flush();
      expect(value().station?.stationId).toBe(STATION);
      expect(value().notice).toBeNull();
    } finally { hook.unmount(); }
  });

  it('any other sign-in is a new seat: the whole question is asked again, as before', async () => {
    const { hook, value, pick, set } = await atTheStation();
    try {
      set({ operator: { id: 'zz-test-ben' }, tillSeat: 'zz-test-ben#2' });
      await vi.waitFor(() => expect(stationsApi.mine).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(value().station?.stationId).toBe(STATION));
      expect(pick).toHaveBeenCalledTimes(2);
    } finally { hook.unmount(); }
  });
});
