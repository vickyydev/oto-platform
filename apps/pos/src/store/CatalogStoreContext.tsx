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
  apiBranchIdForSlug,
  archiveTicketTypeInApi,
  deleteHolidayInApi,
  deletePaymentMethodInApi,
  deleteTierInApi,
  loadCatalogFromApi,
  movePaymentMethodInApi,
  saveBranchToApi,
  saveHolidayToApi,
  savePaymentMethodToApi,
  saveTaxConfigToApi,
  saveTicketTypeToApi,
  saveTierToApi,
} from '@/api/catalogBridge';
import {
  archiveAddOnInApi,
  archiveDiscountInApi,
  archiveMenuCategoryInApi,
  archiveMenuItemInApi,
  archiveMerchItemInApi,
  archiveModifierGroupInApi,
  saveAddOnToApi,
  saveDiscountToApi,
  saveMenuCategoryToApi,
  saveMenuItemToApi,
  saveMerchItemToApi,
  saveModifierGroupToApi,
} from '@/api/menu';
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

/**
 * The tenders (SCRUM-206). Operator-wide, like the tiers: no branch is resolved
 * and no edit stays in the tab.
 */
const wiredUpsertPaymentMethod: typeof upsertPaymentMethod = (m) => {
  const exists = snap().paymentMethods.some((x) => x.id === m.id);
  upsertPaymentMethod(m);
  void savePaymentMethodToApi(m, exists).catch(apiFail('payment method'));
};
const wiredDeletePaymentMethod: typeof deletePaymentMethod = (id) => {
  deletePaymentMethod(id);
  void deletePaymentMethodInApi(id).catch(apiFail('payment method'));
};

/**
 * Move a tender one place up or down the checkout order.
 *
 * The local half is the prototype's own gesture — a swap of two `sortOrder`s
 * (`PaymentMethodsSection.tsx:69-77`) — so the row moves under the finger. The
 * platform half is ONE request that does the same swap in one transaction,
 * rather than the two writes the swap would otherwise become.
 */
const wiredMovePaymentMethod = (code: string, direction: 'up' | 'down'): void => {
  const sorted = [...snap().paymentMethods].sort((x, y) => x.sortOrder - y.sortOrder);
  const at = sorted.findIndex((m) => m.id === code);
  const to = at + (direction === 'up' ? -1 : 1);
  const moving = sorted[at];
  const neighbour = sorted[to];
  if (!moving || !neighbour) return;
  upsertPaymentMethod({ ...moving, sortOrder: neighbour.sortOrder });
  upsertPaymentMethod({ ...neighbour, sortOrder: moving.sortOrder });
  void movePaymentMethodInApi(code, direction).catch(apiFail('the checkout order'));
};

/**
 * The catalogue panels (SCRUM-204, and the F&B item and category forms in
 * SCRUM-341).
 *
 * An item is BRANCH-owned and a category, a modifier group and a discount code
 * are operator-wide, but every write-through takes the branch: the menu is read
 * back per branch afterwards, so an operator-wide edit still needs to know
 * which park's screen to refresh.
 *
 * `branchNow()` resolves the platform id for the branch that is open. A branch
 * the platform does not know is a mock-only branch — the demo's second park,
 * before it is created — and there the edit stays in the tab, exactly as the
 * ticket and holiday editors already behave.
 */
function branchNow(): { id: string; slug: string } | null {
  const slug = getActiveBranch().id;
  const id = apiBranchIdForSlug(slug);
  return id ? { id, slug } : null;
}

