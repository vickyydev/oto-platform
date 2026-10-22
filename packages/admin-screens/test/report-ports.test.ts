import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ReportFilters } from '../src/lifted/lib/reporting';
import type { ReportQuery } from '../src/lifted/api/analyticsReports';
import { ExportCsvButton } from '../src/lifted/components/admin/reports/shared';

type Report = { rows: string[] };
type State = { data: Report; error: string | null; loading: boolean };
const empty: Report = { rows: [] };
const filters: ReportFilters = { startDate: '2026-10-01', endDate: '2026-10-23', branchId: 'zz-park-a' };
const queryForFilters = (value: ReportFilters): ReportQuery | null => value.branchId === 'zz-local-only' ? null : { from: value.startDate, to: value.endDate, branches: [value.branchId] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

/** Run the actual report hook, including render-time ref changes and effect cleanup. */
function reportHarness(load: (query: ReportQuery) => Promise<Report>) {
  const file = new URL('../src/lifted/components/admin/reports/shared.tsx', import.meta.url);
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile('shared.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const find = (name: string) => ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const narrow = find('usePlatformReportWithPorts');
  const actual = narrow ?? find('usePlatformReport');
  if (!actual) throw new Error('Actual report hook missing');
  const callback = ts.transpileModule('(' + actual.getText(ast).replace(/^export\s+/, '') + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '');
  const slots: unknown[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  const useRef = (initial: unknown) => { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; };
  const useState = <T,>(initial: T | (() => T)) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [slots[slot], (next: T | ((previous: T) => T)) => { slots[slot] = typeof next === 'function' ? (next as (previous: T) => T)(slots[slot] as T) : next; }];
  };
  const useEffect = (effect: () => void | (() => void), dependencies: unknown[]) => {
    const slot = cursor++;
    const previous = slots[slot] as { dependencies: unknown[]; cleanup?: () => void } | undefined;
    if (previous && previous.dependencies.length === dependencies.length && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) return;
    pendingEffects.push(() => { previous?.cleanup?.(); const cleanup = effect(); slots[slot] = { dependencies, cleanup }; });
  };
  const hook = runInNewContext(callback, {
    useRef, useState, useEffect, Error,
    useAdminScreenRuntime: () => ({ domain: { reporting: { platformReportQuery: queryForFilters } } }),
  }) as (...args: unknown[]) => State;
  return {
    render(value = filters, contextKey: unknown = 'zz-actor-a', extraKey = '') {
      cursor = 0; pendingEffects = [];
      return narrow ? hook(value, load, empty, { contextKey, queryForFilters }, extraKey) : hook(value, load, empty, extraKey);
    },
    commit() { for (const effect of pendingEffects) effect(); pendingEffects = []; },
    unmount() { for (const slot of slots) (slot as { cleanup?: () => void } | null)?.cleanup?.(); },
  };
}

describe('report answer ownership and native CSV availability', () => {
  it('does not expose old rows under newly selected park and date filters while the next read is pending', async () => {
    const first = deferred<Report>(), second = deferred<Report>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const host = reportHarness(load);
    host.render(); host.commit(); first.resolve({ rows: ['ZZ TEST park A'] }); await settle();
    expect(host.render().data.rows).toEqual(['ZZ TEST park A']); host.commit();
    const next = host.render({ ...filters, branchId: 'zz-park-b', endDate: '2026-10-24' });
    expect(next.data.rows).toEqual([]);
    expect(next.loading).toBe(true);
    host.commit();
    second.resolve({ rows: ['ZZ TEST park B'] }); await settle();
    expect(host.render({ ...filters, branchId: 'zz-park-b', endDate: '2026-10-24' }).data.rows).toEqual(['ZZ TEST park B']);
  });

  it('does not publish the preceding actor response after authority changes with identical filters', async () => {
    const first = deferred<Report>(), second = deferred<Report>();
    const host = reportHarness(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    host.render(filters, 'zz-actor-a'); host.commit();
    host.render(filters, 'zz-actor-b'); host.commit();
    first.resolve({ rows: ['ZZ TEST old actor'] }); await settle();
    expect(host.render(filters, 'zz-actor-b').data.rows).toEqual([]);
    second.resolve({ rows: ['ZZ TEST current actor'] }); await settle();
    expect(host.render(filters, 'zz-actor-b').data.rows).toEqual(['ZZ TEST current actor']);
  });

  it('does not revive the first request after A to B to A authority transitions', async () => {
    const first = deferred<Report>(), second = deferred<Report>(), third = deferred<Report>();
    const host = reportHarness(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise));
    host.render(filters, 'zz-a'); host.commit(); host.render(filters, 'zz-b'); host.commit(); host.render(filters, 'zz-a'); host.commit();
    first.resolve({ rows: ['ZZ TEST first A'] }); second.resolve({ rows: ['ZZ TEST B'] }); await settle();
    expect(host.render(filters, 'zz-a').data.rows).toEqual([]);
    third.resolve({ rows: ['ZZ TEST current A'] }); await settle();
    expect(host.render(filters, 'zz-a').data.rows).toEqual(['ZZ TEST current A']);
  });

  it('disables the native CSV button when its caller has no current answer', () => {
    const props = { onExport: vi.fn(), disabled: true };
    const html = renderToStaticMarkup(createElement(ExportCsvButton, props));
    expect(html).toMatch(/<button\b[^>]*\bdisabled=""/);
    expect(html).toContain('Export CSV');
  });

  it('keeps a local-only park empty without a platform read', () => {
    const load = vi.fn(async () => ({ rows: ['ZZ TEST should not be read'] }));
    const host = reportHarness(load);
    host.render({ ...filters, branchId: 'zz-local-only' }); host.commit();
    expect(host.render({ ...filters, branchId: 'zz-local-only' })).toEqual({ data: empty, error: null, loading: false });
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the existing stale-filter and unmount reply cleanup', async () => {
    const first = deferred<Report>(), second = deferred<Report>();
    const host = reportHarness(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    host.render(); host.commit(); const next = { ...filters, branchId: 'zz-park-b' }; host.render(next); host.commit();
    first.resolve({ rows: ['ZZ TEST old filter'] }); await settle();
    expect(host.render(next).data.rows).toEqual([]);
    host.unmount(); second.resolve({ rows: ['ZZ TEST after unmount'] }); await settle();
    expect(host.render(next).data.rows).toEqual([]);
  });

  it('shows the actual refusal and no retained rows after a failed current read', async () => {
    const pending = deferred<Report>();
    const host = reportHarness(() => pending.promise);
    host.render(); host.commit(); pending.reject(new Error('ZZ TEST report refused')); await settle();
    expect(host.render()).toEqual({ data: empty, error: 'ZZ TEST report refused', loading: false });
  });
});
