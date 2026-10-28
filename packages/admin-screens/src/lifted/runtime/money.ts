import type { ApiResponse } from '@oto/api-types';
import { useEffect, useState } from 'react';
import type { AdminApi } from '../../api/admin-api';
import type { EventDropInPricing } from '@oto/shared';
import type { ApiMenuCategory } from '../api/menu';
import type { VoucherCampaignRow, VoucherDefinitionRow, VoucherPromoPatch } from '../api/voucherPromotions';
import type { CartWireHelpers } from '../lib/cartWire';
import type { DiscountTargetHelpers } from '../lib/discountTarget';
import type { PaymentsHelpers } from '../lib/payments';
import type { AddOn, Discount, DiscountTarget, MenuCategoryDef, MenuItem, MerchItem, PaymentMethod, TaxConfig, TicketType } from '../model/types';
import type { CatalogueMutation, CataloguePriceFormatter } from './catalogue';
import type { MenuToast } from './menu';

export interface MoneyAuthorityPorts {
  canManage?: boolean;
  authorityMessage?: string;
}

export interface DiscountTargetOptions {
  ticketTypes: TicketType[];
  addOns: AddOn[];
  menuItems: MenuItem[];
  menuCategories: MenuCategoryDef[];
}

export interface DiscountTargetPickerPorts extends DiscountTargetOptions {
  formatWWPrice: CataloguePriceFormatter;
}

export interface DiscountTargetPickerProps {
  value: DiscountTarget;
  onChange: (target: DiscountTarget) => void;
}

export interface DiscountCodesSectionPorts extends MoneyAuthorityPorts {
  discounts: Discount[];
  menuItems: MenuItem[];
  merchItems: MerchItem[];
  targetOptions: DiscountTargetOptions;
  formatWWPrice: CataloguePriceFormatter;
  formatDiscountTargetLabel: DiscountTargetHelpers['formatDiscountTargetLabel'];
  canEditDiscount?: (discount: Discount) => boolean;
  upsertDiscount: (discount: Discount, originalCode?: string) => void | Promise<void>;
  deleteDiscount: CatalogueMutation<string>;
}

/** Manual reasons remain the original tab-local prototype. */
export interface DiscountReasonsSectionPorts {
  discountReasons: string[];
  setDiscountReasons: (reasons: string[]) => void;
}

export interface PaymentMethodsSectionPorts extends MoneyAuthorityPorts {
  paymentMethods: PaymentMethod[];
  normalizePaymentMethod: PaymentsHelpers['normalizePaymentMethod'];
  paymentMethodIcon: PaymentsHelpers['paymentMethodIcon'];
  paymentMethodUsage: (id: string) => number;
  upsertPaymentMethod: CatalogueMutation<PaymentMethod>;
  deletePaymentMethod: CatalogueMutation<string>;
  movePaymentMethod: (id: string, direction: 'up' | 'down') => void | Promise<void>;
}

export interface TaxPanelPorts extends MoneyAuthorityPorts {
  taxConfig: TaxConfig;
  taxEngine: Pick<CartWireHelpers, 'toSatang' | 'breakdownToBaht'> & {
    engineTaxConfig: (config: TaxConfig) => ReturnType<CartWireHelpers['engineTaxConfig']>;
  };
  updateTaxConfig: CatalogueMutation<TaxConfig>;
  /** A read only recovery check; hosts without it must require reopening the page. */
  readCurrent?: () => Promise<TaxConfig | null>;
}

export interface EventsPanelPorts extends MoneyAuthorityPorts {
  pricing: EventDropInPricing | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  savePricing: (pricing: EventDropInPricing) => Promise<EventDropInPricing>;
}

export type VoucherLinkOptions = ApiResponse<'/voucher-definitions/link-options', 'get'>;
export interface VoucherCampaignInput {
  definitionId: string;
  branchId: string;
  name: string;
  quantity: number;
}

