import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { api, ApiError, installRequestAuthority, isMissingRoute } from '@/api/client';
import { healthApi } from '@/api/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsFreshnessLines, radarFreshnessLine } from '@/lib/analyticsFreshness';

/**
 * S2-15b round 6 closing sweep — Health's analytics card names every figure
 * set a park's screens read: the day (Today > Performance, Radar), the report
 * rows (Admin > Reports) and the booth fact (the booth report).
 */

const central = {
  branchId: '018f0000-0000-7000-8000-000000000001',
  name: 'Central',
  today: '2026-10-07',
  lastRolledUpAt: '2026-10-07T03:00:00.000Z',
  boothLastRolledUpAt: '2026-10-07T03:01:00.000Z',
  reportsLastRolledUpAt: '2026-10-07T03:00:00.000Z',
};
const chalong = {
  branchId: '018f0000-0000-7000-8000-000000000002',
  name: 'Chalong',
  today: '2026-10-07',
  lastRolledUpAt: null,
  boothLastRolledUpAt: null,
  reportsLastRolledUpAt: null,
};

describe('Health — the analytics freshness lines', () => {
  it('lists each park’s day, then its report figures, then its booth figures', () => {
    expect(analyticsFreshnessLines([central, chalong])).toEqual([
      { key: central.branchId, label: 'Central', at: central.lastRolledUpAt, today: '2026-10-07' },
      { key: chalong.branchId, label: 'Chalong', at: null, today: '2026-10-07' },
      { key: `reports-${central.branchId}`, label: 'Central · report figures', at: central.reportsLastRolledUpAt, today: '2026-10-07' },
      { key: `reports-${chalong.branchId}`, label: 'Chalong · report figures', at: null, today: '2026-10-07' },
      { key: `booth-${central.branchId}`, label: 'Central · booth figures', at: central.boothLastRolledUpAt, today: '2026-10-07' },
      { key: `booth-${chalong.branchId}`, label: 'Chalong · booth figures', at: null, today: '2026-10-07' },
    ]);
  });

  it('reads Radar as fresh as its least recent park, and not refreshed while any park never was (S2-18)', () => {
    const earlier = { ...central, branchId: 'b3', name: 'Rawai', lastRolledUpAt: '2026-10-07T02:00:00.000Z' };
    expect(radarFreshnessLine([central, earlier])).toEqual({
      key: 'radar',
      label: 'Radar last refreshed',
      at: '2026-10-07T02:00:00.000Z',
      today: '2026-10-07',
    });
    expect(radarFreshnessLine([central, chalong])?.at).toBeNull();
    expect(radarFreshnessLine([])).toBeNull();
  });

  it('leaves out a line an older API does not report, rather than calling it never rolled up', () => {
    const { boothLastRolledUpAt: _booth, reportsLastRolledUpAt: _reports, ...old } = central;
    expect(analyticsFreshnessLines([old]).map((l) => l.label)).toEqual(['Central']);
  });
});

type NativeHealthView = { refresh: () => Promise<void>; snapshot: unknown };

function healthDeferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function nativeHealthFunction(path: URL, name: string) {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration?.body) throw new Error(`Native ${name} function missing`);
  return { ast, declaration };
}

