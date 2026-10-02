import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOAT, type EndOfDayRecord } from '@oto/shared';
import { renderHook } from './support/hooks';
import { api, ApiError } from '@/api/client';
import { useEndOfDay } from '@/components/eod/useEndOfDay';
import * as catalogStore from '@/store/catalogStore';
import type { Branch } from '@/types';

vi.mock('react', () => import('./support/hooks'));

/**
 * S2-15a round 1 — the End of Day tab's data, from the platform: the day is
 * read for the Today section's date and branch, Close Day shows what the
 * platform locked, and a close somebody else got to first (409) reloads the
 * locked day — the prototype's `closeEndOfDay(...) ?? getEndOfDay(...)`.
 */

const BRANCH_API = '0192f000-0000-7000-8000-00000000b001';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function day(status: 'open' | 'closed'): EndOfDayRecord {
  return {
    id: status === 'open' ? `eod-${BRANCH_API}-2026-10-02` : '0192f000-0000-7000-8000-00000000e001',
    branchId: BRANCH_API,
    date: '2026-10-02',
    status,
    lines: [{ channel: 'cash', expectedSatang: 100_00, actualSatang: null, differenceSatang: 0 }],
    cashCount: { countedSatang: null, floatSatang: DEFAULT_FLOAT, cashIncomeSatang: null },
    floatFromDate: null,
    floatLeftSatang: DEFAULT_FLOAT,
    vouchers: { handedOut: null, redeemed: null },
    totalExpectedSatang: 100_00,
    totalActualSatang: 0,
    totalDifferenceSatang: 0,
    notes: null,
    closedBy: status === 'closed' ? { accountId: '0192f000-0000-7000-8000-00000000a002', name: 'Som' } : null,
    closedAt: status === 'closed' ? '2026-10-02T14:00:00.000Z' : null,
    terminals: [],
    cashMovements: [],
  };
}

beforeEach(() => {
  vi.spyOn(catalogStore, 'getBranches').mockReturnValue([{ id: 'hkt-central', apiId: BRANCH_API } as unknown as Branch]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEndOfDay', () => {
  it('reads the day, closes it, and shows what the platform locked', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(day('open'));
    const post = vi.spyOn(api, 'post').mockResolvedValue(day('closed'));
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    expect(get).toHaveBeenCalledWith(`/branches/${BRANCH_API}/end-of-day?date=2026-10-02`);
    expect(result.current.record?.status).toBe('open');
    await result.current.close();
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.current.record?.status).toBe('closed');
    expect(result.current.closeError).toBeNull();
  });

  it('a day closed by somebody else first: the 409 reloads the locked day', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(day('open')).mockResolvedValueOnce(day('closed'));
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'DAY_CLOSED', 'This day is already closed.'));
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    await result.current.close();
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.record?.status).toBe('closed');
    expect(result.current.record?.closedBy?.name).toBe('Som');
    expect(result.current.closeError).toBeNull();
  });

  it('any other refusal is shown in the platform’s words and the day stays open', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(day('open'));
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Not allowed'));
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    await result.current.close();
    expect(result.current.record?.status).toBe('open');
    expect(result.current.closeError).toBe('Not allowed');
  });
});
