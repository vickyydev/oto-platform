import { useEffect, useMemo, useState } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { AdminNotifications, adminToast } from '@oto/admin-screens';
import { StaffBenefitsPanelWithPorts } from '@oto/admin-screens/lifted/admin/staff-benefits/StaffBenefitsPanel';
import { createBenefitSummaryHelpers } from '@oto/admin-screens/lifted/admin-helpers/staff-benefits/summary';
import { createMenuCatalogueApi, type MappedMenu } from '@oto/admin-screens/lifted/api/menu';
import { createMenuHelpers } from '@oto/admin-screens/lifted/lib/menu';
import { createDiscountTargetLabel } from '@oto/admin-screens/lifted/lib/discountTarget';
import { isEmptyBenefitProfile } from '@oto/admin-screens/lifted/lib/benefits';
import { createConsoleBenefits } from '@/api/care';
import { api } from '@/api/client';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';

/** Benefit records stay platform-owned; category choices are a separate canonical read. */
export function StaffBenefits() {
  const { me, permissions, has } = useSession();
  const operatorId = me?.account.operatorId, allowed = has('admin:benefit:read');
  const contextKey = [me?.account.id, operatorId, me?.branch?.id,
    permissions.map(row => [row.permission, row.scopeType, row.scopeId].join(':')).sort().join('|')].join('|');
  const can = (permission: Permission, branchId?: string) => permissions.some(row => row.permission === permission && (
    row.scopeType === 'operator' && (row.scopeId === null || row.scopeId === operatorId) ||
    branchId !== undefined && row.scopeType === 'branch' && row.scopeId === branchId
  ));
  const [choices, setChoices] = useState<{ contextKey: string; value: MappedMenu | null; error: string | null } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const branchId = me?.branch?.id, canReadMenu = can('catalog:menu:read', branchId);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    if (!branchId || !canReadMenu) {
      setChoices({ contextKey, value: null, error: 'Menu choices are unavailable for this sign-in. Existing benefit records remain visible.' });
      return;
    }
    const menu = createMenuCatalogueApi(api);
    void menu.menuApi.load(branchId).then(answer => {
      if (live) setChoices({ contextKey, value: menu.mapMenu(answer), error: null });
    }).catch(failure => { if (live) setChoices({ contextKey, value: null,
      error: 'Menu choices could not be read. ' + (failure instanceof Error ? failure.message : 'Try again.') }); });
    return () => { live = false; };
  }, [allowed, contextKey, branchId, canReadMenu, refresh]);
  const menu = choices?.contextKey === contextKey ? choices.value : null;
  const helpers = useMemo(() => {
    const categories = menu?.categories ?? [];
    const formatDiscountTargetLabel = createDiscountTargetLabel({ getTicketTypes: () => [], getAddOns: () => menu?.addOns ?? [],
      getMenuItems: () => menu?.menuItems ?? [], getMenuCategories: () => categories });
    return { categories, ...createMenuHelpers({ catalog: { getMenuCategories: () => categories, getModifierGroups: () => menu?.modifierGroups ?? [] } }),
      ...createBenefitSummaryHelpers({ benefits: { isEmptyBenefitProfile }, discountTarget: { formatDiscountTargetLabel } }) };
  }, [menu]);
  const benefits = useMemo(createConsoleBenefits, [contextKey]);
  if (!allowed) return <PermissionRequired permission="admin:benefit:read" />;
  return <>
    <CommandBar sectionId="staff-benefits" />
    {choices?.contextKey === contextKey && choices.error && <ErrorNote message={choices.error} onRetry={() => setRefresh(value => value + 1)} />}
    <StaffBenefitsPanelWithPorts key={contextKey} ports={{ contextKey, api: benefits, categories: helpers.categories, menu: helpers,
      summarizeProfile: helpers.summarizeProfile, toast: adminToast, canManage: can('admin:benefit:manage'),
      canIssueQr: person => can('admin:benefit:credential_issue', person.branchId ?? undefined) }} />
    <AdminNotifications />
  </>;
}
