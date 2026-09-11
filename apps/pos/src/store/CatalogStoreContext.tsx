import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  subscribeCatalog,
  getCatalogSnapshot,
  type CatalogState,
  upsertTier,
  deleteTier,
  upsertTicketType,
  deleteTicketType,
  upsertAddOn,
  deleteAddOn,
  upsertMenuItem,
  deleteMenuItem,
  upsertMenuCategory,
  deleteMenuCategory,
  upsertMerchItem,
  deleteMerchItem,
  adjustMerchStock,
  upsertInventoryItem,
  deleteInventoryItem,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertDiscount,
  deleteDiscount,
  setDiscountReasons,
  upsertPaymentMethod,
  deletePaymentMethod,
  updateDropOffPricing,
  updateSupervisionPolicy,
  updateTaxConfig,
  upsertEdcTerminal,
  deleteEdcTerminal,
  upsertDevice,
  deleteDevice,
  upsertPrintTemplate,
  deletePrintTemplate,
  upsertPricingOverride,
  deletePricingOverride,
  setRoleBenefitTemplate,
  cloneBranchCatalog,
  branchHasCatalogData,
  upsertBranch,
  upsertStockLocation,
  setStockLocationSellPoint,
  transferStockBetweenLocations,
  replenishStockToLocation,
  commitStockTakeCorrection,
} from './catalogStore';

// Write-through to the platform API (Sprint 1): the wired collections
// (ticket packages, holidays, tax config, branches) persist to the DB, then
// re-hydrate the store. Optimistic local write first so the UI never waits;
// API errors surface as a toast and the reload restores server truth.
import {
  archiveTicketTypeInApi,
  deleteHolidayInApi,
  loadCatalogFromApi,
  saveBranchToApi,
  saveHolidayToApi,
  saveTaxConfigToApi,
  saveTicketTypeToApi,
} from '@/api/catalogBridge';
import { getActiveBranch, getCatalogSnapshot as snap, getTaxConfig } from '@/store/catalogStore';
import { toast } from '@/hooks/use-toast';

function apiFail(what: string) {
  return (err: unknown) => {
    toast({
      title: `Couldn't save ${what}`,
      description: err instanceof Error ? err.message : 'Unknown error',
      variant: 'destructive',
    });
    void loadCatalogFromApi(getActiveBranch().id); // restore server truth
  };
}

const wiredUpsertTicketType: typeof upsertTicketType = (t) => {
  const exists = snap().ticketTypes.some((x) => x.id === t.id);
  upsertTicketType(t);
  void saveTicketTypeToApi(getActiveBranch().id, t, exists).catch(apiFail('ticket'));
};
const wiredDeleteTicketType: typeof deleteTicketType = (id) => {
  deleteTicketType(id);
  void archiveTicketTypeInApi(getActiveBranch().id, id).catch(apiFail('ticket'));
};
const wiredUpsertPricingOverride: typeof upsertPricingOverride = (o) => {
  const exists = snap().pricingOverrides.some((x) => x.id === o.id);
  upsertPricingOverride(o);
  void saveHolidayToApi(getActiveBranch().id, o, exists).catch(apiFail('holiday'));
};
const wiredDeletePricingOverride: typeof deletePricingOverride = (id) => {
  deletePricingOverride(id);
  void deleteHolidayInApi(getActiveBranch().id, id).catch(apiFail('holiday'));
};
const wiredUpdateTaxConfig: typeof updateTaxConfig = (patch) => {
  updateTaxConfig(patch);
  void saveTaxConfigToApi(getActiveBranch().id, getTaxConfig()).catch(apiFail('tax settings'));
};
const wiredUpsertBranch: typeof upsertBranch = (branch) => {
  upsertBranch(branch);
  void saveBranchToApi(branch).catch(apiFail('branch'));
};

// The mutators are stable module-level functions; bundled here so Admin screens
// get the live snapshot + writers from a single hook.
const mutators = {
  upsertTier,
  deleteTier,
  upsertTicketType: wiredUpsertTicketType,
  deleteTicketType: wiredDeleteTicketType,
  upsertAddOn,
  deleteAddOn,
  upsertMenuItem,
  deleteMenuItem,
  upsertMenuCategory,
  deleteMenuCategory,
  upsertMerchItem,
  deleteMerchItem,
  adjustMerchStock,
  upsertInventoryItem,
  deleteInventoryItem,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertDiscount,
  deleteDiscount,
  setDiscountReasons,
  upsertPaymentMethod,
  deletePaymentMethod,
  updateDropOffPricing,
  updateSupervisionPolicy,
  updateTaxConfig: wiredUpdateTaxConfig,
  upsertEdcTerminal,
  deleteEdcTerminal,
  upsertDevice,
  deleteDevice,
  upsertPrintTemplate,
  deletePrintTemplate,
  upsertPricingOverride: wiredUpsertPricingOverride,
  deletePricingOverride: wiredDeletePricingOverride,
  setRoleBenefitTemplate,
  // Branch management
  cloneBranchCatalog,
  branchHasCatalogData,
  upsertBranch: wiredUpsertBranch,
  // Stock management
  upsertStockLocation,
  setStockLocationSellPoint,
  transferStockBetweenLocations,
  replenishStockToLocation,
  commitStockTakeCorrection,
};

export interface CatalogStoreValue extends CatalogState {
  mutators: typeof mutators;
}

const CatalogStoreContext = createContext<CatalogStoreValue | null>(null);

/**
 * App-wide provider for the editable catalog store. Subscribes to the module
 * store via useSyncExternalStore so any consumer re-renders when Admin mutates
 * a collection. The POS reads the same store through mockApi.ts getters.
 */
export function CatalogStoreProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribeCatalog, getCatalogSnapshot);
  const value = useMemo<CatalogStoreValue>(
    () => ({ ...snapshot, mutators }),
    [snapshot]
  );
  return (
    <CatalogStoreContext.Provider value={value}>
      {children}
    </CatalogStoreContext.Provider>
  );
}

export function useCatalogStore(): CatalogStoreValue {
  const ctx = useContext(CatalogStoreContext);
  if (!ctx) {
    throw new Error('useCatalogStore must be used within a CatalogStoreProvider');
  }
  return ctx;
}
