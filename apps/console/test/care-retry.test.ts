import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createCareAdminApi } from '@oto/admin-screens/lifted/api/care';
import { fromApi } from '@oto/admin-screens/lifted/admin-helpers/templates/templateDraft';

function nativeReload() {
  const path = new URL('../src/pages/Care.tsx', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'reload') callback = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error('Actual Care reload callback missing');
  return ts.transpileModule('(' + callback + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '');
}

describe('native Care host command retry identity', () => {
  it('keeps the same print intent after a confirmed save refresh replaces the data snapshot and its print response is lost', async () => {
    const branchId = '01900000-0000-7000-8000-000000000001';
    const templateId = '01900000-0000-7000-8000-000000000002';
    const template = { id: templateId, type: 'receipt', name: 'ZZ TEST receipt', showLogo: false, headerText: null, footerText: null, fields: {} };
    const keys: string[] = [];
    const jobs = new Map<string, number>();
    let loseFirstReply = true;
    const transport = {
      get: vi.fn(async () => ({ templates: [template] })),
      patch: vi.fn(async () => ({ template })),
      post: vi.fn(async (_path: string, _body: unknown, options: { idempotencyKey: string }) => {
        keys.push(options.idempotencyKey);
        if (!jobs.has(options.idempotencyKey)) jobs.set(options.idempotencyKey, jobs.size + 1);
        if (loseFirstReply) { loseFirstReply = false; throw new TypeError('ZZ TEST response lost after commit'); }
        return { printJob: { id: 'ZZ TEST job', status: 'queued' } };
      }),
    } as unknown as Parameters<typeof createCareAdminApi>[0];
    const createConsoleCare = () => createCareAdminApi(transport);
    const contextApi = createConsoleCare();
    let snapshot: { api: ReturnType<typeof createConsoleCare> } | null = null;
    const reload = runInNewContext(nativeReload(), {
      working: { epoch: 1, isCurrent: () => true },
      allowed: true, parkId: branchId, page: 'print-templates', version: 1,
      current: () => true, requests: { current: 0 }, createConsoleCare, contextApi,
      setError: vi.fn(), setStored: (next: typeof snapshot) => { snapshot = next; },
      fromApi, messageOf: () => 'ZZ TEST read failed', useCallback: (callback: unknown) => callback,
    }) as (saved?: boolean) => Promise<void>;
    await reload();
    const capturedApi = snapshot!.api;
    await capturedApi.printApi.updateTemplate(templateId, { footerText: 'ZZ TEST revised footer' });
    await reload(true);
    const refreshedApi = snapshot!.api;

    // The native save-then-print continuation retains its pre-refresh API.
    await capturedApi.printApi.testPrint(templateId, { stationId: null }).catch(() => undefined);
    await refreshedApi.printApi.testPrint(templateId, { stationId: null });

    // Compare only booleans; failure diagnostics must never print a raw key.
    expect(keys.length === 2 && keys[0] === keys[1]).toBe(true);
    expect(jobs.size).toBe(1);
    expect(transport.patch).toHaveBeenCalledTimes(1);
    expect(transport.get).toHaveBeenCalledTimes(2);
  });
});
