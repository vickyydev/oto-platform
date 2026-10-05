import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@/api/client';
import { membersApi, visitsApi } from '@/api/platform';
import { salesApi } from '@/api/sales';
import * as React from 'react';
import { renderHook } from './support/hooks';
import * as branchContext from '@/branch/BranchContext';
import * as operatorContext from '@/auth/OperatorContext';
import { StationProvider } from '@/station/StationContext';
import { authApi, stationsApi } from '@/api/platform';
import * as catalog from '@/store/catalogStore';
import * as catalogBridge from '@/api/catalogBridge';
import * as notifications from '@/hooks/use-toast';
import type { Branch } from '@/types';
import {
  currentLane,
  paymentRefusalMessage,
  refreshLane,
  setLaneStation,
  viaLane,
} from '@/lib/lane';

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  ...await import('./support/hooks'),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: vi.fn() }));
Object.assign(globalThis, { React });

/**
 * THE LANE ARBITER (offline plan OD-1, Round 3).
 *
 * The till works through the platform while it answers, and through its box
 * — the station bridge — when the platform says the station is forced offline
 * or nothing answers at all. Any other refusal is the platform's answer and
 * stands. These cases drive the real api wrappers with `fetch` stubbed, so the
 * paths asserted are the paths the till would call.
 */

const STATION = '018f0000-0000-7000-8000-0000000057a1';

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

const forcedOffline = () =>
  reply(
    {
      error: {
        code: 'STATION_FORCED_OFFLINE',
        message: 'This station is forced offline for testing.',
      },
    },
    503,
  );

beforeEach(() => {
  setLaneStation(null);
  setLaneStation(STATION);
});

afterEach(() => {
  setLaneStation(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which lane a call takes', () => {
  it('stays on the platform while it answers, and a refusal there stands', async () => {
    const fetch = vi.fn(async (_url: string) =>
      reply({ error: { code: 'VALIDATION', message: 'no' } }, 400),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(membersApi.lookup('0811111111')).rejects.toBeInstanceOf(ApiError);
    expect(currentLane()).toBe('platform');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe('/api/members/lookup?phone=0811111111');
  });

  it('moves to the box when the platform says the station is forced offline, and stays there', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith('/api/box/v1/station/')
        ? reply({ member: { id: 'm-1', phone: '+66811111111', children: [], source: 'cache' } })
        : forcedOffline(),
    );
    vi.stubGlobal('fetch', fetch);
    const answer = await membersApi.lookup('0811111111');
    expect(answer.member?.id).toBe('m-1');
    expect(currentLane()).toBe('box');
    expect(String(fetch.mock.calls[1]![0])).toBe(
      `/api/box/v1/station/${STATION}/members/lookup?phone=0811111111`,
    );
    // The next call goes to the box first.
    await membersApi.lookup('0811111111');
    expect(String(fetch.mock.calls[2]![0])).toContain('/api/box/v1/station/');
  });

  it('moves to the box when nothing answers at all', async () => {
    let calls = 0;
    const result = await viaLane(
      async () => {
        calls += 1;
        throw new NetworkError(new TypeError('Failed to fetch'));
      },
      async (station) => `box:${station}`,
    );
    expect(calls).toBe(1);
    expect(result).toBe(`box:${STATION}`);
  });

  it('writes a record on the box under the id minted before either lane was asked', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        bodies.push({ url, body });
        if (!url.startsWith('/api/box/')) return forcedOffline();
        return reply({
          document: {},
          result: {
            id: (body.payload as { visitId: string }).visitId,
            visitDate: '2026-09-30',
            status: 'draft',
          },
        });
      }),
    );
    const visit = await visitsApi.create({ memberId: 'm-1', childIds: ['c-1'] });
    const platformId = bodies[0]!.body.id;
    expect(bodies[1]!.body).toMatchObject({
      type: 'visit.create',
      payload: { visitId: platformId, memberId: 'm-1', childIds: ['c-1'] },
    });
    expect(visit.id).toBe(platformId);
  });

  it('prices a cart on the box in the platform’s quote shape', async () => {
    setLaneStation(null);
    setLaneStation(STATION);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/box/')
          ? reply({
              document: {},
              result: { quote: { totals: { grossSatang: 70000 }, lineTotals: {} } },
            })
          : forcedOffline(),
      ),
    );
    const { quote } = await salesApi.quote({ lines: [] } as never);
    expect(quote.totals.grossSatang).toBe(70000);
  });

  it('comes back to the platform when the box says its link is up and the switch is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => forcedOffline()),
    );
    await expect(
      viaLane(
        async () => {
          throw new ApiError(503, 'STATION_FORCED_OFFLINE', 'x');
        },
        async () => 'box',
      ),
    ).resolves.toBe('box');
    expect(currentLane()).toBe('box');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ link: { up: true, offline: false, lane: 'platform' } })),
    );
    expect(await refreshLane()).toBe('platform');
  });
});

