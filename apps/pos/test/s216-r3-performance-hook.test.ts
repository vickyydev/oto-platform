import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsSummary, AnalyticsSummaryRow } from '@oto/shared';
import { renderHook } from './support/hooks';
import { api, ApiError } from '@/api/client';
import { PERFORMANCE_REFRESH_MS, useDropOffInPark, usePerformance } from '@/components/floor/usePerformance';
import * as catalogStore from '@/store/catalogStore';
import type { Branch } from '@/types';

vi.mock('react', () => import('./support/hooks'));

/**
 * S2-15b round 3 — the Performance tab's figures, from the platform: the
 * rolled-up day for the Today section's date and branch (or every branch this
 * account may read), never this browser's copy of the sales.
 */

const HKT = '0192f000-0000-7000-8000-00000000b001';
const DEMO = '0192f000-0000-7000-8000-00000000b002';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function row(over: Partial<AnalyticsSummaryRow> = {}): AnalyticsSummaryRow {
  return {
    ticketsSatang: 248_000,
    fnbSatang: 45_000,
    merchSatang: 12_000,
    partiesSatang: 0,
    dropoffSatang: 119_000,
    revenueSatang: 424_000,
    txnCount: 5,
    creditPaidSatang: 20_000,
    guestsKids: 3,
    guestsAdults: 2,
    mix1h: 1,
    mix2h: 2,
    mixFullDay: 2,
    partiesCount: 0,
    refundsSatang: 0,
    discountsSatang: 0,
    compsSatang: 0,
    vatSatang: 0,
    serviceSatang: 0,
    byChannel: {},
    businessDate: null,
    provisional: true,
    rolledDays: 1,
    computedAt: '2026-10-06T07:00:00.000Z',
    formulaVersion: 1,
    ...over,
  };
}

