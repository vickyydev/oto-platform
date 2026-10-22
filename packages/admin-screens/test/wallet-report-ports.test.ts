import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ReportFilters, WalletCreditReport } from '../src/lifted/lib/reporting';
import type { WalletReportPorts } from '../src/lifted/runtime/wallet-report';

const first: ReportFilters = { branchId: 'zz-park', startDate: '2026-10-01', endDate: '2026-10-22' };
const empty: WalletCreditReport = {
  summary: { grantedSatang: 0, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, netOutstandingSatang: 0, entryCount: 0 },
  rows: [], totalEntries: 0,
};
const loaded: WalletCreditReport = {
  summary: { ...empty.summary, grantedSatang: 12345, netOutstandingSatang: 67890, entryCount: 1 },
  rows: [{ wristbandCode: 'ZZ TEST band', customerNickname: 'ZZ TEST guest', kind: 'grant', amountSatang: 12345, source: 'sale', at: '2026-10-22T01:00:00Z' }], totalEntries: 1,
};
const voucher = { range: { from: first.startDate, to: first.endDate }, summary: { redemptions: 1, foregoneSatang: 123, creditLoadedSatang: 0 }, rows: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function sourceFunction(path: string, name: string): string | undefined {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(ast).replace(/^export\s+/, '');
}
function ports(): WalletReportPorts {
  return {
    contextKey: 'zz-actor-a', defaultFilters: () => first,
    branchOptions: [{ id: first.branchId, name: 'ZZ TEST Park' }],
    queryForFilters: filters => ({ branches: [filters.branchId], from: filters.startDate, to: filters.endDate }),
    discounts: [], walletReport: vi.fn(async () => loaded),
    discountTransactions: vi.fn(async () => ({ promoRows: [] })), voucherReport: vi.fn(async () => voucher),
  };
}

/** Runs the actual native hook/callback body across renders, without a browser or transport. */
function harness(initialPorts = ports()) {
  const path = '../src/lifted/components/admin/reports/WalletPromoReportPanel.tsx';
  const original = readFileSync(new URL(path, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node));
  const component = functions.find(node => node.name?.text === 'WalletPromoReportPanelWithPorts') ?? functions.find(node => node.name?.text === 'WalletPromoReportPanel');
  if (!component?.body) throw new Error('Actual Wallet report missing');
  const stop = component.body.statements.findIndex(ts.isReturnStatement);
  const prefix = component.body.statements.slice(0, stop).map(node => node.getText(ast)).join('\n');
  const shared = '../src/lifted/components/admin/reports/shared.tsx';
  const commonHook = sourceFunction(shared, 'usePlatformReportWithPorts') ?? '';
  const slots: unknown[] = [], effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
  let cursor = 0, currentPorts = initialPorts;
  const pending: Array<() => void> = [];
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
  const useEffect = (effect: () => (() => void) | undefined, deps?: unknown[]) => {
    const slot = cursor++, previous = effects[slot];
    if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps?.[index]))) {
      pending.push(() => { previous?.cleanup?.(); effects[slot] = { deps, cleanup: effect() }; });
    }
  };
  const downloadCsv = vi.fn();
  const expression = ts.transpileModule(`(function () { ${commonHook}
    return function ({ ports }) { ${prefix}
      return { filters, setFilters, report, promoRows, foregone, exportLedger,
        exportError: typeof exportError === 'undefined' ? null : exportError };
    }; })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const renderNative = runInNewContext(expression, {
    useState, useRef, useEffect, useMemo: (get: () => unknown) => { cursor++; return get(); },
    useCallback: (callback: unknown) => { cursor++; return callback; }, EMPTY_REPORT: empty,
    EMPTY_PROMOS: [], EMPTY_FOREGONE: null, downloadCsv, csvBaht: (value: number) => (value / 100).toFixed(2),
    promoUsageSummaryOf: () => [],
    useAdminScreenRuntime: () => ({
      domain: { reporting: { defaultReportFilters: currentPorts.defaultFilters, platformReportQuery: currentPorts.queryForFilters,
        platformWalletCreditReport: currentPorts.walletReport, promoUsageSummaryOf: () => [] } },
      api: { analyticsReports: { discountTransactions: currentPorts.discountTransactions }, voucherPromotions: { report: () => currentPorts.voucherReport({ from: first.startDate, to: first.endDate }) } },
      reads: { getBranches: () => [{ id: first.branchId, apiId: first.branchId }], getDiscounts: () => currentPorts.discounts },
    }),
  }) as (input: { ports: WalletReportPorts }) => {
    filters: ReportFilters; setFilters: (filters: ReportFilters) => void; report: WalletCreditReport;
    promoRows: unknown[]; foregone: unknown; exportLedger: () => Promise<void>; exportError: string | null;
  };
  return {
    downloadCsv,
    render(nextPorts = currentPorts) { currentPorts = nextPorts; cursor = 0; const result = renderNative({ ports: nextPorts }); while (pending.length) pending.shift()?.(); return result; },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}
async function settled() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('Wallet report owns its displayed range and CSV requests', () => {
  it('empties the old labeled figures while a different range is loading', async () => {
    const input = ports(), held = deferred<WalletCreditReport>(), view = harness(input);
    view.render(); await settled();
    const shown = view.render(); expect(shown.report.summary.grantedSatang).toBe(12345);
    input.walletReport = vi.fn(() => held.promise);
    shown.setFilters({ ...first, startDate: '2026-10-20' });
    const changed = view.render();
    expect(changed.report.rows).toEqual([]);
    expect(changed.foregone).toBeNull();
  });

  it('does not expose the prior actor figures during an authority change', async () => {
    const input = ports(), view = harness(input);
    view.render(); await settled(); expect(view.render().report.totalEntries).toBe(1);
    const next = { ...input, contextKey: 'zz-actor-b', walletReport: vi.fn(() => deferred<WalletCreditReport>().promise) };
    expect(view.render(next).report.rows).toEqual([]);
  });

  for (const change of ['range', 'authority', 'unmount'] as const) {
    it(`does not download an awaited ledger after its ${change} owner ended`, async () => {
      const input = ports(), held = deferred<WalletCreditReport>(), view = harness(input);
      view.render(); await settled(); const shown = view.render();
      input.walletReport = vi.fn(() => held.promise);
      const active = view.render(), work = active.exportLedger();
      if (change === 'range') { shown.setFilters({ ...first, endDate: '2026-10-21' }); view.render(); }
      if (change === 'authority') view.render({ ...input, contextKey: 'zz-actor-b' });
      if (change === 'unmount') view.unmount();
      held.resolve(loaded); await work;
      expect(view.downloadCsv).not.toHaveBeenCalled();
    });
  }

  it('reports an export refusal without an unhandled rejection or an empty success download', async () => {
    const input = ports(), view = harness(input);
    view.render(); await settled(); view.render();
    input.walletReport = vi.fn(async () => { throw new Error('ZZ TEST refused ledger export'); });
    const work = view.render().exportLedger();
    await expect(work).resolves.toBeUndefined();
    expect(view.downloadCsv).not.toHaveBeenCalled();
    expect(view.render().exportError).toContain('could not be exported');
  });
});
