import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AdminApi } from '../src/api/admin-api';
import { readBenefitsCapabilities, type BenefitsApi } from '../src/lifted/runtime/benefits';
import { inForceOn, profileToApi, sameProfile } from '../src/lifted/api/benefits';
import * as staffPanel from '../src/lifted/components/admin/staff-benefits/StaffBenefitsPanel';
import * as overrideDialog from '../src/lifted/components/admin/staff-benefits/OperatorOverrideDialog';
import * as qrDialog from '../src/lifted/components/admin/staff-benefits/BenefitQrDialog';
import * as profileFields from '../src/lifted/components/admin/staff-benefits/BenefitProfileFields';

function nativeCallback(file: string, name: string) {
  const source = readFileSync(new URL('../src/lifted/components/admin/staff-benefits/' + file + '.tsx', import.meta.url), 'utf8');
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

function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
const A = { employeeId: '01900000-0000-7000-8000-000000000001', name: 'ZZ TEST Person A' };
const B = { employeeId: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Person B' };
const live = () => ({ identity: 'actor|A', mounted: { current: true }, identityRef: { current: 'actor|A' }, staffRef: { current: A.employeeId }, openRef: { current: true }, issueRef: { current: true }, manageRef: { current: true }, requestEpoch: { current: 0 }, savingRef: { current: false }, busyRef: { current: false }, credentialOwnerRef: { current: '' }, payloadOwnerRef: { current: '' }, intentRef: { current: null }, idemKey: () => '01900000-0000-7000-8000-000000000003' });

describe('native benefit ports and request ownership', () => {
  it('provides four runtime-independent native entry points while retaining the POS wrappers', () => {
    for (const [module, name] of [[staffPanel, 'StaffBenefitsPanelWithPorts'], [overrideDialog, 'OperatorOverrideDialogWithPorts'], [qrDialog, 'BenefitQrDialogWithPorts'], [profileFields, 'BenefitProfileFieldsWithPorts']] as const) {
      expect(typeof (module as Record<string, unknown>)[name]).toBe('function');
    }
    expect(typeof staffPanel.StaffBenefitsPanel).toBe('function');
    expect(typeof overrideDialog.OperatorOverrideDialog).toBe('function');
    expect(typeof qrDialog.BenefitQrDialog).toBe('function');
    expect(typeof profileFields.BenefitProfileFields).toBe('function');
  });

  it('does not let a held save for A close a newly selected B override', async () => {
    const held = deferred<{ changed: boolean }>(), refs = live(), close = vi.fn(), saved = vi.fn();
    const context = { ...refs, staff: A, role: 'staff', NO_ROLE: 'none', enabled: false, profile: {}, effectiveFrom: '2026-10-23', today: '2026-10-23',
      benefitsApi: { saveStaff: vi.fn(() => held.promise) }, profileToApi: (p: unknown) => p,
      setSaving: vi.fn(), setError: vi.fn(), toast: vi.fn(), onSaved: saved, onOpenChange: close };
    const save = runInNewContext(nativeCallback('OperatorOverrideDialog', 'save'), context) as () => Promise<void>;
    const pending = save();
    refs.identityRef.current = 'actor|B'; refs.staffRef.current = B.employeeId;
    held.release({ changed: true }); await pending;
    expect(close).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
  });

  it('refuses late A credential metadata after the QR dialog selects B', async () => {
    const held = deferred<{ credentials: Array<{ id: string; status: string }> }>(), refs = live(), setCredential = vi.fn(), setPayload = vi.fn();
    const context = { ...refs, canIssue: true, benefitsApi: { credentials: () => held.promise, credentialQr: vi.fn(async () => ({ employeeId: A.employeeId, code: 'ZZ TEST synthetic only' })) },
      setLoading: vi.fn(), setError: vi.fn(), setPayload, setCredential, setConfirmRevoke: vi.fn(), useCallback: (fn: unknown) => fn };
    const load = runInNewContext(nativeCallback('BenefitQrDialog', 'load'), context) as (id: string) => Promise<void>;
    const pending = load(A.employeeId); refs.identityRef.current = 'actor|B'; refs.staffRef.current = B.employeeId;
    held.release({ credentials: [{ id: 'ZZ TEST A credential', status: 'active' }] }); await pending;
    expect(setCredential).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'ZZ TEST A credential' }));
    expect(setPayload).not.toHaveBeenCalledWith(expect.objectContaining({ employeeId: A.employeeId }));
  });

  it('does not publish an in-flight printable payload after credential authority is lost', async () => {
    const held = deferred<{ employeeId: string; code: string }>(), refs = live(), setPayload = vi.fn();
    const context = { ...refs, canIssue: true, benefitsApi: { credentials: async () => ({ credentials: [{ id: 'ZZ TEST own credential', status: 'active' }] }), credentialQr: () => held.promise },
      setLoading: vi.fn(), setError: vi.fn(), setPayload, setCredential: vi.fn(), setConfirmRevoke: vi.fn(), useCallback: (fn: unknown) => fn };
    const load = runInNewContext(nativeCallback('BenefitQrDialog', 'load'), context) as (id: string) => Promise<void>;
    const pending = load(A.employeeId); await Promise.resolve(); await Promise.resolve(); refs.issueRef.current = false;
    held.release({ employeeId: A.employeeId, code: 'ZZ TEST synthetic only' }); await pending;
    expect(setPayload).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'ZZ TEST synthetic only' }));
  });

  it('keeps a template draft edited while its canonical refresh is in flight', async () => {
    const held = deferred<{ today: string; templates: Array<{ role: string; current: { profile: object }; upcoming: never[] }> }>();
    let drafts: Record<string, object> = { staff: { comp: false } };
    const draftsRef = { current: drafts }, datesRef = { current: { staff: '2026-10-23' } };
    const refs = live();
    const context = { ...refs, intentsRef: { current: {} }, draftsRef, datesRef, baseDraftsRef: { current: drafts }, baseDatesRef: { current: datesRef.current }, drafts, dates: datesRef.current, contextRef: { current: 'actor|A' }, readEpoch: { current: 0 },
      benefitsApi: { templates: () => held.promise, staff: async () => ({ staff: [] }), applications: async () => ({ applications: [] }) },
      profileFromApi: (p: object) => p, profileToApi, inForceOn, sameProfile, setDataIdentity: vi.fn(), setLoadError: vi.fn(), setToday: vi.fn(), setTemplates: vi.fn(), setStaff: vi.fn(), setLoaded: vi.fn(), setAuditLog: vi.fn(), auditEntryOf: (p: unknown) => p,
      setDrafts: (next: Record<string, object> | ((prior: Record<string, object>) => Record<string, object>)) => { drafts = typeof next === 'function' ? next(drafts) : next; draftsRef.current = drafts; },
      setDates: vi.fn(), useCallback: (fn: unknown) => fn };
    const reload = runInNewContext(nativeCallback('StaffBenefitsPanel', 'reload'), context) as () => Promise<void>;
    const pending = reload(); drafts = { staff: { comp: true } }; draftsRef.current = drafts;
    held.release({ today: '2026-10-23', templates: [{ role: 'staff', current: { profile: {} }, upcoming: [] }] }); await pending;
    expect(drafts.staff).toEqual({ comp: true });
  });

  it('does not replace the open Staff history with a late Owner history response', async () => {
    const held = deferred<{ versions: Array<{ id: string }> }>(), refs = live(), setHistory = vi.fn(), historyOpenRef = { current: 'owner' };
    const context = { ...refs, historyOpenRef, historyEpoch: { current: 0 }, contextRef: { current: 'actor|A' }, benefitsApi: { templateHistory: () => held.promise }, templateEntry: (v: unknown) => v, setHistory, useCallback: (fn: unknown) => fn };
    const load = runInNewContext(nativeCallback('StaffBenefitsPanel', 'loadHistory'), context) as (role: string) => Promise<void>;
    const pending = load('owner'); historyOpenRef.current = 'staff'; held.release({ versions: [{ id: 'ZZ TEST owner version' }] }); await pending;
    expect(setHistory).not.toHaveBeenCalledWith(expect.objectContaining({ entries: [expect.objectContaining({ id: 'ZZ TEST owner version' })] }));
  });

  it('refuses retained mutation callbacks before dispatch after a different person/context is selected', async () => {
    for (const [file, callback] of [['OperatorOverrideDialog', 'save'], ['BenefitQrDialog', 'issue'], ['BenefitQrDialog', 'revoke']]) {
      const refs = live(); refs.identityRef.current = 'actor|B'; refs.staffRef.current = B.employeeId;
      const write = vi.fn(async () => ({ changed: true }));
      const context = { ...refs, staff: A, credential: { id: 'ZZ TEST A credential' }, role: 'staff', NO_ROLE: 'none', enabled: false, profile: {}, effectiveFrom: '2026-10-23', today: '2026-10-23',
        benefitsApi: { saveStaff: write, issueCredential: write, revokeCredential: write }, profileToApi: (p: unknown) => p,
        setSaving: vi.fn(), setBusy: vi.fn(), setError: vi.fn(), setConfirmRevoke: vi.fn(), toast: vi.fn(), onSaved: vi.fn(), onOpenChange: vi.fn(), load: vi.fn(async () => true) };
      await (runInNewContext(nativeCallback(file!, callback!), context) as () => Promise<void>)();
      expect(write, file + ' ' + callback).not.toHaveBeenCalled();
    }
  });

  it('renders the native sections and profile fields without a full application runtime', () => {
    const menu = { topLevelCategories: () => [], subCategoriesOf: () => [] };
    const html = renderToStaticMarkup(createElement(staffPanel.StaffBenefitsPanelWithPorts, { ports: {
      contextKey: 'ZZ TEST Host', api: {} as BenefitsApi, categories: [], menu,
      summarizeProfile: () => 'No benefit configured', toast: vi.fn(), canManage: false, canIssueQr: () => false,
    } }));
    expect(html).toContain('Role templates'); expect(html).toContain('Staff'); expect(html).toContain('Audit log');
    expect(html).toContain('flex flex-col gap-8');
    const fields = renderToStaticMarkup(createElement(profileFields.BenefitProfileFieldsWithPorts, { profile: {}, categories: [], onChange: vi.fn(), ports: { menu } }));
    expect(fields).toContain('Free items'); expect(fields).toContain('Standing'); expect(fields).toContain('switch');
  });

  it('requires operator management and evaluates the credential right at each employee park', async () => {
    const operatorId = '01900000-0000-7000-8000-000000000010';
    const grants = [
      { permission: 'admin:benefit:manage', scopeType: 'branch', scopeId: A.employeeId },
      { permission: 'admin:benefit:credential_issue', scopeType: 'branch', scopeId: A.employeeId },
    ];
    const api = { get: async (path: string) => path === '/me' ? { account: { id: A.employeeId, operatorId } } : { permissions: grants } } as unknown as AdminApi;
    const person = (branchId: string | null) => ({ branchId } as Parameters<Awaited<ReturnType<typeof readBenefitsCapabilities>>['canIssueQr']>[0]);
    const scoped = await readBenefitsCapabilities(api, A.employeeId);
    expect(scoped.canManage).toBe(false); expect(scoped.canIssueQr(person(A.employeeId))).toBe(true);
    expect(scoped.canIssueQr(person(B.employeeId))).toBe(false); expect(scoped.canIssueQr(person(null))).toBe(false);
    grants.splice(0, grants.length, { permission: 'admin:benefit:manage', scopeType: 'operator', scopeId: operatorId }, { permission: 'admin:benefit:credential_issue', scopeType: 'operator', scopeId: operatorId });
    const wide = await readBenefitsCapabilities(api, A.employeeId);
    expect(wide.canManage).toBe(true); expect(wide.canIssueQr(person(null))).toBe(true); expect(wide.canIssueQr(person(B.employeeId))).toBe(true);
    grants.forEach(grant => { grant.scopeId = B.employeeId; });
    const foreign = await readBenefitsCapabilities(api, A.employeeId);
    expect(foreign.canManage).toBe(false); expect(foreign.canIssueQr(person(A.employeeId))).toBe(false);
  });

  it('retains an uncertain override key and retries only the read after an acknowledged save', async () => {
    const refs = live(), write = vi.fn().mockRejectedValueOnce(new Error('ZZ TEST Transport uncertain')).mockResolvedValue({ changed: true });
    const readBack = vi.fn().mockRejectedValueOnce(new Error('ZZ TEST Read refused')).mockResolvedValue(undefined), close = vi.fn();
    const context = { ...refs, staff: A, role: 'staff', NO_ROLE: 'none', enabled: false, profile: {}, effectiveFrom: '2026-10-23', today: '2026-10-23',
      benefitsApi: { saveStaff: write }, profileToApi: (p: unknown) => p, setSaving: vi.fn(), setError: vi.fn(), toast: vi.fn(), onSaved: readBack, onOpenChange: close };
    const save = runInNewContext(nativeCallback('OperatorOverrideDialog', 'save'), context) as () => Promise<void>;
    await save(); await save();
    expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[0]?.[2] === write.mock.calls[1]?.[2]).toBe(true);
    expect(close).not.toHaveBeenCalled(); await save();
    expect(write).toHaveBeenCalledTimes(2); expect(readBack).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledWith(false);
  });

  it('never issues another QR when an acknowledged issue only needs its failed read retried', async () => {
    const refs = live(), issue = vi.fn(async () => ({})), load = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const context = { ...refs, staff: A, benefitsApi: { issueCredential: issue }, load, setBusy: vi.fn(), setError: vi.fn() };
    const action = runInNewContext(nativeCallback('BenefitQrDialog', 'issue'), context) as () => Promise<void>;
    await action(); await action();
    expect(issue).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(2);
  });

  it('retires an acknowledged template intent once a read-only retry proves its canonical version', async () => {
    const drafts = { staff: { comp: true } }, dates = { staff: '2026-10-23' }, intentsRef = { current: {
      staff: { context: 'actor|A', bodyKey: JSON.stringify({ profile: { comp: true }, effectiveFrom: '2026-10-23' }), key: 'ZZ TEST synthetic key', confirmed: true },
    } };
    const context = { ...live(), contextRef: { current: 'actor|A' }, readEpoch: { current: 0 }, intentsRef,
      draftsRef: { current: drafts }, datesRef: { current: dates }, baseDraftsRef: { current: drafts }, baseDatesRef: { current: dates },
      benefitsApi: { templates: async () => ({ today: '2026-10-23', templates: [{ role: 'staff', current: { effectiveFrom: '2026-10-23', effectiveTo: null, profile: { comp: true } }, upcoming: [] }] }), staff: async () => ({ staff: [] }), applications: async () => ({ applications: [] }) },
      profileFromApi: (p: object) => p, inForceOn, sameProfile, setDataIdentity: vi.fn(), setLoadError: vi.fn(), setToday: vi.fn(), setTemplates: vi.fn(), setStaff: vi.fn(), setLoaded: vi.fn(), setAuditLog: vi.fn(), auditEntryOf: (p: unknown) => p,
      setDrafts: vi.fn(), setDates: vi.fn(), useCallback: (fn: unknown) => fn };
    await (runInNewContext(nativeCallback('StaffBenefitsPanel', 'reload'), context) as () => Promise<boolean>)();
    expect(Boolean(intentsRef.current.staff)).toBe(false);
  });

  it('adopts a fresh canonical template when the draft still equals its previous value in a new object', async () => {
    let drafts: Record<string, object> = { staff: { comp: false } };
    const context = { ...live(), contextRef: { current: 'actor|A' }, readEpoch: { current: 0 }, intentsRef: { current: {} },
      baseDraftsRef: { current: { staff: { comp: false } } }, baseDatesRef: { current: { staff: '2026-10-23' } },
      benefitsApi: { templates: async () => ({ today: '2026-10-23', templates: [{ role: 'staff', current: { effectiveFrom: '2026-10-23', effectiveTo: null, profile: { comp: true } }, upcoming: [] }] }), staff: async () => ({ staff: [] }), applications: async () => ({ applications: [] }) },
      profileFromApi: (p: object) => p, profileToApi, inForceOn, sameProfile,
      setDataIdentity: vi.fn(), setLoadError: vi.fn(), setToday: vi.fn(), setTemplates: vi.fn(), setStaff: vi.fn(), setLoaded: vi.fn(), setAuditLog: vi.fn(), auditEntryOf: (p: unknown) => p,
      setDrafts: (next: (prior: Record<string, object>) => Record<string, object>) => { drafts = next(drafts); }, setDates: vi.fn(), useCallback: (fn: unknown) => fn };
    await (runInNewContext(nativeCallback('StaffBenefitsPanel', 'reload'), context) as () => Promise<boolean>)();
    expect(drafts.staff).toEqual({ comp: true });
  });
});
