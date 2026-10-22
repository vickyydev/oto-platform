import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminApi } from '../src/api/admin-api';
import { createOrganisationAdminApi } from '../src/lifted/api/platform';
import { OperatorsPanelWithPorts } from '../src/lifted/components/admin/access/OperatorsPanel';
import { BranchesPanelWithPorts } from '../src/lifted/components/admin/branches/BranchesPanel';
import { PricingOverridesWithPorts } from '../src/lifted/components/admin/pricing-overrides/PricingOverridesSection';
import type { Branch } from '../src/lifted/model/types';
import type { OperatorsPanelPorts } from '../src/lifted/runtime/organisation';

function transport() {
  const calls: Array<{ method: string; path: string; body?: unknown; key?: string }> = [];
  let answer: () => unknown = () => ({ ok: true });
  const run = async <T,>(method: string, path: string, body?: unknown, key?: string): Promise<T> => {
    calls.push({ method, path, body, key }); return answer() as T;
  };
  const api: AdminApi = {
    get: path => run('GET', path),
    post: (path, body, options) => run('POST', path, body, options?.idempotencyKey),
    patch: (path, body, options) => run('PATCH', path, body, options?.idempotencyKey),
    put: (path, body, options) => run('PUT', path, body, options?.idempotencyKey),
    delete: (path, options) => run('DELETE', path, undefined, options?.idempotencyKey),
  };
  return { calls, organisation: createOrganisationAdminApi(api), respond: (next: () => unknown) => { answer = next; } };
}
const branchA: Branch = { id: 'zz-test-central', apiId: '01900000-0000-7000-8000-000000000001', name: 'ZZ TEST Central', country: 'TH', timezone: 'Asia/Bangkok', active: true };
const branchB: Branch = { ...branchA, id: 'zz-test-other', apiId: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Other park' };

describe('Organisation panels through explicit host ports', () => {
  it('renders the original Operator entry controls without an app provider or an implicit request', () => {
    const { calls, organisation } = transport();
    // The unchanged POS host exposes these four operations. Console-only
    // Rename is an injected row action, not a requirement of the native panel.
    const ports = {
      adminApi: {
        operators: organisation.adminApi.operators,
        createOperator: organisation.adminApi.createOperator,
        archiveOperator: organisation.adminApi.archiveOperator,
        assignOperatorAdmin: organisation.adminApi.assignOperatorAdmin,
      },
      opsApi: organisation.opsApi,
      toast: () => undefined,
    } satisfies OperatorsPanelPorts;
    const html = renderToStaticMarkup(createElement(OperatorsPanelWithPorts, { ports }));
    expect(html).toContain('New operator name (e.g. OTO)');
    expect(html).toContain('Create operator');
    expect(html).toContain('No operators yet.');
    expect(html).not.toContain('Reset demo data');
    expect(ports.adminApi).not.toHaveProperty('renameOperator');
    expect(ports.adminApi.archiveOperator).toBe(organisation.adminApi.archiveOperator);
    expect(ports.adminApi.assignOperatorAdmin).toBe(organisation.adminApi.assignOperatorAdmin);
    expect(calls).toEqual([]);
  });

  it('retains native branch cards and clone controls while the host adds exact mapping facts', () => {
    const { calls, organisation } = transport();
    const html = renderToStaticMarkup(createElement(BranchesPanelWithPorts, { ports: {
      branches: [branchA, branchB], activeBranch: branchA, actorName: 'ZZ TEST Administrator',
      onSelectBranch: () => undefined, upsertBranch: () => undefined,
      branchesApi: organisation.branchesApi, afterClone: async () => undefined,
      renderBranchDetails: park => createElement('span', null, park.id === branchA.id ? 'Mapped to ZZ TEST App Central' : 'Not mapped — ZZ TEST app row absent'),
    } }));
    for (const words of ['Registered branches', 'Add a branch', 'Clone from another branch', 'ZZ TEST Central', 'ZZ TEST Other park', 'Mapped to ZZ TEST App Central', 'Not mapped', 'Switch here', 'Active']) expect(html).toContain(words);
    expect(html).toContain('rounded-2xl border border-foreground/10');
    expect((html.match(/Switch here/g) ?? []).length).toBe(1);
    expect(calls).toEqual([]);
  });

  it('shows no selected branch as an explicit choice and keeps native Holidays ranges without invented data', () => {
    const { calls, organisation } = transport();
    const branches = renderToStaticMarkup(createElement(BranchesPanelWithPorts, { ports: {
      branches: [branchA], activeBranch: null, actorName: 'ZZ TEST Administrator',
      onSelectBranch: () => undefined, upsertBranch: () => undefined, branchesApi: organisation.branchesApi, afterClone: async () => undefined,
    } }));
    expect(branches).toContain('Choose Switch here on a branch before copying its catalogue.');
    const holidays = renderToStaticMarkup(createElement(PricingOverridesWithPorts, { ports: {
      pricingOverrides: [{ id: 'zz-range', name: 'ZZ TEST Future holiday', startDate: '2099-04-13', endDate: '2099-04-15' }],
      getActiveBranch: () => ({ id: branchA.id }), holidaySaleCounts: async () => ({}), upsertPricingOverride: () => undefined, deletePricingOverride: () => undefined,
    } }));
    for (const words of ['Holidays / weekend overrides', 'Add range', 'ZZ TEST Future holiday', '2099-04-13', '2099-04-15', 'Edit ZZ TEST Future holiday', 'Remove ZZ TEST Future holiday']) expect(holidays).toContain(words);
    expect(holidays).not.toContain('No holiday overrides yet');
    expect(calls).toEqual([]);
  });

  it('sends every explicit Organisation mutation with a fresh action key and keeps a DELETE key out of the body', async () => {
    const { calls, organisation: { branchesApi, adminApi, holidaysApi, opsApi } } = transport();
    await branchesApi.create({ name: 'ZZ TEST New park', code: 'zz-test-new' });
    await branchesApi.update(branchA.apiId!, { name: 'ZZ TEST Renamed park' });
    await branchesApi.clone(branchA.apiId!, branchB.apiId!);
    await adminApi.createOperator('ZZ TEST New operator');
    await adminApi.renameOperator('zz-operator', 'ZZ TEST Renamed operator');
    await adminApi.archiveOperator('zz-operator', 'ZZ TEST New operator');
    await adminApi.assignOperatorAdmin('zz-operator', { phone: '+66999620000', name: 'ZZ TEST Local only invite' });
    await holidaysApi.createHoliday(branchA.apiId!, { name: 'ZZ TEST Range', startsOn: '2099-01-01', endsOn: '2099-01-02' });
    await holidaysApi.updateHoliday(branchA.apiId!, 'zz-range', { name: 'ZZ TEST Corrected range' });
    await holidaysApi.deleteHoliday(branchA.apiId!, 'zz-range');
    await opsApi.demoReset('ZZ TEST mocked transport only');
    expect(calls).toHaveLength(11);
    for (const call of calls) expect(call.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(new Set(calls.map(call => call.key)).size).toBe(calls.length);
    expect(calls.find(call => call.method === 'DELETE')).toMatchObject({ path: `/branches/${branchA.apiId}/holidays/zz-range`, body: undefined });
  });

  it('returns canonical source values and preserves a source refusal instead of inventing an empty holiday list', async () => {
    const { organisation, respond } = transport();
    const source = { holidays: [{ id: 'zz-range', name: 'ZZ TEST Traded range', startsOn: '2099-02-01', endsOn: '2099-02-02', pricedSales: 3 }] };
    respond(() => source); expect(await organisation.holidaysApi.holidays(branchA.apiId!)).toBe(source);
    const refusal = new Error('ZZ TEST branch source refused'); respond(() => { throw refusal; });
    await expect(organisation.holidaysApi.holidays(branchA.apiId!)).rejects.toBe(refusal);
  });
});
