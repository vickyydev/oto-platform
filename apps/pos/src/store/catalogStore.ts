import {
  Branch,
  TicketType,
  AddOn,
  Discount,
  MenuItem,
  MenuCategoryDef,
  MerchItem,
  ModifierGroup,
  EdcTerminal,
  Device,
  DropOffPricing,
  EventDropInPricing,
  SupervisionPolicy,
  TaxConfig,
  TaxableCategory,
  PrintTemplate,
  PrintTemplateType,
  PaymentMethod,
  TierDef,
  InventoryItem,
  InventoryVariant,
  INVENTORY_DEFAULT_VARIANT_ID,
  StockLocation,
  StockTransfer,
  StockTakeRecord,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderState,
  WeekdayWeekendPrice,
  PricingOverride,
  RoleBenefitTemplate,
} from '../types';

// Seed helper: {weekday, weekend} price pair. Pass one arg for weekday=weekend.
export const wwp = (weekday: number, weekend: number = weekday): WeekdayWeekendPrice => ({
  weekday,
  weekend,
});

// ============================================================================
// Per-branch catalog / config
// ============================================================================
// All of these collections are scoped to a branch.  The flat CatalogState
// interface that the rest of the app reads is assembled by getCatalogSnapshot()
// from the active branch's BranchCatalog — consumers need no changes.
// ============================================================================

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

// The following are intentionally NOT per-branch (global):
//   - branches registry (the registry itself)
//   - discountReasons (shared reasons for staff discount justifications)
//   - paymentMethods (same physical tenders everywhere)
//   - dropOffPricing (global per the task spec)
//   - pricingOverrides (named holiday/weekend date ranges apply park-wide)

// --- Branch registry (module-level active-branch state) --------------------
const seedBranches: Branch[] = [
  { id: 'hkt-central', name: 'HKT Central', country: 'TH', active: true },
  { id: 'hkt-chalong', name: 'HKT Chalong', country: 'TH', active: true },
];

let _activeBranchId: string = seedBranches[0].id;

// Per-branch, per-session stock deltas on top of the branch catalog baseline.
// TOTAL delta key:    branchId → "inventoryItemId:variantId"         → signed delta
// LOCATION delta key: branchId → "inventoryItemId:variantId:locationId" → signed delta
// Initialized lazily on first write; catalog stock is the branch's own baseline.
const _branchStockDeltas = new Map<string, Map<string, number>>();
// Location-specific deltas (for items using stockByLocation)
const _locationStockDeltas = new Map<string, Map<string, number>>();

function applyBranchDeltas(item: InventoryItem, branchId: string): InventoryItem {
  const legacyMap = _branchStockDeltas.get(branchId);
  const locMap = _locationStockDeltas.get(branchId);

  const variants = item.variants.map((v) => {
    if (v.stockByLocation) {
      // Per-location mode: apply location-specific deltas, recompute total stock
      const newByLoc: Record<string, number> = {};
      let newTotal = 0;
      for (const [locId, baseQty] of Object.entries(v.stockByLocation)) {
        const locKey = `${item.id}:${v.id}:${locId}`;
        const locDelta = locMap?.get(locKey) ?? 0;
        const qty = Math.max(0, baseQty + locDelta);
        newByLoc[locId] = qty;
        newTotal += qty;
      }
      return { ...v, stockByLocation: newByLoc, stock: newTotal };
    } else {
      // Legacy mode: apply total delta only
      const delta = legacyMap?.get(`${item.id}:${v.id}`) ?? 0;
      return delta !== 0 ? { ...v, stock: Math.max(0, v.stock + delta) } : v;
    }
  });
  return { ...item, variants };
}

// ============================================================================
// Seed helpers
// ============================================================================

const iceGroup = (id: string): ModifierGroup => ({
  id,
  name: 'Ice',
  required: true,
  selectionType: 'single',
  options: [
    { id: `${id}-normal`, name: 'Normal ice', price: wwp(0) },
    { id: `${id}-less`, name: 'Less ice', price: wwp(0) },
    { id: `${id}-none`, name: 'No ice', price: wwp(0) },
  ],
});

const seedModifierGroups: ModifierGroup[] = [
  {
    id: 'lib-spice',
    name: 'Spice level',
    required: true,
    selectionType: 'single',
    options: [
      { id: 'lib-spice-mild', name: 'Mild', price: wwp(0) },
      { id: 'lib-spice-medium', name: 'Medium', price: wwp(0) },
      { id: 'lib-spice-hot', name: 'Thai hot', price: wwp(0) },
    ],
  },
  {
    id: 'lib-sugar',
    name: 'Sugar level',
    required: false,
    selectionType: 'single',
    options: [
      { id: 'lib-sugar-0', name: 'No sugar', price: wwp(0) },
      { id: 'lib-sugar-50', name: 'Half sweet', price: wwp(0) },
      { id: 'lib-sugar-100', name: 'Full sweet', price: wwp(0) },
    ],
  },
  {
    id: 'lib-extras',
    name: 'Add-ons',
    required: false,
    selectionType: 'multi',
    max: 3,
    options: [
      { id: 'lib-extras-cheese', name: 'Extra cheese', price: wwp(30) },
      { id: 'lib-extras-egg', name: 'Fried egg', price: wwp(25) },
      { id: 'lib-extras-bacon', name: 'Bacon', price: wwp(45) },
    ],
  },
];

// Adult credit give-back to the adult who paid: full price paid → wallet credit.
const ADULTS_FULL_CREDIT: TicketType['creditRule'] = {
  appliesTo: 'adults',
  basis: 'full_price',
};

// Adult admission is flat across every tier (weekday ฿350 / weekend ฿500) —
// the till edits this via the pinned Adult Admission card in the Tickets
// panel, not a separate admin menu (see AdultAdmissionForm).
const ADULT_ADMISSION_PRICE = wwp(350, 500);
const STANDARD_ADULT_RULES: TicketType['adultRules'] = {
  tourist: { kind: 'set_price', price: ADULT_ADMISSION_PRICE },
  expat: { kind: 'set_price', price: ADULT_ADMISSION_PRICE },
  thai: { kind: 'set_price', price: ADULT_ADMISSION_PRICE },
};

// Expat kid pricing is derived from Tourist: −30% weekday, −20% weekend.
const expatFromTourist = (tourist: WeekdayWeekendPrice): WeekdayWeekendPrice => ({
  weekday: Math.round(tourist.weekday * 0.7),
  weekend: Math.round(tourist.weekend * 0.8),
});

const TOURIST_1H = wwp(690, 690);
const TOURIST_2H = wwp(890, 890);
const TOURIST_FD = wwp(1090, 1090);

const seedTicketTypes: TicketType[] = [
  {
    id: 't-1h',
    name: '1 Hour Play',
    durationLabel: '1 Hour',
    hours: 1,
    prices: { tourist: TOURIST_1H, expat: expatFromTourist(TOURIST_1H), thai: wwp(420, 520) },
    adultRules: STANDARD_ADULT_RULES,
    creditRule: ADULTS_FULL_CREDIT,
    gateAccess: true,
    // Seeded translations for the customer-facing language selector
    // (Task #233). Admin editing of this map is a follow-on — for now only
    // this seed and the two menu items below carry translations.
    translations: {
      zh: { name: '1小时畅玩' },
      th: { name: 'เล่น 1 ชั่วโมง' },
      ru: { name: 'Игра 1 час' },
      fr: { name: 'Jeu 1 heure' },
    },
  },
  {
    id: 't-2h',
    name: '2 Hours Play',
    durationLabel: '2 Hours',
    hours: 2,
    prices: { tourist: TOURIST_2H, expat: expatFromTourist(TOURIST_2H), thai: wwp(520, 620) },
    adultRules: STANDARD_ADULT_RULES,
    creditRule: ADULTS_FULL_CREDIT,
    gateAccess: true,
  },
  {
    id: 't-fd',
    name: 'Full Day Pass',
    durationLabel: 'All Day',
    hours: 8,
    prices: { tourist: TOURIST_FD, expat: expatFromTourist(TOURIST_FD), thai: wwp(620, 720) },
    // Thai families get 1 free adult, then overflow adults pay the flat admission rate.
    adultRules: {
      tourist: { kind: 'set_price', price: ADULT_ADMISSION_PRICE },
      expat: { kind: 'set_price', price: ADULT_ADMISSION_PRICE },
      thai: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: ADULT_ADMISSION_PRICE },
    },
    creditRule: ADULTS_FULL_CREDIT,
    gateAccess: true,
  },
  {
    id: 't-pe',
    name: 'Eat & Play Kids Pass',
    durationLabel: 'All Day + Meal',
    hours: 8,
    prices: { tourist: wwp(1300), expat: wwp(1300), thai: wwp(1300) },
    // Parent/adult ticket is a fixed ฿350 even on weekends (does NOT follow the
    // kid pass' 1300, and does NOT use the flat 350/500 admission rate either).
    adultRules: {
      tourist: { kind: 'set_price', price: wwp(350, 350) },
      expat: { kind: 'set_price', price: wwp(350, 350) },
      thai: { kind: 'set_price', price: wwp(350, 350) },
    },
    // Both kids AND adults get the full ticket amount back as F&B credit.
    creditRule: { appliesTo: 'both', basis: 'full_price' },
    gateAccess: true,
  },
];

