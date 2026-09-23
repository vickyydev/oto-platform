import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, pos, timestamps } from './helpers';
import { branch, operator } from './tenancy';
import { stockItem } from './future';

// --- The catalogue (schema `pos`) ------------------------------------------
// What the till sells and the rules that price it. It sits with the sales it
// prices rather than with tenancy configuration: a package, its holiday
// calendar and its tax rules are only ever read together, and only by the POS.

/**
 * Where an F&B prep ticket prints. `none` means the item prints no prep ticket
 * at all — a pre-packaged snack handed straight over (prototype
 * `types.ts:711`).
 */
export const PREP_STATIONS = ['kitchen', 'bar', 'none'] as const;
export type PrepStation = (typeof PREP_STATIONS)[number];

/**
 * The taxable areas of the business — the same list as `TAXABLE_CATEGORIES` in
 * `@oto/shared` (`catalog-shapes.ts`), repeated here because a schema file
 * states its own vocabulary rather than importing the API's.
 */
export const TAXABLE_CATEGORIES = [
  'tickets',
  'fnb',
  'bar',
  'drop_off',
  'parties',
  'addons',
  'merch',
  'stored_value',
] as const;
export type TaxableCategory = (typeof TAXABLE_CATEGORIES)[number];

// --- Ticket packages -------------------------------------------------------
// Shape follows the prototype's approved pricing model (ARCHITECTURE.md D1),
// not the flat columns sketched in CLAUDE.md §4: per-tier kid prices as
// {weekday, weekend} satang pairs, per-tier adult rules, optional derivation
// rules / freebies / F&B credit rule. The jsonb payloads are validated by zod
// schemas in @oto/shared (catalog-shapes) at the API boundary.

export const ticketPackage = pos.table(
  'ticket_package',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    name: text('name').notNull(),
    description: text('description'),
    /** e.g. "1 Hour", "All Day + Meal" (prototype durationLabel). */
    durationLabel: text('duration_label').notNull(),
    /** Play duration in hours (prototype `hours`; drives later nanny pricing). */
    hours: integer('hours').notNull(),
    /** Record<tierCode, {weekday, weekend}> — satang. */
    prices: jsonb('prices').notNull(),
    /** Record<tierCode, TierPriceRule> — how non-base tiers derive from base. */
    tierPricing: jsonb('tier_pricing'),
    /** Record<tierCode, TierAdultRule> — same_as_kid | set_price | free_adults. */
    adultRules: jsonb('adult_rules'),
    /** TicketFreebie[] — free adults/children/add-ons bundled into the rate. */
    freebies: jsonb('freebies'),
    /** TicketCreditRule — F&B credit give-back (replaces §4 wallet_credit_amount). */
    creditRule: jsonb('credit_rule'),
    /** Wristband gate rights (prototype boolean today; jsonb-ready later). */
    gateAccess: boolean('gate_access').notNull().default(false),
    /** Display-only translations keyed by language. */
    translations: jsonb('translations'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('ticket_package_operator_idx').on(t.operatorId),
    index('ticket_package_branch_idx').on(t.branchId),
    /**
     * NOT partial, and SCRUM-273 is the ticket to make it so — an archived
     * package holds its name for ever today. It is left alone here because the
     * change is two files, not one: the seed upserts a package with `ON
     * CONFLICT (branch_id, name)`, and Postgres will not infer a partial index
     * for that unless the same predicate is named in the conflict target.
     */
    uniqueIndex('ticket_package_name_unique').on(t.branchId, t.name),
  ],
);

/** Named inclusive date range that bills at weekend rates (prototype PricingOverride). */
export const branchHoliday = pos.table(
  'branch_holiday',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    ...timestamps,
    /** Withdrawn rather than deleted (S2-01b): last year's calendar still has
     *  to explain last year's prices. */
    ...archivedAt,
  },
  (t) => [index('branch_holiday_branch_idx').on(t.branchId), index('branch_holiday_dates_idx').on(t.startsOn, t.endsOn)],
);

