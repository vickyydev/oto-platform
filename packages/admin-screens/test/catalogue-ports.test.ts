import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AdminApi } from '../src/api/admin-api';
import type { AddOn, TicketType, TierDef } from '../src/lifted/model/types';
import { createMembershipHelpers } from '../src/lifted/lib/membership';
import { formatWWPrice } from '../src/lifted/lib/pricingMode';
import { isTierPriced } from '../src/lifted/lib/pricing';
import { createTicketPricingHelpers } from '../src/lifted/components/admin/tickets/ticketPricing';
import { TicketsPanelWithPorts } from '../src/lifted/components/admin/tickets/TicketsPanel';
import { TicketTypeFormWithPorts } from '../src/lifted/components/admin/tickets/TicketTypeForm';
import { AddOnsPanelWithPorts } from '../src/lifted/components/admin/addons/AddOnsPanel';
import { MarketsTiersSectionWithPorts } from '../src/lifted/components/admin/markets-tiers/MarketsTiersSection';
import { readOperatorTierCapabilities } from '../src/lifted/runtime/catalogue';

const host = vi.hoisted(() => ({
  branch: { branch: { id: 'zz-test-park', apiId: '01900000-0000-7000-8000-000000000001' as string | undefined } },
  session: { operator: { id: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST Branch manager', role: 'manager' }, can: () => true },
  catalog: {
    tiers: [
      { id: 'standard', name: 'ZZ TEST Standard', isDefault: true, requiresVerification: false, sortOrder: 0 },
      { id: 'student', name: 'ZZ TEST Student', isDefault: false, requiresVerification: true, sortOrder: 1 },
    ],
    ticketTypes: [],
    mutators: { upsertTier: vi.fn(), deleteTier: vi.fn() },
  },
  legacy: { countTierUsage: () => 0 },
  domain: { pricing: { isTierPriced: () => true } },
  transport: { get: vi.fn(async () => ({ permissions: [{ permission: 'catalog:package:update', scopeType: 'branch', scopeId: '01900000-0000-7000-8000-000000000001' }] })) },
}));

vi.mock('../src/lifted/runtime/AdminScreenRuntime', () => ({
  useAdminScreenRuntime: () => host,
  useCatalogStore: () => host.catalog,
}));

import { MarketsTiersSection } from '../src/lifted/components/admin/markets-tiers/MarketsTiersSection';

const tiers: TierDef[] = [
  { id: 'standard', name: 'ZZ TEST Standard', isDefault: true, requiresVerification: false, sortOrder: 0 },
  { id: 'student', name: 'ZZ TEST Student', isDefault: false, requiresVerification: true, sortOrder: 1 },
];
const ticket: TicketType = { id: 'zz-ticket', name: 'ZZ TEST Two hours', durationLabel: '2 hours', hours: 2, prices: { standard: { weekday: 100, weekend: 150 } }, gateAccess: true };
const extras: AddOn[] = [
  { id: 'zz-local-addon', name: 'ZZ TEST Park extra', price: { weekday: 40, weekend: 50 } },
  { id: 'zz-global-addon', name: 'ZZ TEST Shared extra', price: { weekday: 20, weekend: 20 } },
];
const membership = createMembershipHelpers({ catalog: { getTier: id => tiers.find(row => row.id === id), getDefaultTier: () => tiers[0] } });
const ticketPricing = createTicketPricingHelpers({ catalog: { getTiers: () => tiers }, membership, pricingMode: { formatWWPrice } });
const mutations = { upsertTicketType: vi.fn(), deleteTicketType: vi.fn(), upsertAddOn: vi.fn(), deleteAddOn: vi.fn(), upsertInventoryItem: vi.fn(), deleteInventoryItem: vi.fn() };
const ticketPorts = { tiers, defaultTier: tiers[0], ticketTypes: [ticket], addOns: extras, ticketPricing, formatWWPrice, isDefaultTier: membership.isDefaultTier, tierLabel: membership.tierLabel, ...mutations };

function authorityApi(account: { id: string; operatorId: string }, permissions: unknown) {
  const calls: string[] = [];
  const fail = async <T,>(): Promise<T> => { throw new Error('Unexpected mutating call'); };
  const api: AdminApi = { get: async <T,>(path: string): Promise<T> => { calls.push(path); return (path === '/me' ? { account } : { permissions }) as T; }, post: fail, patch: fail, put: fail, delete: fail };
  return { api, calls };
}

describe('Catalogue native panel ports', () => {
  it('offers no operator tier writes before a server-backed branch manager has canonical operator-scope authority', () => {
    host.branch.branch.apiId = '01900000-0000-7000-8000-000000000001';
    const html = renderToStaticMarkup(createElement(MarketsTiersSection));
    expect(html).toContain('Customer tiers');
    expect(html).toContain('ZZ TEST Standard');
    expect(html).not.toContain('New tier (e.g. Student)');
    expect(html).not.toContain('Make default');
    expect(html).not.toContain('aria-label="Move up"');
    expect(html).not.toContain('aria-label="Remove tier"');
    expect(host.catalog.mutators.upsertTier).not.toHaveBeenCalled();
  });

  it('keeps the original unbacked prototype tier controls and performs no request during render', () => {
    host.branch.branch.apiId = undefined;
    const html = renderToStaticMarkup(createElement(MarketsTiersSection));
    expect(html).toContain('New tier (e.g. Student)');
    expect(html).toContain('Make default');
    expect(html).toContain('aria-label="Remove tier"');
    expect(host.transport.get).not.toHaveBeenCalled();
  });

  it('renders the native ticket table/cards and pricing chips from explicit snapshots without an app provider', () => {
    const html = renderToStaticMarkup(createElement(TicketsPanelWithPorts, { ports: ticketPorts }));
    for (const words of ['Add ticket type', 'ZZ TEST Two hours', '2 hours', 'Opens gate', 'ZZ TEST Standard', 'not priced', 'rounded-2xl border border-foreground/10']) expect(html).toContain(words);
    expect(html).toContain('aria-label="Edit ZZ TEST Two hours"');
    expect(html).toContain('aria-label="Delete ZZ TEST Two hours"');
    expect(mutations.upsertTicketType).not.toHaveBeenCalled();
    const other = renderToStaticMarkup(createElement(TicketsPanelWithPorts, { ports: { ...ticketPorts, ticketTypes: [{ ...ticket, name: 'ZZ TEST Separate snapshot' }] } }));
    expect(other).toContain('ZZ TEST Separate snapshot');
    expect(other).not.toContain('ZZ TEST Two hours');
  });

  it('keeps read-only ticket and tier values while withholding their native write offers', () => {
    const ticketHtml = renderToStaticMarkup(createElement(TicketsPanelWithPorts, { ports: { ...ticketPorts, canCreate: false, canUpdate: false } }));
    expect(ticketHtml).toContain('ZZ TEST Two hours');
    expect(ticketHtml).not.toContain('Add ticket type');
    expect(ticketHtml).not.toContain('aria-label="Edit');
    const tiersHtml = renderToStaticMarkup(createElement(MarketsTiersSectionWithPorts, { ports: { tiers, ticketTypes: [ticket], countTierUsage: () => 0, isTierPriced, upsertTier: vi.fn(), deleteTier: vi.fn(), canCreate: false, canUpdate: false } }));
    expect(tiersHtml).toContain('ZZ TEST Student');
    expect(tiersHtml).toContain('No price on 1 of 1');
    expect(tiersHtml).toContain('disabled=""');
    for (const words of ['New tier (e.g. Student)', 'Make default', 'aria-label="Move up"', 'aria-label="Remove tier"']) expect(tiersHtml).not.toContain(words);
  });

  it('renders add-on stock wording and native values while keeping a global read-only row free of write controls', () => {
    const html = renderToStaticMarkup(createElement(AddOnsPanelWithPorts, { ports: { addOns: extras, formatWWPrice, ...mutations, canManageAddOn: row => row.id === 'zz-local-addon' } }));
    expect(html).toContain('To start stock tracking, link the item in Inventory.');
    expect(html).toContain('ZZ TEST Park extra');
    expect(html).toContain('ZZ TEST Shared extra');
    expect(html).toContain('aria-label="Edit ZZ TEST Park extra"');
    expect(html).not.toContain('aria-label="Edit ZZ TEST Shared extra"');
    expect(html).not.toContain('aria-label="Delete ZZ TEST Shared extra"');
    expect(mutations.upsertInventoryItem).not.toHaveBeenCalled();
  });

  it('does not invent a baseline or crash a ticket form while no tier exists', () => {
    const html = renderToStaticMarkup(createElement(TicketTypeFormWithPorts, { ports: { ...ticketPorts, tiers: [], defaultTier: undefined }, open: true, ticket: null, addOns: [], onSave: mutations.upsertTicketType, onClose: () => undefined }));
    expect(html).toBe('');
  });

  it('does not promote a branch permission or a different operator into operator-wide tier authority', async () => {
    const actor = { id: 'zz-actor', operatorId: 'zz-own-operator' };
    const { api, calls } = authorityApi(actor, [
      { permission: 'catalog:package:create', scopeType: 'branch', scopeId: 'zz-park' },
      { permission: 'catalog:package:update', scopeType: 'operator', scopeId: 'zz-other-operator' },
    ]);
    await expect(readOperatorTierCapabilities(api, actor.id)).resolves.toEqual({ canCreate: false, canUpdate: false });
    expect(calls.sort()).toEqual(['/me', '/me/permissions']);
  });

  it('keeps create and update capabilities distinct and accepts a canonical platform-wide assignment', async () => {
    const actor = { id: 'zz-actor', operatorId: 'zz-own-operator' };
    const own = authorityApi(actor, [{ permission: 'catalog:package:create', scopeType: 'operator', scopeId: actor.operatorId }]);
    await expect(readOperatorTierCapabilities(own.api, actor.id)).resolves.toEqual({ canCreate: true, canUpdate: false });
    const platform = authorityApi(actor, [{ permission: 'catalog:package:update', scopeType: 'operator', scopeId: null }]);
    await expect(readOperatorTierCapabilities(platform.api, actor.id)).resolves.toEqual({ canCreate: false, canUpdate: true });
  });

  it('refuses a replaced actor and malformed scope payload instead of reusing another account authority', async () => {
    const actor = { id: 'zz-new-actor', operatorId: 'zz-own-operator' };
    const replaced = authorityApi(actor, [{ permission: 'catalog:package:update', scopeType: 'operator', scopeId: null }]);
    await expect(readOperatorTierCapabilities(replaced.api, 'zz-old-actor')).resolves.toEqual({ canCreate: false, canUpdate: false });
    const malformed = authorityApi(actor, { permission: 'catalog:package:update', scopeType: 'operator', scopeId: null });
    await expect(readOperatorTierCapabilities(malformed.api, actor.id)).resolves.toEqual({ canCreate: false, canUpdate: false });
  });

  it('does not continue the native two-tier reorder after its panel has unmounted', async () => {
    // Execute the actual native callback independently of Console host fences.
    const text = readFileSync(new URL('../src/lifted/components/admin/markets-tiers/MarketsTiersSection.tsx', import.meta.url), 'utf8');
    const file = ts.createSourceFile('tiers.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let action: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'move') action = node.initializer?.getText(file);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(action).toBeDefined();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: TierDef[] = [];
    const pending: Array<Promise<void>> = [];
    const mounted = { current: true };
    const context = {
      sorted: tiers,
      mounted,
      ports: { upsertTier: (row: TierDef) => { calls.push(row); return calls.length === 1 ? held : Promise.resolve(); } },
      write: (operation: () => Promise<void>) => { const task = operation(); pending.push(task); return task; },
    };
    const js = ts.transpileModule('(' + action + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const move = runInNewContext(js, context) as (index: number, direction: -1 | 1) => void;
    move(0, 1);
    expect(calls).toHaveLength(1);
    mounted.current = false;
    release();
    await Promise.all(pending);
    expect(calls).toHaveLength(1);
  });
});
