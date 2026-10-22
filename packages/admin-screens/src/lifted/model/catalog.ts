import type { TierDef, TicketType, AddOn, MenuItem, MenuCategoryDef, ModifierGroup, MerchItem, InventoryItem, StockLocation, EventDropInPricing, TaxConfig, SupervisionPolicy, Discount, PrintTemplate, Device, EdcTerminal, Branch, PaymentMethod, DropOffPricing, PricingOverride, RoleBenefitTemplate } from './types';

export interface BranchCatalog {
  tiers: TierDef[];
  ticketTypes: TicketType[];
  addOns: AddOn[];
  menuItems: MenuItem[];
  menuCategories: MenuCategoryDef[];
  modifierGroups: ModifierGroup[];
  merchItems: MerchItem[];
  inventory: InventoryItem[];
  stockLocations: StockLocation[];
  eventDropInPricing: EventDropInPricing;
  taxConfig: TaxConfig;
  supervisionPolicy: SupervisionPolicy;
  discounts: Discount[];
  printTemplates: PrintTemplate[];
  devices: Device[];
  edcTerminals: EdcTerminal[];
}

export interface CatalogState {
  branches: Branch[];
  tiers: TierDef[];
  ticketTypes: TicketType[];
  addOns: AddOn[];
  menuItems: MenuItem[];
  menuCategories: MenuCategoryDef[];
  merchItems: MerchItem[];
  modifierGroups: ModifierGroup[];
  discounts: Discount[];
  discountReasons: string[];
  paymentMethods: PaymentMethod[];
  dropOffPricing: DropOffPricing;
  eventDropInPricing: EventDropInPricing;
  pricingOverrides: PricingOverride[];
  edcTerminals: EdcTerminal[];
  devices: Device[];
  taxConfig: TaxConfig;
  supervisionPolicy: SupervisionPolicy;
  printTemplates: PrintTemplate[];
  inventory: InventoryItem[];
  stockLocations: StockLocation[];
  roleBenefitTemplates: RoleBenefitTemplate[];
}

/** The existing host hydration input; no store or session is owned here. */
export interface CatalogHydration {
  branches?: Branch[];
  perBranch: Record<string, Partial<BranchCatalog>>;
  pricingOverrides?: PricingOverride[];
  paymentMethods?: PaymentMethod[];
}
