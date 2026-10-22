import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintTemplate } from '../src/lifted/model/types';
import { fromApi, isDirty, saveBody } from '../src/lifted/components/admin/templates/templateDraft';
import type { AdminApi } from '../src/api/admin-api';
import { readCareCapabilities } from '../src/lifted/runtime/care';

const host = vi.hoisted(() => ({
  branch: { branch: { id: 'zz-test-park', apiId: '01900000-0000-7000-8000-000000000001' as string | undefined } },
  station: { station: null },
  session: { operator: { id: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Manager', role: 'manager' } },
  transport: { get: vi.fn() },
  reads: { getActiveBranch: () => ({ id: 'zz-test-park' }) },
  catalog: {
    dropOffPricing: { oneTimeFeeTHB: { weekday: 10, weekend: 20 }, nannyHourlyRateTHB: { weekday: 30, weekend: 40 }, extraHourTHB: { weekday: 50, weekend: 60 }, fullDayHours: 8, nannyRatioSoftMax: 3, prepaidFoodRefundPolicy: 'refund' },
    supervisionPolicy: { bands: [{ id: 'zz-band', label: 'All ages', minAge: 0, maxAge: null, requirement: 'none' }], siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [] },
    printTemplates: [],
    mutators: { updateDropOffPricing: vi.fn(), updateSupervisionPolicy: vi.fn(), upsertPrintTemplate: vi.fn() },
  },
  api: {
    catalogBridge: { apiBranchIdForSlug: vi.fn() },
    checkin: { checkinApi: { config: vi.fn() }, boardApi: { savePricing: vi.fn(), savePolicy: vi.fn(), saveConfirmations: vi.fn() }, TILL_NOT_LINKED: 'Not connected' },
    platform: { printApi: { templates: vi.fn(), updateTemplate: vi.fn(), testPrint: vi.fn() }, templatesApi: { previewPng: vi.fn(), testPrintTarget: vi.fn() } },
  },
}));
vi.mock('../src/lifted/runtime/AdminScreenRuntime', () => ({
  useAdminScreenRuntime: () => host, useCatalogStore: () => host.catalog, useBranch: () => host.branch,
  useStation: () => host.station, useSearch: () => '', useLocation: () => ['', vi.fn()],
}));
vi.mock('../src/lifted/components/admin/markets-tiers/MarketsTiersSection', () => ({ MarketsTiersSection: () => null }));
vi.mock('../src/lifted/components/admin/pricing-overrides/PricingOverridesSection', () => ({ PricingOverridesSection: () => null }));
import { DropOffPricingPanel } from '../src/lifted/components/admin/dropoff-pricing/DropOffPricingPanel';
import { SupervisionPanel } from '../src/lifted/components/admin/supervision/SupervisionPanel';
import { TemplateEditor } from '../src/lifted/components/admin/templates/TemplateEditor';

const template: PrintTemplate = { id: 'zz-template', type: 'receipt', name: 'ZZ TEST receipt', showLogo: false, fields: { itemizedLines: true } };
function enabledButtons(html: string, name: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match => !/\bdisabled(?:\s|=|$)/.test(match[1] ?? '') && match[2]?.replace(/<[^>]+>/g, '').trim() === name).length;
}
function expression(file: string, names: string[], effectMarker?: string) {
  const source = readFileSync(new URL('../src/lifted/components/admin/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast)) && node.initializer) found.set(node.name.getText(ast), node.initializer.getText(ast));
    if (effectMarker && ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes(effectMarker)) found.set('effect', node.arguments[0].getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const callback = effectMarker ? found.get('effect') : names.map(name => found.get(name)).find(Boolean);
  if (!callback) throw new Error('Actual native callback missing: ' + file + ' ' + names.join('/'));
  return ts.transpileModule('(' + callback + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  host.branch.branch.apiId = '01900000-0000-7000-8000-000000000001';
  host.api.catalogBridge.apiBranchIdForSlug.mockReturnValue(host.branch.branch.apiId);
});

describe('native Care and print authority offers', () => {
  it('keeps live supervision changes unavailable while canonical authority is unknown', () => {
    const html = renderToStaticMarkup(createElement(SupervisionPanel));
    expect(html).toContain('Age bands');
    expect(enabledButtons(html, 'Add band')).toBe(0);
    expect(host.transport.get).not.toHaveBeenCalled();
  });
  it('keeps live template commands unavailable while the distinct command right is unknown', () => {
    const html = renderToStaticMarkup(createElement(TemplateEditor, { template, live: true, onClose: vi.fn() }));
    expect(html).toContain('Live preview');
    expect(enabledButtons(html, 'Print test')).toBe(0);
    expect(host.transport.get).not.toHaveBeenCalled();
  });
  it('retains original unbacked local policy editing and disconnected pricing Save with no render requests', () => {
    host.branch.branch.apiId = undefined;
    host.api.catalogBridge.apiBranchIdForSlug.mockReturnValue(null);
    expect(enabledButtons(renderToStaticMarkup(createElement(SupervisionPanel)), 'Add band')).toBe(1);
    expect(enabledButtons(renderToStaticMarkup(createElement(DropOffPricingPanel)), 'Save changes')).toBe(0);
    expect(host.transport.get).not.toHaveBeenCalled();
    expect(host.api.checkin.checkinApi.config).not.toHaveBeenCalled();
  });
});

describe('native Care and template request ownership', () => {
  it('does not reseed a pricing draft edited while the older save was in flight', () => {
    const setValues = vi.fn(), setPrices = vi.fn();
    const effect = runInNewContext(expression('dropoff-pricing/DropOffPricingPanel.tsx', [], 'setValues(toNumericForm(dropOffPricing))'), {
      dropOffPricing: host.catalog.dropOffPricing, preserveDraft: { current: true },
      toNumericForm: (value: unknown) => value, toPriceForm: (value: unknown) => value,
      setValues, setPrices, setRefundPolicy: vi.fn(), setErrors: vi.fn(),
    }) as () => void;
    effect();
    expect(setValues).not.toHaveBeenCalled();
    expect(setPrices).not.toHaveBeenCalled();
  });
  it('does not begin the confirmations PUT when the policy owner unmounted during the first PUT', async () => {
    const pending = deferred<void>();
    const mounted = { current: true };
    const saveConfirmations = vi.fn(async () => ({ policy: host.catalog.supervisionPolicy }));
    const policy = host.catalog.supervisionPolicy;
    const savePolicy = runInNewContext(expression('supervision/SupervisionPanel.tsx', ['persistPolicy', 'handleSave']), {
      platformId: host.branch.branch.apiId, bands: policy.bands, siblingWaiver: policy.siblingWaiver, sortedConfirmations: [],
      boardApi: { savePolicy: () => pending.promise, saveConfirmations },
      mounted, ownerRef: { current: 'owner' }, owner: 'owner', contextKey: 'owner',
      scopeRef: { current: { canManageCare: true } },
      adopt: vi.fn(), setSaving: vi.fn(), setSaveError: vi.fn(), setSaved: vi.fn(),
    }) as (policy: unknown) => Promise<unknown>;
    const work = savePolicy(policy);
    mounted.current = false;
    pending.resolve();
    await work.catch(() => undefined);
    expect(saveConfirmations).not.toHaveBeenCalled();
  });
  it('does not publish an old print-template list after a newer park request replaced it', async () => {
    const pending = deferred<{ templates: never[] }>();
    const readEpoch = { current: 0 };
    const setTemplates = vi.fn();
    const load = runInNewContext(expression('templates/TemplatesPanel.tsx', ['load']), {
      branchId: host.branch.branch.apiId, printApi: { templates: () => pending.promise },
      useCallback: (callback: unknown) => callback,
      mounted: { current: true }, readEpoch, ownerRef: { current: 'owner' }, contextKey: 'owner',
      setTemplates, setError: vi.fn(), setSettled: vi.fn(), fromApi,
    }) as () => Promise<void>;
    const work = load();
    readEpoch.current++;
    pending.resolve({ templates: [] });
    await work;
    expect(setTemplates).not.toHaveBeenCalled();
  });
  it('does not call an old editor onSaved callback after its confirmed save completed on an unmounted editor', async () => {
    const pending = deferred<{ template: unknown }>();
    const mounted = { current: true };
    const onSaved = vi.fn();
    const persist = runInNewContext(expression('templates/TemplateEditor.tsx', ['persist']), {
      nameError: '', draft: template, live: true, printApi: { updateTemplate: () => pending.promise },
      ports: {}, mounted, manageRef: { current: true }, busyRef: { current: false }, printingRef: { current: false },
      setSaving: vi.fn(), setSaveError: vi.fn(), setLoaded: vi.fn(), setDraft: vi.fn(), setJustSaved: vi.fn(),
      onSaved, fromApi: () => template, saveBody, isDirty, isApiError: () => false,
    }) as () => Promise<boolean>;
    const work = persist();
    mounted.current = false;
    pending.resolve({ template });
    await work;
    expect(onSaved).not.toHaveBeenCalled();
  });
  it('retains newer same-editor text after an earlier template save succeeds', async () => {
    const pending = deferred<{ template: unknown }>();
    let current = { ...template, footerText: 'ZZ TEST newer footer' };
    const persist = runInNewContext(expression('templates/TemplateEditor.tsx', ['persist']), {
      nameError: '', draft: template, live: true, printApi: { updateTemplate: () => pending.promise },
      ports: {}, mounted: { current: true }, manageRef: { current: true }, busyRef: { current: false }, printingRef: { current: false },
      setSaving: vi.fn(), setSaveError: vi.fn(), setLoaded: vi.fn(), setDraft: (update: (value: PrintTemplate) => PrintTemplate) => { current = update(current) as typeof current; }, setJustSaved: vi.fn(),
      onSaved: vi.fn(), fromApi: () => template, saveBody, isDirty, isApiError: () => false,
    }) as () => Promise<boolean>;
    const work = persist();
    pending.resolve({ template });
    expect(await work).toBe(true);
    expect(current.footerText).toBe('ZZ TEST newer footer');
  });
  it('does not continue a save-then-print command after the editor unmounts', async () => {
    const pending = deferred<boolean>();
    const mounted = { current: true };
    const testPrintCall = vi.fn(async () => ({ printJob: {} }));
    const testPrint = runInNewContext(expression('templates/TemplateEditor.tsx', ['testPrint']), {
      busy: false, live: true, dirty: true, persist: () => pending.promise, draft: template, stationId: null,
      mounted, manageRef: { current: true }, canPrintRef: { current: true }, printingRef: { current: false }, busyRef: { current: false },
      draftEpoch: { current: 0 },
      printApi: { testPrint: testPrintCall }, setOutcome: vi.fn(), setPrinting: vi.fn(),
      testPrintOutcome: () => ({}), destinationLabel: null, isApiError: () => false,
    }) as () => Promise<void>;
    const work = testPrint();
    mounted.current = false;
    pending.resolve(true);
    await work;
    expect(testPrintCall).not.toHaveBeenCalled();
  });
});

describe('canonical Care and print scope targets', () => {
  const actorId = '01900000-0000-7000-8000-000000000002';
  const operatorId = '01900000-0000-7000-8000-000000000003';
  const branchId = '01900000-0000-7000-8000-000000000001';
  const otherBranchId = '01900000-0000-7000-8000-000000000004';
  function api(rows: unknown[], reportedActor = actorId) {
    return { get: vi.fn(async (path: string) => path === '/me' ? { account: { id: reportedActor, operatorId } } : { permissions: rows }) } as unknown as AdminApi;
  }
  it('separates own-park read, edit and command rights without borrowing a sibling park grant', async () => {
    const transport = api(['pos:checkin:read', 'catalog:package:update', 'pos:print:read', 'admin:branch:update'].map(permission => ({ permission, scopeType: 'branch', scopeId: branchId }))
      .concat([{ permission: 'admin:box:command', scopeType: 'branch', scopeId: otherBranchId }]));
    const scope = await readCareCapabilities(transport, actorId, branchId);
    expect(scope).toEqual({ canReadCare: true, canManageCare: true, canReadTemplates: true, canEditTemplates: true, canTestPrint: false });
    expect((await readCareCapabilities(transport, actorId, otherBranchId)).canTestPrint).toBe(true);
    expect((await readCareCapabilities(transport, actorId, otherBranchId)).canManageCare).toBe(false);
  });
  it('accepts only matching-operator or platform-wide grants at a named park', async () => {
    const transport = api([{ permission: 'admin:box:command', scopeType: 'operator', scopeId: operatorId }, { permission: 'catalog:package:update', scopeType: 'operator', scopeId: null }, { permission: 'admin:branch:update', scopeType: 'operator', scopeId: '01900000-0000-7000-8000-000000000005' }]);
    const scope = await readCareCapabilities(transport, actorId, branchId);
    expect(scope.canTestPrint).toBe(true);
    expect(scope.canManageCare).toBe(true);
    expect(scope.canEditTemplates).toBe(false);
    expect((await readCareCapabilities(transport, actorId)).canManageCare).toBe(false);
  });
  it('refuses a stale account identity even when its response includes full operator grants', async () => {
    const scope = await readCareCapabilities(api([{ permission: 'admin:box:command', scopeType: 'operator', scopeId: null }], '01900000-0000-7000-8000-000000000006'), actorId, branchId);
    expect(scope.canTestPrint).toBe(false);
    expect(scope.canManageCare).toBe(false);
  });
});
