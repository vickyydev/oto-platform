import { z } from 'zod';
import { TaxableCategorySchema } from './catalog-shapes';
import { ProductStockLinkSchema } from './stock';

/**
 * The menu's API contract (SCRUM-232, SCRUM-204).
 *
 * Every rule below is the prototype's, read out of
 * `imports/oto-pos/artifacts/oto-till/src/`: `types.ts:711-771` for the menu
 * shapes, `:1007-1030` for the shop, `store/catalogStore.ts:36` for the
 * weekday/weekend pair, `lib/menu.ts` for the inheritance. What is new here is
 * the spreadsheet vocabulary, and only because a file a person edits has to
 * name its columns somewhere both the writer and the reader can see.
 */

export const PREP_STATIONS = ['kitchen', 'bar', 'none'] as const;
export const PrepStationSchema = z.enum(PREP_STATIONS);
export type PrepStation = z.infer<typeof PrepStationSchema>;

export const PRODUCT_KINDS = ['menu', 'merch', 'addon'] as const;
export const ProductKindSchema = z.enum(PRODUCT_KINDS);
export type ProductKind = z.infer<typeof ProductKindSchema>;

export const MODIFIER_SELECTION_TYPES = ['single', 'multi'] as const;
export const ModifierSelectionTypeSchema = z.enum(MODIFIER_SELECTION_TYPES);

export const DISCOUNT_KINDS = ['percent', 'fixed', 'free_item'] as const;
export const DiscountKindSchema = z.enum(DISCOUNT_KINDS);

/**
 * A stable short key: what the import matches a row on, ahead of the display
 * name and behind the id.
 *
 * Upper case is enforced rather than folded, so what a person typed in the
 * sheet is what appears on the screen afterwards — a code that silently
 * changes case reads as a different code the next time they look for it.
 */
export const CodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/, 'A code is 2–32 characters of A–Z, 0–9, hyphen or underscore');

/** Display-only translations, keyed by language (prototype `translations`). */
export const MenuTranslationsSchema = z.record(
  z.string(),
  z.object({ name: z.string().optional(), description: z.string().optional() }),
);
export type MenuTranslations = z.infer<typeof MenuTranslationsSchema>;

// --- Categories --------------------------------------------------------------

/**
 * Two levels, never three: `parentId` null is a top-level tab and a parent is
 * itself top-level (`types.ts:717-729`). The database refuses only a category
 * that parents itself; the depth is held here and in the menu service.
 *
 * `taxableCategory` and `defaultPrepStation` are optional because a
 * SUB-category inherits its parent's (`lib/menu.ts:52-78`). A top-level
 * category must carry a concrete taxable area — the service rejects one that
 * does not, and so does the database.
 */
export const MenuCategoryBodySchema = z.object({
  code: CodeSchema.nullable().optional(),
  name: z.string().trim().min(1).max(40),
  parentId: z.string().uuid().nullable().optional(),
  taxableCategory: TaxableCategorySchema.nullable().optional(),
  defaultPrepStation: PrepStationSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).default(0),
  translations: MenuTranslationsSchema.nullable().optional(),
});
export type MenuCategoryBody = z.infer<typeof MenuCategoryBodySchema>;

// --- Items -------------------------------------------------------------------

/** Satang, non-negative, and under the ceiling the sheet validates against. */
const PriceSatangSchema = z.number().int().min(0).max(10_000_000);

/**
 * One size of an item — `pos.product.variants`, the owner's decision of
 * 2026-09-24 (S2-09b). The grip socks come in S, M and L; the till asks which,
 * and the sale line records the one sold.
 *
 * `id` is what a sale line records, so it is stable: renaming a size changes
 * its `label` and keeps its `id`. Lower case, like the ids the seed gives the
 * socks (`s`, `m`, `l`).
 *
 * `barcode` is optional and is what the scanner reads off this size's tag; a
 * scan of it adds this item IN THIS SIZE. The item's own `sku` stays the code
 * for the whole item.
 *
 * Only the SHAPE is here. The rules that need the rest of the item or the rest
 * of the catalogue — ids and labels unique within the item, a barcode that is
 * digits, a barcode naming one thing across the operator — are the API's
 * (`services/product-variants.ts`), where they can answer in a sentence.
 */
export const ProductVariantSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'A size id is 1–32 characters of a–z, 0–9, hyphen or underscore',
    ),
  label: z.string().trim().min(1).max(24),
  sku: z.string().trim().min(1).max(64).nullish(),
  barcode: z.string().trim().min(1).max(64).nullish(),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

/** Every size an item comes in. Empty = one size, which sells as items always have. */
export const ProductVariantsSchema = z.array(ProductVariantSchema).max(24);

/**
 * One body for all three kinds, because the prototype's `MenuItem`,
 * `MerchItem` and `AddOn` are one shape — see the note on `product` in
 * `packages/db/src/schema/catalog.ts`.
 *
 * `priceWeekendSatang` null means "the same as weekday": the prototype's
 * `wwp(weekday, weekend = weekday)` (`catalogStore.ts:36`), and the sheet's
 * blank weekend cell.
 */
