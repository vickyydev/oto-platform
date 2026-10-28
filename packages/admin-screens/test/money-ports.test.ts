import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Banknote } from 'lucide-react';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AdminApi } from '../src/api/admin-api';
import { readMoneyCapabilities } from '../src/lifted/runtime/money';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  branch: { branch: { id: 'zz-test-park', apiId: '01900000-0000-7000-8000-000000000001' as string | undefined } },
  session: { operator: { id: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Manager', role: 'manager' }, can: () => true },
  catalog: {
    discounts: [], menuItems: [], merchItems: [], ticketTypes: [], addOns: [], menuCategories: [], discountReasons: ['Service recovery'],
    paymentMethods: [{ id: 'cash', label: 'Cash', kind: 'cash', enabled: true, sortOrder: 0 }],
    mutators: { upsertDiscount: vi.fn(), deleteDiscount: vi.fn(), upsertPaymentMethod: vi.fn(), deletePaymentMethod: vi.fn(), movePaymentMethod: vi.fn(), setDiscountReasons: vi.fn() },
  },
  reads: { getBranches: vi.fn(() => [{ id: 'zz-test-park', name: 'ZZ TEST Park', apiId: '01900000-0000-7000-8000-000000000001' }]), getActiveBranch: () => ({ id: 'zz-test-park' }) },
  domain: { discountTarget: { formatDiscountTargetLabel: () => 'Everything' }, pricingMode: { formatWWPrice: () => '' }, payments: { normalizePaymentMethod: (value: string) => value, paymentMethodIcon: () => null as unknown } },
  transport: { get: vi.fn() },
  api: { catalogBridge: { paymentMethodUsage: () => 0, apiBranchIdForSlug: vi.fn() }, menu: { menuApi: { load: vi.fn() } }, voucherPromotions: { definitions: vi.fn(), campaigns: vi.fn(), saveRules: vi.fn(), mintCampaign: vi.fn(), codesHref: vi.fn() } },
  toast: vi.fn(),
}));
vi.mock('../src/lifted/runtime/AdminScreenRuntime', () => ({ useAdminScreenRuntime: () => host, useCatalogStore: () => host.catalog, useOperator: () => host.session }));
import { DiscountCodesSection } from '../src/lifted/components/admin/discounts/DiscountCodesSection';
import { PaymentMethodsSection } from '../src/lifted/components/admin/payments/PaymentMethodsSection';
import { VoucherPromotionsPanel } from '../src/lifted/components/admin/vouchers/VoucherPromotionsPanel';

function enabledButtons(html: string, text: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match => !/\bdisabled(?:\s|=|$)/.test(match[1] ?? '') && match[2]?.replace(/<[^>]+>/g, '').trim() === text).length;
}

