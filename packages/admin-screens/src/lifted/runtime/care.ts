import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { DropOffPricingConfig } from '@oto/shared';
import type { AdminApi } from '../../api/admin-api';
import type { PricingBody } from '../api/checkin';
import type { createPlatformAdminApi } from '../api/platform';
import type { DropOffPricing, PrintTemplate, SupervisionPolicy } from '../model/types';

export interface CarePanelState {
  connected: boolean;
  canManage?: boolean;
  contextKey?: unknown;
  authorityMessage?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}
export interface DropOffPricingPanelPorts extends CarePanelState {
  pricing: DropOffPricing;
  savePricing: (body: PricingBody) => Promise<DropOffPricingConfig>;
  adjacentSections?: ReactNode;
}
export interface SupervisionPanelPorts extends CarePanelState {
  policy: SupervisionPolicy;
  onDraftChange?: (next: SupervisionPolicy) => void;
  savePolicy: (next: SupervisionPolicy, isCurrent?: () => boolean) => Promise<SupervisionPolicy>;
}

type PlatformApi = ReturnType<typeof createPlatformAdminApi>;
export type CareTemplateApi = Pick<PlatformApi['printApi'], 'updateTemplate' | 'testPrint'> &
  Pick<PlatformApi['templatesApi'], 'previewPng' | 'testPrintTarget'>;
export type TemplatePreviewPorts = Pick<CareTemplateApi, 'previewPng'>;
export interface TemplateEditorPorts {
  api: CareTemplateApi;
  stationId: string | null;
  canEdit?: boolean;
  canTestPrint?: boolean;
  authorityMessage?: string;
  updateLocalTemplate?: (next: PrintTemplate) => void;
}
export interface TemplatesPanelPorts extends TemplateEditorPorts {
  templates: PrintTemplate[];
  live: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSaved?: () => void | Promise<void>;
  askedType?: string | null;
  onAddressClose?: () => void;
}

export interface CareCapabilities {
  canReadCare: boolean;
  canManageCare: boolean;
  canReadTemplates: boolean;
  canEditTemplates: boolean;
  canTestPrint: boolean;
}
const refused: CareCapabilities = {
  canReadCare: false, canManageCare: false, canReadTemplates: false, canEditTemplates: false, canTestPrint: false,
};

/** Reads, configuration edits and print commands retain their distinct park targets. */
export async function readCareCapabilities(api: AdminApi, actorId: string, branchId?: string): Promise<CareCapabilities> {
  const [me, answer] = await Promise.all([api.get('/me'), api.get('/me/permissions')]);
  if (typeof me !== 'object' || me === null || !('account' in me) || typeof me.account !== 'object' || me.account === null ||
    !('id' in me.account) || me.account.id !== actorId || !('operatorId' in me.account) || typeof me.account.operatorId !== 'string' ||
    typeof answer !== 'object' || answer === null || !('permissions' in answer) || !Array.isArray(answer.permissions) || !branchId) return refused;
  const operatorId = me.account.operatorId;
  const permissions: unknown[] = answer.permissions;
  const held = (permission: string) => permissions.some(row =>
    typeof row === 'object' && row !== null && 'permission' in row && row.permission === permission && 'scopeType' in row && 'scopeId' in row && (
      row.scopeType === 'operator' && (row.scopeId === null || row.scopeId === operatorId) ||
      row.scopeType === 'branch' && row.scopeId === branchId
    ));
  return {
    canReadCare: held('pos:checkin:read'), canManageCare: held('catalog:package:update'),
    canReadTemplates: held('pos:print:read'), canEditTemplates: held('admin:branch:update'), canTestPrint: held('admin:box:command'),
  };
}

/** POS prototype state remains local; live wrappers wait for canonical authority. */
export function useCareCapabilities(api: AdminApi | undefined, actorId: string | undefined, serverBacked: boolean, authorityVersion: unknown, branchId?: string) {
  const [answer, setAnswer] = useState<{ actorId: string; version: unknown; branchId: string | undefined; value: CareCapabilities; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!serverBacked || !actorId || !api) return;
    let live = true;
    void readCareCapabilities(api, actorId, branchId).then(value => {
      if (live) setAnswer({ actorId, version: authorityVersion, branchId, value });
    }).catch(() => {
      if (live) setAnswer({ actorId, version: authorityVersion, branchId, value: refused, failed: true });
    });
    return () => { live = false; };
  }, [api, actorId, serverBacked, authorityVersion, branchId]);
  if (!serverBacked) return {
    canReadCare: true, canManageCare: true, canReadTemplates: true, canEditTemplates: true, canTestPrint: false, authorityMessage: undefined,
  };
  if (!answer || answer.actorId !== actorId || answer.version !== authorityVersion || answer.branchId !== branchId)
    return { ...refused, authorityMessage: 'Checking care and print access\u2026' };
  return { ...answer.value, authorityMessage: answer.failed ? 'Care and print access could not be checked. The settings are read-only.' : undefined };
}