/** Executes the real provider's refresh and hooks; only React scheduling and its session dependency are inert ports. */
function nativeHealthProvider(isCurrentAuthority: (epoch: number) => boolean, epoch: number) {
  const { ast, declaration } = nativeHealthFunction(new URL('../src/lib/platformStatus.tsx', import.meta.url), 'PlatformStatusProvider');
  if (!declaration.body) throw new Error('Native provider body missing');
  const stop = declaration.body.statements.findIndex(ts.isReturnStatement);
  if (stop < 0) throw new Error('Native provider value missing');
  const prefix = declaration.body.statements.slice(0, stop).map(node => node.getText(ast)).join('\n');
  const hook = prefix.includes('useWorkingAuthority(')
    ? nativeHealthFunction(new URL('../src/lib/workingAuthority.ts', import.meta.url), 'useWorkingAuthority') : null;
  const hookText = hook ? hook.declaration.getText(hook.ast).replace(/^export\s+/, '') : '';
  const slots: unknown[] = [], cleanups: Array<() => void> = [], pending: Array<() => void> = [];
  let cursor = 0;
  const useState = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
    return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
  };
  const useRef = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = { current: initial };
    return slots[slot];
  };
  const useMemo = (callback: () => unknown, deps: unknown[]) => {
    const slot = cursor++, previous = slots[slot] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
      slots[slot] = { deps, value: callback() };
    }
    return (slots[slot] as { value: unknown }).value;
  };
  const useEffect = (effect: () => (() => void) | undefined) => {
    cursor++;
    pending.push(() => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  };
  const render = runInNewContext(ts.transpileModule(`(function () { ${hookText}\n${prefix}\nreturn value; })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.trim().replace(/;$/, ''), {
    enabled: true, healthApi, api, ApiError, isMissingRoute, POLL_MS: 30_000,
    useState, useRef, useMemo, useEffect,
    useCallback: (callback: () => unknown, deps: unknown[]) => useMemo(() => callback, deps),
    useSession: () => ({ state: 'signed-in', refreshing: false, authorityEpoch: epoch, isCurrentAuthority,
      me: { sessionLocked: false, account: { status: 'active', mustChangePassword: false } } }),
    window, document, Date,
  }) as () => NativeHealthView;
  return {
    render() { cursor = 0; return render(); },
    flushEffects() { while (pending.length) pending.shift()?.(); },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
  };
}

describe('Health native provider working-context lifetimes', () => {
  const disposals: Array<() => void> = [];
  beforeEach(() => {
    vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => { while (disposals.length) disposals.pop()?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  for (const outcome of ['resolved', 'rejected'] as const) {
    it(`never continues an old readiness read into a new context's health snapshot after it ${outcome}`, async () => {
      let currentEpoch = 1;
      const current = (held: number) => held === currentEpoch;
      disposals.push(installRequestAuthority({ capture: () => currentEpoch, isCurrent: current }));
      const pending = healthDeferred<Response>(), paths: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input); paths.push(path);
        if (path === '/api/ready') return pending.promise;
        if (path === '/api/ops/health') return new Response(JSON.stringify({ marker: 'ZZ TEST snapshot' }),
          { headers: { 'content-type': 'application/json' } });
        throw new Error('Unexpected native health request');
      }));
      const provider = nativeHealthProvider(current, 1), held = provider.render();
      const refresh = held.refresh(); provider.flushEffects();
      expect(paths).toEqual(['/api/ready']);
      currentEpoch = 2; provider.unmount();
      // The common client correctly accepts NEW B requests: it cannot identify an old provider callback itself.
      disposals.push(installRequestAuthority({ capture: () => currentEpoch, isCurrent: current }));
      if (outcome === 'resolved') pending.resolve(new Response(JSON.stringify({ status: 'ready' }),
        { headers: { 'content-type': 'application/json' } }));
      else pending.reject(new Error('ZZ TEST old readiness refused'));
      await refresh;
      expect(paths, 'The old provider must not start a second request under the replacement binding').toEqual(['/api/ready']);
      expect(provider.render().snapshot).toBeNull();
    });
  }

  it('refuses a retained refresh callback before dispatch after its provider was replaced', async () => {
    let currentEpoch = 1;
    const current = (held: number) => held === currentEpoch;
    disposals.push(installRequestAuthority({ capture: () => currentEpoch, isCurrent: current }));
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return new Response(JSON.stringify({ status: 'ready' }), { headers: { 'content-type': 'application/json' } });
    }));
    const provider = nativeHealthProvider(current, 1), held = provider.render();
    // No polling effect has run: this is the real refresh callback retained by a page/consumer.
    currentEpoch = 2; provider.unmount();
    disposals.push(installRequestAuthority({ capture: () => currentEpoch, isCurrent: current }));
    await held.refresh();
    expect(paths).toEqual([]);
  });

  it('preserves the native readiness then snapshot reads for the same confirmed context', async () => {
    disposals.push(installRequestAuthority({ capture: () => 1, isCurrent: held => held === 1 }));
    const paths: string[] = [], snapshot = { marker: 'ZZ TEST current snapshot' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input); paths.push(path);
      return new Response(JSON.stringify(path === '/api/ready' ? { status: 'ready' } : snapshot),
        { headers: { 'content-type': 'application/json' } });
    }));
    const provider = nativeHealthProvider(held => held === 1, 1), held = provider.render();
    const refresh = held.refresh(); provider.flushEffects(); await refresh;
    expect(paths).toEqual(['/api/ready', '/api/ops/health']);
    expect(provider.render().snapshot).toEqual(snapshot);
    provider.unmount();
  });
});