const wiredUpsertMenuItem: typeof upsertMenuItem = (item) => {
  const exists = snap().menuItems.some((x) => x.id === item.id);
  upsertMenuItem(item);
  const branch = branchNow();
  if (!branch) return;
  void saveMenuItemToApi(branch.id, branch.slug, item, exists).catch(apiFail('menu item'));
};
const wiredDeleteMenuItem: typeof deleteMenuItem = (id) => {
  deleteMenuItem(id);
  const branch = branchNow();
  if (!branch) return;
  void archiveMenuItemInApi(branch.id, branch.slug, id).catch(apiFail('menu item'));
};
const wiredUpsertMenuCategory: typeof upsertMenuCategory = (category) => {
  const exists = snap().menuCategories.some((x) => x.id === category.id);
  upsertMenuCategory(category);
  const branch = branchNow();
  if (!branch) return;
  void saveMenuCategoryToApi(branch.id, branch.slug, category, exists).catch(apiFail('category'));
};
const wiredDeleteMenuCategory: typeof deleteMenuCategory = (id) => {
  deleteMenuCategory(id);
  const branch = branchNow();
  if (!branch) return;
  void archiveMenuCategoryInApi(branch.id, branch.slug, id).catch(apiFail('category'));
};
const wiredUpsertMerchItem: typeof upsertMerchItem = (item) => {
  const exists = snap().merchItems.some((x) => x.id === item.id);
  upsertMerchItem(item);
  const branch = branchNow();
  if (!branch) return;
  void saveMerchItemToApi(branch.id, branch.slug, item, exists).catch(apiFail('retail item'));
};
const wiredDeleteMerchItem: typeof deleteMerchItem = (id) => {
  deleteMerchItem(id);
  const branch = branchNow();
  if (!branch) return;
  void archiveMerchItemInApi(branch.id, branch.slug, id).catch(apiFail('retail item'));
};
const wiredUpsertAddOn: typeof upsertAddOn = (addOn) => {
  const exists = snap().addOns.some((x) => x.id === addOn.id);
  upsertAddOn(addOn);
  const branch = branchNow();
  if (!branch) return;
  void saveAddOnToApi(branch.id, branch.slug, addOn, exists).catch(apiFail('add-on'));
};
const wiredDeleteAddOn: typeof deleteAddOn = (id) => {
  deleteAddOn(id);
  const branch = branchNow();
  if (!branch) return;
  void archiveAddOnInApi(branch.id, branch.slug, id).catch(apiFail('add-on'));
};
const wiredUpsertModifierGroup: typeof upsertModifierGroup = (group) => {
  const exists = snap().modifierGroups.some((x) => x.id === group.id);
  upsertModifierGroup(group);
  const branch = branchNow();
  if (!branch) return;
  void saveModifierGroupToApi(branch.id, branch.slug, group, exists).catch(
    apiFail('modifier group'),
  );
};
const wiredDeleteModifierGroup: typeof deleteModifierGroup = (id) => {
  deleteModifierGroup(id);
  const branch = branchNow();
  if (!branch) return;
  void archiveModifierGroupInApi(branch.id, branch.slug, id).catch(apiFail('modifier group'));
};
const wiredUpsertDiscount: typeof upsertDiscount = (discount) => {
  upsertDiscount(discount);
  const branch = branchNow();
  if (!branch) return;
  void saveDiscountToApi(branch.id, branch.slug, discount).catch(apiFail('discount code'));
};
const wiredDeleteDiscount: typeof deleteDiscount = (code) => {
  deleteDiscount(code);
  const branch = branchNow();
  if (!branch) return;
  void archiveDiscountInApi(branch.id, branch.slug, code).catch(apiFail('discount code'));
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
  upsertMenuItem: wiredUpsertMenuItem,
  deleteMenuItem: wiredDeleteMenuItem,
  upsertMenuCategory: wiredUpsertMenuCategory,
  deleteMenuCategory: wiredDeleteMenuCategory,
  upsertMerchItem: wiredUpsertMerchItem,
  deleteMerchItem: wiredDeleteMerchItem,
  upsertAddOn: wiredUpsertAddOn,
  deleteAddOn: wiredDeleteAddOn,
  upsertModifierGroup: wiredUpsertModifierGroup,
  deleteModifierGroup: wiredDeleteModifierGroup,
  upsertDiscount: wiredUpsertDiscount,
  deleteDiscount: wiredDeleteDiscount,
  upsertPaymentMethod: wiredUpsertPaymentMethod,
  deletePaymentMethod: wiredDeletePaymentMethod,
  movePaymentMethod: wiredMovePaymentMethod,
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
  // A discount REASON is the free-text list beside the codes and has no table:
  // the codes themselves are `discount_definition` rows and now write through.
  setDiscountReasons: 'SCRUM-230',
  // Stock is the half of the catalogue that has tables and no routes: an item,
  // its price and its barcode persist, and what is on the shelf does not.
  adjustMerchStock: 'SCRUM-204',
  upsertInventoryItem: 'SCRUM-204',
  deleteInventoryItem: 'SCRUM-204',
  upsertStockLocation: 'SCRUM-204',
  setStockLocationSellPoint: 'SCRUM-204',
  transferStockBetweenLocations: 'SCRUM-204',
  replenishStockToLocation: 'SCRUM-204',
  commitStockTakeCorrection: 'SCRUM-204',
  // Supervision policy and its drop-off / nanny prices.
  updateDropOffPricing: 'SCRUM-210',
  updateSupervisionPolicy: 'SCRUM-210',
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
  adjustMerchStock,
  upsertInventoryItem,
  deleteInventoryItem,
  setDiscountReasons,
  updateDropOffPricing,
  updateSupervisionPolicy,
  upsertEdcTerminal,
  deleteEdcTerminal,
  upsertDevice,
  deleteDevice,
  upsertPrintTemplate,
  deletePrintTemplate,
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
