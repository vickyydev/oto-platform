import { useEffect, useRef, useState } from 'react';
import type { AdminApi } from '../../api/admin-api';
import type { createBenefitsAdminApi, StaffBenefitRow } from '../api/benefits';
import type { MenuHelpers } from '../lib/menu';
import type { BenefitProfile, MenuCategoryDef } from '../model/types';
import type { MenuToast } from './menu';

export type BenefitsApi = ReturnType<typeof createBenefitsAdminApi>;
export type BenefitMenu = Pick<MenuHelpers, 'topLevelCategories' | 'subCategoriesOf'>;
export interface BenefitProfileFieldsPorts { menu: BenefitMenu }
export interface BenefitDialogPorts extends BenefitProfileFieldsPorts {
  contextKey: string;
  api: BenefitsApi;
  summarizeProfile: (profile: BenefitProfile) => string;
  toast: MenuToast;
}
export interface StaffBenefitsPanelPorts extends BenefitDialogPorts {
  categories: MenuCategoryDef[];
  canManage: boolean;
  canIssueQr: (staff: StaffBenefitRow) => boolean;
}
export interface BenefitQrDialogPorts { contextKey: string; api: BenefitsApi }

/** Returning to the same person/context cannot revive an earlier request. */
export function useBenefitIdentity(key: string): string {
  const identity = useRef({ key, version: 0 });
  if (identity.current.key !== key) identity.current = { key, version: identity.current.version + 1 };
  return key + '|' + identity.current.version;
}

const refused = { canManage: false, canIssueQr: (_staff: StaffBenefitRow) => false, contextKey: 'unverified' };
/** POS wrappers use the same exact targets as the Console host and API. */
export async function readBenefitsCapabilities(api: AdminApi, actorId: string) {
  const [me, answer] = await Promise.all([api.get('/me'), api.get('/me/permissions')]);
  if (typeof me !== 'object' || me === null || !('account' in me) || typeof me.account !== 'object' || me.account === null ||
    !('id' in me.account) || me.account.id !== actorId || !('operatorId' in me.account) || typeof me.account.operatorId !== 'string' ||
    typeof answer !== 'object' || answer === null || !('permissions' in answer) || !Array.isArray(answer.permissions)) return refused;
  const operatorId = me.account.operatorId, permissions: unknown[] = answer.permissions;
  const held = (permission: string, branchId?: string) => permissions.some(row => typeof row === 'object' && row !== null &&
    'permission' in row && row.permission === permission && 'scopeType' in row && 'scopeId' in row && (
      row.scopeType === 'operator' && (row.scopeId === null || row.scopeId === operatorId) ||
      branchId !== undefined && row.scopeType === 'branch' && row.scopeId === branchId
    ));
  return {
    canManage: held('admin:benefit:manage'),
    canIssueQr: (staff: StaffBenefitRow) => held('admin:benefit:credential_issue', staff.branchId ?? undefined),
    contextKey: actorId + '|' + operatorId + '|' + JSON.stringify(permissions),
  };
}
export function useBenefitsCapabilities(api: AdminApi, actorId: string | undefined, authority: unknown, branchId?: string) {
  const [answer, setAnswer] = useState<{ actorId: string; authority: unknown; branchId?: string; value: typeof refused } | null>(null);
  useEffect(() => {
    if (!actorId) return;
    let live = true;
    void readBenefitsCapabilities(api, actorId).then(value => {
      if (live) setAnswer({ actorId, authority, branchId, value });
    }).catch(() => { if (live) setAnswer({ actorId, authority, branchId, value: refused }); });
    return () => { live = false; };
  }, [api, actorId, authority, branchId]);
  return answer !== null && answer.actorId === actorId && answer.authority === authority && answer.branchId === branchId
    ? answer.value : { ...refused, contextKey: (actorId ?? '') + '|' + (branchId ?? '') + '|unverified' };
}