const seedAddOns: AddOn[] = [
  { id: 'a-socks', name: 'Regular Socks', price: wwp(50), inventoryItemId: 'inv-a-socks' },
  { id: 'a-grip-socks', name: 'Grip Socks', price: wwp(80), inventoryItemId: 'inv-a-grip-socks' },
  { id: 'a-locker', name: 'Locker Rental', price: wwp(100), inventoryItemId: 'inv-a-locker' },
  { id: 'a-cup', name: 'Refillable Drink Cup', price: wwp(150), inventoryItemId: 'inv-a-cup' },
  { id: 'a-glow', name: 'Glow Band', price: wwp(60), inventoryItemId: 'inv-a-glow' },
];

const seedDiscounts: Discount[] = [
  {
    code: 'STAFF10',
    label: 'Staff Discount',
    type: 'percent',
    value: 10,
    active: true,
    stackable: true,
    usedCount: 0,
    perCustomerUsage: {},
  },
  {
    code: 'MEMBER20',
    label: 'Member Discount',
    type: 'percent',
    value: 20,
    active: true,
    stackable: true,
    usedCount: 0,
    perCustomerUsage: {},
  },
  {
    code: 'SAVE100',
    label: 'Promo Event',
    type: 'fixed',
    value: 100,
    active: true,
    usageLimit: 50,
    usedCount: 3,
    perCustomerLimit: 1,
    perCustomerUsage: {},
    validUntil: '2026-12-31',
  },
  {
    code: 'ICECREAM',
    label: 'Free Ice Cream',
    type: 'free_item',
    value: 0,
    freeItemId: 'm-icecream',
    freeItemKind: 'menu',
    target: { kind: 'menuItems', menuItemIds: ['m-icecream'] },
    active: true,
    usageLimit: 100,
    usedCount: 0,
    perCustomerLimit: 1,
    perCustomerUsage: {},
    validUntil: '2026-12-31',
  },
];

const seedDiscountReasons: string[] = [
  'Service recovery',
  'Staff / family',
  'Damaged item',
  'Manager comp',
  'Promotion',
  'Loyalty',
  'Other',
];

