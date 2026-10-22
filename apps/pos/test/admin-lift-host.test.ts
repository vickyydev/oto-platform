import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import Admin from '@/pages/Admin';
import { adminPanelsById, visibleNavFor } from '@/components/admin/adminSections';

const host = vi.hoisted(() => ({ search: '', allow: new Set<string>(), navigate: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));
vi.mock('wouter', () => ({ useSearch: () => host.search, useLocation: () => ['', host.navigate] }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ can: (permission: string) => host.allow.has(permission) }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: () => null }));
vi.mock('@/components/admin/addons/AddOnsPanel', () => ({ AddOnsPanel: () => null }));
vi.mock('@/components/admin/tickets/TicketsPanel', () => ({ TicketsPanel: () => null }));
vi.mock('@/components/admin/dropoff-pricing/DropOffPricingPanel', () => ({ DropOffPricingPanel: () => null }));
vi.mock('@/components/admin/discounts/DiscountsScreen', () => ({ DiscountsScreen: () => null }));
vi.mock('@/components/admin/devices/DevicesPanel', () => ({ DevicesPanel: () => null }));
vi.mock('@/components/admin/menu/MenuPanel', () => ({ MenuPanel: () => null }));
vi.mock('@/components/admin/merch/MerchPanel', () => ({ MerchPanel: () => null }));
vi.mock('@/components/admin/tax/TaxPanel', () => ({ TaxPanel: () => null }));
vi.mock('@/components/admin/categories/CategoriesPanel', () => ({ CategoriesPanel: () => null }));
vi.mock('@/components/admin/modifiers/ModifiersPanel', () => ({ ModifiersPanel: () => null }));
vi.mock('@/components/admin/templates/TemplatesPanel', () => ({ TemplatesPanel: () => null }));
vi.mock('@/components/admin/members/MembersPanel', () => ({ MembersPanel: () => null }));
vi.mock('@/components/admin/members/TierVerificationsPanel', () => ({ TierVerificationsPanel: () => null }));
vi.mock('@/components/admin/supervision/SupervisionPanel', () => ({ SupervisionPanel: () => null }));
vi.mock('@/components/admin/inventory/InventoryPanel', () => ({ InventoryPanel: () => null }));
vi.mock('@/components/admin/branches/BranchesPanel', () => ({ BranchesPanel: () => null }));
vi.mock('@/components/admin/staff-benefits/StaffBenefitsPanel', () => ({ StaffBenefitsPanel: () => null }));
vi.mock('@/components/admin/events/EventsPanel', () => ({ EventsPanel: () => null }));
vi.mock('@/components/admin/access/LoginUsersPanel', () => ({ LoginUsersPanel: () => null }));
vi.mock('@/components/admin/access/OperatorsPanel', () => ({ OperatorsPanel: () => null }));
vi.mock('@/components/admin/reports/SalesReportPanel', () => ({ SalesReportPanel: () => null }));
vi.mock('@/components/admin/reports/ProfitabilityReportPanel', () => ({ ProfitabilityReportPanel: () => null }));
vi.mock('@/components/admin/reports/WalletPromoReportPanel', () => ({ WalletPromoReportPanel: () => null }));
vi.mock('@/components/admin/wallets/WalletLookupPanel', () => ({ WalletLookupPanel: () => null }));
vi.mock('@/components/admin/vouchers/VoucherPromotionsPanel', () => ({ VoucherPromotionsPanel: () => null }));
vi.mock('@/components/admin/reports/DiscountCompReportPanel', () => ({ DiscountCompReportPanel: () => null }));
vi.mock('@/components/admin/reports/TaxVatReportPanel', () => ({ TaxVatReportPanel: () => null }));

function elements(tree: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children as React.ReactNode)];
}
const named = (tree: React.ReactNode, name: string) => elements(tree).find(element => typeof element.type === 'function' && element.type.name === name);

describe('the POS host keeps its approved admin addresses and permission offers', () => {
  beforeEach(() => { host.search = ''; host.allow.clear(); host.navigate.mockReset(); vi.stubGlobal('React', React); });

  it('keeps the original report offer, local panels and server permission strings', () => {
    const offered = visibleNavFor(permission => permission === 'analytics:read').flatMap(entry => entry.kind === 'group' ? entry.panels : [entry.panel]);
    expect(offered.map(panel => panel.id)).toEqual(['inventory', 'supervision', 'devices', 'reports-sales', 'reports-profitability', 'reports-wallet', 'reports-discounts', 'reports-tax']);
    expect(adminPanelsById.tax!.permission).toBe('catalog:tax:manage');
    expect(adminPanelsById['login-users']!.permission).toBe('admin:account:read');
    expect(adminPanelsById['staff-benefits']!.permission).toBe('admin:benefit:read');
  });

  it('keeps a forbidden bookmarked panel as the existing explicit refusal, without rendering its form', () => {
    host.search = '?panel=tax'; host.allow.add('analytics:read');
    const view = renderHook(() => Admin());
    try {
      expect(named(view.result.current, 'TaxPanel')).toBeUndefined();
      const refusal = named(view.result.current, 'PermissionRefused');
      expect(refusal).toBeDefined();
      const html = renderToStaticMarkup(refusal!);
      expect(html).toContain('You do not have access to Tax &amp; Service');
      expect(html).toContain('catalog:tax:manage');
      expect(html).toContain('rounded-3xl border border-dashed border-red-500/25 bg-red-500/[0.03] px-6 py-16 text-center');
      expect(html).not.toContain('<form');
      expect(host.navigate).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it('honors an allowed panel query and keeps panel selection in the existing POS address', () => {
    host.search = '?panel=menu'; host.allow.add('catalog:menu:manage');
    const view = renderHook(() => Admin());
    try {
      expect(named(view.result.current, 'MenuPanel')).toBeDefined();
      expect(named(view.result.current, 'PermissionRefused')).toBeUndefined();
      const layout = named(view.result.current, 'AdminLayout');
      expect(layout?.props.activeId).toBe('menu');
      (layout!.props.onSelect as (panel: string) => void)('reports-tax');
      expect(host.navigate).toHaveBeenCalledExactlyOnceWith('/admin?panel=reports-tax');
    } finally { view.unmount(); }
  });
});