// --- Tax -------------------------------------------------------------------
// The prototype's accountant-specified engine (ARCHITECTURE.md D3): a named
// rate table + per-taxable-category rules + discount placement, stored as one
// config row per branch. `tax_override` (CLAUDE.md §4) then applies
// product-category / product precedence on top.

export const branchTaxConfig = pos.table(
  'branch_tax_config',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    /** TaxConfig: { rates: TaxRate[], categoryRules: CategoryTaxRule[], discountPlacement }. */
    config: jsonb('config').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('branch_tax_config_unique').on(t.branchId)],
);

// --- The menu ---------------------------------------------------------------
// `product_category` and `product` stop being the five-field placeholders
// Sprint 1 created and become the menu the prototype already describes
// (`imports/oto-pos/artifacts/oto-till/src/types.ts:711-771` and `:1007-1030`,
// seeded in `store/catalogStore.ts:328-489`). They keep their names because the
// sale ledger, the tax resolver and the box sync already join on them.
//
// Two fields here are NOT in the approved design, and both are the price of a
// safe spreadsheet import (SCRUM-232):
//   - `code`, a stable short key. Matching an imported row on the display name
//     would silently create a second item the first time one is renamed, and
//     leave the old one on the till.
//   - `archived_at`, because the menu screen deletes outright and a sold item
//     has to stay referenceable by the orders that sold it.

/**
 * An editable menu category. Two levels: `parent_id` null is a top-level tab,
 * `parent_id` set is one of its sub-categories.
 *
 * The prototype's rule is that a parent is itself top-level — no
 * grand-children (`types.ts:717-729`). The check below only rules out a
 * category parenting itself; the depth rule belongs to the menu service and
 * the import validator, neither of which is written yet (SCRUM-232).
 */
