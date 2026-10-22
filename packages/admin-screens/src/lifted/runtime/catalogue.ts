import { useEffect, useState } from 'react';
import type { AdminApi } from '../../api/admin-api';
import type { TicketPricingHelpers } from '../components/admin/tickets/ticketPricing';
import type { AddOn, InventoryItem, TicketType, TierDef, WeekdayWeekendPrice } from '../model/types';

export type CatalogueMutation<T> = (value: T) => void | Promise<void>;
export type CataloguePriceFormatter = (price: WeekdayWeekendPrice | undefined) => string;

export interface TicketTypeFormPorts {
  tiers: TierDef[];
  defaultTier: TierDef | undefined;
  ticketPricing: TicketPricingHelpers;
  tierLabel: (id: string) => string;
}
export interface TicketsPanelPorts extends TicketTypeFormPorts {
  ticketTypes: TicketType[];
  addOns: AddOn[];
  formatWWPrice: CataloguePriceFormatter;
  isDefaultTier: (id: string) => boolean;
  upsertTicketType: CatalogueMutation<TicketType>;
  deleteTicketType: CatalogueMutation<string>;
  canCreate?: boolean;
  canUpdate?: boolean;
}
export interface TiersPanelPorts {
  tiers: TierDef[];
  ticketTypes: TicketType[];
  countTierUsage: (id: string) => number;
  isTierPriced: (ticket: TicketType, id: string) => boolean;
  upsertTier: CatalogueMutation<TierDef>;
  deleteTier: CatalogueMutation<string>;
  canCreate?: boolean;
  canUpdate?: boolean;
  authorityMessage?: string;
}
export interface AddOnsPanelPorts {
  addOns: AddOn[];
  formatWWPrice: CataloguePriceFormatter;
  upsertAddOn: CatalogueMutation<AddOn>;
  deleteAddOn: CatalogueMutation<string>;
  upsertInventoryItem: CatalogueMutation<InventoryItem>;
  deleteInventoryItem: CatalogueMutation<string>;
  canManage?: boolean;
  canManageAddOn?: (addOn: AddOn) => boolean;
}

export interface OperatorTierCapabilities { canCreate: boolean; canUpdate: boolean }

/** Scope is read from the canonical account, never inferred from a POS role label. */
export async function readOperatorTierCapabilities(api: AdminApi, actorId: string): Promise<OperatorTierCapabilities> {
  const [me, answer] = await Promise.all([
    api.get('/me'),
    api.get('/me/permissions'),
  ]);
  if (typeof me !== 'object' || me === null || !('account' in me) || typeof me.account !== 'object' || me.account === null ||
    !('id' in me.account) || me.account.id !== actorId || !('operatorId' in me.account) || typeof me.account.operatorId !== 'string' ||
    typeof answer !== 'object' || answer === null || !('permissions' in answer) || !Array.isArray(answer.permissions))
    return { canCreate: false, canUpdate: false };
  const operatorId = me.account.operatorId;
  const permissions: unknown[] = answer.permissions;
  const held = (permission: string) => permissions.some((row: unknown) =>
    typeof row === 'object' && row !== null && 'permission' in row && row.permission === permission &&
    'scopeType' in row && row.scopeType === 'operator' && 'scopeId' in row &&
    (row.scopeId === null || row.scopeId === operatorId));
  return { canCreate: held('catalog:package:create'), canUpdate: held('catalog:package:update') };
}

/** The temporary POS wrapper retains its local prototype and checks scoped live offers. */
export function useOperatorTierCapabilities(api: AdminApi, actorId: string | undefined, serverBacked: boolean, authorityVersion: unknown) {
  const [answer, setAnswer] = useState<{ actorId: string; version: unknown; value: OperatorTierCapabilities; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!serverBacked || !actorId) return;
    let live = true;
    void readOperatorTierCapabilities(api, actorId).then(value => {
      if (live) setAnswer({ actorId, version: authorityVersion, value });
    }).catch(() => {
      if (live) setAnswer({ actorId, version: authorityVersion, value: { canCreate: false, canUpdate: false }, failed: true });
    });
    return () => { live = false; };
  }, [api, actorId, serverBacked, authorityVersion]);
  if (!serverBacked) return { canCreate: true, canUpdate: true, authorityMessage: undefined };
  if (!answer || answer.actorId !== actorId || answer.version !== authorityVersion)
    return { canCreate: false, canUpdate: false, authorityMessage: 'Checking operator-wide tier access…' };
  return { ...answer.value, authorityMessage: answer.failed ? 'Operator-wide tier access could not be checked. Tiers are read-only.' : !answer.value.canCreate && !answer.value.canUpdate ? 'Customer tiers are shared by every park. Operator-wide access is needed to change them.' : undefined };
}
