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