const seedMenuCategories: MenuCategoryDef[] = [
  { id: 'food', name: 'Food', defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb', sortOrder: 0 },
  { id: 'drinks', name: 'Drinks', defaultPrepStation: 'bar', defaultTaxCategory: 'fnb', sortOrder: 1 },
  { id: 'bar', name: 'Bar', defaultPrepStation: 'bar', defaultTaxCategory: 'bar', sortOrder: 2 },
  { id: 'snacks', name: 'Snacks', defaultPrepStation: 'kitchen', defaultTaxCategory: 'fnb', sortOrder: 3 },
  { id: 'food-mains', name: 'Mains', parentId: 'food', sortOrder: 0 },
  { id: 'food-lightbites', name: 'Light Bites', parentId: 'food', sortOrder: 1 },
  // Sub-category of Drinks so the staff-benefit engine (Task #231) can scope
  // a "free coffee" entitlement without inventing a parallel category system.
  { id: 'drinks-coffee', name: 'Coffee', parentId: 'drinks', sortOrder: 0 },
];

const seedMenuItems: MenuItem[] = [
  {
    id: 'm-nuggets',
    name: 'Chicken Nuggets',
    category: 'food-lightbites',
    price: wwp(120),
    // Seeded translations for the customer-facing language selector
    // (Task #233) — see t-1h above for the note on admin editing follow-on.
    translations: {
      zh: { name: '鸡块' },
      th: { name: 'ไก่นักเก็ต' },
      ru: { name: 'Куриные наггетсы' },
      fr: { name: 'Nuggets de poulet' },
    },
  },
  {
    id: 'm-fries',
    name: 'French Fries',
    category: 'food',
    price: wwp(90),
    translations: {
      zh: { name: '薯条' },
      th: { name: 'เฟรนช์ฟรายส์' },
      ru: { name: 'Картофель фри' },
      fr: { name: 'Frites' },
    },
    modifierGroups: [
      {
        id: 'fries-sauce',
        name: 'Sauces',
        required: false,
        selectionType: 'multi',
        max: 2,
        options: [
          { id: 'fries-sauce-ketchup', name: 'Ketchup', price: wwp(0) },
          { id: 'fries-sauce-mayo', name: 'Mayo', price: wwp(0) },
          { id: 'fries-sauce-cheese', name: 'Cheese sauce', price: wwp(25) },
        ],
      },
    ],
  },
  {
    id: 'm-pizza',
    name: 'Margherita Pizza',
    category: 'food-mains',
    price: wwp(220),
    modifierGroups: [
      {
        id: 'pizza-toppings',
        name: 'Extra toppings',
        required: false,
        selectionType: 'multi',
        options: [
          { id: 'pizza-cheese', name: 'Extra cheese', price: wwp(40) },
          { id: 'pizza-mushrooms', name: 'Mushrooms', price: wwp(30) },
          { id: 'pizza-ham', name: 'Ham', price: wwp(50) },
          { id: 'pizza-olives', name: 'Olives', price: wwp(30) },
        ],
      },
    ],
  },
  {
    id: 'm-burger',
    name: 'Kids Beef Burger',
    category: 'food-mains',
    price: wwp(180),
    modifierGroups: [
      {
        id: 'burger-cook',
        name: 'Cooked how?',
        required: true,
        selectionType: 'single',
        options: [
          { id: 'burger-rare', name: 'Rare', price: wwp(0) },
          { id: 'burger-medium', name: 'Medium', price: wwp(0) },
          { id: 'burger-well', name: 'Well done', price: wwp(0) },
        ],
      },
    ],
  },
  { id: 'm-padthai', name: 'Pad Thai', category: 'food-mains', price: wwp(150) },
  { id: 'm-hotdog', name: 'Hot Dog', category: 'food', price: wwp(110) },
  { id: 'm-water', name: 'Bottled Water', category: 'drinks', price: wwp(25), inventoryItemId: 'inv-m-water' },
  { id: 'm-juice', name: 'Fresh Orange Juice', category: 'drinks', price: wwp(70) },
  {
    id: 'm-soda',
    name: 'Soft Drink',
    category: 'drinks',
    price: wwp(45),
    modifierGroups: [iceGroup('soda-ice')],
  },
  {
    id: 'm-latte',
    name: 'Iced Latte',
    category: 'drinks-coffee',
    price: wwp(95),
    modifierGroups: [
      iceGroup('latte-ice'),
      {
        id: 'latte-milk',
        name: 'Milk',
        required: false,
        selectionType: 'single',
        options: [
          { id: 'latte-milk-regular', name: 'Regular', price: wwp(0) },
          { id: 'latte-milk-oat', name: 'Oat', price: wwp(25) },
          { id: 'latte-milk-soy', name: 'Soy', price: wwp(25) },
        ],
      },
    ],
  },
  {
    id: 'm-shake',
    name: 'Chocolate Milkshake',
    category: 'drinks',
    price: wwp(120),
    modifierGroups: [
      {
        id: 'shake-size',
        name: 'Size',
        required: true,
        selectionType: 'single',
        options: [
          { id: 'shake-regular', name: 'Regular', price: wwp(0) },
          { id: 'shake-large', name: 'Large', price: wwp(40) },
        ],
      },
    ],
  },
  { id: 'm-beer', name: 'Chang Beer', category: 'bar', price: wwp(110) },
  { id: 'm-wine', name: 'House Wine', category: 'bar', price: wwp(180) },
  { id: 'm-mojito', name: 'Mojito', category: 'bar', price: wwp(200) },
  { id: 'm-gintonic', name: 'Gin & Tonic', category: 'bar', price: wwp(190) },
  { id: 'm-popcorn', name: 'Popcorn', category: 'snacks', price: wwp(60) },
  { id: 'm-icecream', name: 'Ice Cream Cone', category: 'snacks', price: wwp(50) },
  { id: 'm-cottoncandy', name: 'Cotton Candy', category: 'snacks', price: wwp(70) },
  { id: 'm-fruitcup', name: 'Fresh Fruit Cup', category: 'snacks', price: wwp(80) },
  { id: 'm-slushie', name: 'Slushie', category: 'drinks', price: wwp(90), inventoryItemId: 'inv-m-slushie' },
];

const seedMerchItems: MerchItem[] = [
  { id: 'mr-tshirt', name: 'Oto T-Shirt', active: true, category: 'Apparel', price: wwp(350), cost: 120, sku: 'OTO-TS', inventoryItemId: 'inv-mr-tshirt' },
  { id: 'mr-cap', name: 'Oto Cap', active: true, category: 'Apparel', price: wwp(250), cost: 90, sku: 'OTO-CAP', inventoryItemId: 'inv-mr-cap' },
  { id: 'mr-socks', name: 'Grip Socks', active: true, category: 'Apparel', price: wwp(120), cost: 35, sku: 'OTO-SOCK', inventoryItemId: 'inv-mr-socks' },
  { id: 'mr-bottle', name: 'Water Bottle', active: true, category: 'Accessories', price: wwp(180), cost: 60, sku: 'OTO-BTL', inventoryItemId: 'inv-mr-bottle' },
  { id: 'mr-plush', name: 'Oto Mascot Plush', active: true, category: 'Toys', price: wwp(450), cost: 160, sku: 'OTO-PLUSH', inventoryItemId: 'inv-mr-plush' },
  { id: 'mr-stickerpack', name: 'Sticker Pack', active: true, category: 'Toys', price: wwp(60), cost: 12, sku: 'OTO-STK', inventoryItemId: 'inv-mr-stickerpack' },
  { id: 'mr-keyring', name: 'Mascot Keyring', active: true, category: 'Accessories', price: wwp(90), cost: 25, sku: 'OTO-KEY', inventoryItemId: 'inv-mr-keyring' },
  { id: 'mr-lanyard', name: 'Old Lanyard (retired)', active: false, category: 'Accessories', price: wwp(70), cost: 20, sku: 'OTO-LAN', inventoryItemId: 'inv-mr-lanyard' },
];

// --- Seed stock locations (three canonical locations per branch) -----------
// All pre-existing stock is migrated into the back-of-house location by default;
// the rotation (sell-point) starts with a partial stock for a realistic demo.
export const STOCK_LOC_BULK = 'loc-bulk';
export const STOCK_LOC_BOH  = 'loc-boh';
export const STOCK_LOC_ROT  = 'loc-rotation';

const seedStockLocations: StockLocation[] = [
  { id: STOCK_LOC_BULK, name: 'Store', type: 'bulk',          active: true },
  { id: STOCK_LOC_BOH,  name: 'BOH',   type: 'back_of_house', active: true },
  { id: STOCK_LOC_ROT,  name: 'FOH',   type: 'rotation',      sellPoint: true, active: true },
];

const inv = (
  id: string,
  name: string,
  linkedKind: InventoryItem['linkedKind'],
  linkedId: string,
  variants: InventoryVariant[],
  units?: InventoryItem['units'],
): InventoryItem => ({ id, name, linkedKind, linkedId, variants, ...(units ? { units } : {}) });

// Seed helper: single-variant item with per-location stock.
// boh = back-of-house qty, rot = rotation/sell-point qty, bulk = bulk qty (default 0)
const defVarLoc = (
  boh: number,
  rot: number,
  threshold: number,
  parRot?: number,
  bulk = 0,
): InventoryVariant => {
  const stockByLocation: Record<string, number> = {
    [STOCK_LOC_BULK]: bulk,
    [STOCK_LOC_BOH]: boh,
    [STOCK_LOC_ROT]: rot,
  };
  const total = bulk + boh + rot;
  const parByLocation: Record<string, number> | undefined =
    parRot !== undefined ? { [STOCK_LOC_ROT]: parRot } : undefined;
  return {
    id: INVENTORY_DEFAULT_VARIANT_ID,
    label: 'Default',
    stock: total,
    lowStockThreshold: threshold,
    stockByLocation,
    ...(parByLocation ? { parByLocation } : {}),
  };
};

// Helper for multi-variant items: build a single variant with per-location stock
const varLoc = (
  id: string,
  label: string,
  boh: number,
  rot: number,
  threshold: number,
  parRot?: number,
  bulk = 0,
): InventoryVariant => {
  const stockByLocation: Record<string, number> = {
    [STOCK_LOC_BULK]: bulk,
    [STOCK_LOC_BOH]: boh,
    [STOCK_LOC_ROT]: rot,
  };
  const parByLocation: Record<string, number> | undefined =
    parRot !== undefined ? { [STOCK_LOC_ROT]: parRot } : undefined;
  return {
    id,
    label,
    stock: bulk + boh + rot,
    lowStockThreshold: threshold,
    stockByLocation,
    ...(parByLocation ? { parByLocation } : {}),
  };
};

// Pack/unit definitions used by common inventory items
const PACK_DOZEN: InventoryItem['units'] = [{ id: 'dozen', label: 'Dozen', eaches: 12 }];
const PACK_CASE24: InventoryItem['units'] = [{ id: 'case', label: 'Case', eaches: 24 }];

const seedInventory: InventoryItem[] = [
  // Merch items: most stock in BOH, some at rotation sell-point
  {
    ...inv('inv-mr-tshirt', 'Oto T-Shirt', 'merch', 'mr-tshirt', [defVarLoc(28, 12, 8, 15)]),
    unitCostTHB: 120,
    reorderSettings: { reorderPoint: 20, leadTimeDays: 7, supplierName: 'Bangkok Merch Co.', supplierContact: '02-555-0100', reorderQty: 48 },
  },
  {
    ...inv('inv-mr-cap', 'Oto Cap', 'merch', 'mr-cap', [defVarLoc(18, 7, 6, 10)]),
    unitCostTHB: 90,
    reorderSettings: { reorderPoint: 15, leadTimeDays: 7, supplierName: 'Bangkok Merch Co.', supplierContact: '02-555-0100', reorderQty: 24 },
  },
  // Grip Socks: total stock = 6; reorderPoint = 15 → needs reordering AND low-at-par
  {
    ...inv('inv-mr-socks', 'Grip Socks (Merch)', 'merch', 'mr-socks', [defVarLoc(0, 6, 12, 15)]),
    unitCostTHB: 35,
    reorderSettings: { reorderPoint: 15, leadTimeDays: 5, supplierName: 'Phuket Socks Ltd.', supplierContact: 'socks@pkt.th', reorderQty: 120 },
  },
  {
    ...inv('inv-mr-bottle', 'Water Bottle', 'merch', 'mr-bottle', [defVarLoc(22, 8, 8, 10)]),
    unitCostTHB: 60,
    reorderSettings: { reorderPoint: 20, leadTimeDays: 10, supplierName: 'Bottle House TH', reorderQty: 48 },
  },
  {
    ...inv('inv-mr-plush', 'Oto Mascot Plush', 'merch', 'mr-plush', [defVarLoc(14, 4, 5, 8)]),
    unitCostTHB: 160,
  },
  {
    ...inv('inv-mr-stickerpack', 'Sticker Pack', 'merch', 'mr-stickerpack', [defVarLoc(60, 20, 15, 25)], PACK_DOZEN),
    unitCostTHB: 12,
  },
  // Mascot Keyring: out of stock everywhere; reorderPoint = 5 → needs reordering
  {
    ...inv('inv-mr-keyring', 'Mascot Keyring', 'merch', 'mr-keyring', [defVarLoc(0, 0, 6, 8)]),
    unitCostTHB: 25,
    reorderSettings: { reorderPoint: 5, leadTimeDays: 14, supplierName: 'Phuket Socks Ltd.', supplierContact: 'socks@pkt.th', reorderQty: 24 },
  },
  inv('inv-mr-lanyard',    'Old Lanyard (retired)',   'merch', 'mr-lanyard',
    [defVarLoc(4, 0, 0)]),
  // Add-on items
  {
    ...inv('inv-a-socks', 'Regular Socks', 'addon', 'a-socks', [defVarLoc(80, 20, 20, 30)], PACK_DOZEN),
    unitCostTHB: 15,
    reorderSettings: { reorderPoint: 50, leadTimeDays: 5, supplierName: 'Phuket Socks Ltd.', supplierContact: 'socks@pkt.th', reorderQty: 120 },
  },
  {
    ...inv('inv-a-grip-socks', 'Grip Socks', 'addon', 'a-grip-socks', [
      varLoc('S', 'S', 18, 7, 8, 10),
      varLoc('M', 'M', 28, 12, 8, 15),
      varLoc('L', 'L', 14, 6, 8, 10),
    ], PACK_DOZEN),
    unitCostTHB: 28,
    reorderSettings: { reorderPoint: 30, leadTimeDays: 5, supplierName: 'Phuket Socks Ltd.', supplierContact: 'socks@pkt.th', reorderQty: 72 },
  },
  inv('inv-a-locker',      'Locker Rental',           'addon', 'a-locker',
    [defVarLoc(10, 5, 3, 5)]),
  {
    ...inv('inv-a-cup', 'Refillable Drink Cup', 'addon', 'a-cup', [defVarLoc(38, 12, 10, 15)]),
    unitCostTHB: 65,
  },
  inv('inv-a-glow',        'Glow Band',               'addon', 'a-glow',
    [defVarLoc(60, 20, 15, 20)]),
  // F&B stocked items (beverage inventory tracked by case)
  // Original total: water=60; split BOH 48 + FOH 12 = 60 (no bulk created from thin air)
  {
    ...inv('inv-m-water', 'Bottled Water', 'menu', 'm-water', [defVarLoc(48, 12, 12, 24)], PACK_CASE24),
    unitCostTHB: 12,
    reorderSettings: { reorderPoint: 30, leadTimeDays: 2, supplierName: 'Island Beverages Co.', reorderQty: 120 },
  },
  // Original totals: Red=20, Blue=15, Green=4; restored (BOH + FOH = original)
  {
    ...inv('inv-m-slushie', 'Slushie', 'menu', 'm-slushie', [
      varLoc('red',   'Red',   15, 5, 5, 8),    // 15+5=20 ✓
      varLoc('blue',  'Blue',  12, 3, 5, 8),    // 12+3=15 ✓
      varLoc('green', 'Green', 2,  2, 5, 8),    // 2+2=4 ✓; green low at FOH < par 8
    ]),
    unitCostTHB: 35,
    reorderSettings: { reorderPoint: 10, leadTimeDays: 2, supplierName: 'Island Beverages Co.', reorderQty: 48 },
  },
];

const seedEdcTerminals: EdcTerminal[] = [
  { id: 'edc-1', tid: 'TID65703234', label: 'EDC 1' },
  { id: 'edc-2', tid: 'TID65703235', label: 'EDC 2' },
  { id: 'edc-3', tid: 'TID91471493', label: 'EDC 3' },
  { id: 'edc-4', tid: 'TID91471492', label: 'EDC 4' },
];

const seedDevices: Device[] = [
  { id: 'rcpt-1', type: 'receipt_printer', label: 'Receipt Printer 1', connection: 'network', address: '192.168.1.21' },
  { id: 'rcpt-2', type: 'receipt_printer', label: 'Receipt Printer 2', connection: 'network', address: '192.168.1.22' },
  { id: 'rcpt-3', type: 'receipt_printer', label: 'Receipt Printer 3', connection: 'network', address: '192.168.1.23' },
  { id: 'brac-1', type: 'bracelet_printer', label: 'Bracelet Printer 1', connection: 'network', address: '192.168.1.31' },
  { id: 'brac-2', type: 'bracelet_printer', label: 'Bracelet Printer 2', connection: 'network', address: '192.168.1.32' },
  { id: 'brac-3', type: 'bracelet_printer', label: 'Bracelet Printer 3', connection: 'network', address: '192.168.1.33' },
  { id: 'kitchen-1', type: 'kitchen_printer', label: 'Kitchen Printer', connection: 'network', address: '192.168.1.41' },
  { id: 'kitchen-2', type: 'kitchen_printer', label: 'Kitchen Printer 2', connection: 'network', address: '192.168.1.42' },
  { id: 'bar-1', type: 'bar_printer', label: 'Bar Printer', connection: 'network', address: '192.168.1.51' },
  { id: 'bar-2', type: 'bar_printer', label: 'Bar Printer 2', connection: 'network', address: '192.168.1.52' },
  { id: 'scan-1', type: 'scanner', label: 'Scanner 1', connection: 'bluetooth' },
  { id: 'scan-2', type: 'scanner', label: 'Scanner 2', connection: 'bluetooth' },
  { id: 'gate-1', type: 'gate', label: 'Entrance Gate', connection: 'network', address: '192.168.1.61' },
  { id: 'gate-2', type: 'gate', label: 'Exit Gate', connection: 'network', address: '192.168.1.62' },
];

const seedEventDropInPricing: EventDropInPricing = {
  campDayTHB: wwp(600),
  eventDayTHB: wwp(350),
  partyGuestTHB: wwp(450),
};

// Services default weekday = weekend until the owner edits an override.
const seedDropOffPricing: DropOffPricing = {
  oneTimeFeeTHB: wwp(225),
  nannyHourlyRateTHB: wwp(330),
  extraHourTHB: wwp(300),
  fullDayHours: 8,
  nannyRatioSoftMax: 3,
  prepaidFoodRefundPolicy: 'refund',
};

const seedPricingOverrides: PricingOverride[] = [
  { id: 'ov-songkran', name: 'Songkran', startDate: '2026-04-13', endDate: '2026-04-15' },
];

const ALL_TAXABLE_CATEGORIES: TaxableCategory[] = [
  'tickets', 'fnb', 'bar', 'drop_off', 'parties', 'addons', 'merch', 'stored_value',
];

const seedSupervisionPolicy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: {
    enabled: true,
    guardianMinAge: 9,
    waivableRequirement: 'drop_off',
    staffOnly: true,
  },
  confirmations: [
    { id: 'confirm-15min', text: 'I will remain within 15 minutes of the venue', required: true, order: 0 },
    { id: 'confirm-no-refund', text: 'I understand early pickup does not qualify for refund', required: true, order: 1 },
    { id: 'confirm-evac', text: 'I acknowledge the emergency evacuation point', required: true, order: 2 },
  ],
};

