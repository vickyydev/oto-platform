import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * S2-12 round 4 — the occupancy chip's seam reads the platform's route.
 *
 * The chip itself (poll every 5 s, the same button and popover) renders what
 * `fetchLiveOccupancy` returns; this pins that it asks the ACTIVE branch's
 * platform id, passes the count through untouched, and carries `stale` /
 * `asOf` so the chip can say "stale since" rather than pretend.
 */

const active: { apiId?: string } = { apiId: 'b0000000-0000-7000-8000-000000000001' };
vi.mock('@/store/catalogStore', () => ({
  getActiveBranch: () => ({ id: 'hkt', name: 'HKT Central', active: true, ...active }),
}));

const { fetchLiveOccupancy } = await import('../src/api/occupancy');

afterEach(() => {
  active.apiId = 'b0000000-0000-7000-8000-000000000001';
});

function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('fetchLiveOccupancy (S2-12 round 4)', () => {
  it('reads GET /branches/:id/occupancy for the active branch and keeps the chip shape', async () => {
    const calls = stubFetch({
      adults: 3,
      kids: 4,
      total: 7,
      asOf: '2026-10-01T05:00:00.000Z',
      stale: false,
      staleAfterSeconds: 150,
      gates: 1,
      businessDate: '2026-10-01',
    });
    const got = await fetchLiveOccupancy();
    expect(calls).toEqual(['/api/branches/b0000000-0000-7000-8000-000000000001/occupancy']);
    expect(got).toEqual({ adults: 3, kids: 4, total: 7, stale: false, asOf: '2026-10-01T05:00:00.000Z', gates: 1 });
  });

  it('passes a stale answer through with the moment the gate was last heard from', async () => {
    stubFetch({
      adults: 2,
      kids: 0,
      total: 2,
      asOf: '2026-10-01T04:00:00.000Z',
      stale: true,
      staleAfterSeconds: 150,
      gates: 1,
      businessDate: '2026-10-01',
    });
    const got = await fetchLiveOccupancy();
    expect(got.stale).toBe(true);
    expect(got.asOf).toBe('2026-10-01T04:00:00.000Z');
  });

  it('a branch the platform does not know reads as stale with no gate, and asks nothing', async () => {
    active.apiId = undefined;
    const calls = stubFetch({});
    const got = await fetchLiveOccupancy();
    expect(calls).toEqual([]);
    expect(got).toEqual({ adults: 0, kids: 0, total: 0, stale: true, asOf: null, gates: 0 });
  });

  it('a refused read is an error the chip shows as stale, not a zero', async () => {
    stubFetch({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
    await expect(fetchLiveOccupancy()).rejects.toThrow();
  });
});
