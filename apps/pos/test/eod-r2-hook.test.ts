import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOAT, type EndOfDayRecord, type EodStrandedRow } from '@oto/shared';
import { renderHook } from './support/hooks';
import { api, ApiError } from '@/api/client';
import { useEndOfDay } from '@/components/eod/useEndOfDay';
import { withCounted } from '@/api/endOfDay';
import * as catalogStore from '@/store/catalogStore';
import type { Branch } from '@/types';
import * as React from 'react';
import { SettlementPanel } from '@/components/eod/SettlementPanel';
import { settlementsApi } from '@/api/settlements';

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
Object.assign(globalThis, { React });

/**
 * S2-15a round 2 — the hook behind the additions: a resolved row leaves the
 * list, a refusal is answered and the next press is a new attempt, the lists
 * are read again without losing what staff typed, and a closed day's receipt
 * is reprinted.
 */

const BRANCH_API = '0192f000-0000-7000-8000-00000000b001';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const row: EodStrandedRow = {
  kind: 'band',
  subjectId: '0192f000-0000-7000-8000-0000000b0001',
  bandCode: 'A7K2Q',
  childName: null,
  childrenWithBand: 1,
  lastGateEvent: null,
  checkedInAt: null,
  sale: null,
  guardian: null,
};

function day(status: 'open' | 'closed', extra: Partial<EndOfDayRecord> = {}): EndOfDayRecord {
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
    ...extra,
  };
}