const seedTaxConfig: TaxConfig = {
  rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
  categoryRules: ALL_TAXABLE_CATEGORIES.map((category) =>
    category === 'stored_value'
      ? ({ category, taxMode: 'none' as const, serviceChargePercent: 0, taxOnServiceCharge: false })
      : ({ category, taxRateId: 'vat', taxMode: 'inclusive' as const, serviceChargePercent: 0, taxOnServiceCharge: false })
  ),
  discountPlacement: 'before_tax',
};

const seedPrintTemplates: PrintTemplate[] = [
  {
    id: 'tpl-receipt',
    type: 'receipt',
    name: 'Standard receipt',
    showLogo: true,
    headerText: 'Oto Play Park',
    footerText: 'Thank you for visiting! · Tax ID 0105500000000',
    fields: { itemizedLines: true, taxServiceBreakdown: true, voucherInfo: true },
  },
  {
    id: 'tpl-kids-wristband',
    type: 'kids_wristband',
    name: 'Kids wristband',
    showLogo: false,
    fields: {
      holderName: true, durationTime: true, qr: true, allergyLine: true,
      startEndTime: true, partyName: true, dietaryRequirement: true,
      supervisionBadge: true, assignedNannyName: true,
    },
  },
  {
    id: 'tpl-adult-wristband',
    type: 'adult_wristband',
    name: 'Adult wristband',
    showLogo: false,
    fields: {
      holderName: false, durationTime: true, qr: true, startEndTime: true,
      partyName: true, dietaryRequirement: true, supervisionBadge: true,
      assignedNannyName: true,
    },
  },
  {
    id: 'tpl-kitchen',
    type: 'kitchen_ticket',
    name: 'Kitchen ticket',
    showLogo: false,
    fields: { itemizedLines: true, allergyLine: true, orderNotes: true, orderRefTime: true, holderName: true },
  },
  {
    id: 'tpl-bar',
    type: 'bar_ticket',
    name: 'Bar ticket',
    showLogo: false,
    fields: { itemizedLines: true, allergyLine: true, orderNotes: true, orderRefTime: true, holderName: true },
  },
  {
    id: 'tpl-credit-voucher',
    type: 'credit_voucher',
    name: 'Credit voucher',
    showLogo: true,
    headerText: 'Oto Play Park',
    footerText: 'Scan QR or wristband at the F&B or merch counter to spend.',
    fields: { creditVoucherBalance: true, creditVoucherQr: true },
  },
];

const seedPaymentMethods: PaymentMethod[] = [
  { id: 'cash', label: 'Cash', kind: 'cash', enabled: true, sortOrder: 0 },
  { id: 'card', label: 'Card', kind: 'card', enabled: true, sortOrder: 1 },
  { id: 'promptpay', label: 'PromptPay', kind: 'qr', enabled: true, sortOrder: 2 },
];

const seedTiers: TierDef[] = [
  { id: 'tourist', name: 'Tourist', isDefault: true, requiresVerification: false, sortOrder: 0 },
  { id: 'expat', name: 'Expat', isDefault: false, requiresVerification: true, sortOrder: 1 },
  { id: 'thai', name: 'Thai', isDefault: false, requiresVerification: true, sortOrder: 2 },
];

// --- Staff benefit role templates (Task #231) ------------------------------
// Global (not per-branch) — every operator with a matching `benefitRole`
// inherits this profile unless they carry a per-primitive override. Editable
// in Admin → Staff Benefits.
const seedRoleBenefitTemplates: RoleBenefitTemplate[] = [
  {
    role: 'owner',
    name: 'Owner',
    profile: { comp: true },
  },
  {
    role: 'manager',
    name: 'Manager',
    profile: {
      freeItems: [
        {
          id: 'coffee',
          label: 'Free coffee',
          target: { kind: 'fnbCategory', category: 'drinks-coffee' },
          quotaPerPeriod: 2,
          period: 'daily',
        },
      ],
      credit: { amountTHB: 500, period: 'monthly' },
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    },
  },
  {
    role: 'staff',
    name: 'Staff',
    profile: {
      freeItems: [
        {
          id: 'coffee',
          label: 'Free coffee',
          target: { kind: 'fnbCategory', category: 'drinks-coffee' },
          quotaPerPeriod: 2,
          period: 'daily',
        },
      ],
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
    },
  },
];

// ============================================================================
// Branch catalog constructors
// ============================================================================

/** The full HKT Central seed catalog (all existing data migrated here). */
function centralBranchCatalog(): BranchCatalog {
  return {
    tiers: seedTiers,
    ticketTypes: seedTicketTypes,
    addOns: seedAddOns,
    menuItems: seedMenuItems,
    menuCategories: seedMenuCategories,
    modifierGroups: seedModifierGroups,
    merchItems: seedMerchItems,
    inventory: seedInventory,
    stockLocations: seedStockLocations,
    eventDropInPricing: seedEventDropInPricing,
    taxConfig: seedTaxConfig,
    supervisionPolicy: seedSupervisionPolicy,
    discounts: seedDiscounts,
    printTemplates: seedPrintTemplates,
    devices: seedDevices,
    edcTerminals: seedEdcTerminals,
  };
}