function nativeCallback(file: string, name: string) {
  const source = readFileSync(new URL('../src/lifted/components/admin/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) callback = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error('Native callback missing: ' + name);
  return ts.transpileModule('(' + callback + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '');
}

function voucherLoader() {
  const file = 'vouchers/VoucherPromotionsPanel.tsx';
  const source = readFileSync(new URL('../src/lifted/components/admin/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'VoucherPromotionsPanel');
  let effect: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('voucherPromotionsApi.definitions()')) effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  };
  if (component) visit(component);
  if (!effect) throw new Error('Native voucher loader missing');
  return ts.transpileModule('(' + effect + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim().replace(/;$/, '');
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  host.branch.branch.apiId = '01900000-0000-7000-8000-000000000001';
  host.domain.payments.paymentMethodIcon = () => Banknote;
  host.api.catalogBridge.apiBranchIdForSlug.mockReturnValue(host.branch.branch.apiId);
  vi.clearAllMocks();
});

describe('native money confirmed writes', () => {
  it('offers payment-method name, availability and kind refinements of the loaded list', () => {
    const html = renderToStaticMarkup(createElement(PaymentMethodsSection));
    expect(html).toContain('Search payment methods');
    expect(html).toContain('Payment method availability');
    expect(html).toContain('Filter payment method kind');
    expect(html).toContain('1 of 1 payment methods');
  });

  it('renames the existing discount in one update without deleting it before a refusal', async () => {
    const draft = { originalCode: 'ZZOLD', code: 'ZZNEW', label: 'ZZ TEST Renamed', type: 'percent', value: '10', target: { kind: 'everything' }, active: true };
    const deleteDiscount = vi.fn();
    const upsertDiscount = vi.fn((): Promise<void> => Promise.reject(new Error('Not saved')));
    const setDraft = vi.fn();
    const save = runInNewContext(nativeCallback('discounts/DiscountCodesSection.tsx', 'save'), {
      draft, canSave: true, trimmedCode: 'ZZNEW', trimmedLabel: 'ZZ TEST Renamed', numericValue: 10, isFreeItem: false, discounts: [{ code: 'ZZOLD' }], usageLimitNum: undefined, perCustLimitNum: undefined,
      mutators: { deleteDiscount, upsertDiscount }, ports: {}, setDraft,
      busyRef: { current: false }, manageRef: { current: true }, mounted: { current: true }, draftRef: { current: draft }, setBusy: vi.fn(), setWriteError: vi.fn(),
      editRef: { current: undefined },
    }) as () => Promise<void> | void;
    // Observe the original destructive ordering without leaving a rejected promise unhandled.
    upsertDiscount.mockImplementation(() => Promise.resolve());
    await save();
    expect(deleteDiscount).not.toHaveBeenCalled();
    expect(upsertDiscount).toHaveBeenCalledWith(expect.objectContaining({ code: 'ZZNEW' }), 'ZZOLD');
    upsertDiscount.mockImplementation(() => Promise.reject(new Error('Not saved')));
    setDraft.mockClear();
    await save();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it('does not discard a discount draft before its write is confirmed', async () => {
    const pending = deferred();
    const setDraft = vi.fn();
    const draft = { originalCode: null, code: 'ZZTEST', label: 'ZZ TEST Code', type: 'percent', value: '10', target: { kind: 'everything' }, active: true };
    const save = runInNewContext(nativeCallback('discounts/DiscountCodesSection.tsx', 'save'), {
      draft, canSave: true, trimmedCode: 'ZZTEST', trimmedLabel: 'ZZ TEST Code', numericValue: 10, isFreeItem: false, discounts: [], usageLimitNum: undefined, perCustLimitNum: undefined,
      mutators: { upsertDiscount: () => pending.promise }, ports: {}, setDraft,
      busyRef: { current: false }, manageRef: { current: true }, mounted: { current: true }, draftRef: { current: draft }, setBusy: vi.fn(), setWriteError: vi.fn(),
    }) as () => Promise<void> | void;
    const outcome = save();
    expect(setDraft).not.toHaveBeenCalled();
    pending.release();
    await outcome;
    expect(setDraft).toHaveBeenCalledWith(null);
  });

  it('keeps a new tender label until the create is confirmed', async () => {
    const pending = deferred();
    const setNewLabel = vi.fn();
    const add = runInNewContext(nativeCallback('payments/PaymentMethodsSection.tsx', 'add'), {
      newLabel: 'ZZ TEST Tender', newKind: 'other', paymentMethods: [], sorted: [], makeId: () => 'zz_test_tender', normalizePaymentMethod: (v: string) => v,
      mutators: { upsertPaymentMethod: () => pending.promise }, setNewLabel, setNewKind: vi.fn(),
      canManage: true, manageRef: { current: true }, busyRef: { current: false }, mounted: { current: true }, draftEpoch: { current: 0 },
      write: async (work: () => Promise<void>, accepted: () => void) => { await work(); accepted(); },
    }) as () => Promise<void> | void;
    const outcome = add();
    expect(setNewLabel).not.toHaveBeenCalled();
    pending.release();
    await outcome;
    expect(setNewLabel).toHaveBeenCalledWith('');
  });

  it('does not show tax settings as saved before the update is confirmed', async () => {
    const pending = deferred();
    const setSaved = vi.fn();
    const handleSave = runInNewContext(nativeCallback('tax/TaxPanel.tsx', 'handleSave'), {
      rules: [], service: {}, taxConfig: { categoryRules: [] }, rates: [], discountPlacement: 'before_tax',
      mutators: { updateTaxConfig: () => pending.promise }, setSaved,
      manageRef: { current: true }, busyRef: { current: false }, mounted: { current: true }, draftEpoch: { current: 0 }, setSaving: vi.fn(), setWriteError: vi.fn(),
      confirmedConfig: { current: null },
      recoveryRef: { current: { needsRead: false, reading: false, waitUntil: 0, readError: null, notice: null } },
      setRecovery: vi.fn(), setCopyNote: vi.fn(),
    }) as () => Promise<void> | void;
    const outcome = handleSave();
    expect(setSaved).not.toHaveBeenCalledWith(true);
    pending.release();
    await outcome;
    expect(setSaved).toHaveBeenCalledWith(true);
  });
});

describe('native money permission offers', () => {
  it('withholds shared discount and tender writes while live canonical authority is unknown', () => {
    const discounts = renderToStaticMarkup(createElement(DiscountCodesSection));
    const payments = renderToStaticMarkup(createElement(PaymentMethodsSection));
    expect(discounts).toContain('Discount codes');
    expect(payments).toContain('Payment methods');
    expect(enabledButtons(discounts, 'Add code')).toBe(0);
    expect(enabledButtons(payments, 'Add')).toBe(0);
    const cashInput = payments.match(/<input\b[^>]*value="Cash"[^>]*>/)?.[0];
    expect(cashInput).toBeDefined();
    expect(cashInput).toMatch(/\bdisabled(?:\s|=|>)/);
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('withholds live campaign mutation while the canonical branch authority is unknown', () => {
    const html = renderToStaticMarkup(createElement(VoucherPromotionsPanel));
    expect(html).toContain('Campaigns');
    expect(enabledButtons(html, 'Mint codes')).toBe(0);
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('keeps original unbacked prototype discount and tender offers without render-time requests', () => {
    host.branch.branch.apiId = undefined;
    host.api.catalogBridge.apiBranchIdForSlug.mockReturnValue(null);
    const discounts = renderToStaticMarkup(createElement(DiscountCodesSection));
    const payments = renderToStaticMarkup(createElement(PaymentMethodsSection));
    expect(enabledButtons(discounts, 'Add code')).toBe(1);
    expect(enabledButtons(payments, 'Add')).toBe(0);
    expect(payments).toContain('New method (e.g. Bank transfer)');
    const cashInput = payments.match(/<input\b[^>]*value="Cash"[^>]*>/)?.[0];
    expect(cashInput).toBeDefined();
    expect(cashInput).not.toMatch(/\bdisabled(?:\s|=|>)/);
    expect(host.transport.get).not.toHaveBeenCalled();
  });
});

describe('canonical money scope targets', () => {
  const actor = '01900000-0000-7000-8000-000000000002';
  const operator = '01900000-0000-7000-8000-000000000003';
  const park = '01900000-0000-7000-8000-000000000001';
  const sibling = '01900000-0000-7000-8000-000000000004';
  function transport(rows: unknown[], account = { id: actor, operatorId: operator }) {
    return { get: vi.fn(async (path: string) => path === '/me' ? { account } : { permissions: rows }) } as unknown as AdminApi;
  }

  it('keeps shared lists read-only but permits only the granted park actions', async () => {
    const scope = await readMoneyCapabilities(transport(['catalog:menu:manage', 'catalog:tax:manage', 'admin:event_pricing:manage', 'admin:booth:manage'].map(permission => ({ permission, scopeType: 'branch', scopeId: park }))), actor, park);
    expect(scope.canManageDiscounts).toBe(false);
    expect(scope.canManageTenders).toBe(false);
    expect(scope.canManageRules).toBe(false);
    expect(scope.canManageTax).toBe(true);
    expect(scope.canManageEvents).toBe(true);
    expect(scope.canMintCampaign(park)).toBe(true);
    expect(scope.canDownloadCodes({ branchId: park })).toBe(true);
    expect(scope.canMintCampaign(sibling)).toBe(false);
    expect(scope.canDownloadCodes({ branchId: sibling })).toBe(false);
    expect(scope.canMintCampaign('')).toBe(false);
  });

  it('uses owned operator grants for shared settings and both park campaign targets', async () => {
    const scope = await readMoneyCapabilities(transport(['catalog:menu:manage', 'catalog:tax:manage', 'admin:event_pricing:manage', 'admin:booth:manage'].map(permission => ({ permission, scopeType: 'operator', scopeId: operator }))), actor, park);
    expect([scope.canManageDiscounts, scope.canManageTenders, scope.canManageRules, scope.canManageTax, scope.canManageEvents]).toEqual([true, true, true, true, true]);
    expect(scope.canMintCampaign(park)).toBe(true);
    expect(scope.canDownloadCodes({ branchId: sibling })).toBe(true);
  });

  it('refuses a mismatched canonical actor and foreign or malformed scope grants', async () => {
    const rows = [null, { permission: 'catalog:menu:manage', scopeType: 'operator', scopeId: sibling }, { permission: 'admin:booth:manage', scopeType: 'branch', scopeId: sibling }];
    const invalidActor = await readMoneyCapabilities(transport(rows, { id: sibling, operatorId: operator }), actor, park);
    expect(invalidActor.canMintCampaign(sibling)).toBe(false);
    const scope = await readMoneyCapabilities(transport(rows), actor, park);
    expect(scope.canManageDiscounts).toBe(false);
    expect(scope.canMintCampaign(park)).toBe(false);
    expect(scope.canManageRules).toBe(false);
    expect(scope.canManageTax).toBe(false);
  });
});

describe('native money async ownership', () => {
  it('keeps confirmed voucher metadata usable when the optional menu categories cannot be read', async () => {
    let snapshot: unknown = null;
    const definitions = [{ id: 'zz-definition', nameEn: 'ZZ TEST Definition' }];
    const campaigns = [{ id: 'zz-campaign', name: 'ZZ TEST Campaign' }];
    const loader = runInNewContext(voucherLoader(), {
      owner: { id: 'zz-actor' }, branches: [{ apiId: 'zz-park' }],
      voucherPromotionsApi: { definitions: async () => ({ definitions }), campaigns: async () => ({ campaigns }) },
      runtime: { transport: { get: async () => ({ products: [], packages: [] }) } },
      menuApi: { load: async () => { throw new Error('This park menu is not available to this account.'); } },
      setSnapshot: (next: unknown) => { snapshot = typeof next === 'function' ? next(snapshot) : next; }, setFailure: vi.fn(),
    }) as () => () => void;
    const cleanup = loader();
    await new Promise(resolve => setImmediate(resolve));
    expect(snapshot).toEqual(expect.objectContaining({ definitions, campaigns }));
    cleanup();
  });

  it('keeps newer event-price edits when an earlier save resolves', async () => {
    const pending = deferred();
    const draftEpoch = { current: 0 };
    const setPrices = vi.fn();
    const pricing = { campDay: { weekday: 1, weekend: 2 }, eventDay: { weekday: 3, weekend: 4 }, partyGuest: { weekday: 5, weekend: 6 } };
    const submit = runInNewContext(nativeCallback('events/EventsPanel.tsx', 'handleSubmit'), {
      loaded: true, invalid: false, canManage: true, prices: pricing, toSatang: (value: unknown) => value, toBaht: (value: unknown) => value,
      ports: { savePricing: async () => { await pending.promise; return pricing; } },
      setSaving: vi.fn(), setError: vi.fn(), setSaved: vi.fn(), setPrices, setJustSaved: vi.fn(),
      busyRef: { current: false }, manageRef: { current: true }, mounted: { current: true }, draftEpoch,
    }) as (event: { preventDefault: () => void }) => Promise<void>;
    const outcome = submit({ preventDefault: vi.fn() });
    draftEpoch.current++;
    pending.release();
    await outcome;
    expect(setPrices).not.toHaveBeenCalled();
  });

  it('does not close a newer voucher rules editor after an earlier save', async () => {
    const pending = deferred();
    const draft = { usageLimit: '10', perCustomerLimit: '', validFrom: '', validUntil: '' };
    const draftRef = { current: draft };
    const editingRef = { current: 'old-definition' };
    const setEditing = vi.fn();
    const save = runInNewContext(nativeCallback('vouchers/VoucherPromotionsPanel.tsx', 'save'), {
      draft, saving: false, canManageRules: true, targetOf: () => null, limitOf: (text: string) => text ? Number(text) : null,
      ports: { saveRules: () => pending.promise }, setSaving: vi.fn(), setEditing, toast: vi.fn(),
      savingRef: { current: false }, mounted: { current: true }, manageRef: { current: true }, draftRef, editingRef,
    }) as (row: { id: string; kind: string; nameEn: string }) => Promise<void>;
    const outcome = save({ id: 'old-definition', kind: 'discount', nameEn: 'ZZ TEST Old voucher' });
    editingRef.current = 'new-definition';
    draftRef.current = { ...draft, usageLimit: '20' };
    pending.release();
    await outcome;
    expect(setEditing).not.toHaveBeenCalled();
  });

  it('does not erase a newer campaign draft when an earlier mint resolves', async () => {
    const pending = deferred();
    const campaign = { definitionId: 'zz-definition', branchId: 'zz-park', name: 'ZZ TEST First', quantity: '1' };
    const campaignRef = { current: campaign };
    let shown = { ...campaign, name: 'ZZ TEST New draft' };
    const mint = runInNewContext(nativeCallback('vouchers/VoucherPromotionsPanel.tsx', 'mint'), {
      campaign, minting: false, ports: { canMintCampaign: () => true, mintCampaign: () => pending.promise },
      setMinting: vi.fn(), setCampaign: (update: (value: typeof shown) => typeof shown) => { shown = update(shown); }, toast: vi.fn(),
      mintingRef: { current: false }, mounted: { current: true }, campaignRef, mintKeyRef: { current: null }, idemKey: () => 'zz-test-key',
    }) as () => Promise<void>;
    const outcome = mint();
    campaignRef.current = shown;
    pending.release();
    await outcome;
    expect(shown.name).toBe('ZZ TEST New draft');
  });

  it('reuses the exact mint key after an uncertain outcome for the unchanged draft', async () => {
    const campaign = { definitionId: 'zz-definition', branchId: 'zz-park', name: 'ZZ TEST Retry', quantity: '1' };
    const mintCampaign = vi.fn(async () => { throw new Error('The connection closed'); });
    let serial = 0;
    const mint = runInNewContext(nativeCallback('vouchers/VoucherPromotionsPanel.tsx', 'mint'), {
      campaign, minting: false, ports: { canMintCampaign: () => true, mintCampaign },
      setMinting: vi.fn(), setCampaign: vi.fn(), toast: vi.fn(), mintingRef: { current: false }, mounted: { current: true }, campaignRef: { current: campaign },
      mintKeyRef: { current: null }, idemKey: () => 'zz-test-key-' + (++serial),
    }) as () => Promise<void>;
    await mint();
    await mint();
    expect(mintCampaign).toHaveBeenCalledTimes(2);
    const first = mintCampaign.mock.calls[0] as unknown[] | undefined;
    const second = mintCampaign.mock.calls[1] as unknown[] | undefined;
    expect(first?.[1]).toEqual(expect.any(String));
    expect(second).toEqual(first);
  });
});
