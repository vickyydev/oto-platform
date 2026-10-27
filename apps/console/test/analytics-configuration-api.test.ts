import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleConfigurationApi, consolePagePath, settingsTarget } from '@/api/consoleConfiguration';

const fetcher = vi.fn<typeof fetch>();
const assign = vi.fn<(url: string) => void>();
beforeEach(() => {
  fetcher.mockReset(); assign.mockReset();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('window', { location: { assign } });
});
afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
const lastRequest = () => {
  const [request, options] = fetcher.mock.calls.at(-1)!;
  return { url: new URL(String(request), 'https://admin.test'), options };
};
const PARK = '01964600-0000-7000-8000-00000000000a';

describe('Configuration and drift client (SCRUM-646)', () => {
  it('reads the settings index with only the explicitly chosen park', async () => {
    for (const branchId of [undefined, null, '', PARK]) {
      answer({ entries: [] });
      await consoleConfigurationApi.configuration(branchId);
      const { url, options } = lastRequest();
      expect(url.pathname).toBe('/api/console/configuration');
      expect([...url.searchParams]).toEqual(branchId ? [['branchId', PARK]] : []);
      expect(options?.method).toBe('GET');
      expect(options?.body).toBeUndefined();
    }
  });

  it('reads drift for the default selection or the named parks, read-only', async () => {
    for (const branches of [undefined, [] as string[], [PARK]]) {
      answer({ comparisons: [] });
      await consoleConfigurationApi.drift(branches);
      const { url, options } = lastRequest();
      expect(url.pathname).toBe('/api/console/analytics/drift');
      expect([...url.searchParams]).toEqual(branches?.length ? [['branches', PARK]] : []);
      expect(options?.method).toBe('GET');
    }
  });

  it('hands an app-owned setting off through one fresh acting-user handoff', async () => {
    answer({ launchUrl: 'https://inbox.test/#handoff=zz-local-placeholder' });
    await consoleConfigurationApi.openInApp({ app: 'inbox', path: '/?settings=templates' }, () => true);
    const { url, options } = lastRequest();
    expect(url.pathname).toBe('/api/auth/handoff');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ app: 'inbox' });
    expect((options?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    expect(assign).toHaveBeenCalledTimes(1);
    const destination = new URL(assign.mock.calls[0]![0]);
    expect(destination.origin).toBe('https://inbox.test');
    expect(new URLSearchParams(destination.hash.slice(1)).get('to')).toBe('/?settings=templates');
  });

  it.each([
    { app: 'pos', path: '/settings' }, { app: 'inbox', path: '//evil.example/' }, { app: 'inbox', path: 'https://evil.example/' },
    { app: 'inbox', path: '/\\evil' },
  ])('refuses an unknown app or a foreign path before any request (%j)', async target => {
    await expect(consoleConfigurationApi.openInApp(target as never, () => true)).rejects.toThrow('not available');
    expect(fetcher).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([{}, { launchUrl: '' }, { launchUrl: 'javascript:alert(1)' }, { launchUrl: 'https://inbox.test/' },
    { launchUrl: 'https://user:zz-local-placeholder@inbox.test/#handoff=zz-local-placeholder' }])(
    'refuses an unsafe issued address without navigating (%j)', async body => {
      answer(body);
      await expect(consoleConfigurationApi.openInApp({ app: 'inbox', path: '/?settings=templates' }, () => true))
        .rejects.toThrow('configured destination');
      expect(assign).not.toHaveBeenCalled();
    });

  it('does not navigate once the page is no longer current', async () => {
    let current = true;
    fetcher.mockImplementationOnce(async () => {
      current = false;
      return new Response(JSON.stringify({ launchUrl: 'https://inbox.test/#handoff=zz-local-placeholder' }), { status: 200 });
    });
    await consoleConfigurationApi.openInApp({ app: 'inbox', path: '/?settings=templates' }, () => current);
    expect(assign).not.toHaveBeenCalled();
  });

  it('reads sources and the preview read-only, with only the given query', async () => {
    answer({ branches: [] });
    await consoleConfigurationApi.sources([PARK]);
    let { url, options } = lastRequest();
    expect(url.pathname).toBe('/api/console/analytics/sources');
    expect([...url.searchParams]).toEqual([['branches', PARK]]);
    expect(options?.method).toBe('GET');
    answer({ days: 30 });
    await consoleConfigurationApi.sourcePreview(PARK, 'pisell');
    ({ url, options } = lastRequest());
    expect(url.pathname).toBe('/api/console/analytics/sources/preview');
    expect([...url.searchParams]).toEqual([['branchId', PARK], ['source', 'pisell']]);
    expect(options?.method).toBe('GET');
    expect(options?.body).toBeUndefined();
  });

  it('saves a confirmed switch and queues a re-run each under its own fresh key', async () => {
    answer({ changed: true });
    await consoleConfigurationApi.switchSource(PARK, { source: 'papaya', preference: 'both' });
    const first = lastRequest();
    expect(first.url.pathname).toBe(`/api/console/analytics/sources/${PARK}`);
    expect(first.options?.method).toBe('PUT');
    expect(JSON.parse(String(first.options?.body))).toEqual({ source: 'papaya', preference: 'both' });
    answer({ days: 2 });
    await consoleConfigurationApi.rerun(PARK, '2026-09-01', '2026-09-02');
    const second = lastRequest();
    expect(second.url.pathname).toBe('/api/console/analytics/rerun');
    expect(second.options?.method).toBe('POST');
    expect(JSON.parse(String(second.options?.body))).toEqual({ branchId: PARK, from: '2026-09-01', to: '2026-09-02' });
    const keys = [first, second].map(call => (call.options?.headers as Record<string, string>)['idempotency-key']);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  it('accepts only Console page paths and known settings apps', () => {
    expect(consolePagePath('/catalogue/tax')).toBe('/catalogue/tax');
    for (const bad of [null, '', 'catalogue/tax', '//evil.example', '/\\evil', 'https://evil.example/', '/a b']) {
      expect(consolePagePath(bad), String(bad)).toBeNull();
    }
    expect(settingsTarget({ app: 'radar', path: '/' })).toEqual({ app: 'radar', path: '/' });
    expect(settingsTarget(null)).toBeNull();
  });
});
