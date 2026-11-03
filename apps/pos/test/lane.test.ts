import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@/api/client';
import { bridgeApi, bridgeUrl, holdBoxSession, setBridgeOrigin, prepareConfiguredBridgeUnlock } from '@/api/bridge';
import { confirmVisitChildren, membersApi, visitsApi } from '@/api/platform';
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
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  setBridgeOrigin(null);
  setLaneStation(null);
  setLaneStation(STATION);
});

afterEach(() => {
  setBridgeOrigin(null);
  setLaneStation(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('which lane a call takes', () => {
  it.each(['lock', 'origin', 'abort'] as const)('HIGH: a late bridge unlock cannot restore access after %s; discard its credential', async change => {
    setBridgeOrigin('https://counter.example.test');
    let answer: (value: Response) => void = () => undefined;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/unlock')
      ? new Promise<Response>(resolve => { answer = resolve; }) : reply({ link: { lane: 'platform' } }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = bridgeApi.unlock(STATION, { token: 'test-token', password: 'test-password' }, controller.signal);
    if (change === 'lock') await bridgeApi.lock(STATION);
    if (change === 'origin') setBridgeOrigin('https://changed.example.test');
    if (change === 'abort') controller.abort();
    answer(reply({ session: 'late-test-session' }));
    await pending;
    await bridgeApi.status(STATION);
    expect(fetch.mock.calls.at(-1)?.[1]).not.toEqual(expect.objectContaining({ headers: expect.objectContaining({ authorization: expect.any(String) }) }));
  });

  it('connects only a configured bridge with token AND password, without ambient credentials or a lane change', async () => {
    const fetch = vi.fn(async () => reply({ session: 'test-session' }));
    vi.stubGlobal('fetch', fetch);
    const body = { token: 'test-token', password: 'test-password' };
    await prepareConfiguredBridgeUnlock(STATION, body)();
    expect(fetch).not.toHaveBeenCalled();
    setBridgeOrigin('https://counter.example.test');
    await prepareConfiguredBridgeUnlock(STATION, { ...body, token: '' })();
    await prepareConfiguredBridgeUnlock(STATION, { ...body, password: '' })();
    expect(fetch).not.toHaveBeenCalled();
    await prepareConfiguredBridgeUnlock(STATION, body)();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://counter.example.test/box/v1/station/${STATION}/unlock`, expect.objectContaining({ credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(currentLane()).toBe('platform');
  });

  it('bounds an unavailable local unlock and never retries or fails the platform unlock', async () => {
    vi.useFakeTimers();
    try {
      setBridgeOrigin('https://counter.example.test');
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));
      vi.stubGlobal('fetch', fetch);
      const pending = prepareConfiguredBridgeUnlock(STATION, { token: 'test-token', password: 'test-password' })();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(currentLane()).toBe('platform');
    } finally { vi.useRealTimers(); }
  });

  it('does not start a local unlock when a new lock overtakes platform authentication', async () => {
    setBridgeOrigin('https://counter.example.test');
    const fetch = vi.fn(async () => reply({ session: 'test-session' }));
    vi.stubGlobal('fetch', fetch);
    const connect = prepareConfiguredBridgeUnlock(STATION, { token: 'test-token', password: 'test-password' });
    await bridgeApi.lock(STATION);
    await connect();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a configured bridge for the precise forwarder outage, never a platform refusal or an unconfigured box', async () => {
    const unavailable = new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'API unavailable');
    const platform = vi.fn(async () => { throw unavailable; });
    const local = vi.fn(async () => 'local');
    await expect(viaLane(platform, local)).rejects.toBe(unavailable);
    expect(local).not.toHaveBeenCalled();
    setBridgeOrigin('https://counter.example.test');
    await expect(viaLane(async () => 'online', local)).resolves.toBe('online');
    await expect(viaLane(async () => { throw new ApiError(502, 'OTHER', 'no'); }, local)).rejects.toMatchObject({ code: 'OTHER' });
    expect(local).not.toHaveBeenCalled();
    await expect(viaLane(platform, local)).resolves.toBe('local');
    expect(local).toHaveBeenCalledTimes(1);
    expect(currentLane()).toBe('box');
  });

  it('drops the RAM box credential when the destination changes', async () => {
    setBridgeOrigin('https://first.example.test'); holdBoxSession('test-only-session');
    setBridgeOrigin('https://second.example.test');
    const fetch = vi.fn(async () => reply({ link: { lane: 'platform' } }));
    vi.stubGlobal('fetch', fetch);
    await bridgeApi.status(STATION);
    expect(fetch).toHaveBeenCalledWith(`https://second.example.test/box/v1/station/${STATION}/status`, expect.objectContaining({ credentials: 'omit', headers: {} }));
    setBridgeOrigin(null);
    expect(bridgeUrl(STATION, 'status')).toBe(`/api/box/v1/station/${STATION}/status`);
  });
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

  it('SCRUM-339: a second screen adds its children to the family’s open visit instead of opening another', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === '/api/visits') return reply({ id: body.id, visitDate: '2026-10-14', status: 'draft' });
        return reply({ id: 'open-visit', visitDate: '2026-10-14', status: 'draft' });
      }),
    );
    // With an open visit: the children join it, and its id comes back.
    expect(await confirmVisitChildren('open-visit', { memberId: 'm-1', childIds: ['c-1', 'c-2'] })).toBe('open-visit');
    expect(calls[0]).toEqual({ url: '/api/visits/open-visit/children', body: { childIds: ['c-1', 'c-2'] } });
    // Nobody to add: the open visit stands and nothing is sent.
    expect(await confirmVisitChildren('open-visit', { memberId: 'm-1', childIds: [] })).toBe('open-visit');
    expect(calls).toHaveLength(1);
    // No open visit yet: one is opened.
    const opened = await confirmVisitChildren(null, { memberId: 'm-1', childIds: ['c-1'] });
    expect(calls[1]!.url).toBe('/api/visits');
    expect(opened).toBe(calls[1]!.body.id);
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

  it('adopts and remembers the bridge, restores it during outage, and clears it on leaving or an older station answer', async () => {
    const selected = { branch: parks[0]!, branches: parks, switching: false, setActiveBranchId: () => {} };
    vi.spyOn(branchContext, 'useBranch').mockReturnValue(selected);
    vi.spyOn(operatorContext, 'useOperator').mockReturnValue({ operator: { id: 'operator' }, mustChangePassword: false } as ReturnType<typeof operatorContext.useOperator>);
    const memory = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
    vi.spyOn(stationsApi, 'mine').mockResolvedValue({ stations: [] });
    const record = { id: STATION, branchId: parks[0]!.id, name: 'ZZ TEST bridge', kind: 'till', boxId: 'box', bridgeOrigin: 'https://counter.example.test' };
    const pick = vi.spyOn(stationsApi, 'pick').mockResolvedValue({ station: record, staffToken: null, staffTokenUnavailable: null });
    let hook = renderHook(() => StationProvider({ children: null }));
    const value = () => hook.result.current.props.value as ReturnType<typeof import('@/station/StationContext').useStation>;
    try {
      await flush(); await value().pick(STATION);
      expect(bridgeUrl(STATION, 'status')).toBe(`https://counter.example.test/box/v1/station/${STATION}/status`);
      hook.unmount();
      expect(bridgeUrl(STATION, 'status')).toBe(`/api/box/v1/station/${STATION}/status`);
      pick.mockRejectedValue(new NetworkError());
      hook = renderHook(() => StationProvider({ children: null }));
      await flush();
      expect(value().station?.stationId).toBe(STATION);
      expect(bridgeUrl(STATION, 'status')).toBe(`https://counter.example.test/box/v1/station/${STATION}/status`);
      value().clearStation();
      expect(bridgeUrl(STATION, 'status')).toBe(`/api/box/v1/station/${STATION}/status`);
      pick.mockResolvedValue({ station: { ...record, bridgeOrigin: undefined }, staffToken: null, staffTokenUnavailable: null });
      await value().pick(STATION);
      expect(bridgeUrl(STATION, 'status')).toBe(`/api/box/v1/station/${STATION}/status`);
    } finally { hook.unmount(); }
  });
});

