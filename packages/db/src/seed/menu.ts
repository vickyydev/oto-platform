/**
 * The menu, the shop and the discount codes (SCRUM-232, SCRUM-230).
 *
 * Almost every row here is the prototype's own demo catalogue, lifted from
 * `imports/oto-pos/artifacts/oto-till/src/store/catalogStore.ts:260-489`: seven
 * menu categories, twenty menu items with their modifier groups, eight retail
 * items, five ticket add-ons, the three shared modifier groups and the four
 * discount codes. Nothing here comes from the park's live catalogue. The one
 * addition is the grip socks' three sizes and the barcode on the M — see the
 * comment on `MR-SOCKS`.
 *
 * Two things it demonstrates on purpose:
 *
 *   - **Not one item sets a weekend price.** `price_weekend_satang` is null
 *     throughout, which is the prototype's `wwp(weekday, weekend = weekday)`
 *     (`catalogStore.ts:36`) and the import sheet's blank weekend cell. The pair
 *     exists on the type; the park has never used it.
 *   - **Sub-categories leave the prep station and the taxable area unset**, so
 *     Mains, Light Bites and Coffee resolve theirs from Food and Drinks.
 *
 * It is keyed on `code` and safe to re-run: a row whose code is already there is
 * left exactly as it is.
 */
import { newId, satangFromBaht } from '@oto/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';
import type { PrepStation, ProductVariant, TaxableCategory } from '../schema/catalog';

const b = satangFromBaht;

interface CategorySeed {
  code: string;
  name: string;
  parent?: string;
  taxable?: TaxableCategory;
  prep?: PrepStation;
  sort: number;
}

/**
 * The prototype's seven F&B categories, plus a home for the shop and the ticket
 * add-ons. Merch categories are the free-text labels `MerchItem.category`
 * carries (`types.ts:1027`) made into real rows, which is the point of the
 * reshape; the add-on category is where the 'addons' taxable area the tax
 * config already rules on (`packages/shared/catalog-shapes.ts`) attaches to the
 * items that belong to it.
 */
const CATEGORIES: CategorySeed[] = [
  { code: 'FOOD', name: 'Food', taxable: 'fnb', prep: 'kitchen', sort: 0 },
  { code: 'DRINKS', name: 'Drinks', taxable: 'fnb', prep: 'bar', sort: 1 },
  { code: 'BAR', name: 'Bar', taxable: 'bar', prep: 'bar', sort: 2 },
  { code: 'SNACKS', name: 'Snacks', taxable: 'fnb', prep: 'kitchen', sort: 3 },
  // Sub-categories: prep station and taxable area deliberately unset.
  { code: 'FOOD-MAINS', name: 'Mains', parent: 'FOOD', sort: 0 },
  { code: 'FOOD-LIGHT', name: 'Light Bites', parent: 'FOOD', sort: 1 },
  { code: 'DRINKS-COFFEE', name: 'Coffee', parent: 'DRINKS', sort: 0 },
  { code: 'MERCH-APPAREL', name: 'Apparel', taxable: 'merch', prep: 'none', sort: 4 },
  { code: 'MERCH-ACCESSORIES', name: 'Accessories', taxable: 'merch', prep: 'none', sort: 5 },
  { code: 'MERCH-TOYS', name: 'Toys', taxable: 'merch', prep: 'none', sort: 6 },
  { code: 'ADDONS', name: 'Ticket add-ons', taxable: 'addons', prep: 'none', sort: 7 },
];

interface OptionSeed {
  name: string;
  baht?: number;
}

interface GroupSeed {
  name: string;
  required?: boolean;
  selectionType?: 'single' | 'multi';
  max?: number;
  options: OptionSeed[];
}

interface ItemSeed {
  code: string;
  name: string;
  category: string;
  baht: number;
  costBaht?: number;
  kind?: 'menu' | 'merch' | 'addon';
  sku?: string;
  /** The sizes it is sold in (`product.variants`). Absent = one size. */
  variants?: ProductVariant[];
  active?: boolean;
  translations?: Record<string, { name: string }>;
  /** Groups specific to this item (prototype `MenuItem.modifierGroups`). */
  groups?: GroupSeed[];
  /** Shared library groups by name (prototype `linkedModifierGroupIds`). */
  linked?: string[];
}

