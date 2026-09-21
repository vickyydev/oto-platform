import { useState } from 'react';
import { Construction, ShieldAlert } from 'lucide-react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import {
  adminPanelsById,
  DEFAULT_ADMIN_PANEL,
  firstUsableAdminPanel,
} from '@/components/admin/adminSections';
import { AddOnsPanel } from '@/components/admin/addons/AddOnsPanel';
import { TicketsPanel } from '@/components/admin/tickets/TicketsPanel';
import { DropOffPricingPanel } from '@/components/admin/dropoff-pricing/DropOffPricingPanel';
import { DiscountsScreen } from '@/components/admin/discounts/DiscountsScreen';
import { DevicesPanel } from '@/components/admin/devices/DevicesPanel';
import { MenuPanel } from '@/components/admin/menu/MenuPanel';
import { MerchPanel } from '@/components/admin/merch/MerchPanel';
import { TaxPanel } from '@/components/admin/tax/TaxPanel';
import { CategoriesPanel } from '@/components/admin/categories/CategoriesPanel';
import { ModifiersPanel } from '@/components/admin/modifiers/ModifiersPanel';
import { TemplatesPanel } from '@/components/admin/templates/TemplatesPanel';
import { MembersPanel } from '@/components/admin/members/MembersPanel';
import { TierVerificationsPanel } from '@/components/admin/members/TierVerificationsPanel';
import { SupervisionPanel } from '@/components/admin/supervision/SupervisionPanel';
import { InventoryPanel } from '@/components/admin/inventory/InventoryPanel';
import { BranchesPanel } from '@/components/admin/branches/BranchesPanel';
import { StaffBenefitsPanel } from '@/components/admin/staff-benefits/StaffBenefitsPanel';
import { LoginUsersPanel } from '@/components/admin/access/LoginUsersPanel';
import { OperatorsPanel } from '@/components/admin/access/OperatorsPanel';
import { SalesReportPanel } from '@/components/admin/reports/SalesReportPanel';
import { ProfitabilityReportPanel } from '@/components/admin/reports/ProfitabilityReportPanel';
import { WalletPromoReportPanel } from '@/components/admin/reports/WalletPromoReportPanel';
import { DiscountCompReportPanel } from '@/components/admin/reports/DiscountCompReportPanel';
import { TaxVatReportPanel } from '@/components/admin/reports/TaxVatReportPanel';
import { useOperator } from '@/auth/OperatorContext';

export default function Admin() {
  const { can } = useOperator();
  /**
   * Land on something this account can use. Tickets is the console's front
   * page and needs `catalog:package:update`, which an account here to manage
   * staff accounts does not hold — opening on a refusal would be a poor
   * welcome and would read as a fault. Computed once, because it answers
   * "where does this person start", not "what may they do now".
   */
  const [activeId, setActiveId] = useState<string>(() => firstUsableAdminPanel(can));
  const panel = adminPanelsById[activeId] ?? adminPanelsById[DEFAULT_ADMIN_PANEL];
  /**
   * A panel the nav did not offer, opened anyway — a state edit today, a deep
   * link when panels get addresses. It gets a refusal that names the
   * permission rather than a form that will 403 on save: the same choice
   * App.tsx makes for the station-setup routes, so a person can be shown why
   * and can screenshot it.
   */
  const refusedPermission = panel.permission && !can(panel.permission) ? panel.permission : null;

  return (
    <AdminLayout activeId={activeId} onSelect={setActiveId}>
      <div className="mx-auto max-w-4xl flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-foreground/5 text-foreground/80">
            <panel.icon className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-2xl font-black tracking-tight">{panel.label}</h1>
            <p className="text-sm text-foreground/50">{panel.description}</p>
          </div>
        </div>

        {refusedPermission ? (
          <PermissionRefused label={panel.label} permission={refusedPermission} />
        ) : activeId === 'tickets' ? (
          <TicketsPanel />
        ) : activeId === 'addons' ? (
          <AddOnsPanel />
        ) : activeId === 'pricing' ? (
          <DropOffPricingPanel />
        ) : activeId === 'discounts' ? (
          <DiscountsScreen />
        ) : activeId === 'devices' ? (
          <DevicesPanel />
        ) : activeId === 'menu' ? (
          <MenuPanel />
        ) : activeId === 'merch' ? (
          <MerchPanel />
        ) : activeId === 'tax' ? (
          <TaxPanel />
        ) : activeId === 'categories' ? (
          <CategoriesPanel />
        ) : activeId === 'modifiers' ? (
          <ModifiersPanel />
        ) : activeId === 'templates' ? (
          <TemplatesPanel />
        ) : activeId === 'members' ? (
          <MembersPanel />
        ) : activeId === 'tier-verifications' ? (
          <TierVerificationsPanel />
        ) : activeId === 'login-users' ? (
          <LoginUsersPanel />
        ) : activeId === 'operators' ? (
          <OperatorsPanel />
        ) : activeId === 'supervision' ? (
          <SupervisionPanel />
        ) : activeId === 'inventory' ? (
          <InventoryPanel />
        ) : activeId === 'branches' ? (
          <BranchesPanel />
        ) : activeId === 'staff-benefits' ? (
          <StaffBenefitsPanel />
        ) : activeId === 'reports-sales' ? (
          <SalesReportPanel />
        ) : activeId === 'reports-profitability' ? (
          <ProfitabilityReportPanel />
        ) : activeId === 'reports-wallet' ? (
          <WalletPromoReportPanel />
        ) : activeId === 'reports-discounts' ? (
          <DiscountCompReportPanel />
        ) : activeId === 'reports-tax' ? (
          <TaxVatReportPanel />
        ) : (
          <ComingSoon label={panel.label} />
        )}
      </div>
    </AdminLayout>
  );
}

function PermissionRefused({ label, permission }: { label: string; permission: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-red-500/25 bg-red-500/[0.03] px-6 py-16 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-300">
        <ShieldAlert className="w-7 h-7" />
      </span>
      <h2 className="text-lg font-bold">You do not have access to {label}</h2>
      <p className="max-w-sm text-sm text-foreground/50">
        This screen needs the{' '}
        <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-xs text-foreground/80">
          {permission}
        </code>{' '}
        permission, which this account does not hold. A manager can grant it in Login Users.
      </p>
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-16 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300">
        <Construction className="w-7 h-7" />
      </span>
      <h2 className="text-lg font-bold">Coming soon</h2>
      <p className="max-w-sm text-sm text-foreground/50">
        The editing screen for <span className="text-foreground/80">{label}</span>{' '}
        will be built next. The data already flows through the shared store.
      </p>
    </div>
  );
}
