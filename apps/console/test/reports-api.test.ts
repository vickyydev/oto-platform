import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportsApi } from '@/api/reports';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
const url = () => new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'https://console.test');
const filters = { startDate: '2026-10-01', endDate: '2026-10-22', branchId: 'zz-own-park' };
const wallet = { summary: { grantedSatang: 12345, spentSatang: 2345, refundedSatang: 0, expiredSatang: 0,
  reactivatedSatang: 100, outstandingSatang: 10000, ledgerOutstandingSatang: 10000, entryCount: 1 },
rows: [{ keyDisplay: 'ZZ TEST band', holderName: null, kind: 'grant', amountSatang: 12345,
  source: 'sale', at: '2026-10-22T00:00:00Z', by: null }] };

describe('Admin Reports reuses canonical read transports', () => {
  it('reads canonical park clocks through the existing typed summary without a branch-directory gate', async () => {
    answer({ branches: [{ branchId: 'zz-own-park', name: 'ZZ TEST Park', timezone: 'Asia/Bangkok', businessDayStart: '08:00', today: '2026-10-31' }] });
    expect(await reportsApi.parks()).toEqual([{ id: 'zz-own-park', name: 'ZZ TEST Park', timezone: 'Asia/Bangkok', businessDayStart: '08:00', today: '2026-10-31' }]);
    expect(url().pathname).toBe('/api/analytics/summary'); expect(url().searchParams.get('group')).toBe('total');
    expect(url().searchParams.get('from')).toBe(url().searchParams.get('to'));
  });
  it('carries exact park/date filters and keeps all parks as an omitted parameter', async () => {
    answer({}); await reportsApi.analytics.sales({ branches: ['zz-own-park'], from: filters.startDate, to: filters.endDate });
    expect(url().pathname).toBe('/api/analytics/reports/sales');
    expect(Object.fromEntries(url().searchParams)).toEqual({ branches: 'zz-own-park', from: filters.startDate, to: filters.endDate });
    answer({}); await reportsApi.analytics.vat({ from: filters.startDate, to: filters.endDate }, 'month');
    expect(Object.fromEntries(url().searchParams)).toEqual({ from: filters.startDate, to: filters.endDate, period: 'month' });
  });

  it('preserves wallet satang, live balance, guest fallback and native 100/1000 limits', async () => {
    const read = reportsApi.walletReader([{ id: 'zz-own-park' }]);
    answer(wallet); const report = await read(filters);
    expect(Object.fromEntries(url().searchParams)).toEqual({ from: filters.startDate, to: filters.endDate, branchId: filters.branchId, limit: '100' });
    expect(report.summary).toMatchObject({ grantedSatang: 12345, netOutstandingSatang: 10000, reactivatedSatang: 100 });
    expect(report.rows[0]).toMatchObject({ wristbandCode: 'ZZ TEST band', customerNickname: 'Guest', amountSatang: 12345 });
    answer(wallet); await read({ ...filters, branchId: 'all' }, 1000);
    expect(url().searchParams.has('branchId')).toBe(false); expect(url().searchParams.get('limit')).toBe('1000');
    fetcher.mockClear(); expect((await read({ ...filters, branchId: 'zz-local-only' })).rows).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads voucher figures separately and maps only live native promo metadata', async () => {
    answer({}); await reportsApi.voucherReport({ branches: [filters.branchId], from: filters.startDate, to: filters.endDate });
    expect(url().pathname).toBe('/api/vouchers/promotions/report');
    expect(url().searchParams.get('branchId')).toBe(filters.branchId);
    answer({ discounts: [
      { id: 'zz-live', code: 'ZZTEST', label: 'ZZ TEST promo', kind: 'percent', valueBp: 500, active: true,
        usedCount: 8, usageLimit: 10, stackable: false, archivedAt: null },
      { id: 'zz-archived', code: 'ZZOLD', label: 'ZZ TEST old', kind: 'fixed', valueSatang: 100,
        active: false, archivedAt: '2026-10-01T00:00:00Z' },
    ] });
    expect(await reportsApi.discounts()).toEqual([expect.objectContaining({ code: 'ZZTEST', value: 5, usedCount: 8, usageLimit: 10 })]);
    expect(url().pathname).toBe('/api/menu/discounts');
  });

  it('opens Radar only through a fresh explicit handoff and refuses a missing destination', async () => {
    const assign = vi.fn(); vi.stubGlobal('window', { location: { assign } });
    answer({}); await expect(reportsApi.openRadar()).rejects.toThrow('no configured destination');
    expect(assign).not.toHaveBeenCalled();
    answer({ launchUrl: 'https://radar.test/#handoff=ZZ-TEST-opaque' }); await reportsApi.openRadar();
    expect(url().pathname).toBe('/api/auth/handoff');
    const options = fetcher.mock.calls.at(-1)?.[1];
    expect(options?.method).toBe('POST'); expect(JSON.parse(String(options?.body))).toEqual({ app: 'radar' });
    expect(options?.headers).toHaveProperty('idempotency-key', expect.any(String));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toMatch(/^https:\/\/radar\.test\//);
  });

  it('does not navigate an ended actor lifetime when its Radar handoff arrives late', async () => {
    const assign = vi.fn(); vi.stubGlobal('window', { location: { assign } });
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    let current = true;
    const pending = reportsApi.openRadar(() => current);
    current = false;
    resolve(new Response(JSON.stringify({ launchUrl: 'https://radar.test/#handoff=ZZ-TEST-opaque' }), { status: 200 }));
    await pending;
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not echo a one-use destination when browser navigation fails', async () => {
    vi.stubGlobal('window', { location: { assign: () => { throw new Error('ZZ TEST private destination'); } } });
    answer({ launchUrl: 'https://radar.test/#handoff=ZZ-TEST-opaque' });
    await expect(reportsApi.openRadar()).rejects.toThrow('Radar could not be opened. Please try again.');
  });
});
