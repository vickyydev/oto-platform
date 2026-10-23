import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { subscribeCatalog, getCatalogSnapshot, type CatalogState, adjustMerchStock, upsertInventoryItem, deleteInventoryItem, setDiscountReasons, updateDropOffPricing, updateSupervisionPolicy, upsertEdcTerminal, deleteEdcTerminal, upsertDevice, deleteDevice, upsertPrintTemplate, deletePrintTemplate, cloneBranchCatalog, branchHasCatalogData, upsertStockLocation, setStockLocationSellPoint, transferStockBetweenLocations, replenishStockToLocation, commitStockTakeCorrection } from './catalogStore';

// Administration now runs in Admin; the POS retains its subscribed catalogue snapshot.

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

const mutators = { ...readOnlyHelpers, ...mockMutators };

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