export const productCategory = pos.table(
  'product_category',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    /**
     * The stable key sheet 2 of the import workbook carries (`FOOD`,
     * `FOOD-MAINS`). Nullable because the categories seeded before this column
     * existed have none, and because the menu form does not ask for one — the
     * import does.
     */
    code: text('code'),
    name: text('name').notNull(),
    /** Null = a top-level tab. Set = a sub-category of that tab. */
    parentId: uuid('parent_id').references((): AnyPgColumn => productCategory.id, {
      onDelete: 'restrict',
    }),
    /**
     * Which taxable area this category's items fall under. **Null only on a
     * sub-category**, which then inherits its parent's — the check below holds
     * a top-level category to a concrete value, as the prototype does
     * (`types.ts:726-729`, resolved by `lib/menu.ts:68-78`).
     */
    taxableCategory: text('taxable_category').$type<TaxableCategory>(),
    /**
     * Where this category's prep tickets print by default, overridable per
     * item. Null anywhere in the chain resolves to `kitchen` — the prototype's
     * own fallback (`lib/menu.ts:92`) — so this is nullable at every level
     * rather than backfilled with a station nobody chose.
     */
    defaultPrepStation: text('default_prep_station').$type<PrepStation>(),
    /** Tab order within its level (top-level row, or within a parent). */
    sortOrder: integer('sort_order').notNull().default(0),
    /** Partial<Record<lang, { name, description? }>> — display only. */
    translations: jsonb('translations'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('product_category_operator_idx').on(t.operatorId),
    index('product_category_parent_idx').on(t.parentId),
    /** Partial: withdrawing a category frees its code for the one replacing it. */
    uniqueIndex('product_category_code_unique')
      .on(t.operatorId, t.code)
      .where(sql`code is not null and archived_at is null`),
    check('product_category_parent_not_self_check', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    check(
      'product_category_top_level_taxable_check',
      sql`${t.parentId} is not null or ${t.taxableCategory} is not null`,
    ),
    check(
      'product_category_taxable_check',
      sql`${t.taxableCategory} is null or ${t.taxableCategory} in ('tickets','fnb','bar','drop_off','parties','addons','merch','stored_value')`,
    ),
    check(
      'product_category_prep_station_check',
      sql`${t.defaultPrepStation} is null or ${t.defaultPrepStation} in ('kitchen','bar','none')`,
    ),
  ],
);

/**
 * What kind of thing a catalogue row is.
 *
 * One table, because the prototype's three shapes are the same shape: `MenuItem`
 * (`types.ts:752`), `MerchItem` (`:1007`) and `AddOn` (`:212`) each carry a
 * name, a weekday/weekend price, an optional cost, an optional inventory link,
 * an optional tax-category override and translations. Merch adds a SKU; the
 * menu adds a prep station and modifier groups. Splitting them would also fork
 * an id space the sale ledger already treats as one: `sale_line.product_id`
 * resolves a ticket add-on and an F&B line against the same table
 * (`services/sale.ts:85`, `:528-572`).
 */
export const PRODUCT_KINDS = ['menu', 'merch', 'addon'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/**
 * One size of a product — the owner's decision of 2026-09-24 (S2-09b): the
 * shop's grip socks come in S, M and L, the till asks which, and the sale line
 * records the one sold.
 *
 * The same shape as `ProductVariantSchema` in `@oto/shared` (`menu-shapes.ts`),
 * repeated here because a schema file states its own vocabulary rather than
 * importing the API's.
 */
export interface ProductVariant {
  /** Stable within its product — `s`, `m`, `l`. What a sale line records. */
  id: string;
  /** What the size picker, the cart and the receipt say — `S`, `M`, `L`. */
  label: string;
  /** This size's own stock-keeping code, when it has one. */
  sku?: string;
  /** The code printed on this size's tag. A scan of it adds this size. */
  barcode?: string;
}

export const product = pos.table(
  'product',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    categoryId: uuid('category_id').references(() => productCategory.id),
    kind: text('kind').$type<ProductKind>().notNull().default('menu'),
    /**
     * The stable short key the import matches a row on, ahead of the display
     * name and behind the id (SCRUM-232). Nullable: whether every item must
     * carry one is the owner's open question, and a menu item created in the
     * form has no field to type it into yet.
     */
    code: text('code'),
    name: text('name').notNull(),
    /**
     * The base (English) description. New: the prototype has nowhere to put one
     * but `translations.en.description`.
     */
    description: text('description'),
    /**
     * The weekday price, in satang. This is *the* price for an item that does
     * not vary by day, which is every F&B item the prototype seeds.
     */
    priceSatang: integer('price_satang').notNull().default(0),
    /**
     * The weekend and holiday price, in satang. **Null means the same as
     * `price_satang`** — the prototype's `wwp(weekday, weekend = weekday)`
     * (`store/catalogStore.ts:36`), and the import sheet's blank weekend cell.
     */
    priceWeekendSatang: integer('price_weekend_satang'),
    /** Cost to the park (COGS), satang. Null = not tracked (prototype `cost?`). */
    costSatang: integer('cost_satang'),
    /** Overrides the category's prep station. Null = inherit (`lib/menu.ts:85-94`). */
    prepStationOverride: text('prep_station_override').$type<PrepStation>(),
    /** Overrides the category's taxable area. Null = inherit (`lib/menu.ts:101-110`). */
    taxCategoryOverride: text('tax_category_override').$type<TaxableCategory>(),
    /** Partial<Record<lang, { name, description? }>> — display only. */
    translations: jsonb('translations'),
    /**
     * Barcode / stock-keeping unit, for the WHOLE item. Merch carries one; the
     * menu does not. A size's own barcode is on the size, in `variants`.
     */
    sku: text('sku'),
    /**
     * The sizes this item is sold in (`ProductVariant[]`). `[]` for an item
     * that comes in one size, which sells exactly as it did before sizes
     * existed — and so does an item with a single size.
     *
     * jsonb rather than a table because nothing is priced or counted per size
     * yet: a size is a label, an id a sale line can record, and optionally the
     * barcode on its tag. Stock per size is S2-14b, and a priced or counted
     * size is when a row earns a table of its own.
     *
     * The database holds only the shape it can check: an array. What is not a
     * shape — ids and labels unique within the item, a barcode naming one thing
     * across the operator's live items and sizes — is held where sizes are
     * written through the API, `apps/api/src/services/product-variants.ts`.
     */
    variants: jsonb('variants').$type<ProductVariant[]>().notNull().default([]),
    /** The prototype's `inventoryItemId`: set = stock-tracked, null = not. */
    stockItemId: uuid('stock_item_id').references(() => stockItem.id, { onDelete: 'restrict' }),
    /** Order within its category on the sell grid. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** False = withdrawn from the sell surface but still on the menu and in past orders. */
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('product_operator_idx').on(t.operatorId),
    index('product_branch_idx').on(t.branchId),
    index('product_category_idx').on(t.categoryId),
    index('product_kind_idx').on(t.operatorId, t.kind),
    index('product_stock_item_idx').on(t.stockItemId),
    /**
     * The import's matching key, and the reason a re-import updates rather than
     * duplicates. Partial on both columns: a code is optional, and archiving an
     * item frees its code for the one that replaces it.
     */
    uniqueIndex('product_code_unique')
      .on(t.operatorId, t.code)
      .where(sql`code is not null and archived_at is null`),
    uniqueIndex('product_sku_unique')
      .on(t.operatorId, t.sku)
      .where(sql`sku is not null and archived_at is null`),
    /**
     * The scanner's second question, after "is this an item's own barcode":
     * "is it one of an item's sizes" — `variants @> '[{"barcode": …}]'`, which
     * `jsonb_path_ops` answers from the index.
     */
    index('product_variants_idx').using('gin', t.variants.op('jsonb_path_ops')),
    check('product_kind_check', sql`${t.kind} in ('menu','merch','addon')`),
    check('product_variants_array_check', sql`jsonb_typeof(${t.variants}) = 'array'`),
    check('product_price_check', sql`${t.priceSatang} >= 0`),
    check(
      'product_price_weekend_check',
      sql`${t.priceWeekendSatang} is null or ${t.priceWeekendSatang} >= 0`,
    ),
    check('product_cost_check', sql`${t.costSatang} is null or ${t.costSatang} >= 0`),
    check(
      'product_prep_station_check',
      sql`${t.prepStationOverride} is null or ${t.prepStationOverride} in ('kitchen','bar','none')`,
    ),
    check(
      'product_tax_category_check',
      sql`${t.taxCategoryOverride} is null or ${t.taxCategoryOverride} in ('tickets','fnb','bar','drop_off','parties','addons','merch','stored_value')`,
    ),
  ],
);

// --- Modifiers --------------------------------------------------------------
// "How would you like your steak?" and its answers. The prototype holds these
// two ways (`types.ts:742-762`): INLINE on one item, and a shared LIBRARY an
// item links to by id. Both are rows here, told apart by `product_id`: set =
// inline to that item, null = a library group any item may link to.
//
// Options are rows rather than jsonb because each one is priced, and a priced
// thing that a sale line can point at belongs in a table.

export const MODIFIER_SELECTION_TYPES = ['single', 'multi'] as const;
export type ModifierSelectionType = (typeof MODIFIER_SELECTION_TYPES)[number];

export const modifierGroup = pos.table(
  'modifier_group',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    /** Set = inline to this item. Null = a shared library group. */
    productId: uuid('product_id').references(() => product.id, { onDelete: 'restrict' }),
    /** The question put to the guest, e.g. "Ice" or "Extra toppings". */
    name: text('name').notNull(),
    required: boolean('required').notNull().default(false),
    selectionType: text('selection_type')
      .$type<ModifierSelectionType>()
      .notNull()
      .default('single'),
    /** Only meaningful on a `multi` group (prototype `min?` / `max?`). */
    minSelect: integer('min_select'),
    maxSelect: integer('max_select'),
    sortOrder: integer('sort_order').notNull().default(0),
    translations: jsonb('translations'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('modifier_group_operator_idx').on(t.operatorId),
    index('modifier_group_product_idx').on(t.productId),
    /**
     * The import sheet names a library group by its name (`Ice level; Milk`),
     * so two live library groups may not share one. Inline groups are excluded:
     * they are addressed through their item, and two items may both have an
     * "Ice" of their own.
     */
    uniqueIndex('modifier_group_library_name_unique')
      .on(t.operatorId, t.name)
      .where(sql`product_id is null and archived_at is null`),
    check(
      'modifier_group_selection_type_check',
      sql`${t.selectionType} in ('single','multi')`,
    ),
    check(
      'modifier_group_bounds_check',
      sql`(${t.minSelect} is null or ${t.minSelect} >= 0) and (${t.maxSelect} is null or ${t.maxSelect} >= 1) and (${t.minSelect} is null or ${t.maxSelect} is null or ${t.maxSelect} >= ${t.minSelect})`,
    ),
    /** A single-choice group is exactly one; bounds belong to `multi`. */
    check(
      'modifier_group_single_no_bounds_check',
      sql`${t.selectionType} = 'multi' or (${t.minSelect} is null and ${t.maxSelect} is null)`,
    ),
  ],
);

export const modifierOption = pos.table(
  'modifier_option',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    modifierGroupId: uuid('modifier_group_id')
      .notNull()
      .references(() => modifierGroup.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * The weekday delta added to the item price, in satang. Zero is free —
     * "No ice" and "Well done" are options that cost nothing, not options that
     * are unpriced.
     */
    priceSatang: integer('price_satang').notNull().default(0),
    /** Weekend/holiday delta. Null = the same as `price_satang` (`wwp`). */
    priceWeekendSatang: integer('price_weekend_satang'),
    /** Cost to the park for this option, satang. Null = not tracked. */
    costSatang: integer('cost_satang'),
    sortOrder: integer('sort_order').notNull().default(0),
    translations: jsonb('translations'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('modifier_option_operator_idx').on(t.operatorId),
    index('modifier_option_group_idx').on(t.modifierGroupId),
    uniqueIndex('modifier_option_name_unique')
      .on(t.modifierGroupId, t.name)
      .where(sql`archived_at is null`),
    check('modifier_option_price_check', sql`${t.priceSatang} >= 0`),
    check(
      'modifier_option_price_weekend_check',
      sql`${t.priceWeekendSatang} is null or ${t.priceWeekendSatang} >= 0`,
    ),
    check('modifier_option_cost_check', sql`${t.costSatang} is null or ${t.costSatang} >= 0`),
  ],
);

/**
 * An item's links into the shared modifier library — the prototype's
 * `MenuItem.linkedModifierGroupIds` (`types.ts:762`).
 *
 * A link is configuration rather than a business record, so removing one is a
 * delete and there is no `archived_at`: nothing a sale points at is lost, since
 * the group and its options stay.
 */
export const productModifierGroup = pos.table(
  'product_modifier_group',
  {
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),
    modifierGroupId: uuid('modifier_group_id')
      .notNull()
      .references(() => modifierGroup.id, { onDelete: 'restrict' }),
    /** Order the linked groups are asked in, after the item's inline ones. */
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.modifierGroupId] }),
    index('product_modifier_group_operator_idx').on(t.operatorId),
    index('product_modifier_group_group_idx').on(t.modifierGroupId),
  ],
);