/** A minimal empty catalog for a new branch until it is edited or cloned. */
function emptyBranchCatalog(): BranchCatalog {
  return {
    // Tiers are kept minimal (same base 3) so the POS doesn't break if someone
    // accidentally tries to use an empty-catalog branch without cloning.
    tiers: seedTiers.map((t) => ({ ...t })),
    ticketTypes: [],
    addOns: [],
    menuItems: [],
    menuCategories: [],
    modifierGroups: [],
    merchItems: [],
    inventory: [],
    stockLocations: [...seedStockLocations],
    eventDropInPricing: { campDayTHB: wwp(0), eventDayTHB: wwp(0), partyGuestTHB: wwp(0) },
    taxConfig: {
      rates: [],
      categoryRules: ALL_TAXABLE_CATEGORIES.map((category) => ({
        category,
        taxMode: 'none' as const,
        serviceChargePercent: 0,
        taxOnServiceCharge: false,
      })),
      discountPlacement: 'before_tax',
    },
    supervisionPolicy: {
      bands: [],
      siblingWaiver: { enabled: false, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
      confirmations: [],
    },
    discounts: [],
    printTemplates: [],
    devices: [],
    edcTerminals: [],
  };
}

// ============================================================================
// Internal state shape
// ============================================================================

interface InternalState {
  branches: Branch[];
  // Per-branch catalog keyed by branchId.  All catalog/config getters read from
  // branchCatalogs[_activeBranchId]; mutators write to the same key.
  branchCatalogs: Record<string, BranchCatalog>;
  // --- Global (not per-branch) ---
  discountReasons: string[];
  paymentMethods: PaymentMethod[];
  dropOffPricing: DropOffPricing;
  pricingOverrides: PricingOverride[];
  roleBenefitTemplates: RoleBenefitTemplate[];
}

let state: InternalState = {
  branches: seedBranches,
  branchCatalogs: {
    'hkt-central': centralBranchCatalog(),
    'hkt-chalong': emptyBranchCatalog(),
  },
  discountReasons: seedDiscountReasons,
  paymentMethods: seedPaymentMethods,
  dropOffPricing: seedDropOffPricing,
  pricingOverrides: seedPricingOverrides,
  roleBenefitTemplates: seedRoleBenefitTemplates,
};

// ============================================================================
// Public CatalogState (flat snapshot — unchanged interface, backward compat)
// ============================================================================

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

// ============================================================================
// Subscription primitive (for useSyncExternalStore)
// ============================================================================

const listeners = new Set<() => void>();
let _snapshotCache: CatalogState | null = null;

function invalidateSnapshot(): void {
  _snapshotCache = null;
}

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

export function subscribeCatalog(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Active branch catalog, falling back to an empty one if branchId is stale. */
function activeCatalog(): BranchCatalog {
  return state.branchCatalogs[_activeBranchId] ?? emptyBranchCatalog();
}

/** Inventory items for the active branch with session stock deltas applied. */
function activeInventoryWithDeltas(): InventoryItem[] {
  return activeCatalog().inventory.map((item) =>
    applyBranchDeltas(item, _activeBranchId)
  );
}

/**
 * Returns a stable flat CatalogState built from the active branch's catalog.
 * getCatalogSnapshot builds it lazily; invalidateSnapshot resets the cache
 * whenever the active branch changes or a mutation occurs.
 */
export function getCatalogSnapshot(): CatalogState {
  if (!_snapshotCache) {
    const bc = activeCatalog();
    _snapshotCache = {
      branches: state.branches,
      tiers: bc.tiers,
      ticketTypes: bc.ticketTypes,
      addOns: bc.addOns,
      menuItems: bc.menuItems,
      menuCategories: bc.menuCategories,
      merchItems: bc.merchItems,
      modifierGroups: bc.modifierGroups,
      discounts: bc.discounts,
      discountReasons: state.discountReasons,
      paymentMethods: state.paymentMethods,
      dropOffPricing: state.dropOffPricing,
      eventDropInPricing: bc.eventDropInPricing,
      pricingOverrides: state.pricingOverrides,
      edcTerminals: bc.edcTerminals,
      devices: bc.devices,
      taxConfig: bc.taxConfig,
      supervisionPolicy: bc.supervisionPolicy,
      printTemplates: bc.printTemplates,
      inventory: activeInventoryWithDeltas(),
      stockLocations: bc.stockLocations,
      roleBenefitTemplates: state.roleBenefitTemplates,
    };
  }
  return _snapshotCache;
}

// ============================================================================
// Internal commit helpers
// ============================================================================

/** Commit a patch to the ACTIVE branch's catalog. */
function commitBranch(patch: Partial<BranchCatalog>): void {
  const bc = activeCatalog();
  state = {
    ...state,
    branchCatalogs: {
      ...state.branchCatalogs,
      [_activeBranchId]: { ...bc, ...patch },
    },
  };
  invalidateSnapshot();
  notifyListeners();
}

/** Commit a patch to the global (non-branch) state fields. */
function commitGlobal(patch: Partial<Pick<InternalState, 'branches' | 'discountReasons' | 'paymentMethods' | 'dropOffPricing' | 'pricingOverrides' | 'roleBenefitTemplates'>>): void {
  state = { ...state, ...patch };
  invalidateSnapshot();
  notifyListeners();
}

// ============================================================================
// Branch registry getters + mutators
// ============================================================================

export const getBranches = (): Branch[] => state.branches;

export const getActiveBranch = (): Branch =>
  state.branches.find((b) => b.id === _activeBranchId) ?? state.branches[0];

/**
 * Switch the active branch. Called by BranchContext when the user picks a
 * different location. Invalidates the snapshot so getCatalogSnapshot() rebuilds
 * from the new branch's catalog on the next call.
 */
export const setActiveBranch = (id: string): void => {
  if (state.branches.some((b) => b.id === id) && _activeBranchId !== id) {
    _activeBranchId = id;
    invalidateSnapshot();
    notifyListeners();
  }
};

/**
 * Add or update a branch in the registry.  If the branch is new (no existing
 * catalog entry), an empty catalog is initialized so the POS doesn't crash.
 */
export const upsertBranch = (branch: Branch): void => {
  const newBranches = upsertById(state.branches, branch);
  const catalogs = state.branchCatalogs;
  const newCatalogs =
    catalogs[branch.id] != null
      ? catalogs
      : { ...catalogs, [branch.id]: emptyBranchCatalog() };
  state = { ...state, branches: newBranches, branchCatalogs: newCatalogs };
  invalidateSnapshot();
  notifyListeners();
};

// ============================================================================
// Per-branch catalog getters
// All read from the active branch's BranchCatalog.
// ============================================================================

export const getTiers = (): TierDef[] =>
  [...activeCatalog().tiers].sort((a, b) => a.sortOrder - b.sortOrder);
export const getTier = (id: string): TierDef | undefined =>
  activeCatalog().tiers.find((t) => t.id === id);
export const getDefaultTier = (): TierDef =>
  activeCatalog().tiers.find((t) => t.isDefault) ?? getTiers()[0];

export const getTicketTypes = (): TicketType[] => activeCatalog().ticketTypes;
export const getAddOns = (): AddOn[] => activeCatalog().addOns;
export const getMenuItems = (): MenuItem[] => activeCatalog().menuItems;

function resolveItemStock(item: MerchItem): MerchItem {
  if (!item.inventoryItemId) return item;
  const invItem = getInventoryItem(item.inventoryItemId);
  if (!invItem) return item;
  const variant =
    invItem.variants.find((v) => v.id === INVENTORY_DEFAULT_VARIANT_ID) ?? invItem.variants[0];
  if (!variant) return item;
  return {
    ...item,
    stock: variant.stock,
    lowStockThreshold: variant.lowStockThreshold,
    // Photo only surfaces on the POS tile when explicitly enabled in Admin.
    ...(invItem.photoUrl && invItem.showPhotoInPos ? { photoUrl: invItem.photoUrl } : {}),
  };
}

export const getMerchItems = (): MerchItem[] =>
  activeCatalog().merchItems.map(resolveItemStock);
export const getActiveMerchItems = (): MerchItem[] =>
  activeCatalog().merchItems.filter((m) => m.active).map(resolveItemStock);

export const getInventory = (): InventoryItem[] => activeInventoryWithDeltas();
export const getInventoryItem = (id: string): InventoryItem | undefined => {
  const item = activeCatalog().inventory.find((i) => i.id === id);
  return item ? applyBranchDeltas(item, _activeBranchId) : undefined;
};

export const getMenuCategories = (): MenuCategoryDef[] =>
  [...activeCatalog().menuCategories].sort((a, b) => a.sortOrder - b.sortOrder);
export const getModifierGroups = (): ModifierGroup[] => activeCatalog().modifierGroups;
export const getDiscounts = (): Discount[] => activeCatalog().discounts;
export const getDiscountReasons = (): string[] => state.discountReasons; // global
export const getPaymentMethods = (): PaymentMethod[] =>
  [...state.paymentMethods].sort((a, b) => a.sortOrder - b.sortOrder); // global
export const getDropOffPricing = (): DropOffPricing => state.dropOffPricing; // global
export const getEventDropInPricing = (): EventDropInPricing =>
  activeCatalog().eventDropInPricing;
export const getPricingOverrides = (): PricingOverride[] => state.pricingOverrides; // global
export const getRoleBenefitTemplates = (): RoleBenefitTemplate[] => state.roleBenefitTemplates; // global
export const getRoleBenefitTemplate = (role: RoleBenefitTemplate['role']): RoleBenefitTemplate | undefined =>
  state.roleBenefitTemplates.find((t) => t.role === role);
export const getEdcTerminals = (): EdcTerminal[] => activeCatalog().edcTerminals;
export const getAvailableDevices = (): Device[] => activeCatalog().devices;
export const getTaxConfig = (): TaxConfig => activeCatalog().taxConfig;
export const getSupervisionPolicy = (): SupervisionPolicy =>
  activeCatalog().supervisionPolicy;
export const getPrintTemplates = (): PrintTemplate[] => activeCatalog().printTemplates;
export const getPrintTemplate = (type: PrintTemplateType): PrintTemplate | undefined =>
  activeCatalog().printTemplates.find((t) => t.type === type);

// ============================================================================
// Internal helpers
// ============================================================================

const upsertById = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

const removeById = <T extends { id: string }>(list: T[], id: string): T[] =>
  list.filter((x) => x.id !== id);

// ============================================================================
// Per-branch catalog mutators (all write to the ACTIVE branch)
// ============================================================================

export const upsertTier = (t: TierDef): void => {
  let next = upsertById(activeCatalog().tiers, t);
  if (t.isDefault) {
    next = next.map((x) => (x.id === t.id ? x : { ...x, isDefault: false }));
  } else if (!next.some((x) => x.isDefault)) {
    next = next.map((x) => (x.id === t.id ? { ...x, isDefault: true } : x));
  }
  commitBranch({ tiers: next });
};
export const deleteTier = (id: string): void =>
  commitBranch({ tiers: removeById(activeCatalog().tiers, id) });

export const upsertTicketType = (t: TicketType): void =>
  commitBranch({ ticketTypes: upsertById(activeCatalog().ticketTypes, t) });
export const deleteTicketType = (id: string): void =>
  commitBranch({ ticketTypes: removeById(activeCatalog().ticketTypes, id) });

export const upsertAddOn = (a: AddOn): void =>
  commitBranch({ addOns: upsertById(activeCatalog().addOns, a) });
export const deleteAddOn = (id: string): void =>
  commitBranch({ addOns: removeById(activeCatalog().addOns, id) });

export const upsertMenuItem = (m: MenuItem): void =>
  commitBranch({ menuItems: upsertById(activeCatalog().menuItems, m) });
export const deleteMenuItem = (id: string): void =>
  commitBranch({ menuItems: removeById(activeCatalog().menuItems, id) });

export const upsertMerchItem = (m: MerchItem): void =>
  commitBranch({ merchItems: upsertById(activeCatalog().merchItems, m) });
export const deleteMerchItem = (id: string): void =>
  commitBranch({ merchItems: removeById(activeCatalog().merchItems, id) });

/**
 * Adjust stock for an inventory variant. When the variant has `stockByLocation`
 * the adjustment targets the sell-point (rotation) location by default, or the
 * specified `locationId`. Without a location the legacy total delta is used.
 * All paths clamp to 0 so stock never goes negative.
 */
export const adjustInventoryStock = (
  inventoryItemId: string,
  variantId: string,
  delta: number,
  locationId?: string,
): void => {
  const item = activeCatalog().inventory.find((i) => i.id === inventoryItemId);
  if (!item) return;
  const variant = item.variants.find((v) => v.id === variantId);
  if (!variant) return;
  const branchId = _activeBranchId;

  if (variant.stockByLocation) {
    // Per-location mode: find target location (default = sell-point / rotation)
    const targetLocId = locationId ??
      activeCatalog().stockLocations.find((l) => l.sellPoint)?.id ??
      STOCK_LOC_ROT;
    // Positive deltas (receiving) may land in a location the variant has never
    // stocked before — the delta map handles the missing key. Negative deltas
    // still require a known location so sales can't drain a phantom bucket.
    if (delta < 0 && !(targetLocId in variant.stockByLocation)) return;
    if (!_locationStockDeltas.has(branchId)) _locationStockDeltas.set(branchId, new Map());
    const locMap = _locationStockDeltas.get(branchId)!;
    const qtyAt = (locId: string): number => {
      const base = variant.stockByLocation![locId] ?? 0;
      const d = locMap.get(`${inventoryItemId}:${variantId}:${locId}`) ?? 0;
      return Math.max(0, base + d);
    };
    const applyAt = (locId: string, d: number): void => {
      const key = `${inventoryItemId}:${variantId}:${locId}`;
      locMap.set(key, (locMap.get(key) ?? 0) + d);
    };

    if (delta >= 0) {
      // Restore / receive: all of it lands in the target location.
      applyAt(targetLocId, delta);
    } else {
      // Decrement (sale): sale flows validate availability against TOTAL stock,
      // so the total must always drop by the sold qty. Take from the target
      // (sell-point) location first, then cascade the remainder through the
      // other locations — clamping each at 0 so no location goes negative.
      let remaining = -delta;
      const order = [
        targetLocId,
        ...Object.keys(variant.stockByLocation).filter((id) => id !== targetLocId),
      ];
      for (const locId of order) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, qtyAt(locId));
        if (take > 0) {
          applyAt(locId, -take);
          remaining -= take;
        }
      }
    }
  } else {
    // Legacy mode: total delta only
    const key = `${inventoryItemId}:${variantId}`;
    if (!_branchStockDeltas.has(branchId)) _branchStockDeltas.set(branchId, new Map());
    const branchMap = _branchStockDeltas.get(branchId)!;
    const currentDelta = branchMap.get(key) ?? 0;
    const currentStock = Math.max(0, variant.stock + currentDelta);
    const clampedDelta = Math.max(-currentStock, delta);
    branchMap.set(key, currentDelta + clampedDelta);
  }

  invalidateSnapshot();
  notifyListeners();
};