describe('SCRUM-727: independent till address check before any password leaves the page', () => {
  it.each(['https://evil.example', 'https://counter.example.test.evil.test', 'https://0.0.0.0', 'https://[::]'])('HIGH: refuses %s even if the API named it', async target => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    setBridgeOrigin(target);
    await prepareConfiguredBridgeUnlock(STATION, { token: 'test-only', password: 'test-only' })();
    expect(fetch).not.toHaveBeenCalled();
    expect(bridgeUrl(STATION, 'unlock')).toMatch(/^\/api\//);
  });
  it('HIGH: an absent build-time zone keeps the credential on this origin', async () => {
    vi.stubEnv('VITE_BOX_BRIDGE_ZONE', '');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    setBridgeOrigin('https://counter.example.test');
    await prepareConfiguredBridgeUnlock(STATION, { token: 'test-only', password: 'test-only' })();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('SCRUM-727 HIGH: online bridge unlock refuses redirects and makes one attempt', async () => {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => { throw new TypeError('redirect refused'); });
  vi.stubGlobal('fetch', fetch);
  setBridgeOrigin('https://counter.example.test');
  await prepareConfiguredBridgeUnlock(STATION, { token: 'test-only', password: 'test-only' })();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit', method: 'POST' });
});


it('SCRUM-727: same-origin virtual calls retain the browser redirect default', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ link: { lane: 'platform' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const { bridgeApi, setBridgeOrigin } = await import('@/api/bridge');
  setBridgeOrigin(null); await bridgeApi.status('station');
  expect(fetch.mock.calls.length).toBe(1);
  expect((fetch.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1].redirect).toBeUndefined();
});

it('SCRUM-727: an unusable build-time zone is visible in station settings', async () => {
  const { bridgeConfigurationWarning } = await import('@/api/bridge');
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', '');
  expect(bridgeConfigurationWarning('https://counter.example.test')).toContain('matching box DNS zone');
  expect(bridgeConfigurationWarning(null)).toBeNull();
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  expect(bridgeConfigurationWarning('https://counter.example.test')).toBeNull();
});
