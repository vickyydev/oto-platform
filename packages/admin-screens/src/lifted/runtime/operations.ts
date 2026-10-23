import type { Permission } from '@oto/shared/permissions';
import type { createStockAdminApi, inventoryItemToStockBody, stockErrorWords } from '../api/stock';
import type { createPlatformAdminApi } from '../api/platform';
import type { createWalletAdminApi } from '../api/wallet';
import type { AddOn, InventoryItem, MenuItem, MerchItem, Operator, StockLocation, TierDef } from '../model/types';
import type { AdminScreenRuntime } from './AdminScreenRuntime';

export interface OperationLifetime {
  /** One actor, authority and park snapshot; obsolete work cannot update a newer host. */
  isCurrent?: () => boolean;
}
type MembersApi = ReturnType<typeof createPlatformAdminApi>['membersApi'];
type StockApi = ReturnType<typeof createStockAdminApi>['stockApi'];

export interface MemberFormPorts extends OperationLifetime {
  getDefaultTier: () => TierDef | undefined;
  tierLabel: (id: string) => string;
  isDefaultTier: (id: string) => boolean;
  verifiedTiers: () => string[];
  operator: Pick<Operator, 'id' | 'name'> | null;
  can: (permission: Permission) => boolean;
}
export interface MembersPanelPorts extends MemberFormPorts {
  membersApi: MembersApi;
  toast: AdminScreenRuntime['toast'];
}
export interface TierVerificationsPorts extends OperationLifetime {
  membersApi: Pick<MembersApi, 'tierVerifications'>;
  tierLabel: (id: string) => string;
  toast: AdminScreenRuntime['toast'];
}
export interface WalletLookupPorts extends OperationLifetime {
  lookupWallet: ReturnType<typeof createWalletAdminApi>['lookupWallet'];
  reactivateWallet: ReturnType<typeof createWalletAdminApi>['reactivateWallet'];
  can: (permission: Permission) => boolean;
  toast: AdminScreenRuntime['toast'];
}
export interface StockLocationsPorts extends OperationLifetime {
  stockApi: Pick<StockApi, 'createLocation' | 'updateLocation' | 'setSellPoint'>;
  stockErrorWords: typeof stockErrorWords;
}
export interface InventoryPanelPorts extends StockLocationsPorts {
  branch: { id: string; apiId?: string } | null;
  stock: { inventory: InventoryItem[]; locations: StockLocation[]; error: string | null };
  merchItems: MerchItem[];
  addOns: AddOn[];
  menuItems: MenuItem[];
  catalogueReady?: boolean;
  stockApi: StockLocationsPorts['stockApi'] & Pick<StockApi, 'saveItem' | 'adjust'>;
  inventoryItemToStockBody: typeof inventoryItemToStockBody;
  catalogueSizesOf: (productId: string) => Array<{ id: string; label: string }>;
  reloadMenuInto: (branchId: string, slug: string) => Promise<void>;
}
