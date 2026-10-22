import { useEffect, useState } from 'react';
import type { AdminApi } from '../../api/admin-api';
import type { createMenuApi } from '../api/menu';
import type { MenuHelpers } from '../lib/menu';
import type { Discount, InventoryItem, MenuCategoryDef, MenuItem, MerchItem, ModifierGroup } from '../model/types';
import type { CatalogueMutation, CataloguePriceFormatter } from './catalogue';

export type MenuDomainPorts = Pick<MenuHelpers, 'topLevelCategories' | 'subCategoriesOf' | 'categoryPrepStation' | 'categoryTaxCategory'>;
export type MenuFileApi = Pick<ReturnType<typeof createMenuApi>['menuApi'], 'exportWorkbook' | 'importPreview' | 'importCommit'>;
export type MenuImportApi = Pick<MenuFileApi, 'importPreview' | 'importCommit'>;
export type MenuToast = (input: { title: string; description?: string; variant?: 'default' | 'destructive' }) => unknown;

export interface MenuItemFormPorts {
  menuCategories: MenuCategoryDef[];
  modifierGroups: ModifierGroup[];
  menuHelpers: MenuDomainPorts;
  canManageInlineGroups?: boolean;
}

export interface MenuPanelPorts extends MenuItemFormPorts {
  menuItems: MenuItem[];
  branch: { id: string; name: string };
  apiBranchId: string | null;
  fileApi: MenuFileApi;
  onImported: () => void | Promise<void>;
  toast: MenuToast;
  formatWWPrice: CataloguePriceFormatter;
  upsertMenuItem: CatalogueMutation<MenuItem>;
  deleteMenuItem: CatalogueMutation<string>;
  upsertInventoryItem: CatalogueMutation<InventoryItem>;
  deleteInventoryItem: CatalogueMutation<string>;
  canCreate?: boolean;
  canManageItem?: (item: MenuItem) => boolean;
  canImport?: boolean;
  canExport?: boolean;
}

export interface CategoriesPanelPorts {
  menuCategories: MenuCategoryDef[];
  menuItems: MenuItem[];
  discounts: Discount[];
  menuHelpers: MenuDomainPorts;
  upsertMenuCategory: CatalogueMutation<MenuCategoryDef>;
  deleteMenuCategory: CatalogueMutation<string>;
  upsertMenuItem: CatalogueMutation<MenuItem>;
  canManage?: boolean;
  authorityMessage?: string;
}

export interface ModifiersPanelPorts {
  modifierGroups: ModifierGroup[];
  menuItems: MenuItem[];
  upsertModifierGroup: CatalogueMutation<ModifierGroup>;
  deleteModifierGroup: CatalogueMutation<string>;
  canManage?: boolean;
  authorityMessage?: string;
}

export interface MerchPanelPorts {
  /** Editable catalogue rows never carry the stock projection back into a write. */
  merchItems: MerchItem[];
  shownItems: MerchItem[];
  formatWWPrice: CataloguePriceFormatter;
  upsertMerchItem: CatalogueMutation<MerchItem>;
  deleteMerchItem: CatalogueMutation<string>;
  upsertInventoryItem: CatalogueMutation<InventoryItem>;
  deleteInventoryItem: CatalogueMutation<string>;
  canCreate?: boolean;
  canManageItem?: (item: MerchItem) => boolean;
}

export interface MenuCapabilities {
  canManage: boolean;
  canManageBranch: boolean;
  canImport: boolean;
  canManageProduct: (productBranchId: string | null | undefined) => boolean;
}

const refused: MenuCapabilities = { canManage: false, canManageBranch: false, canImport: false, canManageProduct: () => false };

/** Offers are bound to both the canonical actor and this exact platform park. */
export async function readMenuCapabilities(api: AdminApi, actorId: string, apiBranchId?: string): Promise<MenuCapabilities> {
  const [me, answer] = await Promise.all([api.get('/me'), api.get('/me/permissions')]);
  if (typeof me !== 'object' || me === null || !('account' in me) || typeof me.account !== 'object' || me.account === null ||
    !('id' in me.account) || me.account.id !== actorId || !('operatorId' in me.account) || typeof me.account.operatorId !== 'string' ||
    typeof answer !== 'object' || answer === null || !('permissions' in answer) || !Array.isArray(answer.permissions)) return refused;
  const operatorId = me.account.operatorId;
  const permissions: unknown[] = answer.permissions;
  const held = (permission: string, branchId?: string) => permissions.some(row =>
    typeof row === 'object' && row !== null && 'permission' in row && row.permission === permission && 'scopeType' in row && 'scopeId' in row && (
      row.scopeType === 'operator' && (row.scopeId === null || row.scopeId === operatorId) ||
      branchId !== undefined && row.scopeType === 'branch' && row.scopeId === branchId
    ));
  const canManage = held('catalog:menu:manage');
  const canManageBranch = Boolean(apiBranchId) && held('catalog:menu:manage', apiBranchId);
  return { canManage, canManageBranch, canImport: Boolean(apiBranchId) && held('catalog:menu:import', apiBranchId),
    canManageProduct: productBranchId => productBranchId === null ? canManage : productBranchId !== undefined && productBranchId === apiBranchId && canManageBranch };
}

/** Compatibility for the shared category/library callers that need only operator scope. */
export async function readOperatorMenuCapability(api: AdminApi, actorId: string): Promise<boolean> {
  return (await readMenuCapabilities(api, actorId)).canManage;
}

/** Unbacked local prototypes keep their controls; live POS wrappers fail closed during reads. */
export function useOperatorMenuCapability(api: AdminApi, actorId: string | undefined, serverBacked: boolean, authorityVersion: unknown, apiBranchId?: string) {
  const [answer, setAnswer] = useState<{ actorId: string; version: unknown; branchId: string | undefined; value: MenuCapabilities; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!serverBacked || !actorId) return;
    let live = true;
    void readMenuCapabilities(api, actorId, apiBranchId).then(value => {
      if (live) setAnswer({ actorId, version: authorityVersion, branchId: apiBranchId, value });
    }).catch(() => {
      if (live) setAnswer({ actorId, version: authorityVersion, branchId: apiBranchId, value: refused, failed: true });
    });
    return () => { live = false; };
  }, [api, actorId, serverBacked, authorityVersion, apiBranchId]);
  if (!serverBacked) return { canManage: true, canManageBranch: true, canImport: true, canManageProduct: () => true, authorityMessage: undefined };
  if (!answer || answer.actorId !== actorId || answer.version !== authorityVersion || answer.branchId !== apiBranchId)
    return { ...refused, authorityMessage: 'Checking menu access\u2026' };
  return { ...answer.value, authorityMessage: answer.failed ? 'Menu access could not be checked. The menu is read-only.' : !answer.value.canManage ? 'Categories and modifier groups are shared by every park. Operator-wide access is needed to change them.' : undefined };
}
