import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boothReportApi } from '@/api/analytics';
import { api, ApiError } from '@/api/client';

function nativeWorkingHook() {
  const source = readFileSync(new URL('../src/lib/workingAuthority.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('workingAuthority.ts', source, ts.ScriptTarget.Latest, true);
  const hook = ast.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'useWorkingAuthority');
  if (!hook) throw new Error('Native working-authority hook missing');
  return hook.getText(ast).replace(/^export\s+/, '');
}

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
  let providerEpoch = 0, providerKey = '', providerMounted = true;
  const isCurrentAuthority = (held: number) => providerMounted && held === providerEpoch;
  const sessionPort = () => {
    const operatorContext = {
      sessionId: session.me.account.id === 'zz-actor-a'
        ? '01964000-0000-7000-8000-000000000009' : '01964000-0000-7000-8000-00000000000a',
      homeOperatorId: session.me.account.operatorId, effectiveOperatorId: session.me.account.operatorId,
      operatorOverride: null, branchId: session.me.branch.id, stationId: null, revision: 0,
    };
    return { ...session, state: 'signed-in', refreshing: false, locked: false,
      authorityEpoch: providerEpoch, isCurrentAuthority, operatorContext,
      effectiveOperatorId: operatorContext.effectiveOperatorId,
      me: { ...session.me, sessionLocked: false, operatorContext,
        account: { ...session.me.account, status: 'active', mustChangePassword: false } } };
  };
  let confirmedSession = sessionPort();
  const pending: Array<() => void> = [];
  const useState = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
  };
  const useRef = (initial: unknown) => { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; };
  const useMemo = (callback: () => unknown, deps: unknown[]) => {
    const slot = cursor++, previous = slots[slot] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
      slots[slot] = { deps, value: callback() };
    }
    return (slots[slot] as { value: unknown }).value;
  };
  const useEffect = (effect: () => (() => void) | undefined, deps?: unknown[]) => {
    const slot = cursor++, before = effects[slot];
    if (!before || !deps || deps.some((value, index) => !Object.is(value, before.deps?.[index]))) pending.push(() => {
      before?.cleanup?.(); effects[slot] = { deps, cleanup: effect() };
    });
  };
  const link = { href: '', download: '', click: vi.fn() };
  const createObjectURL = vi.fn(() => 'blob:zz-test-report');
  const renderNative = runInNewContext(ts.transpileModule(`(function () { ${nativeWorkingHook()}
    ${prefix}
    return { data, branches, error, downloading, download, setBranchId, setFrom, setTo, setRefresh };
  })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, ''), {
    useSession: () => confirmedSession, useState, useRef, useEffect, useMemo,
    useCallback: (callback: () => unknown, deps: unknown[]) => useMemo(() => callback, deps), api, ApiError,
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
    render(next = session) {
      session = next; cursor = 0;
      const nextKey = JSON.stringify(session);
      if (nextKey !== providerKey) {
        providerKey = nextKey; providerEpoch++; confirmedSession = sessionPort();
      }
      const view = renderNative(); while (pending.length) pending.shift()?.(); return view;
    },
    unmount() { providerMounted = false; effects.forEach(effect => effect?.cleanup?.()); },
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


type RequestAuthority = { capture: () => number | null; isCurrent: (epoch: number) => boolean };
type InstallAuthority = (binding: RequestAuthority) => () => void;
const authorityDisposals: Array<() => void> = [];
const authorityFetch = vi.fn<typeof fetch>();
const authorityOutcome = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const, value }),
  error => ({ ok: false as const, error: error as unknown }));

async function boundClient(binding: RequestAuthority) {
  const client = await import('@/api/client');
  const install = (client as unknown as { installRequestAuthority?: InstallAuthority }).installRequestAuthority;
  expect(typeof install, 'The actual common client must expose installRequestAuthority').toBe('function');
  if (typeof install !== 'function') throw new Error('ZZ_TEST_REQUEST_AUTHORITY_EXPORT_MISSING');
  const dispose = install(binding); expect(typeof dispose).toBe('function'); authorityDisposals.push(dispose);
  return { client, dispose };
}
function rejectedAuthority<T>(result: Awaited<ReturnType<typeof authorityOutcome<T>>>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('ZZ_TEST_STALE_CLIENT_ANSWER_ACCEPTED');
  expect(result.error).toBeInstanceOf(Error);
  return result.error as Error & { code?: string };
}
const jsonAuthority = (body: unknown = { marker: 'ZZ TEST current answer' }, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Common Console request authority; real exported client and local fetch only', () => {
  beforeEach(() => {
    authorityFetch.mockReset(); vi.stubGlobal('fetch', authorityFetch);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });
  afterEach(() => {
    while (authorityDisposals.length) authorityDisposals.pop()?.();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it('keeps the existing standalone request behavior when no provider binding is installed', async () => {
    const { api } = await import('@/api/client');
    authorityFetch.mockResolvedValueOnce(jsonAuthority());
    expect(await api.get('/zz-test/ordinary')).toEqual({ marker: 'ZZ TEST current answer' });
    expect(authorityFetch).toHaveBeenCalledTimes(1);
  });

  it('captures a non-null epoch before dispatch and preserves an unchanged-context answer', async () => {
    const capture = vi.fn(() => 17), isCurrent = vi.fn((epoch: number) => epoch === 17);
    const { client } = await boundClient({ capture, isCurrent });
    authorityFetch.mockImplementationOnce(async () => {
      expect(capture).toHaveBeenCalled(); return jsonAuthority();
    });
    expect(await client.api.get('/zz-test/ordinary')).toEqual({ marker: 'ZZ TEST current answer' });
    expect(isCurrent).toHaveBeenCalledWith(17); expect(authorityFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['json', 'file', 'post-blob'] as const)('rejects an unready %s request before any fetch', async transport => {
    const { client } = await boundClient({ capture: () => null, isCurrent: () => false });
    const work = transport === 'json' ? client.api.get('/zz-test/ordinary')
      : transport === 'file' ? client.api.getFile('/zz-test/export') : client.api.postBlob('/zz-test/render', {});
    rejectedAuthority(await authorityOutcome<unknown>(work));
    expect(authorityFetch).not.toHaveBeenCalled(); expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('rejects JSON bytes that finish after the captured epoch was invalidated', async () => {
    let epoch = 1;
    const { client } = await boundClient({ capture: () => epoch, isCurrent: held => held === epoch });
    const body = deferred<unknown>(), entered = deferred<void>(), response = jsonAuthority();
    vi.spyOn(response, 'json').mockImplementation(() => { entered.resolve(); return body.promise; });
    authorityFetch.mockResolvedValueOnce(response);
    const work = authorityOutcome<unknown>(client.api.get('/zz-test/ordinary')); await entered.promise;
    epoch = 2; body.resolve({ marker: 'ZZ TEST old A answer' });
    rejectedAuthority(await work); expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('replaces an old fetch rejection with a stale-authority refusal rather than exposing the old error', async () => {
    let epoch = 1, rejectFetch!: (error: Error) => void;
    const { client } = await boundClient({ capture: () => epoch, isCurrent: held => held === epoch });
    authorityFetch.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    const work = authorityOutcome<unknown>(client.api.get('/zz-test/ordinary'));
    const old = new Error('ZZ TEST old A network failure'); epoch = 2; rejectFetch(old);
    const error = rejectedAuthority(await work);
    expect(error).not.toBe(old); expect(error.message).not.toContain(old.message); expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it.each(['file', 'get-blob', 'post-blob'] as const)('rejects %s body bytes that finish after invalidation', async transport => {
    let epoch = 1;
    const { client } = await boundClient({ capture: () => epoch, isCurrent: held => held === epoch });
    const body = deferred<Blob>(), entered = deferred<void>();
    const response = new Response('ZZ TEST synthetic export', { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="zz-test.csv"' } });
    vi.spyOn(response, 'blob').mockImplementation(() => { entered.resolve(); return body.promise; });
    authorityFetch.mockResolvedValueOnce(response);
    const work = authorityOutcome<unknown>(transport === 'file' ? client.api.getFile('/zz-test/export')
      : transport === 'get-blob' ? client.api.getBlob('/zz-test/export') : client.api.postBlob('/zz-test/render', {}));
    await entered.promise; epoch = 2; body.resolve(new Blob(['ZZ TEST stale bytes']));
    rejectedAuthority(await work); expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  for (const status of [401, 423]) it.each(['json', 'file', 'post-blob'] as const)(
    'late ' + status + ' from %s cannot sign out or lock a newer context', async transport => {
      let epoch = 1;
      const { client } = await boundClient({ capture: () => epoch, isCurrent: held => held === epoch });
      const response = deferred<Response>(); authorityFetch.mockImplementationOnce(() => response.promise);
      const work = authorityOutcome<unknown>(transport === 'json' ? client.api.get('/zz-test/ordinary')
        : transport === 'file' ? client.api.getFile('/zz-test/export') : client.api.postBlob('/zz-test/render', {}));
      epoch = 2; response.resolve(jsonAuthority({ error: { code: 'ZZ_TEST_OLD_HTTP', message: 'ZZ TEST old A HTTP failure' } }, status));
      const error = rejectedAuthority(await work);
      expect(error.code).not.toBe('ZZ_TEST_OLD_HTTP'); expect(error.message).not.toContain('ZZ TEST old A HTTP failure');
      expect(window.dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it.each([401, 423])('current %s still keeps native error and session-event behavior', async status => {
    const { client } = await boundClient({ capture: () => 1, isCurrent: held => held === 1 });
    authorityFetch.mockResolvedValueOnce(jsonAuthority({ error: { code: 'ZZ_TEST_CURRENT_HTTP', message: 'ZZ TEST current HTTP failure' } }, status));
    const error = rejectedAuthority(await authorityOutcome<unknown>(client.api.get('/zz-test/ordinary')));
    expect(error).toMatchObject({ status, code: 'ZZ_TEST_CURRENT_HTTP' });
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: status === 401 ? 'oto:unauthorized' : 'oto:session-locked' }));
  });

  it('disposing a binding invalidates already pending answers while restoring standalone behavior for new requests', async () => {
    const { client, dispose } = await boundClient({ capture: () => 1, isCurrent: () => true });
    const response = deferred<Response>(); authorityFetch.mockImplementationOnce(() => response.promise);
    const old = authorityOutcome<unknown>(client.api.get('/zz-test/ordinary')); dispose();
    response.resolve(jsonAuthority({ marker: 'ZZ TEST old binding' })); rejectedAuthority(await old);
    authorityFetch.mockResolvedValueOnce(jsonAuthority());
    expect(await client.api.get('/zz-test/ordinary')).toEqual({ marker: 'ZZ TEST current answer' });
  });

  it('a reinstalled binding with the same numeric epoch rejects old promises and an old disposer cannot clear it', async () => {
    const first = await boundClient({ capture: () => 7, isCurrent: () => true });
    const response = deferred<Response>(); authorityFetch.mockImplementationOnce(() => response.promise);
    const old = authorityOutcome<unknown>(first.client.api.get('/zz-test/ordinary'));
    let ready = false;
    const next = await boundClient({ capture: () => ready ? 7 : null, isCurrent: held => ready && held === 7 });
    first.dispose(); response.resolve(jsonAuthority({ marker: 'ZZ TEST superseded binding' })); rejectedAuthority(await old);
    authorityFetch.mockClear();
    rejectedAuthority(await authorityOutcome<unknown>(next.client.api.get('/zz-test/ordinary'))); expect(authorityFetch).not.toHaveBeenCalled();
    ready = true; authorityFetch.mockResolvedValueOnce(jsonAuthority());
    expect(await next.client.api.get('/zz-test/ordinary')).toEqual({ marker: 'ZZ TEST current answer' });
  });

  it.each([
    ['GET', '/me'], ['GET', '/me/permissions'], ['PUT', '/me/session/branch'], ['PUT', '/me/session/operator'],
    ['POST', '/auth/sign-in'], ['POST', '/auth/sign-out'], ['POST', '/auth/unlock'], ['POST', '/auth/handoff/exchange'],
  ] as const)('permits only the coordinator operation %s %s while the ordinary scope is unready', async (method, path) => {
    const { client } = await boundClient({ capture: () => null, isCurrent: () => false });
    authorityFetch.mockResolvedValueOnce(jsonAuthority({ ok: true }));
    const result = method === 'GET' ? await client.api.get(path)
      : method === 'PUT' ? await client.api.put(path, {}, { idempotencyKey: 'zz-test-coordinator' }) : await client.api.post(path, {});
    expect(result).toEqual({ ok: true }); expect(authorityFetch).toHaveBeenCalledTimes(1);
    expect(authorityFetch.mock.calls[0]![0]).toBe('/api' + path);
    expect(authorityFetch.mock.calls[0]![1]?.method).toBe(method);
  });

  it.each([
    ['GET', '/me/preferences'], ['GET', '/me?unexpected=1'], ['POST', '/me'],
    ['PUT', '/me/session/operator/extra'], ['GET', '/auth/sign-out'],
    ['POST', '/auth/handoff/exchange/extra'], ['POST', '/auth/handoff'],
  ] as const)('does not widen coordinator authority to %s %s', async (method, path) => {
    const { client } = await boundClient({ capture: () => null, isCurrent: () => false });
    const work = method === 'GET' ? client.api.get(path) : method === 'PUT' ? client.api.put(path, {}) : client.api.post(path, {});
    rejectedAuthority(await authorityOutcome<unknown>(work)); expect(authorityFetch).not.toHaveBeenCalled();
  });

  for (const status of [401, 423]) it.each([
    ['GET', '/me'], ['GET', '/me/permissions'], ['PUT', '/me/session/branch'], ['PUT', '/me/session/operator'],
    ['POST', '/auth/sign-in'], ['POST', '/auth/sign-out'], ['POST', '/auth/unlock'], ['POST', '/auth/handoff/exchange'],
  ] as const)('coordinator ' + status + ' from %s %s belongs to its caller and cannot fire global session events', async (method, path) => {
    let epoch = 1;
    const { client } = await boundClient({ capture: () => epoch, isCurrent: held => held === epoch });
    const response = deferred<Response>(); authorityFetch.mockImplementationOnce(() => response.promise);
    const request = method === 'GET' ? client.api.get(path) : method === 'PUT' ? client.api.put(path, {}) : client.api.post(path, {});
    const work = authorityOutcome<unknown>(request);
    epoch = 2;
    response.resolve(jsonAuthority({ error: { code: 'ZZ_TEST_COORDINATOR', message: 'ZZ TEST coordinator refusal' } }, status));
    const error = rejectedAuthority(await work);
    expect(error).toBeInstanceOf(client.ApiError);
    expect(error).toMatchObject({ status, code: 'ZZ_TEST_COORDINATOR', message: 'ZZ TEST coordinator refusal' });
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});