/**
 * Transfer up to `qty` eaches of a variant from one location to another within
 * the active branch. Clamps to the actual available qty at fromLocation so the
 * ledger never records more than what physically moved.
 *
 * Returns the actual qty moved (0 = nothing moved — source empty, invalid args,
 * or locations identical). Callers MUST log the returned value, not the
 * requested value, to keep the audit trail accurate.
 */
export const transferStockBetweenLocations = (
  inventoryItemId: string,
  variantId: string,
  fromLocationId: string,
  toLocationId: string,
  qty: number,
): number => {
  if (qty <= 0 || fromLocationId === toLocationId) return 0;
  const item = activeCatalog().inventory.find((i) => i.id === inventoryItemId);
  if (!item) return 0;
  const variant = item.variants.find((v) => v.id === variantId);
  if (!variant?.stockByLocation) return 0;
  const branchId = _activeBranchId;
  if (!_locationStockDeltas.has(branchId)) _locationStockDeltas.set(branchId, new Map());
  const locMap = _locationStockDeltas.get(branchId)!;

  // Read current from-location stock (baseline + in-session delta) to clamp correctly
  const fromKey = `${inventoryItemId}:${variantId}:${fromLocationId}`;
  const toKey   = `${inventoryItemId}:${variantId}:${toLocationId}`;
  const fromBase    = variant.stockByLocation[fromLocationId] ?? 0;
  const fromDelta   = locMap.get(fromKey) ?? 0;
  const fromCurrent = Math.max(0, fromBase + fromDelta);
  const actualQty   = Math.min(qty, fromCurrent); // clamp to what is actually available
  if (actualQty <= 0) return 0;

  locMap.set(fromKey, fromDelta - actualQty);
  const toDelta = locMap.get(toKey) ?? 0;
  locMap.set(toKey, toDelta + actualQty);

  invalidateSnapshot();
  notifyListeners();
  return actualQty; // always the exact qty that moved, never more than requested
};

/**
 * Replenish stock into a specific location (receive delivery). Writes the
 * qty into the target location and notifies listeners. The caller is
 * responsible for logging to the RestockLog.
 */
export const replenishStockToLocation = (
  inventoryItemId: string,
  variantId: string,
  locationId: string,
  qty: number,
): void => {
  if (qty <= 0) return;
  const item = activeCatalog().inventory.find((i) => i.id === inventoryItemId);
  if (!item) return;
  const variant = item.variants.find((v) => v.id === variantId);
  if (!variant) return;
  const branchId = _activeBranchId;

  if (variant.stockByLocation) {
    const locKey = `${inventoryItemId}:${variantId}:${locationId}`;
    if (!_locationStockDeltas.has(branchId)) _locationStockDeltas.set(branchId, new Map());
    const locMap = _locationStockDeltas.get(branchId)!;
    locMap.set(locKey, (locMap.get(locKey) ?? 0) + qty);
  } else {
    // Legacy: add to total
    const key = `${inventoryItemId}:${variantId}`;
    if (!_branchStockDeltas.has(branchId)) _branchStockDeltas.set(branchId, new Map());
    const branchMap = _branchStockDeltas.get(branchId)!;
    branchMap.set(key, (branchMap.get(key) ?? 0) + qty);
  }

  invalidateSnapshot();
  notifyListeners();
};

/**
 * Commit a stock-take correction: set the location's stock to the counted qty.
 * Computes the delta from current stock and applies it. Used after manager sign-off
 * on flagged discrepancies (or auto-commit for small ones).
 * Returns the applied delta (0 if no change needed).
 */