/** The prototype's "Ice" group, rebuilt per item exactly as `iceGroup()` does. */
const ice = (): GroupSeed => ({
  name: 'Ice',
  required: true,
  options: [{ name: 'Normal ice' }, { name: 'Less ice' }, { name: 'No ice' }],
});

const MENU: ItemSeed[] = [
  {
    code: 'FB-NUGGETS',
    name: 'Chicken Nuggets',
    category: 'FOOD-LIGHT',
    baht: 120,
    translations: {
      zh: { name: '鸡块' },
      th: { name: 'ไก่นักเก็ต' },
      ru: { name: 'Куриные наггетсы' },
      fr: { name: 'Nuggets de poulet' },
    },
  },
  {
    code: 'FB-FRIES',
    name: 'French Fries',
    category: 'FOOD',
    baht: 90,
    translations: {
      zh: { name: '薯条' },
      th: { name: 'เฟรนช์ฟรายส์' },
      ru: { name: 'Картофель фри' },
      fr: { name: 'Frites' },
    },
    groups: [
      {
        name: 'Sauces',
        selectionType: 'multi',
        max: 2,
        options: [{ name: 'Ketchup' }, { name: 'Mayo' }, { name: 'Cheese sauce', baht: 25 }],
      },
    ],
  },
  {
    code: 'FB-PIZZA',
    name: 'Margherita Pizza',
    category: 'FOOD-MAINS',
    baht: 220,
    groups: [
      {
        name: 'Extra toppings',
        selectionType: 'multi',
        options: [
          { name: 'Extra cheese', baht: 40 },
          { name: 'Mushrooms', baht: 30 },
          { name: 'Ham', baht: 50 },
          { name: 'Olives', baht: 30 },
        ],
      },
    ],
  },
  {
    code: 'FB-BURGER',
    name: 'Kids Beef Burger',
    category: 'FOOD-MAINS',
    baht: 180,
    groups: [
      {
        name: 'Cooked how?',
        required: true,
        options: [{ name: 'Rare' }, { name: 'Medium' }, { name: 'Well done' }],
      },
    ],
  },
  { code: 'FB-PADTHAI', name: 'Pad Thai', category: 'FOOD-MAINS', baht: 150 },
  { code: 'FB-HOTDOG', name: 'Hot Dog', category: 'FOOD', baht: 110 },
  { code: 'FB-WATER', name: 'Bottled Water', category: 'DRINKS', baht: 25 },
  { code: 'FB-JUICE', name: 'Fresh Orange Juice', category: 'DRINKS', baht: 70 },
  { code: 'FB-SODA', name: 'Soft Drink', category: 'DRINKS', baht: 45, groups: [ice()] },
  {
    code: 'FB-LATTE',
    name: 'Iced Latte',
    category: 'DRINKS-COFFEE',
    baht: 95,
    groups: [
      ice(),
      {
        name: 'Milk',
        options: [{ name: 'Regular' }, { name: 'Oat', baht: 25 }, { name: 'Soy', baht: 25 }],
      },
    ],
    // Not in the prototype's seed: one item linking a library group, so the
    // link table has a row and the resolver has something to resolve.
    linked: ['Sugar level'],
  },
  {
    code: 'FB-SHAKE',
    name: 'Chocolate Milkshake',
    category: 'DRINKS',
    baht: 120,
    groups: [
      {
        name: 'Size',
        required: true,
        options: [{ name: 'Regular' }, { name: 'Large', baht: 40 }],
      },
    ],
  },
  { code: 'FB-BEER', name: 'Chang Beer', category: 'BAR', baht: 110 },
  { code: 'FB-WINE', name: 'House Wine', category: 'BAR', baht: 180 },
  { code: 'FB-MOJITO', name: 'Mojito', category: 'BAR', baht: 200 },
  { code: 'FB-GINTONIC', name: 'Gin & Tonic', category: 'BAR', baht: 190 },
  { code: 'FB-POPCORN', name: 'Popcorn', category: 'SNACKS', baht: 60 },
  { code: 'FB-ICECREAM', name: 'Ice Cream Cone', category: 'SNACKS', baht: 50 },
  { code: 'FB-COTTONCANDY', name: 'Cotton Candy', category: 'SNACKS', baht: 70 },
  { code: 'FB-FRUITCUP', name: 'Fresh Fruit Cup', category: 'SNACKS', baht: 80 },
  { code: 'FB-SLUSHIE', name: 'Slushie', category: 'DRINKS', baht: 90 },

  // --- The shop (prototype `seedMerchItems`) --------------------------------
  { code: 'MR-TSHIRT', name: 'Oto T-Shirt', category: 'MERCH-APPAREL', baht: 350, costBaht: 120, kind: 'merch', sku: 'OTO-TS' },
  { code: 'MR-CAP', name: 'Oto Cap', category: 'MERCH-APPAREL', baht: 250, costBaht: 90, kind: 'merch', sku: 'OTO-CAP' },
  /**
   * The prototype's shop Grip Socks (`mr-socks`, `catalogStore.ts:483`), sold
   * here in sizes S, M and L — one product with sizes, which is the owner's
   * decision of 2026-09-24. The sizes come with that decision, not from the
   * prototype: its stock module counts these socks in one size, their stock
   * item `inv-mr-socks` holding a single default variant
   * (`catalogStore.ts:585`). The S, M and L it does count belong to the ticket
   * ADD-ON's grip socks (`inv-a-grip-socks`, `catalogStore.ts:617`) —
   * `AO-GRIPSOCKS` below, a separate product this seed gives no sizes.
   *
   * The M carries the one real barcode in this seed, `8850000000017`: S2-09b's
   * acceptance line is that a scan of it adds the socks in size M. It used to
   * be a product of its own ("Grip socks M", `MR-SOCKS-M`) because there was
   * nowhere under a product to put a size; that row is no longer seeded. The
   * seed leaves existing rows alone, so a database seeded before this keeps
   * that row until someone withdraws it — and while it is live the Merch panel
   * refuses to put the same barcode on this M, because a barcode names one
   * thing.
   *
   * `OTO-SOCK` stays the WHOLE item's code. It is not a barcode shape, so the
   * scanner never reads it, and it names no size. S and L carry no barcode:
   * the park has never printed one for them, and an invented number would be
   * a label nobody can scan.
   */
  {
    code: 'MR-SOCKS',
    name: 'Grip Socks',
    category: 'MERCH-APPAREL',
    baht: 120,
    costBaht: 35,
    kind: 'merch',
    sku: 'OTO-SOCK',
    variants: [
      { id: 's', label: 'S' },
      { id: 'm', label: 'M', barcode: '8850000000017' },
      { id: 'l', label: 'L' },
    ],
  },
  { code: 'MR-BOTTLE', name: 'Water Bottle', category: 'MERCH-ACCESSORIES', baht: 180, costBaht: 60, kind: 'merch', sku: 'OTO-BTL' },
  { code: 'MR-PLUSH', name: 'Oto Mascot Plush', category: 'MERCH-TOYS', baht: 450, costBaht: 160, kind: 'merch', sku: 'OTO-PLUSH' },
  { code: 'MR-STICKERS', name: 'Sticker Pack', category: 'MERCH-TOYS', baht: 60, costBaht: 12, kind: 'merch', sku: 'OTO-STK' },
  { code: 'MR-KEYRING', name: 'Mascot Keyring', category: 'MERCH-ACCESSORIES', baht: 90, costBaht: 25, kind: 'merch', sku: 'OTO-KEY' },
  /** Retired in the prototype's own seed — `active: false`, still in the catalogue. */
  { code: 'MR-LANYARD', name: 'Old Lanyard (retired)', category: 'MERCH-ACCESSORIES', baht: 70, costBaht: 20, kind: 'merch', sku: 'OTO-LAN', active: false },

  // --- Ticket add-ons (prototype `seedAddOns`) ------------------------------
  { code: 'AO-SOCKS', name: 'Regular Socks', category: 'ADDONS', baht: 50, kind: 'addon' },
  { code: 'AO-GRIPSOCKS', name: 'Grip Socks', category: 'ADDONS', baht: 80, kind: 'addon' },
  { code: 'AO-LOCKER', name: 'Locker Rental', category: 'ADDONS', baht: 100, kind: 'addon' },
  { code: 'AO-CUP', name: 'Refillable Drink Cup', category: 'ADDONS', baht: 150, kind: 'addon' },
  { code: 'AO-GLOW', name: 'Glow Band', category: 'ADDONS', baht: 60, kind: 'addon' },
];

