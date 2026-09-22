// The menu spreadsheet: its columns, and how the live menu is written into one.
//
// This file is the contract. The export writes these columns and the API's
// import validator reads them, so the two only stay in step while there is one
// place that names them — that is here, and the API mirrors it.
//
// Ported rules, not invented ones:
//   - a blank `price_weekend` means "the same as the weekday price". That is
//     `wwp(weekday, weekend = weekday)` (prototype `store/catalogStore.ts:36`),
//     which is why not one seeded F&B item carries a weekend price.
//   - a blank `prep_station` or `tax_category` on an item means "inherit the
//     category's", and a blank on a SUB-category means "inherit the parent's"
//     (`lib/menu.ts:52-110`, `types.ts:726-729`). A top-level category must
//     carry both.
//   - categories are two levels. A parent is itself top-level.

import type {
  MenuCategoryDef,
  MenuItem,
  ModifierGroup,
  PrepStation,
  TaxableCategory,
} from '@/types';
import { downloadWorkbook, type Cell, type Sheet } from './xlsx';

export const ITEMS_SHEET = 'Menu items';
export const CATEGORIES_SHEET = 'Categories';
export const HELP_SHEET = 'How to fill this in';

/** Sheet 1, left to right. The API's validator reads these names. */
export const ITEM_COLUMNS = [
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

/** Sheet 2, left to right. */
export const CATEGORY_COLUMNS = [
  'code',
  'name_en',
  'name_th',
  'parent_code',
  'sort_order',
  'default_prep_station',
  'default_tax_category',
] as const;

const PREP_STATIONS: PrepStation[] = ['kitchen', 'bar', 'none'];
const TAXABLE_CATEGORIES: TaxableCategory[] = [
  'tickets',
  'fnb',
  'bar',
  'drop_off',
  'parties',
  'addons',
  'merch',
  'stored_value',
];

/**
 * The text an example row carries in `action`.
 *
 * It sits in `action` deliberately. That column's whole job is "what to do with
 * this row", so a leftover example is refused with this sentence quoted back —
 * rather than importing three fictional items because somebody scrolled past
 * the grey.
 */
export const EXAMPLE_MARKER = 'EXAMPLE — delete this row';

/**
 * The codes the platform holds for rows it knows about.
 *
 * Empty until the menu is server-backed. Until then the export derives a code
 * from the row's own key, below — it is not invented data, it is the store's
 * stable key in the case the sheet requires.
 */
export interface KnownCodes {
  item(id: string): string | null;
  category(id: string): string | null;
}

export const NO_KNOWN_CODES: KnownCodes = { item: () => null, category: () => null };

/**
 * A code for a row the platform has not given one to.
 *
 * `MenuItem` and `MenuCategoryDef` carry no code — the prototype has none, and
 * the column is new with the import (SCRUM-232). But their ids ARE stable keys
 * chosen by hand (`food`, `food-mains`, `m-nuggets`), so upper-casing one
 * yields exactly the shape the sheet wants and, more importantly, makes an
 * export re-importable: without it every row in a file exported before the
 * platform knew the menu would arrive code-less and be refused.
 *
 * Once the menu is server-backed this is never reached: the platform's own code
 * is used.
 */
function derivedCode(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

const th = (t: MenuItem['translations'] | MenuCategoryDef['translations']) => t?.th;
const en = (t: MenuItem['translations']) => t?.en;

export interface MenuSheetInput {
  items: MenuItem[];
  categories: MenuCategoryDef[];
  /** The shared library. Inline groups stay in the item form and are not written. */
  modifierGroups: ModifierGroup[];
  codes?: KnownCodes;
}

/**
 * Build the workbook's sheets from the live menu.
 *
 * On an EMPTY menu this still produces a usable template — every header, the
 * help sheet in full, three greyed example rows, and whatever categories exist
 * so there is something valid to reference. An export that hands back a bare
 * header row is the version of this that fails in front of the owner, since an
 * empty menu is exactly when somebody downloads the template.
 */
export function buildMenuSheets(input: MenuSheetInput): Sheet[] {
  const codes = input.codes ?? NO_KNOWN_CODES;
  const categoryById = new Map(input.categories.map((c) => [c.id, c]));
  const groupNameById = new Map(input.modifierGroups.map((g) => [g.id, g.name]));

  const categoryCode = (id: string): string =>
    codes.category(id) ?? derivedCode(id);

  const itemRow = (item: MenuItem): Cell[] => {
    const category = categoryById.get(item.category);
    const parent = category?.parentId ? categoryById.get(category.parentId) : undefined;
    const top = parent ?? category;
    const groups = (item.linkedModifierGroupIds ?? [])
      .map((id) => groupNameById.get(id))
      .filter((name): name is string => !!name)
      .join('; ');
    return [
      item.id,
      codes.item(item.id) ?? derivedCode(item.id),
      item.name,
      th(item.translations)?.name ?? null,
      en(item.translations)?.description ?? null,
      th(item.translations)?.description ?? null,
      top ? categoryCode(top.id) : null,
      parent && category ? categoryCode(category.id) : null,
      item.price.weekday,
      // Blank when the two are equal: that is what `wwp` means, and writing the
      // same number twice would teach the reader the opposite.
      item.price.weekend === item.price.weekday ? null : item.price.weekend,
      item.cost ?? null,
      item.prepStationOverride ?? null,
      item.taxCategoryOverride ?? null,
      // Every menu item on the prototype's menu is on sale: `MenuItem` carries
      // no availability flag, only `MerchItem` does. So this is `yes` rather
      // than a value read off the row.
      'yes',
      groups || null,
      null,
    ];
  };

  const exampleRows: Cell[][] = [
    [
      null,
      'FB-EXAMPLE-1',
      'Margherita Pizza',
      'พิซซ่ามาร์เกอริต้า',
      'Tomato, mozzarella, basil',
      null,
      'FOOD',
      'FOOD-MAINS',
      220,
      240,
      78,
      'kitchen',
      'fnb',
      'yes',
      null,
      EXAMPLE_MARKER,
    ],
    [
      null,
      'FB-EXAMPLE-2',
      'Iced Latte',
      null,
      null,
      null,
      'DRINKS',
      'DRINKS-COFFEE',
      95,
      null,
      null,
      null,
      null,
      'yes',
      'Ice level; Milk',
      EXAMPLE_MARKER,
    ],
    [
      null,
      'FB-EXAMPLE-3',
      'Popcorn',
      null,
      null,
      null,
      'SNACKS',
      null,
      60,
      null,
      18,
      'none',
      null,
      'no',
      null,
      EXAMPLE_MARKER,
    ],
  ];

  const itemRows = input.items.map(itemRow);
  const useExamples = itemRows.length === 0;
  const rows: Cell[][] = [
    [...ITEM_COLUMNS],
    ...(useExamples ? exampleRows : itemRows),
  ];

  const items: Sheet = {
    name: ITEMS_SHEET,
    rows,
    mutedRows: useExamples ? new Set([1, 2, 3]) : undefined,
    widths: [30, 18, 26, 22, 30, 30, 14, 16, 13, 13, 8, 13, 13, 10, 24, 22],
  };

  // Top-level first, then each one's children — the order the tabs read in, so
  // a parent is always above the rows that name it.
  const tops = input.categories
    .filter((c) => !c.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const ordered: MenuCategoryDef[] = [];
  for (const top of tops) {
    ordered.push(top);
    ordered.push(
      ...input.categories
        .filter((c) => c.parentId === top.id)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    );
  }

  const categories: Sheet = {
    name: CATEGORIES_SHEET,
    rows: [
      [...CATEGORY_COLUMNS],
      ...ordered.map((c): Cell[] => [
        categoryCode(c.id),
        c.name,
        th(c.translations)?.name ?? null,
        c.parentId ? categoryCode(c.parentId) : null,
        c.sortOrder,
        c.defaultPrepStation ?? null,
        c.defaultTaxCategory ?? null,
      ]),
    ],
    widths: [20, 22, 22, 18, 12, 22, 22],
  };

  return [items, categories, helpSheet()];
}

/**
 * The reference sheet. Every enum's allowed values, what blank means in each
 * column, and the three rules a person has to hold in their head.
 */
function helpSheet(): Sheet {
  const rows: Cell[][] = [
    ['Column', 'Sheet', 'Required', 'What goes in it'],
    ['id', ITEMS_SHEET, 'no', 'Ours. The export fills it. Leave it alone; blank means a new item.'],
    ['code', ITEMS_SHEET, 'yes', 'Your short key, e.g. FB-PIZZA. A–Z, 0–9, - and _ . This is what makes importing the same file twice an update rather than a second menu.'],
    ['name_en', ITEMS_SHEET, 'yes', 'The name on the till and the receipt.'],
    ['name_th', ITEMS_SHEET, 'no', 'The Thai name on the guest display. Blank falls back to name_en.'],
    ['description_en', ITEMS_SHEET, 'no', 'A short description, up to 200 characters.'],
    ['description_th', ITEMS_SHEET, 'no', 'The Thai description.'],
    ['category', ITEMS_SHEET, 'yes', `A code from the ${CATEGORIES_SHEET} sheet with no parent_code, e.g. FOOD.`],
    ['subcategory', ITEMS_SHEET, 'no', `A code from the ${CATEGORIES_SHEET} sheet whose parent_code is this row's category.`],
    ['price_weekday', ITEMS_SHEET, 'yes', 'Baht, as you would type it: 220 or 220.50. No ฿ sign.'],
    ['price_weekend', ITEMS_SHEET, 'no', 'Baht. BLANK MEANS THE SAME AS THE WEEKDAY PRICE. Holidays bill at the weekend price.'],
    ['cost', ITEMS_SHEET, 'no', 'What the item costs the park, in baht. Feeds the profit report.'],
    ['prep_station', ITEMS_SHEET, 'no', `One of: ${PREP_STATIONS.join(', ')}. Blank inherits the category's. "none" prints no prep ticket at all.`],
    ['tax_category', ITEMS_SHEET, 'no', `One of: ${TAXABLE_CATEGORIES.join(', ')}. Blank inherits the category's.`],
    ['available', ITEMS_SHEET, 'no', 'yes or no. Blank means yes. "no" keeps the item on the menu but takes it off the till.'],
    ['modifier_groups', ITEMS_SHEET, 'no', 'Shared modifier groups to attach, by name, separated by a semicolon: "Ice level; Milk". The group has to exist already — build it under Modifiers. Groups that belong to one item only stay in the item form.'],
    ['action', ITEMS_SHEET, 'no', 'Blank normally. "archive" withdraws the item from the menu without touching the orders that sold it.'],
    ['code', CATEGORIES_SHEET, 'yes', 'The category key items reference, e.g. FOOD or FOOD-MAINS.'],
    ['name_en', CATEGORIES_SHEET, 'yes', 'The tab label.'],
    ['name_th', CATEGORIES_SHEET, 'no', 'The Thai tab label.'],
    ['parent_code', CATEGORIES_SHEET, 'no', 'Blank makes this a top-level tab. Otherwise the code of the tab it sits under. There are two levels only — a parent cannot itself have a parent.'],
    ['sort_order', CATEGORIES_SHEET, 'yes', 'A whole number. Lower sorts first, within its own level.'],
    ['default_prep_station', CATEGORIES_SHEET, 'on a top-level row', `One of: ${PREP_STATIONS.join(', ')}. A sub-category may leave it blank to inherit its parent's.`],
    ['default_tax_category', CATEGORIES_SHEET, 'on a top-level row', `One of: ${TAXABLE_CATEGORIES.join(', ')}. A sub-category may leave it blank to inherit its parent's.`],
    [null, null, null, null],
    ['The three rules', null, null, null],
    ['1', null, null, 'An import never removes anything. An item already on the menu that is not in this file is left exactly as it was — so a file with one new dessert in it adds one dessert. To take something off, put "archive" in its action column, or "no" in available.'],
    ['2', null, null, 'code is the key. Change an item\'s name and it is still the same item; change its code and it is a new one.'],
    ['3', null, null, 'Nothing is written until you press Apply. The screen shows you what will change first, and a single bad row stops the whole file — with every problem listed, not just the first.'],
  ];
  return { name: HELP_SHEET, rows, widths: [24, 16, 20, 110] };
}

/** `oto-menu-hkt-central-2026-09-23.xlsx` */
export function menuFilename(branchName: string, today = new Date()): string {
  const slug = branchName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return `oto-menu-${slug || 'branch'}-${date}.xlsx`;
}

/** Build the workbook and hand it to the browser. */
export function exportMenuWorkbook(branchName: string, input: MenuSheetInput): void {
  downloadWorkbook(menuFilename(branchName), buildMenuSheets(input));
}
