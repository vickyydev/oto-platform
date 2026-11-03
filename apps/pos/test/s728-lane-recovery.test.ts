import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { setBridgeOrigin } from '@/api/bridge';
import { currentLane, noteLaneFailure, platformNeedsUnlock, refreshLane, setLaneStation } from '@/lib/lane';

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  setBridgeOrigin('https://counter.example.test');
  setLaneStation('018f0000-0000-7000-8000-0000000057a1');
  noteLaneFailure(new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Unavailable'));
});
afterEach(() => { setLaneStation(null); setBridgeOrigin(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('HIGH: a healthy agent heartbeat cannot flap the till back onto its broken API path', async () => {
  const fetch = vi.fn(async (url: string) => url === '/api/me'
    ? answer({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Unavailable' } }, 502)
    : answer({ link: { lane: 'platform' } }));
  vi.stubGlobal('fetch', fetch);
  for (let i = 0; i < 3; i++) expect(await refreshLane()).toBe('box');
  expect(currentLane()).toBe('box');
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('HIGH: a still-locked platform session asks for its password before any lane switch', async () => {
  let locked = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => answer(url === '/api/me'
    ? { sessionLocked: locked } : { link: { lane: 'platform' } })));
  const onLock = vi.fn(); window.addEventListener('oto:session-locked', onLock);
  expect(await refreshLane()).toBe('box');
  expect(platformNeedsUnlock()).toBe(true);
  expect(await refreshLane()).toBe('box');
  expect(onLock).toHaveBeenCalledTimes(1);
  locked = false;
  expect(await refreshLane()).toBe('platform');
  expect(platformNeedsUnlock()).toBe(false);
});

it('HIGH: a forced-offline box stays offline without probing the platform', async () => {
  const fetch = vi.fn(async () => answer({ link: { lane: 'box' } }));
  vi.stubGlobal('fetch', fetch);
  expect(await refreshLane()).toBe('box');
  expect(fetch).toHaveBeenCalledTimes(1);
});
