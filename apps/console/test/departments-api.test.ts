import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { departmentsApi } from '@/api/departments';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

describe('Departments source navigation', () => {
  it('reads only the existing directory endpoint and carries the exact search', async () => {
    answer({ departments: [] });
    expect(await departmentsApi.read('ZZ TEST & reception')).toEqual({ departments: [] });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]), 'https://admin.test');
    expect(url.pathname).toBe('/api/departments');
    expect(url.searchParams.get('q')).toBe('ZZ TEST & reception');
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('issues a fresh acting-user handoff with idempotency and targets the native department list', async () => {
    answer({ launchUrl: 'https://oto.test/#handoff=zz-local-placeholder' });
    const destination = new URL(await departmentsApi.sourceDestination());
    expect(destination.origin).toBe('https://oto.test');
    expect(destination.hash).toContain('handoff=zz-local-placeholder');
    expect(new URLSearchParams(destination.hash.slice(1)).get('to')).toBe('/departments');
    const [request, options] = fetcher.mock.calls[0]!;
    expect(request).toBe('/api/auth/handoff');
    expect(options?.method).toBe('POST');
    expect(options?.credentials).toBe('same-origin');
    expect(JSON.parse(String(options?.body))).toEqual({ app: 'oto_app' });
    expect((options?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { launchUrl: '' }, { launchUrl: 'javascript:alert(1)' }, { launchUrl: 'https://oto.test/' }])(
    'refuses an unavailable or unsafe source destination without another request: %j', async (body) => {
      answer(body);
      await expect(departmentsApi.sourceDestination()).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