describe('what paying says when no lane took it (round 4 sells on the box lane)', () => {
  it('a forced-offline answer on a till with no box to sell through is refused in the counter’s words', () => {
    const message = paymentRefusalMessage(new ApiError(503, 'STATION_FORCED_OFFLINE', 'forced'));
    expect(message).toMatch(/working without the internet/);
    expect(currentLane()).toBe('box');
  });

  it('a single dropped request on the platform lane keeps its own words, and moves the till to its box; the box not answering either says so', () => {
    expect(paymentRefusalMessage(new NetworkError())).toBeNull();
    expect(currentLane()).toBe('box');
    expect(paymentRefusalMessage(new NetworkError())).toMatch(/Neither the internet nor this counter’s box answered/);
  });

  it('any other refusal is not the lane’s to reword', () => {
    expect(paymentRefusalMessage(new ApiError(409, 'SALE_LINES_DIFFER', 'no'))).toBeNull();
    expect(currentLane()).toBe('platform');
  });
});

describe('the selected park and its station lane', () => {
  const parks = [
    { id: 'park-a', apiId: 'api-a', active: true },
    { id: 'park-b', apiId: 'api-b', active: true },
    { id: 'park-c', apiId: 'api-c', active: true },
  ] as Branch[];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('confirms the server choice before publishing it and serialises rapid selections', async () => {
    vi.spyOn(catalog, 'getBranches').mockReturnValue(parks);
    vi.spyOn(catalog, 'getActiveBranch').mockReturnValue(parks[0]!);
    const store = vi.spyOn(catalog, 'setActiveBranch').mockImplementation(() => {});
    const hydrate = vi.spyOn(catalogBridge, 'loadCatalogFromApi').mockResolvedValue();
    let finish!: (value: { ok: true }) => void;
    const change = vi.spyOn(authApi, 'switchBranch')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ ok: true });
    const hook = renderHook(() => branchContext.BranchProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof branchContext.useBranch>;
    try {
      value().setActiveBranchId('park-b');
      await flush();
      expect(value().branch.id).toBe('park-a');
      expect(value().switching).toBe(true);
      expect(store).not.toHaveBeenCalled();
      value().setActiveBranchId('park-c');
      expect(change).toHaveBeenCalledTimes(1);
      finish({ ok: true });
      await flush();
      expect(change.mock.calls.map(([id]) => id)).toEqual(['api-b', 'api-c']);
      expect(hydrate.mock.calls.map(([id]) => id)).toEqual(['park-b', 'park-c']);
      expect(value().branch.id).toBe('park-c');
      expect(value().switching).toBe(false);
    } finally { hook.unmount(); }
  });

  it('keeps the previous park and shows the refusal when the session change fails', async () => {
    vi.spyOn(catalog, 'getBranches').mockReturnValue(parks);
    vi.spyOn(catalog, 'getActiveBranch').mockReturnValue(parks[0]!);
    const store = vi.spyOn(catalog, 'setActiveBranch').mockImplementation(() => {});
    vi.spyOn(authApi, 'switchBranch').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This park is not available to this account.'));
    const toast = vi.spyOn(notifications, 'toast');
    const hook = renderHook(() => branchContext.BranchProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof branchContext.useBranch>;
    try {
      value().setActiveBranchId('park-b');
      await flush();
      expect(value().branch.id).toBe('park-a');
      expect(value().switching).toBe(false);
      expect(store).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Park could not be changed', description: 'This park is not available to this account.' }));
    } finally { hook.unmount(); }
  });

  it('waits for park selection and ignores an old list or pick after the park changes', async () => {
    type Context = ReturnType<typeof branchContext.useBranch>;
    let selected: Context = { branch: parks[0]!, branches: parks, switching: true, setActiveBranchId: () => {} };
    vi.spyOn(branchContext, 'useBranch').mockImplementation(() => selected);
    vi.spyOn(operatorContext, 'useOperator').mockReturnValue({ operator: { id: 'operator' }, mustChangePassword: false } as ReturnType<typeof operatorContext.useOperator>);
    const memory = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
    type List = Awaited<ReturnType<typeof stationsApi.mine>>;
    type Pick = Awaited<ReturnType<typeof stationsApi.pick>>;
    const oldList = { stations: [{ id: 'station-a' }] } as List;
    const newList = { stations: [{ id: 'station-b' }] } as List;
    let finishList!: (value: List) => void;
    let finishPick!: (value: Pick) => void;
    const mine = vi.spyOn(stationsApi, 'mine').mockResolvedValueOnce(oldList)
      .mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }))
      .mockResolvedValue(newList);
    vi.spyOn(stationsApi, 'pick').mockImplementation(() => new Promise((resolve) => { finishPick = resolve; }));
    const hook = renderHook(() => StationProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof import('@/station/StationContext').useStation>;
    try {
      await flush();
      expect(mine).not.toHaveBeenCalled();
      expect(value().resolved).toBe(false);
      selected = { ...selected, switching: false };
      hook.rerender();
      await flush();
      expect(value().stations?.[0]?.id).toBe('station-a');
      const reload = value().reload();
      const pick = value().pick('station-a');
      selected = { ...selected, branch: parks[1]! };
      hook.rerender();
      await flush();
      finishList(oldList);
      finishPick({ station: { id: 'station-a' }, staffToken: null } as Pick);
      await Promise.all([reload, pick]);
      expect(value().stations?.[0]?.id).toBe('station-b');
      expect(value().station).toBeNull();
      expect(memory.size).toBe(0);
    } finally { hook.unmount(); }
  });
});