export const commitStockTakeCorrection = (
  inventoryItemId: string,
  variantId: string,
  locationId: string,
  countedQty: number,
): number => {
  // Read current with deltas applied
  const withDeltas = activeInventoryWithDeltas();
  const item = withDeltas.find((i) => i.id === inventoryItemId);
  if (!item) return 0;
  const variant = item.variants.find((v) => v.id === variantId);
  if (!variant) return 0;

  const currentQty = variant.stockByLocation
    ? (variant.stockByLocation[locationId] ?? 0)
    : variant.stock;
  const delta = countedQty - currentQty;
  if (delta === 0) return 0;

  if (variant.stockByLocation) {
    const branchId = _activeBranchId;
    const locKey = `${inventoryItemId}:${variantId}:${locationId}`;
    if (!_locationStockDeltas.has(branchId)) _locationStockDeltas.set(branchId, new Map());
    const locMap = _locationStockDeltas.get(branchId)!;
    locMap.set(locKey, (locMap.get(locKey) ?? 0) + delta);
  } else {
    adjustInventoryStock(inventoryItemId, variantId, delta);
    return delta;
  }

  invalidateSnapshot();
  notifyListeners();
  return delta;
};

// --- Stock location getters + mutators ------------------------------------

export const getStockLocations = (): StockLocation[] =>
  activeCatalog().stockLocations.filter((l) => l.active);

export const getAllStockLocations = (): StockLocation[] =>
  activeCatalog().stockLocations;

export const getSellPointLocation = (): StockLocation | undefined =>
  activeCatalog().stockLocations.find((l) => l.sellPoint && l.active);

export const upsertStockLocation = (loc: StockLocation): void =>
  commitBranch({ stockLocations: upsertById(activeCatalog().stockLocations, loc) });

/**
 * Mark a specific location as the rotation sell-point, clearing the flag from
 * all other locations. Enforces "exactly one sell-point per branch" invariant.
 *
 * Guards:
 *   - The target location must exist, be active, and have type 'rotation'.
 *   - Only rotation locations can be the sell point (non-rotation locations
 *     do not decrement from sale flows, so a non-rotation sell point would
 *     silently route sale decrements to a location never replenished from FOH).
 *
 * Returns true on success, false if the guard rejected the call.
 */
export const setStockLocationSellPoint = (locationId: string): boolean => {
  const locs = activeCatalog().stockLocations;
  const target = locs.find((l) => l.id === locationId);
  if (!target) return false;
  if (target.type !== 'rotation') return false;
  if (!target.active) return false;
  commitBranch({
    stockLocations: locs.map((l) => ({
      ...l,
      sellPoint: l.id === locationId ? true : undefined,
    })),
  });
  return true;
};

export const upsertInventoryItem = (item: InventoryItem): void =>
  commitBranch({ inventory: upsertById(activeCatalog().inventory, item) });
export const deleteInventoryItem = (id: string): void =>
  commitBranch({ inventory: removeById(activeCatalog().inventory, id) });

export const adjustMerchStock = (id: string, delta: number): MerchItem | undefined => {
  const item = activeCatalog().merchItems.find((m) => m.id === id);
  if (!item) return undefined;
  if (item.inventoryItemId) {
    adjustInventoryStock(item.inventoryItemId, INVENTORY_DEFAULT_VARIANT_ID, delta);
    return resolveItemStock(item);
  }
  const next: MerchItem = { ...item, stock: Math.max(0, (item.stock ?? 0) + delta) };
  commitBranch({ merchItems: upsertById(activeCatalog().merchItems, next) });
  return next;
};

export const upsertMenuCategory = (c: MenuCategoryDef): void =>
  commitBranch({ menuCategories: upsertById(activeCatalog().menuCategories, c) });
export const deleteMenuCategory = (id: string): void =>
  commitBranch({ menuCategories: removeById(activeCatalog().menuCategories, id) });

export const upsertModifierGroup = (g: ModifierGroup): void =>
  commitBranch({ modifierGroups: upsertById(activeCatalog().modifierGroups, g) });
export const deleteModifierGroup = (id: string): void =>
  commitBranch({ modifierGroups: removeById(activeCatalog().modifierGroups, id) });

export const upsertDiscount = (d: Discount): void => {
  const bc = activeCatalog();
  const i = bc.discounts.findIndex(
    (x) => x.code.toUpperCase() === d.code.toUpperCase()
  );
  if (i === -1) {
    commitBranch({ discounts: [...bc.discounts, d] });
  } else {
    const next = bc.discounts.slice();
    next[i] = d;
    commitBranch({ discounts: next });
  }
};
export const deleteDiscount = (code: string): void =>
  commitBranch({
    discounts: activeCatalog().discounts.filter(
      (x) => x.code.toUpperCase() !== code.toUpperCase()
    ),
  });

export const incrementPromoUsage = (code: string, phone?: string): void => {
  const bc = activeCatalog();
  const i = bc.discounts.findIndex(
    (x) => x.code.toUpperCase() === code.toUpperCase()
  );
  if (i === -1) return;
  const promo = bc.discounts[i];
  const prevUsage = promo.perCustomerUsage ?? {};
  const perCustomerUsage: Record<string, number> =
    phone
      ? { ...prevUsage, [phone]: (prevUsage[phone] ?? 0) + 1 }
      : prevUsage;
  const next = bc.discounts.slice();
  next[i] = { ...promo, usedCount: (promo.usedCount ?? 0) + 1, perCustomerUsage };
  commitBranch({ discounts: next });
};

// --- Global mutators -------------------------------------------------------

export const setDiscountReasons = (reasons: string[]): void =>
  commitGlobal({ discountReasons: reasons });

export const upsertPaymentMethod = (m: PaymentMethod): void =>
  commitGlobal({ paymentMethods: upsertById(state.paymentMethods, m) });
export const deletePaymentMethod = (id: string): void =>
  commitGlobal({ paymentMethods: removeById(state.paymentMethods, id) });

export const updateDropOffPricing = (patch: Partial<DropOffPricing>): void =>
  commitGlobal({ dropOffPricing: { ...state.dropOffPricing, ...patch } });

export const setRoleBenefitTemplate = (t: RoleBenefitTemplate): void =>
  commitGlobal({
    roleBenefitTemplates: state.roleBenefitTemplates.map((existing) =>
      existing.role === t.role ? t : existing
    ),
  });

export const upsertPricingOverride = (o: PricingOverride): void =>
  commitGlobal({ pricingOverrides: upsertById(state.pricingOverrides, o) });
export const deletePricingOverride = (id: string): void =>
  commitGlobal({ pricingOverrides: removeById(state.pricingOverrides, id) });

// --- Per-branch config mutators --------------------------------------------

export const updateEventDropInPricing = (patch: Partial<EventDropInPricing>): void =>
  commitBranch({ eventDropInPricing: { ...activeCatalog().eventDropInPricing, ...patch } });

export const updateTaxConfig = (patch: Partial<TaxConfig>): void =>
  commitBranch({ taxConfig: { ...activeCatalog().taxConfig, ...patch } });

export const updateSupervisionPolicy = (patch: Partial<SupervisionPolicy>): void =>
  commitBranch({ supervisionPolicy: { ...activeCatalog().supervisionPolicy, ...patch } });

export const upsertEdcTerminal = (t: EdcTerminal): void =>
  commitBranch({ edcTerminals: upsertById(activeCatalog().edcTerminals, t) });
export const deleteEdcTerminal = (id: string): void =>
  commitBranch({ edcTerminals: removeById(activeCatalog().edcTerminals, id) });

export const upsertDevice = (d: Device): void =>
  commitBranch({ devices: upsertById(activeCatalog().devices, d) });
export const deleteDevice = (id: string): void =>
  commitBranch({ devices: removeById(activeCatalog().devices, id) });

export const upsertPrintTemplate = (t: PrintTemplate): void =>
  commitBranch({ printTemplates: upsertById(activeCatalog().printTemplates, t) });
export const deletePrintTemplate = (id: string): void =>
  commitBranch({ printTemplates: removeById(activeCatalog().printTemplates, id) });

// ============================================================================
// Clone branch catalog
// ============================================================================
// Deep-copies the source branch's entire BranchCatalog into the target branch
// with freshly generated IDs so the two catalogs are fully independent afterward.
// Cross-references (inventoryItemId, linkedModifierGroupIds, parentId, etc.) are
// remapped using the same id translation table so the cloned catalog is coherent.
// ============================================================================

/** Result returned to callers so they can show an audit stamp in the UI. */
export interface CloneResult {
  sourceBranchId: string;
  targetBranchId: string;
  at: string; // ISO
}

/**
 * Deep-copy the source branch's BranchCatalog into the target branch,
 * regenerating all IDs so the two branches are fully independent after the clone.
 * Returns a CloneResult stamp that callers can show as an audit entry.
 *
 * This overwrites whatever catalog the target branch currently has — callers
 * must confirm with the user before calling when the target is non-empty.
 */