/** The shared library — groups defined once and linked from any item. */
const LIBRARY: GroupSeed[] = [
  {
    name: 'Spice level',
    required: true,
    options: [{ name: 'Mild' }, { name: 'Medium' }, { name: 'Thai hot' }],
  },
  {
    name: 'Sugar level',
    options: [{ name: 'No sugar' }, { name: 'Half sweet' }, { name: 'Full sweet' }],
  },
  {
    name: 'Add-ons',
    selectionType: 'multi',
    max: 3,
    options: [
      { name: 'Extra cheese', baht: 30 },
      { name: 'Fried egg', baht: 25 },
      { name: 'Bacon', baht: 45 },
    ],
  },
];

/**
 * Seed the menu, the shop, the add-ons and the discount codes for one branch.
 *
 * Call it from the main seed after the branch exists:
 *   `await seedMenu(db, { operatorId, branchId });`
 */
export async function seedMenu(
  db: Db,
  scope: { operatorId: string; branchId: string },
): Promise<void> {
  const { operatorId, branchId } = scope;

  // --- Categories -----------------------------------------------------------
  const existingCats = await db
    .select({ id: s.productCategory.id, code: s.productCategory.code })
    .from(s.productCategory)
    .where(eq(s.productCategory.operatorId, operatorId));
  const catIdByCode = new Map<string, string>();
  for (const row of existingCats) if (row.code) catIdByCode.set(row.code, row.id);

  // Parents first: a sub-category's row carries its parent's id.
  for (const pass of [0, 1]) {
    const rows = CATEGORIES.filter((c) => (pass === 0 ? !c.parent : !!c.parent)).filter(
      (c) => !catIdByCode.has(c.code),
    );
    if (rows.length === 0) continue;
    const values = rows.map((c) => {
      const id = newId();
      catIdByCode.set(c.code, id);
      return {
        id,
        operatorId,
        code: c.code,
        name: c.name,
        parentId: c.parent ? (catIdByCode.get(c.parent) ?? null) : null,
        taxableCategory: c.taxable ?? null,
        defaultPrepStation: c.prep ?? null,
        sortOrder: c.sort,
      };
    });
    await db.insert(s.productCategory).values(values);
  }

  // --- The shared modifier library -----------------------------------------
  const libraryIdByName = await upsertGroups(db, operatorId, null, LIBRARY);

  // --- Items ----------------------------------------------------------------
  const existingItems = await db
    .select({ id: s.product.id, code: s.product.code })
    .from(s.product)
    .where(eq(s.product.operatorId, operatorId));
  const itemIdByCode = new Map<string, string>();
  for (const row of existingItems) if (row.code) itemIdByCode.set(row.code, row.id);

  const newItems = MENU.filter((i) => !itemIdByCode.has(i.code));
  if (newItems.length > 0) {
    const values = newItems.map((i, index) => {
      const id = newId();
      itemIdByCode.set(i.code, id);
      return {
        id,
        operatorId,
        branchId,
        categoryId: catIdByCode.get(i.category) ?? null,
        kind: i.kind ?? ('menu' as const),
        code: i.code,
        name: i.name,
        priceSatang: b(i.baht),
        // Left null on every row: the prototype's whole menu prices the same
        // on a Saturday as on a Tuesday.
        priceWeekendSatang: null,
        costSatang: i.costBaht === undefined ? null : b(i.costBaht),
        translations: i.translations ?? null,
        sku: i.sku ?? null,
        variants: i.variants ?? [],
        sortOrder: index,
        active: i.active ?? true,
      };
    });
    await db.insert(s.product).values(values);

    // Inline groups, then the links into the library, for the items just made.
    for (const i of newItems) {
      const productId = itemIdByCode.get(i.code);
      if (!productId) continue;
      if (i.groups?.length) await upsertGroups(db, operatorId, productId, i.groups);
      const links = (i.linked ?? [])
        .map((name, order) => ({ id: libraryIdByName.get(name), order }))
        .filter((l): l is { id: string; order: number } => !!l.id);
      if (links.length > 0) {
        await db.insert(s.productModifierGroup).values(
          links.map((l) => ({
            operatorId,
            productId,
            modifierGroupId: l.id,
            sortOrder: l.order,
          })),
        );
      }
    }
  }

  // --- Discount codes (SCRUM-230) ------------------------------------------
  const wanted = ['STAFF10', 'MEMBER20', 'SAVE100', 'ICECREAM'];
  const present = await db
    .select({ code: s.discountDefinition.code })
    .from(s.discountDefinition)
    .where(
      and(
        eq(s.discountDefinition.operatorId, operatorId),
        inArray(s.discountDefinition.code, wanted),
      ),
    );
  const have = new Set(present.map((r) => r.code));
  const iceCreamId = itemIdByCode.get('FB-ICECREAM') ?? null;

  const discounts = [
    {
      code: 'STAFF10',
      label: 'Staff Discount',
      kind: 'percent' as const,
      valueBp: 1000,
      stackable: true,
    },
    {
      code: 'MEMBER20',
      label: 'Member Discount',
      kind: 'percent' as const,
      valueBp: 2000,
      stackable: true,
    },
    {
      code: 'SAVE100',
      label: 'Promo Event',
      kind: 'fixed' as const,
      valueSatang: b(100),
      usageLimit: 50,
      perCustomerLimit: 1,
      validUntil: '2026-12-31',
    },
    // Scoped to the one item it gives away, which is what the prototype's
    // `target: { kind: 'menuItems', … }` says.
    ...(iceCreamId
      ? [
          {
            code: 'ICECREAM',
            label: 'Free Ice Cream',
            kind: 'free_item' as const,
            freeProductId: iceCreamId,
            target: { kind: 'menuItems', menuItemIds: [iceCreamId] },
            usageLimit: 100,
            perCustomerLimit: 1,
          },
        ]
      : []),
  ].filter((d) => !have.has(d.code));

  if (discounts.length > 0) {
    await db
      .insert(s.discountDefinition)
      .values(discounts.map((d) => ({ id: newId(), operatorId, ...d })));
  }
}

