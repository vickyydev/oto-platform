import type { CatalogState } from './catalog';
import type { Branch, TierDef, TicketType, AddOn, MenuItem, MenuCategoryDef, MerchItem, ModifierGroup, Discount, PaymentMethod, DropOffPricing, PricingOverride, TaxConfig, SupervisionPolicy, EdcTerminal, Device, PrintTemplate, InventoryItem, StockLocation, Sale, FnbOrder, MerchOrder, OtoEvent, Wristband, MerchStockAdjustment } from './types';

export interface CloneResult {
  sourceBranchId: string;
  targetBranchId: string;
  at: string; // ISO
}

export interface CatalogMutators {
  upsertBranch(branch: Branch): void;
  upsertTier(t: TierDef): void;
  deleteTier(id: string): void;
  upsertTicketType(t: TicketType): void;
  deleteTicketType(id: string): void;
  upsertAddOn(a: AddOn): void;
  deleteAddOn(id: string): void;
  upsertMenuItem(m: MenuItem): void;
  deleteMenuItem(id: string): void;
  upsertMerchItem(m: MerchItem): void;
  deleteMerchItem(id: string): void;
  transferStockBetweenLocations(inventoryItemId: string, variantId: string, fromLocationId: string, toLocationId: string, qty: number): number;
  replenishStockToLocation(inventoryItemId: string, variantId: string, locationId: string, qty: number): void;
  commitStockTakeCorrection(inventoryItemId: string, variantId: string, locationId: string, countedQty: number): number;
  upsertStockLocation(loc: StockLocation): void;
  setStockLocationSellPoint(locationId: string): boolean;
  upsertInventoryItem(item: InventoryItem): void;
  deleteInventoryItem(id: string): void;
  adjustMerchStock(id: string, delta: number): MerchItem | undefined;
  upsertMenuCategory(c: MenuCategoryDef): void;
  deleteMenuCategory(id: string): void;
  upsertModifierGroup(g: ModifierGroup): void;
  deleteModifierGroup(id: string): void;
  upsertDiscount(d: Discount): void;
  deleteDiscount(code: string): void;
  setDiscountReasons(reasons: string[]): void;
  upsertPaymentMethod(m: PaymentMethod): void;
  deletePaymentMethod(id: string): void;
  updateDropOffPricing(patch: Partial<DropOffPricing>): void;
  upsertPricingOverride(o: PricingOverride): void;
  deletePricingOverride(id: string): void;
  updateTaxConfig(patch: Partial<TaxConfig>): void;
  updateSupervisionPolicy(patch: Partial<SupervisionPolicy>): void;
  upsertEdcTerminal(t: EdcTerminal): void;
  deleteEdcTerminal(id: string): void;
  upsertDevice(d: Device): void;
  deleteDevice(id: string): void;
  upsertPrintTemplate(t: PrintTemplate): void;
  deletePrintTemplate(id: string): void;
  cloneBranchCatalog(sourceBranchId: string, targetBranchId: string): CloneResult;
  branchHasCatalogData(branchId: string): boolean;
  movePaymentMethod(code: string, direction: 'up' | 'down'): void;
}

export interface CatalogStoreValue extends CatalogState { mutators: CatalogMutators }

export interface CatalogReaders {
 getCatalogSnapshot(): CatalogState;
 getActiveBranch(): Branch;
 getBranches(): Branch[];
 getTiers(): TierDef[];
 getTier(id: string): TierDef | undefined;
 getDefaultTier(): TierDef | undefined;
 getTicketTypes(): TicketType[];
 getAddOns(): AddOn[];
 getMenuItems(): MenuItem[];
 getMenuCategories(): MenuCategoryDef[];
 getModifierGroups(): ModifierGroup[];
 getMerchItems(): MerchItem[];
 getInventory(): InventoryItem[];
 getDiscounts(): Discount[];
 getPaymentMethods(): PaymentMethod[];
 getPricingOverrides(): PricingOverride[];
 getTaxConfig(): TaxConfig;
 getDropOffPricing(): DropOffPricing;
 getSupervisionPolicy(): SupervisionPolicy;
 getPrintTemplates(): PrintTemplate[];
}

/** Host callbacks for existing prototype data/actions; no mock store is copied. */
export interface LegacyPorts {
 getDefaultTier(): TierDef | undefined;
 countTierUsage(id: string): number;
 recordMerchStockAdjustment(params: {merchItemId:string;delta:number;reason:string;adjustedBy:string;adjustedById:string}): MerchStockAdjustment;
 getAllSalesForReporting(): Sale[];
 getAllFnbOrdersForReporting(): FnbOrder[];
 getAllMerchOrdersForReporting(): MerchOrder[];
 getAllEventsForReporting(): OtoEvent[];
 getMockWristbands(): Wristband[];
 getInventory(): InventoryItem[];
}