export interface VoucherPromotionsPanelPorts {
  definitions: VoucherDefinitionRow[];
  campaigns: VoucherCampaignRow[];
  links: VoucherLinkOptions;
  categories: Pick<ApiMenuCategory, 'id' | 'name'>[];
  branches: { id: string; name: string; apiId?: string }[];
  loadError?: string | null;
  loading?: boolean;
  onRetry?: () => void;
  saveRules: (id: string, patch: VoucherPromoPatch) => Promise<void>;
  mintCampaign: (input: VoucherCampaignInput, idempotencyKey?: string) => Promise<void>;
  codesHref: (campaignId: string) => string;
  toast: MenuToast;
  canManageRules: boolean;
  canMintCampaign: (branchId: string) => boolean;
  canDownloadCodes: (campaign: VoucherCampaignRow) => boolean;
  authorityMessage?: string;
}

export interface MoneyCapabilities {
  canManageDiscounts: boolean;
  canManageTenders: boolean;
  canManageTax: boolean;
  canManageEvents: boolean;
  canManageRules: boolean;
  canMintCampaign: (branchId: string) => boolean;
  canDownloadCodes: (campaign: Pick<VoucherCampaignRow, 'branchId'>) => boolean;
}

const refused: MoneyCapabilities = {
  canManageDiscounts: false, canManageTenders: false, canManageTax: false, canManageEvents: false,
  canManageRules: false, canMintCampaign: () => false, canDownloadCodes: () => false,
};

/** Global lists and park actions retain the server's distinct scope targets. */
export async function readMoneyCapabilities(api: AdminApi, actorId: string, branchId?: string): Promise<MoneyCapabilities> {
  const [me, answer] = await Promise.all([api.get('/me'), api.get('/me/permissions')]);
  if (typeof me !== 'object' || me === null || !('account' in me) || typeof me.account !== 'object' || me.account === null ||
    !('id' in me.account) || me.account.id !== actorId || !('operatorId' in me.account) || typeof me.account.operatorId !== 'string' ||
    typeof answer !== 'object' || answer === null || !('permissions' in answer) || !Array.isArray(answer.permissions)) return refused;
  const operatorId = me.account.operatorId;
  const permissions: unknown[] = answer.permissions;
  const held = (permission: string, target?: string) => permissions.some(row =>
    typeof row === 'object' && row !== null && 'permission' in row && row.permission === permission && 'scopeType' in row && 'scopeId' in row && (
      row.scopeType === 'operator' && (row.scopeId === null || row.scopeId === operatorId) ||
      target !== undefined && row.scopeType === 'branch' && row.scopeId === target
    ));
  const canMintCampaign = (target: string) => Boolean(target) && held('admin:booth:manage', target);
  return {
    canManageDiscounts: held('catalog:menu:manage'), canManageTenders: held('catalog:menu:manage'),
    canManageTax: Boolean(branchId) && held('catalog:tax:manage', branchId),
    canManageEvents: Boolean(branchId) && held('admin:event_pricing:manage', branchId),
    canManageRules: held('admin:booth:manage'), canMintCampaign,
    canDownloadCodes: campaign => canMintCampaign(campaign.branchId),
  };
}

/** Only server-backed POS wrappers fetch authority; local prototype controls stay native. */
export function useMoneyCapabilities(api: AdminApi, actorId: string | undefined, serverBacked: boolean, authorityVersion: unknown, branchId?: string) {
  const [answer, setAnswer] = useState<{ actorId: string; version: unknown; branchId: string | undefined; value: MoneyCapabilities; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!serverBacked || !actorId) return;
    let live = true;
    void readMoneyCapabilities(api, actorId, branchId).then(value => {
      if (live) setAnswer({ actorId, version: authorityVersion, branchId, value });
    }).catch(() => {
      if (live) setAnswer({ actorId, version: authorityVersion, branchId, value: refused, failed: true });
    });
    return () => { live = false; };
  }, [api, actorId, serverBacked, authorityVersion, branchId]);
  if (!serverBacked) return {
    canManageDiscounts: true, canManageTenders: true, canManageTax: true, canManageEvents: true,
    canManageRules: true, canMintCampaign: () => true, canDownloadCodes: () => true, authorityMessage: undefined,
  };
  if (!answer || answer.actorId !== actorId || answer.version !== authorityVersion || answer.branchId !== branchId)
    return { ...refused, authorityMessage: 'Checking money settings access\u2026' };
  return { ...answer.value, authorityMessage: answer.failed ? 'Money settings access could not be checked. The settings are read-only.' : undefined };
}