export const MenuItemBodySchema = z.object({
  kind: ProductKindSchema.default('menu'),
  code: CodeSchema.nullable().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  priceSatang: PriceSatangSchema,
  priceWeekendSatang: PriceSatangSchema.nullable().optional(),
  costSatang: PriceSatangSchema.nullable().optional(),
  prepStationOverride: PrepStationSchema.nullable().optional(),
  taxCategoryOverride: TaxableCategorySchema.nullable().optional(),
  translations: MenuTranslationsSchema.nullable().optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  /**
   * The sizes, as a whole list: what is sent replaces what was there, and an
   * empty list takes the sizes away. Absent leaves them as they are — the F&B
   * item form and the add-on form have no sizes to send.
   */
  variants: ProductVariantsSchema.optional(),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  /** Shared library groups this item asks, by id (prototype `linkedModifierGroupIds`). */
  modifierGroupIds: z.array(z.string().uuid()).optional(),
  /**
   * S2-14b — the stock items that stock this item at the route's branch, one
   * per size (`variantId` null for an item sold in one size). The list
   * replaces what was there; an empty list stops tracking stock; absent leaves
   * the links alone. The prototype's `inventoryItemId`, made real.
   */
  stockLinks: z.array(ProductStockLinkSchema).max(24).optional(),
});
export type MenuItemBody = z.infer<typeof MenuItemBodySchema>;

// --- Modifiers ---------------------------------------------------------------

export const ModifierOptionBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Zero is free — "No ice" costs nothing on purpose, it is not unpriced. */
  priceSatang: PriceSatangSchema.default(0),
  priceWeekendSatang: PriceSatangSchema.nullable().optional(),
  costSatang: PriceSatangSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).default(0),
  translations: MenuTranslationsSchema.nullable().optional(),
});
export type ModifierOptionBody = z.infer<typeof ModifierOptionBodySchema>;

/**
 * `productId` set makes the group inline to that item; null makes it a shared
 * library group any item may link (`types.ts:742-762`).
 *
 * The bounds belong to a `multi` group. A `single` group is exactly one
 * choice, which is what makes a minimum or a maximum on it meaningless — the
 * database holds the same line.
 */
export const ModifierGroupBodySchema = z
  .object({
    productId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(80),
    required: z.boolean().default(false),
    selectionType: ModifierSelectionTypeSchema.default('single'),
    minSelect: z.number().int().min(0).nullable().optional(),
    maxSelect: z.number().int().min(1).nullable().optional(),
    sortOrder: z.number().int().min(0).default(0),
    translations: MenuTranslationsSchema.nullable().optional(),
    options: z.array(ModifierOptionBodySchema).optional(),
  })
  .refine((g) => g.selectionType === 'multi' || (!g.minSelect && !g.maxSelect), {
    message: 'A single-choice group is exactly one answer, so it takes no minimum or maximum',
    path: ['maxSelect'],
  })
  .refine((g) => g.minSelect == null || g.maxSelect == null || g.maxSelect >= g.minSelect, {
    message: 'The maximum cannot be below the minimum',
    path: ['maxSelect'],
  });
export type ModifierGroupBody = z.infer<typeof ModifierGroupBodySchema>;

// --- Discount codes ----------------------------------------------------------

/**
 * The prototype's `DiscountTarget` (`types.ts:254-265`) — what a code applies
 * to. Null is the whole order, which is what an absent target means there.
 */
export const DiscountTargetSchema = z.object({
  kind: z.enum(['everything', 'tickets', 'fnb', 'merch', 'menuItems', 'categories']),
  menuItemIds: z.array(z.string()).optional(),
  categoryIds: z.array(z.string()).optional(),
});