function answer(over: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    from: '2026-10-06',
    to: '2026-10-06',
    group: 'total',
    source: 'oto_pos',
    branches: [
      {
        branchId: HKT,
        name: 'Oto Play Park, Central Floresta',
        timezone: 'Asia/Bangkok',
        businessDayStart: '05:00',
        today: '2026-10-06',
        lastRolledUpAt: '2026-10-06T07:05:00.000Z',
        rows: [row()],
        source: 'oto_pos',
      },
    ],
    omitted: [],
    readable: [{ branchId: HKT, name: 'Oto Play Park, Central Floresta' }],
    mergeable: [{ branchId: HKT, name: 'Oto Play Park, Central Floresta' }],
    merged: [row()],
    hours: null,
    lastRolledUpAt: '2026-10-06T07:05:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(catalogStore, 'getBranches').mockReturnValue([{ id: 'hkt-central', apiId: HKT } as unknown as Branch]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePerformance', () => {
  it('reads the branch’s rolled-up day and hands the tab the prototype’s figures in baht', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(answer());
    const { result } = renderHook(() => usePerformance('2026-10-06', 'hkt-central', 'branch', false));
    expect(result.current.report).toBeNull();
    await flush();
    expect(get).toHaveBeenCalledWith(`/analytics/summary?branches=${HKT}&from=2026-10-06&to=2026-10-06&group=total`);
    const report = result.current.report!;
    expect(report.netRevenueTHB).toBe(4240);
    expect(report.creditPaidTHB).toBe(200);
    expect(report.txnCount).toBe(5);
    expect(report.guests).toEqual({ kids: 3, adults: 2 });
    expect(report.revenueSplit).toEqual([
      { key: 'tickets', label: 'Tickets', amountTHB: 2480 },
      { key: 'fnb', label: 'F&B', amountTHB: 450 },
      { key: 'merch', label: 'Merch', amountTHB: 120 },
      { key: 'parties', label: 'Parties', amountTHB: 0 },
      { key: 'dropoff', label: 'Drop-off', amountTHB: 1190 },
    ]);
    expect(report.ticketMix).toEqual({ oneHour: 1, twoHour: 2, fullDay: 2 });
    expect(result.current.provisional).toBe(true);
    // An open day is as fresh as the last rollup.
    expect(result.current.updatedAt).toBe('2026-10-06T07:05:00.000Z');
    expect(result.current.timezone).toBe('Asia/Bangkok');
    expect(result.current.branchIds).toEqual([HKT]);
  });

  it('a day that has ended says when it was last written, not when the rollup last ran', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      answer({ merged: [row({ provisional: false, computedAt: '2026-10-05T14:10:00.000Z' })] }),
    );
    const { result } = renderHook(() => usePerformance('2026-10-05', 'hkt-central', 'branch', false));
    await flush();
    expect(result.current.provisional).toBe(false);
    expect(result.current.updatedAt).toBe('2026-10-05T14:10:00.000Z');
  });

  it('carries the branch’s trading day and day start, so the freshness line can tell a stale update (fix round)', async () => {
    // A stalled rollup: today is the 7th at the branch, the last run a day old.
    const stalled = answer({
      branches: [{ ...answer().branches[0]!, today: '2026-10-07', lastRolledUpAt: '2026-10-05T18:42:00.000Z' }],
      merged: [row({ revenueSatang: 0, rolledDays: 0, computedAt: null })],
      lastRolledUpAt: '2026-10-05T18:42:00.000Z',
    });
    vi.spyOn(api, 'get').mockResolvedValue(stalled);
    const { result } = renderHook(() => usePerformance('2026-10-07', 'hkt-central', 'branch', false));
    await flush();
    expect(result.current.today).toBe('2026-10-07');
    expect(result.current.businessDayStart).toBe('05:00');
    expect(result.current.updatedAt).toBe('2026-10-05T18:42:00.000Z');
  });

  it('All branches names no branch, so the platform adds up every one this account may read', async () => {
    const both = answer({
      readable: [
        { branchId: DEMO, name: 'Demo Branch 2' },
        { branchId: HKT, name: 'Oto Play Park, Central Floresta' },
      ],
      mergeable: [
        { branchId: DEMO, name: 'Demo Branch 2' },
        { branchId: HKT, name: 'Oto Play Park, Central Floresta' },
      ],
      branches: [
        { ...answer().branches[0]!, branchId: DEMO, name: 'Demo Branch 2' },
        answer().branches[0]!,
      ],
      merged: [row({ revenueSatang: 848_000, ticketsSatang: 496_000, fnbSatang: 90_000, merchSatang: 24_000, dropoffSatang: 238_000 })],
    });
    const get = vi.spyOn(api, 'get').mockResolvedValue(both);
    const { result, rerender } = renderHook(
      (scope: 'branch' | 'all') => usePerformance('2026-10-06', 'hkt-central', scope, false),
      'all' as 'branch' | 'all',
    );
    await flush();
    expect(get).toHaveBeenCalledWith('/analytics/summary?from=2026-10-06&to=2026-10-06&group=total');
    expect(result.current.report!.netRevenueTHB).toBe(8480);
    expect(result.current.readable).toHaveLength(2);
    expect(result.current.branchIds).toEqual([DEMO, HKT]);

    // Back to the one branch: its own figures, not the sum held over.
    get.mockResolvedValue(answer());
    rerender('branch');
    expect(result.current.report).toBeNull();
    await flush();
    expect(result.current.report!.netRevenueTHB).toBe(4240);
    // What this account may read is still known while the next answer is on its way.
    expect(result.current.readable).toHaveLength(1);
  });

  it('round 6: Today at two parks is not All branches — the offer follows the branches it may add up', async () => {
    // Reception reads Central and Demo Branch 2 one at a time (the Today
    // screen's permission) but holds analytics:read nowhere: nothing to add up.
    vi.spyOn(api, 'get').mockResolvedValue(
      answer({
        readable: [
          { branchId: DEMO, name: 'Demo Branch 2' },
          { branchId: HKT, name: 'Oto Play Park, Central Floresta' },
        ],
        mergeable: [],
      }),
    );
    const { result } = renderHook(() => usePerformance('2026-10-06', 'hkt-central', 'branch', false));
    await flush();
    expect(result.current.report!.netRevenueTHB).toBe(4240);
    expect(result.current.readable).toEqual([]);
  });

  it('a refusal is shown in the platform’s words; a branch not linked to the platform is said so', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Missing permission pos:cash:read'));
    const { result } = renderHook(() => usePerformance('2026-10-06', 'hkt-central', 'branch', false));
    await flush();
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBe('Missing permission pos:cash:read');

    const unlinked = renderHook(() => usePerformance('2026-10-06', 'nowhere', 'branch', false));
    await flush();
    expect(unlinked.result.current.error).toBe('This branch is not linked to the platform yet.');
  });

  it('an answer for a day the tab has moved on from is dropped', async () => {
    let resolveFirst: (a: AnalyticsSummary) => void = () => {};
    const get = vi
      .spyOn(api, 'get')
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve as (a: AnalyticsSummary) => void)))
      .mockResolvedValueOnce(answer({ merged: [row({ revenueSatang: 100_000, ticketsSatang: 100_000, fnbSatang: 0, merchSatang: 0, dropoffSatang: 0 })] }));
    const { result, rerender } = renderHook((date: string) => usePerformance(date, 'hkt-central', 'branch', false), '2026-10-05' as string);
    rerender('2026-10-06');
    await flush();
    resolveFirst(answer());
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.report!.date).toBe('2026-10-06');
    expect(result.current.report!.netRevenueTHB).toBe(1000);
  });

  it('while the day is today it reads again every minute; a failed re-read keeps the figures shown', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(answer()).mockRejectedValueOnce(new Error('offline'));
    const { result, unmount } = renderHook(() => usePerformance('2026-10-06', 'hkt-central', 'branch', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.current.report!.netRevenueTHB).toBe(4240);
    await vi.advanceTimersByTimeAsync(PERFORMANCE_REFRESH_MS);
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.report!.netRevenueTHB).toBe(4240);
    expect(result.current.error).toBeNull();
    unmount();
    await vi.advanceTimersByTimeAsync(PERFORMANCE_REFRESH_MS * 3);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('useDropOffInPark', () => {
  it('adds up the children in the park now at every branch the figures cover; one unread is "—"', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) =>
      path.includes(HKT) ? { inPark: 3 } : { inPark: 2 },
    );
    const { result, rerender } = renderHook((ids: string[]) => useDropOffInPark(ids), [HKT, DEMO]);
    expect(result.current).toBeNull();
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(5);

    get.mockRejectedValueOnce(new Error('denied'));
    rerender([HKT]);
    await flush();
    expect(result.current).toBeNull();
  });
});
