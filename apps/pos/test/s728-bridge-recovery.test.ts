import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeApi, holdBoxSession, setBridgeOrigin, watchBridgeSnapshots } from '@/api/bridge';

const station = '018f0000-0000-7000-8000-0000000057a1';
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  vi.stubGlobal('window', new EventTarget());
  setBridgeOrigin('https://counter.example.test');
  holdBoxSession(null);
});
afterEach(() => {
  setBridgeOrigin(null);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('SCRUM-728: recover a missing box session without retrying a write', () => {
  it('HIGH: the first sale opens the lock screen on BOX_SESSION_REQUIRED; never replay the sale', async () => {
    const locked = vi.fn(); window.addEventListener('oto:session-locked', locked);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 'BOX_SESSION_REQUIRED', message: 'Unlock this till on its box first',
    } }), { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    await expect(bridgeApi.intent(station, 'sale.open', {})).rejects.toMatchObject({ code: 'BOX_SESSION_REQUIRED' });
    expect(locked).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('HIGH: a staff stream refused before unlock resumes once with the fresh session', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const stop = watchBridgeSnapshots(station, { onSnapshot: vi.fn(), onState: vi.fn(), onFailure: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      holdBoxSession('ZZ TEST renewed box session');
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]).toEqual([expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer ZZ TEST renewed box session' }),
      })]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });

  it('HIGH: a revoked display credential stays refused when a staff session changes', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const stop = watchBridgeSnapshots(station, { bearer: 'ZZ TEST display credential',
      onSnapshot: vi.fn(), onState: vi.fn(), onFailure: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      holdBoxSession('ZZ TEST renewed box session');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });
});
