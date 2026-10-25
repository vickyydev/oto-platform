import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { staffApi, type StaffSource } from '@/api/staff';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

describe('Staff summary and native source client', () => {
  it('reads only the summary endpoint with the explicit selected core park when present', async () => {
    const branch = '01900000-0000-7000-8000-000000000001';
    for (const selected of [undefined, null, branch]) {
      answer({ source: 'unavailable' });
      await staffApi.read(selected);
      const [request, options] = fetcher.mock.calls.at(-1)!;
      const url = new URL(String(request), 'https://admin.test');
      expect(url.pathname).toBe('/api/staff/summary');
      expect([...url.searchParams]).toEqual(selected ? [['branchId', branch]] : []);
      expect(options?.method).toBe('GET');
      expect(options?.credentials).toBe('same-origin');
      expect(options?.body).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('issues one fresh acting-user handoff for each of the four fixed native destinations', async () => {
    const sources: Array<[StaffSource, string]> = [
      ['working', '/timekeeping-review?tab=live'], ['attendance', '/timekeeping-review?tab=issues'],
      ['leave', '/scheduling'], ['payroll', '/payroll'],
    ];
    const keys: string[] = [];
    for (const [source, path] of sources) {
      answer({ launchUrl: 'https://oto.test/#handoff=zz-local-placeholder' });
      const destination = new URL(await staffApi.sourceDestination(source));
      expect(destination.origin).toBe('https://oto.test');
      expect(new URLSearchParams(destination.hash.slice(1)).get('to')).toBe(path);
      const [request, options] = fetcher.mock.calls.at(-1)!;
      expect(request).toBe('/api/auth/handoff');
      expect(options?.method).toBe('POST');
      expect(JSON.parse(String(options?.body))).toEqual({ app: 'oto_app' });
      const key = (options?.headers as Record<string, string>)['idempotency-key'];
      expect(key).toBeTruthy(); keys.push(key!);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new Set(keys).size).toBe(4);
  });

  it.each(['https://foreign.test/', '/payroll?company=foreign', '__proto__'])('refuses an unrecognized source before I/O (%s)', async source => {
    await expect(staffApi.sourceDestination(source as StaffSource)).rejects.toThrow('not available');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { launchUrl: '' }, { launchUrl: 'javascript:alert(1)' }, { launchUrl: 'https://oto.test/' },
    { launchUrl: 'https://user:zz-local-placeholder@oto.test/#handoff=zz-local-placeholder' },
    { launchUrl: 'https://oto.test/#handoff=zz-local-placeholder&to=%2Fother' },
  ])('refuses an unavailable or unsafe issued address without another request (%j)', async body => {
    answer(body);
    await expect(staffApi.sourceDestination('working')).rejects.toThrow('configured destination');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