/**
 * Insert a set of modifier groups and their options, skipping any already
 * there. `productId` null makes them library groups; set makes them inline to
 * that item. Returns every group's id by name.
 */
async function upsertGroups(
  db: Db,
  operatorId: string,
  productId: string | null,
  groups: GroupSeed[],
): Promise<Map<string, string>> {
  const idByName = new Map<string, string>();
  const existing = await db
    .select({ id: s.modifierGroup.id, name: s.modifierGroup.name })
    .from(s.modifierGroup)
    .where(eq(s.modifierGroup.operatorId, operatorId));
  const existingLibrary = new Set(productId === null ? existing.map((g) => g.name) : []);
  for (const g of existing) if (productId === null) idByName.set(g.name, g.id);

  const fresh = groups.filter((g) => !existingLibrary.has(g.name));
  if (fresh.length === 0) return idByName;

  const prepared = fresh.map((g, index) => {
    const id = newId();
    idByName.set(g.name, id);
    const selectionType = g.selectionType ?? 'single';
    return {
      group: {
        id,
        operatorId,
        productId,
        name: g.name,
        required: g.required ?? false,
        selectionType,
        // The prototype puts min/max on a multi group only, and the schema's
        // check holds it to that.
        minSelect: null,
        maxSelect: selectionType === 'multi' ? (g.max ?? null) : null,
        sortOrder: index,
      },
      options: g.options.map((o, optionIndex) => ({
        id: newId(),
        operatorId,
        modifierGroupId: id,
        name: o.name,
        // Zero is free, not unpriced: "No ice" costs nothing on purpose.
        priceSatang: b(o.baht ?? 0),
        priceWeekendSatang: null,
        sortOrder: optionIndex,
      })),
    };
  });
  await db.insert(s.modifierGroup).values(prepared.map((p) => p.group));

  const optionRows = prepared.flatMap((p) => p.options);
  if (optionRows.length > 0) await db.insert(s.modifierOption).values(optionRows);

  return idByName;
}