// --- Payment methods --------------------------------------------------------
// S2-10a (SCRUM-206). The tenders the park takes money in, which the prototype
// keeps in browser memory (`catalogStore.ts:786-790`, three rows: cash, card,
// promptpay) behind an admin panel that edits them and loses them on refresh.
//
// TWO RULES PORTED FROM THE PROTOTYPE, and both are the reason this is a table
// rather than a constant:
//
//   - **The tender list is data, never hardcoded** (`lib/payments.ts:17`). The
//     till's method grid is sized from this list, so a park that stops taking
//     PromptPay unticks a row.
//   - **Behaviour keys off `kind`, never off the token** (`lib/payments.ts:41,
//     56,65`), so a second card acquirer or a renamed wallet is a row and not a
//     branch in the code.
//
// OPERATOR-WIDE, not per branch: the prototype says so in as many words —
// "paymentMethods (same physical tenders everywhere)", `catalogStore.ts:71`.
//
// `code` is the token stored on the money row (`pos.payment_attempt
// .method_code`), and `pos.payment_attempt.method` is the behaviour word the
// ledger groups by. The two are separate because "PromptPay" is a name the park
// chose and `qr` is what the platform does about it.

/** What a tender DOES. The same four words as `PAYMENT_METHOD_KINDS` in `@oto/shared`. */
export const PAYMENT_METHOD_KINDS = ['cash', 'card', 'qr', 'other'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export const paymentMethod = pos.table(
  'payment_method',
  {
    id: idPk(),
    /** `restrict`, as every tenancy column on the money tables is: a tender list is not deletable history. */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /**
     * The token written onto the money row — `cash`, `card`, `promptpay`. The
     * prototype's `makeId` can never re-mint `credit_card`
     * (`PaymentMethodsSection.tsx:20-33`) because a legacy token still resolves
     * to `card` on read (`normalizePaymentMethod`); that rule stays in the POS,
     * and this column holds whatever the operator's list actually says.
     */
    code: text('code').notNull(),
    /** What the till's button says. */
    label: text('label').notNull(),
    kind: text('kind').$type<PaymentMethodKind>().notNull(),
    /**
     * Unticked rather than deleted is the ordinary way a tender leaves the
     * till: a disabled method disappears from the method grid, while every sale
     * that already names it still reads back correctly.
     *
     * The grid is the whole of the enforcement today. `finaliseSale` reads this
     * row for a tender's KIND and does not ask whether it is ticked, so a call
     * that names a disabled token is still recorded; refusing one is the admin
     * half of this ticket, not a property of the column.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Reorder is a swap of two of these (`PaymentMethodsSection.tsx:69-77`). */
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('payment_method_operator_idx').on(t.operatorId),
    /**
     * PARTIAL, where the ticket's own sketch said a plain `unique(operator_id,
     * code)`: archiving a tender has to free its token for a later one
     * (SCRUM-273's rule, already followed by every other archivable list here),
     * and a total unique index would make "PromptPay, archived in March" the
     * permanent owner of `promptpay`. A reader looking for the constraint by
     * name will find it; a reader counting on it to hold across archived rows
     * will not.
     */
    uniqueIndex('payment_method_code_unique')
      .on(t.operatorId, t.code)
      .where(sql`archived_at is null`),
    check('payment_method_kind_check', sql`${t.kind} in ('cash','card','qr','other')`),
    check('payment_method_code_check', sql`${t.code} ~ '^[a-z0-9_]{1,40}$'`),
  ],
);

// --- Discount codes ---------------------------------------------------------
// SCRUM-230 (register P10): `STAFF10`, `MEMBER20`, `SAVE100` and `ICECREAM` are
// mock rows in the prototype's catalog store, their usage counters live in
// browser memory, and no code is checked anywhere but the browser.
//
// This is the definition only. What a code took on a given sale is already
// recorded by `pos.sale_discount` (`sales.ts:661`), which carries the code, the
// amount and how it was allocated — so a redemption count is a query over
// rows, not a counter this table increments.
//
// Distinct from `promo.voucher_definition`: a voucher is an issued instrument
// with its own lifecycle (drawn on the wheel, printed, redeemed once). A
// discount code is a rule typed or scanned at the till.

export const DISCOUNT_KINDS = ['percent', 'fixed', 'free_item'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export const discountDefinition = pos.table(
  'discount_definition',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    /** Null = every branch of the operator. Set = that branch only. */
    branchId: uuid('branch_id').references(() => branch.id),
    /** What staff or the guest types or scans, e.g. `STAFF10`. */
    code: text('code').notNull(),
    /** What the receipt and the report call it, e.g. "Staff Discount". */
    label: text('label').notNull(),
    kind: text('kind').$type<DiscountKind>().notNull(),
    /** Basis points for `percent` — 1000 is 10 %. Integers only (D4). */
    valueBp: integer('value_bp'),
    /** Satang for `fixed`. */
    valueSatang: integer('value_satang'),
    /** What a `free_item` hands over. Menu or merch — both are `product` rows. */
    freeProductId: uuid('free_product_id').references(() => product.id, {
      onDelete: 'restrict',
    }),
    /**
     * `DiscountTarget` (prototype `types.ts:254-265`) — what the code applies
     * to, from `{kind:'everything'}` down to one named menu item. Null = the
     * whole order, which is what the prototype means by an absent target.
     */
    target: jsonb('target'),
    /** Inclusive; null = no bound at that end. */
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
    /** Null = unlimited (prototype `usageLimit?` / `perCustomerLimit?`). */
    usageLimit: integer('usage_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    /**
     * False = exclusive. The prototype's rule is that to apply more than one
     * code to a cart every applied code must be stackable, so the default is
     * the restrictive one.
     */
    stackable: boolean('stackable').notNull().default(false),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('discount_definition_operator_idx').on(t.operatorId),
    index('discount_definition_branch_idx').on(t.branchId),
    index('discount_definition_free_product_idx').on(t.freeProductId),
    /** Partial: retiring a campaign frees its code for a later one. */
    uniqueIndex('discount_definition_code_unique')
      .on(t.operatorId, t.code)
      .where(sql`archived_at is null`),
    check('discount_definition_kind_check', sql`${t.kind} in ('percent','fixed','free_item')`),
    /** A percentage above 100 % is a typo, not a discount. */
    check(
      'discount_definition_value_bp_check',
      sql`${t.valueBp} is null or (${t.valueBp} >= 0 and ${t.valueBp} <= 10000)`,
    ),
    check(
      'discount_definition_value_satang_check',
      sql`${t.valueSatang} is null or ${t.valueSatang} >= 0`,
    ),
    /** Each kind carries the value it is priced by, and a free item names one. */
    check(
      'discount_definition_value_for_kind_check',
      sql`(${t.kind} = 'percent' and ${t.valueBp} is not null) or (${t.kind} = 'fixed' and ${t.valueSatang} is not null) or (${t.kind} = 'free_item' and ${t.freeProductId} is not null)`,
    ),
    check(
      'discount_definition_validity_check',
      sql`${t.validFrom} is null or ${t.validUntil} is null or ${t.validUntil} >= ${t.validFrom}`,
    ),
    check(
      'discount_definition_usage_limit_check',
      sql`(${t.usageLimit} is null or ${t.usageLimit} > 0) and (${t.perCustomerLimit} is null or ${t.perCustomerLimit} > 0)`,
    ),
  ],
);

/**
 * VAT / service-charge override for a product category or a single product.
 * Resolver precedence (SCRUM-37): product > category > branch config rule.
 */
export const taxOverride = pos.table(
  'tax_override',
  {
    id: idPk(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    categoryId: uuid('category_id').references(() => productCategory.id),
    productId: uuid('product_id').references(() => product.id),
    /** Basis points, e.g. 700 = 7%. Null = keep the resolved value. */
    vatRateBp: integer('vat_rate_bp'),
    serviceChargeBp: integer('service_charge_bp'),
    ...timestamps,
  },
  (t) => [
    index('tax_override_branch_idx').on(t.branchId),
    index('tax_override_category_idx').on(t.categoryId),
    index('tax_override_product_idx').on(t.productId),
  ],
);
