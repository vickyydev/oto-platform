import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boothReportApi } from '@/api/analytics';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const answer = { booths: [{ boothId: 'zz-own-booth', name: 'ZZ TEST booth' }], prizes: [], staff: [] };
const ownPark = { id: '01900000-0000-7000-8000-000000000001', name: 'ZZ TEST park', timezone: 'Asia/Bangkok', archived: false };
const initialSession = () => ({ me: { account: { id: 'zz-actor-a', operatorId: 'zz-operator' }, branch: ownPark }, permissions: [{ permission: 'analytics:read', scopeType: 'branch', scopeId: ownPark.id }] });

/** Runs the native page's real read/export callbacks, without React DOM or network. */
function pageHarness(options: { read?: () => Promise<unknown>; directory?: () => Promise<unknown> } = {}) {
  const path = new URL('../src/pages/BoothReport.tsx', import.meta.url);
  const source = readFileSync(path, 'utf8'), ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'BoothReport');
  if (!page?.body) throw new Error('Actual Booth report missing');
  const stop = page.body.statements.findIndex(ts.isReturnStatement);
  const prefix = page.body.statements.slice(0, stop).map(node => node.getText(ast)).join('\n');
  const slots: unknown[] = [], effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
  let cursor = 0, session = initialSession();
  const pending: Array<() => void> = [];
  const useState = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
  };
  const useRef = (initial: unknown) => { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; };
  const useEffect = (effect: () => (() => void) | undefined, deps?: unknown[]) => {
    const slot = cursor++, before = effects[slot];
    if (!before || !deps || deps.some((value, index) => !Object.is(value, before.deps?.[index]))) pending.push(() => {
      before?.cleanup?.(); effects[slot] = { deps, cleanup: effect() };
    });
  };
  const link = { href: '', download: '', click: vi.fn() };
  const createObjectURL = vi.fn(() => 'blob:zz-test-report');
  const renderNative = runInNewContext(ts.transpileModule(`(function () { ${prefix}
    return { data, branches, error, downloading, download, setBranchId, setFrom, setTo, setRefresh };
  })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, ''), {
    useSession: () => session, useState, useRef, useEffect,
    useMemo: (callback: () => unknown) => { cursor++; return callback(); },
    addDaysToIsoDate: () => '2026-10-17', businessDate: () => '2026-10-23', parseDayStart: () => undefined,
    directoryApi: { branches: options.directory ?? (async () => ({ branches: [ownPark] })) },
    boothReportApi: { ...boothReportApi, read: options.read ?? (async () => answer) },
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    document: { createElement: () => link },
    URL: { createObjectURL, revokeObjectURL: vi.fn() }, AbortController,
  }) as () => {
    data: unknown; branches: unknown[]; error: string | null; downloading: boolean; download: () => Promise<void>;
    setBranchId: (id: string) => void; setFrom: (date: string) => void; setTo: (date: string) => void; setRefresh: (value: number) => void;
  };
  return {
    link, createObjectURL,
    render(next = session) { session = next; cursor = 0; const view = renderNative(); while (pending.length) pending.shift()?.(); return view; },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}
async function settled() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('Booth native CSV and read lifetimes', () => {
  beforeEach(() => { vi.stubGlobal('window', { dispatchEvent: vi.fn() }); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  for (const change of ['filter', 'actor', 'unmount'] as const) {
    it(`discards a pending CSV after ${change}, including returning to the original actor/filter`, async () => {
      const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
      const view = pageHarness(); view.render(); await settled(); const shown = view.render(), work = shown.download();
      if (change === 'filter') { shown.setFrom('2026-10-18'); view.render(); shown.setFrom('2026-10-17'); view.render(); }
      if (change === 'actor') { const next = initialSession(); next.me.account.id = 'zz-actor-b'; view.render(next); view.render(initialSession()); }
      if (change === 'unmount') view.unmount();
      pending.resolve(new Response('ZZ TEST aggregate only', { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="zz-report.csv"' } }));
      await work;
      expect(view.link.click).not.toHaveBeenCalled(); expect(view.createObjectURL).not.toHaveBeenCalled();
    });
  }

  it('does not retain displayed figures when canonical authority changes', async () => {
    const view = pageHarness(); const firstSession = initialSession();
    view.render(firstSession); await settled(); expect(view.render().data).toEqual(answer);
    expect(view.render({ ...firstSession, permissions: [] }).data).toBeNull();
  });

  it('does not absorb an old report response after an actor A to B to A transition', async () => {
    const pending = deferred<unknown>(); let calls = 0;
    const view = pageHarness({ read: () => ++calls === 1 ? pending.promise : new Promise(() => {}) });
    const first = initialSession(); view.render(first);
    const other = initialSession(); other.me.account.id = 'zz-actor-b'; view.render(other); view.render(first);
    pending.resolve(answer); await settled();
    // The original request alone resolves; later actor-owned requests remain pending.
    expect(view.render().data).toBeNull();
  });

  it('discards a directory response owned by an unmounted page', async () => {
    const pending = deferred<unknown>(), view = pageHarness({ directory: () => pending.promise });
    view.render(); view.unmount(); pending.resolve({ branches: [ownPark] }); await settled();
    expect(view.render().branches).toEqual([]);
  });

  it.each([401, 423])('the native CSV uses the common client session handling for %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST report refused' } }), { status, headers: { 'content-type': 'application/json' } })));
    const view = pageHarness(); view.render(); await settled(); await view.render().download();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: status === 401 ? 'oto:unauthorized' : 'oto:session-locked' }));
    expect(view.link.click).not.toHaveBeenCalled();
  });

  it.each(['zz-report.csv', null])('preserves successful native filename or its existing fallback (%s)', async filename => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ZZ TEST aggregate only', { headers: { 'content-type': 'text/csv', ...(filename ? { 'content-disposition': `attachment; filename="${filename}"` } : {}) } })));
    const view = pageHarness(); view.render(); await settled(); await view.render().download();
    expect(view.link.click).toHaveBeenCalledTimes(1); expect(view.link.download).toBe(filename ?? 'booth-report.csv');
  });
});
