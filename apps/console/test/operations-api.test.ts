import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationsApi } from '@/api/operations';
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
const request = () => ({ url: new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'https://admin.test'), init: fetcher.mock.calls.at(-1)?.[1] });
const hold = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('Admin operational hosts retain native contracts and current ownership', () => {
  it('keeps member search escaping and the native member body and caller identity', async () => {
    const api = createOperationsApi(() => true, async () => undefined);
    answer({ members: [] }); await api.membersApi.list('ZZ TEST & family');
    expect(request().url.pathname).toBe('/api/members'); expect(request().url.searchParams.get('q')).toBe('ZZ TEST & family');
    answer({ member: { id: 'zz-person' } });
    await api.membersApi.create({ phone: 'ZZ TEST local phone', nickname: 'ZZ TEST Person' }, 'zz-person');
    expect(request().init?.method).toBe('POST');
    expect(JSON.parse(String(request().init?.body))).toEqual({ id: 'zz-person', phone: 'ZZ TEST local phone', nickname: 'ZZ TEST Person' });
    expect(new Headers(request().init?.headers).get('idempotency-key')).toBeTruthy();
  });
  it('keeps wallet lookup and reactivation reason and explicit retry identity', async () => {
    const api = createOperationsApi(() => true, async () => undefined);
    answer({ wallet: null, ledger: [] }); await api.walletApi.lookupWallet('  ZZ TEST & wallet  ');
    expect(request().url.pathname).toBe('/api/wallets/lookup'); expect(request().url.searchParams.get('key')).toBe('ZZ TEST & wallet');
    for (let repeat = 0; repeat < 2; repeat++) {
      answer({}); await api.walletApi.reactivateWallet('zz/wallet', 'ZZ TEST manager reason', '00000000-0000-4000-8000-000000000001');
      expect(request().url.pathname).toBe('/api/wallets/zz%2Fwallet/reactivate');
      expect(JSON.parse(String(request().init?.body))).toEqual({ reason: 'ZZ TEST manager reason' });
      expect(new Headers(request().init?.headers).get('idempotency-key')).toBe('00000000-0000-4000-8000-000000000001');
    }
  });
  it('reads the selected park stock and retained places, never the session branch', async () => {
    const api = createOperationsApi(() => true, async () => undefined);
    for (const read of [api.stockLevels, api.stockLocations, api.sellableStock]) { answer({}); await read('zz-selected-park'); }
    expect(fetcher.mock.calls.map(row => new URL(String(row[0]), 'https://admin.test').pathname)).toEqual([
      '/api/branches/zz-selected-park/stock/levels', '/api/branches/zz-selected-park/stock/locations', '/api/branches/zz-selected-park/stock/sellable',
    ]);
    expect(new URL(String(fetcher.mock.calls[1]![0]), 'https://admin.test').searchParams.get('all')).toBe('true');
  });
  it('refuses an abandoned actor or park before reading or mutating', async () => {
    const reload = vi.fn(), api = createOperationsApi(() => false, reload);
    await expect(api.membersApi.list()).rejects.toThrow('changed');
    await expect(api.walletApi.reactivateWallet('zz-wallet', 'ZZ TEST reason')).rejects.toThrow('changed');
    await expect(api.stockApi.adjust('zz-park', { stockItemId: 'zz-item', delta: 1, reason: 'ZZ TEST reason' })).rejects.toThrow('changed');
    expect(fetcher).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  });
  it('rejects a late read instead of handing old rows to a new host', async () => {
    let current = true; const pending = hold<Response>(); fetcher.mockReturnValueOnce(pending.promise);
    const api = createOperationsApi(() => current, async () => undefined);
    const read = api.membersApi.list(); void read.catch(() => undefined); current = false;
    pending.resolve(new Response(JSON.stringify({ members: [{ id: 'zz-old-person' }] })));
    await expect(read).rejects.toThrow('changed');
  });
  it('does not refresh a new host after an old write has already committed', async () => {
    let current = true; const pending = hold<Response>(), reload = vi.fn(); fetcher.mockReturnValueOnce(pending.promise);
    const api = createOperationsApi(() => current, reload);
    const write = api.stockApi.adjust('zz-old-park', { stockItemId: 'zz-item', delta: 1, reason: 'ZZ TEST reason' }); void write.catch(() => undefined);
    current = false; pending.resolve(new Response('{}'));
    await expect(write).rejects.toThrow('changed'); expect(reload).not.toHaveBeenCalled();
  });
  it('waits for the confirmed stock reread and preserves its failure', async () => {
    const failure = new Error('ZZ TEST saved but refresh refused'), reload = vi.fn().mockRejectedValueOnce(failure);
    const api = createOperationsApi(() => true, reload); answer({ ok: true });
    await expect(api.stockApi.adjust('zz-selected-park', { stockItemId: 'zz-item', delta: 1, reason: 'ZZ TEST reason' })).rejects.toBe(failure);
    expect(reload).toHaveBeenCalledExactlyOnceWith('zz-selected-park'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves server refusal without inventing empty stock or member data', async () => {
    const api = createOperationsApi(() => true, async () => undefined);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'ZZ TEST not permitted' } }), { status: 403 }));
    await expect(api.stockLevels('zz-foreign-park')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
