import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = join(root, 'packages/admin-screens');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const code = (path: string) => readFileSync(path, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

interface Options { idempotencyKey?: string; headers?: Record<string, string>; signal?: AbortSignal }
interface Transport {
  href: (path: string) => string;
  delete: (path: string, options?: Options) => Promise<unknown>;
  deleteWithBody: (path: string, body?: unknown, options?: Options) => Promise<unknown>;
  getFile: (path: string, signal?: AbortSignal) => Promise<{ blob: Blob; filename: string | null; contentType: string | null }>;
  getBlob: (path: string, signal?: AbortSignal) => Promise<Blob>;
  postBlob: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Blob>;
}
const adapterPath = fileURLToPath(new URL('../../pos/src/api/admin-screen-api.ts', import.meta.url));
let transport: Transport;
let calls: Array<{ url: string; method: string; body: unknown; headers: Headers; signal: AbortSignal | null | undefined; credentials: string | undefined }>;
let answer: (signal: AbortSignal | null | undefined) => Response | Promise<Response>;

beforeAll(async () => {
  const loaded: unknown = await import(adapterPath);
  expect(loaded).toHaveProperty('adminScreenApi');
  transport = (loaded as { adminScreenApi: Transport }).adminScreenApi;
});
beforeEach(() => {
  calls = [];
  answer = () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body, headers: new Headers(init?.headers), signal: init?.signal, credentials: init?.credentials });
    return answer(init?.signal);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('SCRUM-619 independent review of the shared admin lift', () => {
  it('R1 [high] serves the existing panels from the shared package; fix: move implementations and leave only POS host wiring', () => {
    const shared = sources(join(packageRoot, 'src')).map(path => ({ path, text: code(path) }));
    const pos = sources(join(root, 'apps/pos/src/components/admin')).map(path => ({ path, text: code(path) }));
    for (const panel of ['TicketsPanel', 'MenuPanel', 'TaxPanel', 'StaffBenefitsPanel', 'TemplatesPanel', 'SalesReportPanel']) {
      const declaration = new RegExp(`\\b(?:function\\s+${panel}\\b|(?:const|let)\\s+${panel}\\s*=)`);
      expect(shared.some(file => declaration.test(file.text)), `${panel} has no shared implementation`).toBe(true);
      expect(pos.filter(file => declaration.test(file.text)).map(file => relative(root, file.path)), `${panel} remains implemented in POS`).toEqual([]);
    }
  });

  it('R2 [high] keeps app sessions and stores outside the package; fix: inject host capabilities rather than import an app', () => {
    const forbidden: string[] = [];
    for (const path of sources(join(packageRoot, 'src'))) {
      const text = code(path);
      for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        const target = specifier.startsWith('.') ? relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/') : specifier;
        if (specifier.startsWith('@/') || target.startsWith('apps/') || /^@oto\/(?:pos|console|launcher|inbox|booth|radar|oto-app)(?:\/|$)/.test(specifier)) {
          forbidden.push(`${relative(root, path)} -> ${specifier}`);
        }
      }
    }
    expect(forbidden).toEqual([]);
  });

  it('R3 [high] sends a bodyless DELETE key as a header; fix: translate the AdminApi options into the POS client third argument', async () => {
    const signal = new AbortController().signal;
    await transport.delete('/admin/apps/oto_app/users/fixture-account', {
      idempotencyKey: '00000000-0000-4000-8000-000000000001', headers: { 'x-proof': 'synthetic' }, signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/admin/apps/oto_app/users/fixture-account', method: 'DELETE', signal, credentials: 'same-origin' });
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers.get('idempotency-key')).toBe('00000000-0000-4000-8000-000000000001');
    expect(calls[0]!.headers.get('x-proof')).toBe('synthetic');
  });

  it('R4 [high] preserves a typed DELETE reason and its action key; fix: use the distinct deleteWithBody capability', async () => {
    await transport.deleteWithBody('/members/fixture-member/tier-verification', { reason: 'ZZ TEST wrong tier' }, {
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('/api/members/fixture-member/tier-verification');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ reason: 'ZZ TEST wrong tier' });
    expect(calls[0]!.headers.get('idempotency-key')).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('R5 [high] retains download bytes, filename and MIME through the host; fix: inject the binary file boundary instead of JSON or a raw package fetch', async () => {
    const signal = new AbortController().signal;
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    answer = () => new Response('synthetic workbook bytes', { headers: {
      'content-type': mime, 'content-disposition': 'attachment; filename="ZZ TEST-menu.xlsx"',
    } });
    const file = await transport.getFile('/branches/fixture-branch/menu/export.xlsx', signal);
    expect(file.filename).toBe('ZZ TEST-menu.xlsx');
    expect(file.contentType).toBe(mime);
    expect(await file.blob.text()).toBe('synthetic workbook bytes');
    expect(calls[0]).toMatchObject({ url: '/api/branches/fixture-branch/menu/export.xlsx', method: 'GET', signal, credentials: 'same-origin' });
    expect(transport.href('/voucher-promotions/fixture/codes.csv')).toBe('/api/voucher-promotions/fixture/codes.csv');
  });

  it('R6 [high] preserves binary refusals and cancellation; fix: forward the signal and keep the host error rather than fabricate an empty file', async () => {
    answer = () => new Response('{"error":{"code":"FORBIDDEN","message":"Not permitted"}}', {
      status: 403, headers: { 'content-type': 'application/json' },
    });
    await expect(transport.getFile('/branches/fixture-branch/menu/export.xlsx')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const controller = new AbortController();
    const aborted = new DOMException('synthetic cancellation', 'AbortError');
    answer = signal => new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(aborted);
      else signal?.addEventListener('abort', () => reject(aborted), { once: true });
    });
    const pending = transport.postBlob('/print-templates/fixture/preview.png', { sample: 'standard' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.at(-1)?.signal).toBe(controller.signal);
    expect(calls.at(-1)?.method).toBe('POST');
    await expect(transport.delete('/members/fixture-member', { signal: controller.signal })).rejects.toMatchObject({ name: 'NetworkError', cause: aborted });
    expect(calls.at(-1)?.signal).toBe(controller.signal);
  });
});