beforeEach(() => {
  vi.spyOn(catalogStore, 'getBranches').mockReturnValue([{ id: 'hkt-central', apiId: BRANCH_API } as unknown as Branch]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function receiptDay(status: string): EndOfDayRecord {
  return day('closed', {
    receipt: {
      number: 'T1-EOD-000001', stationId: null, stationName: 'Reception Till 1', note: null,
      jobs: [{ id: '0192f000-0000-7000-8000-00000000f001', status, reprint: false,
        deviceLabel: 'Receipt printer', errorMessage: null, queuedAt: '2026-10-02T14:00:00.000Z' }],
    },
  });
}

describe('eod-r2 useEndOfDay', () => {
  it('offers an all-payments export even when no terminal has a TID', async () => {
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.spyOn(settlementsApi, 'read').mockResolvedValue({
      branchId: BRANCH_API, date: '2026-10-02', devices: [], batches: [], lines: [], unmatchedAttempts: [],
    });
    const download = vi.spyOn(settlementsApi, 'export').mockRejectedValue(new Error('Test download stopped'));
    const hook = renderHook(() => SettlementPanel({ branchId: BRANCH_API, date: '2026-10-02', canSettle: false }));
    type Props = { children?: React.ReactNode; 'aria-label'?: string; value?: string; disabled?: boolean; onClick?: () => void };
    const find = (node: React.ReactNode, matches: (props: Props) => boolean): Props | undefined => {
      for (const child of React.Children.toArray(node)) {
        if (!React.isValidElement<Props>(child)) continue;
        if (matches(child.props)) return child.props;
        const result = find(child.props.children, matches);
        if (result) return result;
      }
    };
    try {
      await flush();
      expect(find(hook.result.current, (props) => props['aria-label'] === 'Export payment scope')?.value).toBe('');
      const button = find(hook.result.current, (props) => props.children === 'Download CSV');
      expect(button?.disabled).toBe(false);
      button?.onClick?.();
      await flush();
      expect(download).toHaveBeenCalledWith(BRANCH_API, '2026-10-02', undefined);
    } finally { hook.unmount(); }
  });

  it('retains a terminal settlement identity while the original request is still in flight', async () => {
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.spyOn(settlementsApi, 'read').mockResolvedValue({
      branchId: BRANCH_API, date: '2026-10-02', devices: [{ id: BRANCH_API, label: 'Test terminal', tid: null, provider: 'simulator' }],
      batches: [], lines: [], unmatchedAttempts: [],
    });
    const run = vi.spyOn(settlementsApi, 'run')
      .mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_IN_FLIGHT', 'The original request is still running'))
      .mockResolvedValue({ batchId: BRANCH_API, commandId: BRANCH_API, state: 'pending' });
    const hook = renderHook(() => SettlementPanel({ branchId: BRANCH_API, date: '2026-10-02', canSettle: true }));
    type Props = { children?: React.ReactNode; 'aria-label'?: string; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void };
    const find = (node: React.ReactNode, matches: (props: Props) => boolean): Props | undefined => {
      for (const child of React.Children.toArray(node)) {
        if (!React.isValidElement<Props>(child)) continue;
        if (matches(child.props)) return child.props;
        const result = find(child.props.children, matches);
        if (result) return result;
      }
    };
    try {
      await flush();
      find(hook.result.current, (props) => props['aria-label'] === 'Settlement terminal')!.onChange!({ target: { value: BRANCH_API } });
      find(hook.result.current, (props) => props.children === 'Run settlement')!.onClick!();
      await flush();
      find(hook.result.current, (props) => props.children === 'Run settlement')!.onClick!();
      await flush();
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]![3]).toBe(run.mock.calls[0]![3]);
    } finally { hook.unmount(); }
  });

  it('refreshes a queued closed-day receipt until printed, then stops', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(receiptDay('queued')).mockResolvedValue(receiptDay('printed'));
    const hook = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.result.current.record?.receipt?.jobs.at(-1)?.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hook.result.current.record?.receipt?.jobs.at(-1)?.status).toBe('printed');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(get).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it.each(['date', 'branch'] as const)('ignores a late receipt read after changing %s and preserves the open count', async (change) => {
    vi.useFakeTimers();
    const otherBranch = '0192f000-0000-7000-8000-00000000b002';
    vi.mocked(catalogStore.getBranches).mockReturnValue([
      { id: 'hkt-central', apiId: BRANCH_API }, { id: 'hkt-other', apiId: otherBranch },
    ] as unknown as Branch[]);
    const next = change === 'date' ? { date: '2026-10-03', branch: 'hkt-central' }
      : { date: '2026-10-02', branch: 'hkt-other' };
    const nextBranchId = change === 'branch' ? otherBranch : BRANCH_API;
    let finish!: (record: EndOfDayRecord) => void;
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce(receiptDay('queued'))
      .mockImplementationOnce(() => new Promise<EndOfDayRecord>((resolve) => { finish = resolve; }))
      .mockResolvedValue(day('open', { date: next.date, branchId: nextBranchId }));
    const hook = renderHook(({ date, branch }) => useEndOfDay(date, branch), { date: '2026-10-02', branch: 'hkt-central' });
    await vi.advanceTimersByTimeAsync(3_000);
    hook.rerender(next);
    await vi.advanceTimersByTimeAsync(0);
    hook.result.current.setRecord((prev) => withCounted(prev, 6_100));
    finish(receiptDay('printed'));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(hook.result.current.record?.date).toBe(next.date);
    expect(hook.result.current.record?.branchId).toBe(nextBranchId);
    expect(hook.result.current.record?.status).toBe('open');
    expect(hook.result.current.record?.cashCount.countedSatang).toBe(6_100_00);
    expect(get).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it('cancels pending receipt polling and its in-flight answer on unmount', async () => {
    vi.useFakeTimers();
    let finish!: (record: EndOfDayRecord) => void;
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(receiptDay('queued'))
      .mockImplementationOnce(() => new Promise<EndOfDayRecord>((resolve) => { finish = resolve; }));
    const hook = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await vi.advanceTimersByTimeAsync(3_000);
    const before = hook.result.current.record;
    hook.unmount();
    finish(receiptDay('printed'));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(hook.result.current.record).toBe(before);
    expect(get).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a resolved row leaves the list the platform answers with', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(day('open', { stranded: [row], provisional: [] }));
    const post = vi.spyOn(api, 'post').mockResolvedValue({ resolutionId: '0192f000-0000-7000-8000-0000000f0001', replayed: false, stranded: [] });
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    expect(result.current.record?.stranded).toHaveLength(1);
    await result.current.resolve(row, 'band_lost');
    expect(post).toHaveBeenCalledWith(
      `/branches/${BRANCH_API}/end-of-day/stranded/resolve`,
      expect.objectContaining({ kind: 'band', subjectId: row.subjectId, reason: 'band_lost', date: '2026-10-02' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(result.current.record?.stranded).toEqual([]);
    expect(result.current.resolveError).toBeNull();
  });

  it('a provisional refusal is shown, the lists are read again keeping the count, and the next press is a new key', async () => {
    const waiting = { boxId: '0192f000-0000-7000-8000-00000000c001', name: 'Counter Pi', reason: 'outbox' as const, waiting: 3, since: null, message: 'Counter Pi has 3 records it has not sent yet.' };
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(day('open', { provisional: [], stranded: [] }))
      .mockResolvedValueOnce(day('open', { provisional: [waiting], stranded: [] }));
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValue(new ApiError(409, 'DAY_PROVISIONAL', 'The day is still provisional — Counter Pi has 3 records it has not sent yet.'));
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    result.current.setRecord((prev) => withCounted(prev, 6_100));
    await flush();
    await result.current.close();
    await flush();
    expect(result.current.closeError).toContain('Counter Pi');
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.record?.provisional).toEqual([waiting]);
    // What staff typed is kept.
    expect(result.current.record?.cashCount.countedSatang).toBe(6_100_00);
    await result.current.close();
    const keys = post.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a manager’s reason rides on Close Day', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(day('open', { stranded: [row] }));
    const post = vi.spyOn(api, 'post').mockResolvedValue(day('closed'));
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    result.current.setOverrideReason('Gate lost power');
    await flush();
    await result.current.close();
    expect(post).toHaveBeenCalledWith(
      `/branches/${BRANCH_API}/end-of-day/close`,
      expect.objectContaining({ override: { reason: 'Gate lost power' } }),
      expect.anything(),
    );
    expect(result.current.record?.status).toBe('closed');
  });

  it('a closed day’s receipt is reprinted and the answer shown', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(day('closed'));
    const reprinted = day('closed', {
      receipt: { number: 'T1-EOD-000001', stationId: null, stationName: 'Reception Till 1', jobs: [], note: null },
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue(reprinted);
    const { result } = renderHook(() => useEndOfDay('2026-10-02', 'hkt-central'));
    await flush();
    await result.current.reprint();
    expect(post).toHaveBeenCalledWith(`/branches/${BRANCH_API}/end-of-day/reprint`, expect.objectContaining({ date: '2026-10-02' }), expect.anything());
    expect(result.current.record?.receipt?.number).toBe('T1-EOD-000001');
    expect(result.current.reprintError).toBeNull();
  });
});