export const cloneBranchCatalog = (
  sourceBranchId: string,
  targetBranchId: string,
): CloneResult => {
  const source = state.branchCatalogs[sourceBranchId] ?? emptyBranchCatalog();

  // Unique suffix for this clone operation — keeps IDs recognisably related
  // to their originals while guaranteeing uniqueness.
  const sfx = Math.random().toString(36).slice(2, 7);
  const remap = (oldId: string): string => `${oldId}--${sfx}`;

  // Build translation tables for every collection that other collections
  // cross-reference.
  const invIdMap: Record<string, string> = {};
  source.inventory.forEach((i) => { invIdMap[i.id] = remap(i.id); });

  const modGroupIdMap: Record<string, string> = {};
  source.modifierGroups.forEach((g) => { modGroupIdMap[g.id] = remap(g.id); });

  const catIdMap: Record<string, string> = {};
  source.menuCategories.forEach((c) => { catIdMap[c.id] = remap(c.id); });

  const ticketIdMap: Record<string, string> = {};
  source.ticketTypes.forEach((t) => { ticketIdMap[t.id] = remap(t.id); });

  const addOnIdMap: Record<string, string> = {};
  source.addOns.forEach((a) => { addOnIdMap[a.id] = remap(a.id); });

  // --- Clone each collection with remapped IDs ---

  const clonedTiers: TierDef[] = source.tiers.map((t) => ({ ...t }));

  const clonedTicketTypes: TicketType[] = source.ticketTypes.map((t) => ({
    ...t,
    id: ticketIdMap[t.id],
    freebies: t.freebies?.map((f) => ({
      ...f,
      id: remap(f.id),
      addOnId: f.addOnId ? (addOnIdMap[f.addOnId] ?? f.addOnId) : undefined,
    })),
  }));

  const clonedAddOns: AddOn[] = source.addOns.map((a) => ({
    ...a,
    id: addOnIdMap[a.id],
    inventoryItemId: a.inventoryItemId ? (invIdMap[a.inventoryItemId] ?? a.inventoryItemId) : undefined,
  }));

  const clonedModifierGroups: ModifierGroup[] = source.modifierGroups.map((g) => ({
    ...g,
    id: modGroupIdMap[g.id],
    options: g.options.map((o) => ({ ...o, id: remap(o.id) })),
  }));

  const clonedMenuCategories: MenuCategoryDef[] = source.menuCategories.map((c) => ({
    ...c,
    id: catIdMap[c.id],
    parentId: c.parentId ? (catIdMap[c.parentId] ?? c.parentId) : undefined,
  }));

  const clonedMenuItems: MenuItem[] = source.menuItems.map((m) => ({
    ...m,
    id: remap(m.id),
    category: catIdMap[m.category] ?? m.category,
    inventoryItemId: m.inventoryItemId
      ? (invIdMap[m.inventoryItemId] ?? m.inventoryItemId)
      : undefined,
    linkedModifierGroupIds: m.linkedModifierGroupIds?.map(
      (lid) => modGroupIdMap[lid] ?? lid
    ),
    modifierGroups: m.modifierGroups?.map((mg) => ({
      ...mg,
      id: remap(mg.id),
      options: mg.options.map((o) => ({ ...o, id: remap(o.id) })),
    })),
  }));

  const clonedMerchItems: MerchItem[] = source.merchItems.map((m) => ({
    ...m,
    id: remap(m.id),
    inventoryItemId: m.inventoryItemId
      ? (invIdMap[m.inventoryItemId] ?? m.inventoryItemId)
      : undefined,
  }));

  // Build a reverse map from source location id → cloned location id, so that
  // stockByLocation and parByLocation keys are rewritten to match the new ids.
  const locIdMap: Record<string, string> = {};
  source.stockLocations.forEach((l, _idx) => {
    locIdMap[l.id] = remap(l.id);
  });
  const remapLocKeys = (obj: Record<string, number> | undefined): Record<string, number> | undefined => {
    if (!obj) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[locIdMap[k] ?? k] = v;
    }
    return out;
  };

  const clonedInventory: InventoryItem[] = source.inventory.map((item) => ({
    ...item,
    id: invIdMap[item.id],
    // linkedId cross-refs AddOn/MerchItem/MenuItem ids — remap from their maps.
    linkedId: (() => {
      if (item.linkedKind === 'addon') return addOnIdMap[item.linkedId] ?? item.linkedId;
      if (item.linkedKind === 'merch') return remap(item.linkedId); // merch ids remapped above
      if (item.linkedKind === 'menu') return remap(item.linkedId);  // menu ids remapped above
      return item.linkedId;
    })(),
    variants: item.variants.map((v) => ({
      ...v,
      stockByLocation: remapLocKeys(v.stockByLocation),
      parByLocation: remapLocKeys(v.parByLocation),
    })),
  }));

  const clonedDiscounts: Discount[] = source.discounts.map((d) => ({
    ...d,
    perCustomerUsage: { ...(d.perCustomerUsage ?? {}) },
    target: d.target
      ? ((): typeof d.target => {
          const tgt = d.target!;
          if (tgt.kind === 'ticketType') {
            return { ...tgt, ticketTypeId: ticketIdMap[tgt.ticketTypeId] ?? tgt.ticketTypeId };
          }
          if (tgt.kind === 'addOn') {
            return { ...tgt, addOnId: addOnIdMap[tgt.addOnId] ?? tgt.addOnId };
          }
          if (tgt.kind === 'menuItems') {
            return { ...tgt, menuItemIds: tgt.menuItemIds.map((id) => remap(id)) };
          }
          return { ...tgt };
        })()
      : undefined,
  }));

  const clonedPrintTemplates: PrintTemplate[] = source.printTemplates.map((t) => ({
    ...t,
    id: remap(t.id),
    fields: { ...t.fields },
  }));

  const clonedDevices: Device[] = source.devices.map((d) => ({
    ...d,
    id: remap(d.id),
  }));

  const clonedEdcTerminals: EdcTerminal[] = source.edcTerminals.map((t) => ({
    ...t,
    id: remap(t.id),
  }));

  const clonedStockLocations: StockLocation[] = source.stockLocations.map((l) => ({
    ...l,
    id: remap(l.id),
  }));

  const cloned: BranchCatalog = {
    tiers: clonedTiers,
    ticketTypes: clonedTicketTypes,
    addOns: clonedAddOns,
    menuItems: clonedMenuItems,
    menuCategories: clonedMenuCategories,
    modifierGroups: clonedModifierGroups,
    merchItems: clonedMerchItems,
    inventory: clonedInventory,
    stockLocations: clonedStockLocations,
    eventDropInPricing: { ...source.eventDropInPricing },
    taxConfig: {
      rates: source.taxConfig.rates.map((r) => ({ ...r })),
      categoryRules: source.taxConfig.categoryRules.map((r) => ({ ...r })),
      discountPlacement: source.taxConfig.discountPlacement,
    },
    supervisionPolicy: {
      bands: source.supervisionPolicy.bands.map((b) => ({ ...b })),
      siblingWaiver: { ...source.supervisionPolicy.siblingWaiver },
      confirmations: source.supervisionPolicy.confirmations.map((c) => ({ ...c })),
    },
    discounts: clonedDiscounts,
    printTemplates: clonedPrintTemplates,
    devices: clonedDevices,
    edcTerminals: clonedEdcTerminals,
  };

  state = {
    ...state,
    branchCatalogs: { ...state.branchCatalogs, [targetBranchId]: cloned },
  };
  // Clear session stock deltas for the target branch so the fresh inventory
  // baseline is used from scratch (the cloned catalog has the full stock figures).
  _branchStockDeltas.delete(targetBranchId);
  _locationStockDeltas.delete(targetBranchId);
  invalidateSnapshot();
  notifyListeners();

  return { sourceBranchId, targetBranchId, at: new Date().toISOString() };
};

/**
 * Returns true if the target branch's catalog has any non-empty collections
 * (i.e., the user will be OVERWRITING existing data). Used by the UI to decide
 * whether to show a confirmation before calling cloneBranchCatalog.
 */
export const branchHasCatalogData = (branchId: string): boolean => {
  const bc = state.branchCatalogs[branchId];
  if (!bc) return false;
  return (
    bc.ticketTypes.length > 0 ||
    bc.menuItems.length > 0 ||
    bc.addOns.length > 0 ||
    bc.discounts.length > 0 ||
    bc.devices.length > 0 ||
    bc.edcTerminals.length > 0 ||
    bc.printTemplates.length > 0 ||
    bc.inventory.length > 0
  );
};

// ============================================================================
// Platform-API hydration (Sprint 1 rebuild)
// ============================================================================
// The API is now the source of truth for branches + the wired collections
// (tiers, ticket types, holidays, tax config). This injects server data into
// the store so every ported screen keeps reading the same snapshot shape;
// collections still on mock (menu, merch, inventory, …) keep their seeds.

export function hydrateFromApi(data: {
  /** Omit to keep the current branch list (public /book hydration). */
  branches?: Branch[];
  /** Patches keyed by branch slug (Branch.id). */
  perBranch: Record<string, Partial<BranchCatalog>>;
  pricingOverrides?: PricingOverride[];
}): void {
  const branchCatalogs = { ...state.branchCatalogs };
  for (const [slug, patch] of Object.entries(data.perBranch)) {
    branchCatalogs[slug] = { ...(branchCatalogs[slug] ?? emptyBranchCatalog()), ...patch };
  }
  state = {
    ...state,
    ...(data.branches ? { branches: data.branches } : {}),
    branchCatalogs,
    ...(data.pricingOverrides ? { pricingOverrides: data.pricingOverrides } : {}),
  };
  if (!state.branches.some((b) => b.id === _activeBranchId) && state.branches[0]) {
    _activeBranchId = state.branches[0].id;
  }
  invalidateSnapshot();
  notifyListeners();
}
