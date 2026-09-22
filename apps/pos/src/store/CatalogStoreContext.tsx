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
  deleteTierInApi,
  loadCatalogFromApi,
  saveBranchToApi,
  saveHolidayToApi,
  saveTaxConfigToApi,
  saveTicketTypeToApi,
  saveTierToApi,
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
const wiredUpsertTier: typeof upsertTier = (t) => {
  const exists = snap().tiers.some((x) => x.id === t.id);
  upsertTier(t);
  void saveTierToApi(t, exists).catch(apiFail('tier'));
};
const wiredDeleteTier: typeof deleteTier = (id) => {
  deleteTier(id);
  void deleteTierInApi(id).catch(apiFail('tier'));
};
const wiredUpsertBranch: typeof upsertBranch = (branch) => {
  upsertBranch(branch);
  void saveBranchToApi(branch).catch(apiFail('branch'));
};

// The mutators are stable module-level functions; bundled here so Admin screens
// get the live snapshot + writers from a single hook. The bundle is assembled
// from three named groups and nothing else, so a mutator cannot join it without
// its author saying which kind it is (SCRUM-236).

/** Writes reach the database and survive a reload. */
const wiredMutators = {
  upsertTier: wiredUpsertTier,
  deleteTier: wiredDeleteTier,
  upsertTicketType: wiredUpsertTicketType,
  deleteTicketType: wiredDeleteTicketType,
  updateTaxConfig: wiredUpdateTaxConfig,
  upsertPricingOverride: wiredUpsertPricingOverride,
  deletePricingOverride: wiredDeletePricingOverride,
  upsertBranch: wiredUpsertBranch,
};

/** Reads in-memory catalogue state; writes nothing, so nothing to persist. */
const readOnlyHelpers = {
  branchHasCatalogData,
};

/**
 * Mutators that write to the in-memory store only: the edit lands on screen and
 * is gone on reload. Each is listed against the ticket that owns making it
 * real, and `NotSavedNotice` renders that ticket on the panel that calls it, so
 * no such screen can look like it saved.
 *
 * Wiring one means deleting its entry here; `MockMutatorName` then stops
 * accepting it and the compiler points at every notice that has to change with
 * it. Adding a mutator to the bundle without choosing a group is a type error.
 */
export const MOCK_MUTATOR_TICKETS = {
  // Add-ons and discount/promo definitions have no table and no route.
  upsertAddOn: 'SCRUM-230',
  deleteAddOn: 'SCRUM-230',
  upsertDiscount: 'SCRUM-230',
  deleteDiscount: 'SCRUM-230',
  setDiscountReasons: 'SCRUM-230',
  // The product schema reshape has landed, so these are no longer waiting on a
  // table: `product`, `product_category`, `modifier_group` and `modifier_option`
  // hold the weekday/weekend pair, cost, modifiers and translations, the menu on
  // screen is READ from them (`api/catalogBridge.ts:loadMenuFromApi`), and the
  // menu panel's Import WRITES to them. What is left of SCRUM-232 is the
  // write-through for these editors — one form saving an item is still a change
  // to this tab and nothing else.
  upsertMenuItem: 'SCRUM-232',
  deleteMenuItem: 'SCRUM-232',
  upsertMenuCategory: 'SCRUM-232',
  deleteMenuCategory: 'SCRUM-232',
  upsertModifierGroup: 'SCRUM-232',
  deleteModifierGroup: 'SCRUM-232',
  // The shop is the same three tables with `kind = 'merch'`, and rows are
  // seeded there — but nothing reads or writes them through the API yet:
  // `mapMenu` keeps only `kind === 'menu'`, so every merch item on screen comes
  // from the ported mock. That is the shop half of SCRUM-204.
  upsertMerchItem: 'SCRUM-204',
  deleteMerchItem: 'SCRUM-204',
  adjustMerchStock: 'SCRUM-204',
  // Stock tables exist and nothing in the API reads or writes them yet.
  upsertInventoryItem: 'SCRUM-204',
  deleteInventoryItem: 'SCRUM-204',
  upsertStockLocation: 'SCRUM-204',
  setStockLocationSellPoint: 'SCRUM-204',
  transferStockBetweenLocations: 'SCRUM-204',
  replenishStockToLocation: 'SCRUM-204',
  commitStockTakeCorrection: 'SCRUM-204',
  // No tender of any kind is recorded yet, so a method list has nowhere to go.
  upsertPaymentMethod: 'SCRUM-206',
  deletePaymentMethod: 'SCRUM-206',
  // Supervision policy and its drop-off / nanny prices.
  updateDropOffPricing: 'SCRUM-210',
  updateSupervisionPolicy: 'SCRUM-210',
  // Per-role staff benefit templates.
  setRoleBenefitTemplate: 'SCRUM-218',
  // The POS's own device list is not the fleet: the real one is the Console's
  // Devices area and each till's Station Setup, both already writable.
  upsertDevice: 'SCRUM-236',
  deleteDevice: 'SCRUM-236',
  upsertEdcTerminal: 'SCRUM-236',
  deleteEdcTerminal: 'SCRUM-236',
  // Print templates DO persist through `printApi` when the row came from the
  // platform; these two are the built-in fallback for rows that did not, which
  // the editor reaches only when its `live` prop is false.
  upsertPrintTemplate: 'SCRUM-236',
  deletePrintTemplate: 'SCRUM-236',
  // Copying one branch's catalogue onto another is an in-memory convenience.
  cloneBranchCatalog: 'SCRUM-240',
} as const;

export type MockMutatorName = keyof typeof MOCK_MUTATOR_TICKETS;

const mockMutators = {
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
  upsertEdcTerminal,
  deleteEdcTerminal,
  upsertDevice,
  deleteDevice,
  upsertPrintTemplate,
  deletePrintTemplate,
  setRoleBenefitTemplate,
  cloneBranchCatalog,
  upsertStockLocation,
  setStockLocationSellPoint,
  transferStockBetweenLocations,
  replenishStockToLocation,
  commitStockTakeCorrection,
  // Every key here must appear in MOCK_MUTATOR_TICKETS and every ticket there
  // must have its mutator here — a missing entry on either side fails the build.
} satisfies Record<MockMutatorName, unknown>;

const mutators = { ...wiredMutators, ...readOnlyHelpers, ...mockMutators };

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
