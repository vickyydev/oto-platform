import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthApi } from '@/api/observability';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());

describe('readiness evidence remains a real server answer (SCRUM-645)', () => {
  it.each([
    { http: 200, status: 'ready', ok: true },
    { http: 200, status: 'degraded', ok: true },
    { http: 503, status: 'not_ready', ok: false },
  ])('preserves native $status with HTTP $http', async ({ http, status, ok }) => {
    const checks = { database: { ok: http === 200, latencyMs: 0 }, pool: null,
      jobs: { configured: false, watchdogAgeS: null, staleAfterS: 180, stale: false },
      stationChannels: { stations: 0, connections: 0, perStation: {} } };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status, checks }), { status: http }));
    const result = await healthApi.ready();
    expect(result).toMatchObject({ status, ok, checks });
    expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/ready', { credentials: 'same-origin' });
  });

  it('preserves the older status-only response without inventing missing measurements', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ready' })));
    expect(await healthApi.ready()).toMatchObject({ status: 'ready', ok: true, checks: undefined });
  });

  it('does not label a successful HTML response as a ready API', async () => {
    fetcher.mockResolvedValueOnce(new Response('<html>ZZ TEST proxy response</html>', { status: 200 }));
    await expect(healthApi.ready()).rejects.toThrow('readiness');
  });

  it.each([null, {}, [], { ok: true }, { status: 'ZZ TEST unknown' }].map(body => ({ body })))(
    'refuses malformed readiness evidence $body instead of fabricating a healthy result', async ({ body }) => {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(healthApi.ready()).rejects.toThrow('readiness');
    },
  );

  it('keeps a transport refusal as a failed read', async () => {
    const failure = new Error('ZZ TEST readiness unavailable');
    fetcher.mockRejectedValueOnce(failure);
    await expect(healthApi.ready()).rejects.toBe(failure);
  });
});