export const DiscountDefinitionBodySchema = z
  .object({
    branchId: z.string().uuid().nullable().optional(),
    code: CodeSchema,
    label: z.string().trim().min(1).max(80),
    kind: DiscountKindSchema,
    /** Basis points for `percent` — 1000 is 10 %. */
    valueBp: z.number().int().min(0).max(10000).nullable().optional(),
    valueSatang: PriceSatangSchema.nullable().optional(),
    freeProductId: z.string().uuid().nullable().optional(),
    target: DiscountTargetSchema.nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    usageLimit: z.number().int().positive().nullable().optional(),
    perCustomerLimit: z.number().int().positive().nullable().optional(),
    stackable: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine((d) => d.kind !== 'percent' || d.valueBp != null, {
    message: 'A percentage discount must carry its percentage',
    path: ['valueBp'],
  })
  .refine((d) => d.kind !== 'fixed' || d.valueSatang != null, {
    message: 'A fixed discount must carry its amount',
    path: ['valueSatang'],
  })
  .refine((d) => d.kind !== 'free_item' || !!d.freeProductId, {
    message: 'A free-item discount must name the item it gives away',
    path: ['freeProductId'],
  })
  .refine((d) => !d.validFrom || !d.validUntil || d.validUntil >= d.validFrom, {
    message: 'The end of the window cannot be before its start',
    path: ['validUntil'],
  });
export type DiscountDefinitionBody = z.infer<typeof DiscountDefinitionBodySchema>;

// --- The spreadsheet ---------------------------------------------------------

/**
 * The workbook's sheet names. They are matched on import, so renaming one here
 * renames it in the file AND in what the import will accept.
 */
export const MENU_SHEET = 'Menu items';
export const CATEGORY_SHEET = 'Categories';
export const HELP_SHEET = 'How to fill this in';

/**
 * What a row's `action` cell says.
 *
 *   - blank   — create it or update it, whichever the match says;
 *   - archive — withdraw it, explicitly. **The only way an import removes
 *     anything**: a row absent from the sheet is left exactly as it is, so a
 *     manager who exports one part of the menu to correct three prices cannot
 *     wipe the rest by leaving it out;
 *   - example — a sample row written by the export of an empty menu. The
 *     import ignores it, so the template can carry a filled-in example without
 *     that example becoming a menu item the first time somebody presses
 *     Import.
 */
export const SHEET_ACTIONS = ['archive', 'example'] as const;
export type SheetAction = (typeof SHEET_ACTIONS)[number];

/** The `Menu items` columns, in the order the file writes and reads them. */
export const MENU_SHEET_COLUMNS = [
  'id',
  'code',
  'name_en',
  'name_th',
  'description_en',
  'description_th',
  'category',
  'subcategory',
  'price_weekday',
  'price_weekend',
  'cost',
  'prep_station',
  'tax_category',
  'available',
  'modifier_groups',
  'action',
] as const;
export type MenuSheetColumn = (typeof MENU_SHEET_COLUMNS)[number];

/**
 * The `Categories` columns, in the order the file writes and reads them.
 *
 * `id` is here for the same reason it is on the menu sheet, and it is not
 * decoration: rows already exist that carry no code — the admin form has no
 * field to type one into — and without an id column the export would write
 * those rows out blank and then refuse its own file on the way back in.
 */
export const CATEGORY_SHEET_COLUMNS = [
  'id',
  'code',
  'name_en',
  'name_th',
  'parent_code',
  'sort_order',
  'default_prep_station',
  'default_tax_category',
  'action',
] as const;
export type CategorySheetColumn = (typeof CATEGORY_SHEET_COLUMNS)[number];

/**
 * A row the import refused, addressed the way the person's own screen
 * addresses it: the sheet it is on and the row number Excel shows in its
 * left-hand margin, which is one-based and counts the header.
 */
export interface SheetIssue {
  sheet: string;
  /** 1-based, as Excel numbers it. The header is row 1, so data starts at 2. */
  row: number;
  column: string | null;
  message: string;
}

export type MenuImportAction = 'create' | 'update' | 'archive' | 'unchanged';

/**
 * One field the import would change, named and valued **as the sheet spells
 * it** — `price_weekday`, not `priceSatang`, and ฿240 rather than 24000.
 *
 * The preview is read by the person who just edited the file, so it answers in
 * the vocabulary of the thing they edited rather than the column names
 * underneath it.
 */
export interface MenuImportChange {
  field: string;
  from: string | null;
  to: string | null;
}

/** What a preview says would happen to one row, before anything is written. */
export interface SheetRowChange {
  sheet: string;
  row: number;
  code: string | null;
  name: string;
  action: MenuImportAction;
  /** Empty on a create and on an unchanged row. */
  changes: MenuImportChange[];
}

export type MenuImportCounts = Record<MenuImportAction, number>;

export interface MenuImportPreview {
  /** `v1.<file digest>.<menu digest>` — see the menu-sheet service. */
  previewToken: string;
  filename: string;
  /** The `Menu items` sheet. `ignored` counts rows marked `example`. */
  counts: MenuImportCounts & { ignored: number };
  /** The `Categories` sheet, counted separately: they are operator-wide rows. */
  categories: MenuImportCounts;
  rows: SheetRowChange[];
  /** Every problem in the file, not the first. Non-empty means nothing can be applied. */
  errors: SheetIssue[];
  /**
   * The sentence the preview screen shows, kept here so the API and the dialog
   * cannot drift: an import never removes what the sheet does not mention.
   */
  notice: string;
}

/** What the commit actually did. */
export interface MenuImportResult {
  created: number;
  updated: number;
  archived: number;
  categoriesCreated: number;
  categoriesUpdated: number;
  categoriesArchived: number;
}

export const MENU_IMPORT_NOTICE =
  'Items already on the menu that are not in this sheet are left exactly as they are — ' +
  'an import never removes anything you left out. To withdraw an item, put `archive` in its `action` column.';
