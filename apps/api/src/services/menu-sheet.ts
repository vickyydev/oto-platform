import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { product, productCategory, productModifierGroup } from '@oto/db';
import {
  CATEGORY_SHEET,
  CATEGORY_SHEET_COLUMNS,
  HELP_SHEET,
  MENU_IMPORT_NOTICE,
  MENU_SHEET,
  MENU_SHEET_COLUMNS,
  PREP_STATIONS,
  TAXABLE_CATEGORIES,
  newId,
  type MenuImportChange,
  type MenuImportCounts,
  type MenuImportPreview,
  type MenuImportResult,
  type MenuTranslations,
  type PrepStation,
  type SheetIssue,
  type SheetRowChange,
  type TaxableCategory,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { CategoryRow, ItemRow, MenuSnapshot } from './menu';
import type { Exec } from './tx';

/**
 * The menu as a spreadsheet (SCRUM-232).
 *
 * The owner asked for an Import that takes a spreadsheet and an Export whose
 * output doubles as the template. That is one file format, written and read by
 * this module, and three rules that decide everything else:
 *
 *   1. **A row is matched on `id`, then on `code`, never on the name.** Export
 *      always fills the id, so a straight round-trip is exact. The name is
 *      never a key: "Fresh Orange Juice" becomes "Orange Juice" one day, and
 *      matching on the name would quietly make a second item and leave the
 *      first one on the till.
 *   2. **A row that is not in the sheet is left exactly as it is.** The real
 *      use is partial — export, add a Desserts section, import. Treating the
 *      file as the whole menu would mean it silently withdrew everything it did
 *      not mention. `action: archive` is the only way out.
 *   3. **One bad row refuses the whole file.** A menu is one document, and a
 *      half-applied import leaves nobody able to say what landed. That is only
 *      defensible because the report lists EVERY bad row rather than the first
 *      — validation runs to the end and collects.
 *
 * **Why `.xlsx` and not CSV.** Excel on Windows opens a UTF-8 CSV without a
 * byte-order mark in the system code page, so Thai arrives as mojibake; adding
 * the mark does not survive the round trip, because Google Sheets re-saves
 * without it and the whole point here is export → edit → import. Excel also
 * coerces types on a CSV, and the column it would mangle is the key one — a
 * code like `2-1` becomes a date. An `.xlsx` stores strings as UTF-16 in a
 * shared-strings table: no encoding to negotiate, and cell types are explicit.
 *
 * Both libraries are MIT and pinned exactly: `write-excel-file` 4.1.1 and
 * `read-excel-file` 9.3.10. `exceljs` and `xlsx` were rejected — each carries
 * an unfixed prototype-pollution advisory on the READ path, which is the path
 * an uploaded file takes.
 */

/** This slice's sheet is the menu. The shop keys on `sku` and is its own ticket. */
const SHEET_KIND = 'menu';

/** ฿100,000 a line, the ceiling the columns validate against. */
const MAX_BAHT = 100_000;

// --- Writing -----------------------------------------------------------------

/**
 * A cell as `write-excel-file` wants one: an ABSENT value is `undefined`, not
 * null, which is why `text()` and `number()` below normalise to that.
 */
type Cell = {
  value?: string | number;
  type?: typeof String | typeof Number;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
  wrap?: boolean;
};

/**
 * Text, always written as an explicit string.
 *
 * A menu item called `+1 Topping` or a code like `2-1` is a formula or a date
 * to a spreadsheet left to guess. Declaring the type is the fix, and it is
 * declared on every text cell rather than on the ones that look dangerous.
 */
const text = (value: string | null | undefined): Cell => ({
  value: value === null || value === undefined || value === '' ? undefined : value,
  type: String,
});

const number = (value: number | null | undefined): Cell => ({
  value: value === null || value === undefined ? undefined : value,
  type: Number,
});

const header = (value: string): Cell => ({
  value,
  type: String,
  fontWeight: 'bold',
  backgroundColor: '#EFEFEF',
});

/** A sample row: greyed, and marked `example` so the import ignores it. */
const sample = (cell: Cell): Cell => ({ ...cell, color: '#8A8A8A' });

const baht = (satang: number | null | undefined): number | null =>
  satang === null || satang === undefined ? null : satang / 100;

function translated(
  translations: unknown,
  lang: string,
  field: 'name' | 'description',
): string | null {
  if (!translations || typeof translations !== 'object') return null;
  const entry = (translations as MenuTranslations)[lang];
  const value = entry?.[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The workbook: the menu, its categories, and a sheet explaining the columns.
 *
 * On an EMPTY menu this still produces a usable template — every header, the
 * help sheet, and three example rows on each data sheet marked `example`. That
 * is the moment somebody most needs the file, and an export that hands back a
 * bare header row is the version of this feature that fails in front of the
 * owner.
 */
export async function buildMenuWorkbook(snapshot: MenuSnapshot): Promise<Buffer> {
  const { categories, items, groups, links } = snapshot;
  const library = groups.filter((g) => g.productId === null);
  const menuItems = items.filter((i) => i.kind === SHEET_KIND);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const libraryById = new Map(library.map((g) => [g.id, g]));

  const menuRows: Cell[][] = [MENU_SHEET_COLUMNS.map((c) => header(c))];
  for (const item of menuItems) {
    const own = item.categoryId ? byId.get(item.categoryId) : undefined;
    const parent = own?.parentId ? byId.get(own.parentId) : undefined;
    // A sub-category goes in `subcategory`, and its parent in `category`, so
    // the two columns always read as the path to the item.
    const topLevel = parent ?? own;
    const groupNames = links
      .filter((l) => l.productId === item.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => libraryById.get(l.modifierGroupId)?.name)
      .filter((n): n is string => !!n);

    menuRows.push([
      text(item.id),
      text(item.code),
      text(item.name),
      text(translated(item.translations, 'th', 'name')),
      text(item.description),
      text(translated(item.translations, 'th', 'description')),
      text(topLevel?.code ?? null),
      text(parent ? (own?.code ?? null) : null),
      number(baht(item.priceSatang)),
      number(baht(item.priceWeekendSatang)),
      number(baht(item.costSatang)),
      text(item.prepStationOverride),
      text(item.taxCategoryOverride),
      text(item.active ? 'yes' : 'no'),
      text(groupNames.join('; ')),
      text(null),
    ]);
  }
  if (menuItems.length === 0) menuRows.push(...exampleMenuRows());

  const categoryRows: Cell[][] = [CATEGORY_SHEET_COLUMNS.map((c) => header(c))];
  // Parents first, so the file reads top-down the way the tabs do.
  const ordered = [
    ...categories.filter((c) => !c.parentId).sort(bySort),
    ...categories.filter((c) => c.parentId).sort(bySort),
  ];
  for (const c of ordered) {
    categoryRows.push([
      text(c.id),
      text(c.code),
      text(c.name),
      text(translated(c.translations, 'th', 'name')),
      text(c.parentId ? (byId.get(c.parentId)?.code ?? null) : null),
      number(c.sortOrder),
      text(c.defaultPrepStation),
      text(c.taxableCategory),
      text(null),
    ]);
  }
  if (categories.length === 0) categoryRows.push(...exampleCategoryRows());

  return writeXlsxFile([
    {
      data: menuRows,
      sheet: MENU_SHEET,
      columns: [
        { width: 38 },
        { width: 16 },
        { width: 28 },
        { width: 24 },
        { width: 34 },
        { width: 30 },
        { width: 14 },
        { width: 16 },
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 14 },
        { width: 14 },
        { width: 11 },
        { width: 26 },
        { width: 10 },
      ],
    },
    {
      data: categoryRows,
      sheet: CATEGORY_SHEET,
      columns: [
        { width: 38 },
        { width: 18 },
        { width: 24 },
        { width: 24 },
        { width: 16 },
        { width: 12 },
        { width: 22 },
        { width: 22 },
        { width: 10 },
      ],
    },
    { data: helpRows(), sheet: HELP_SHEET, columns: [{ width: 24 }, { width: 96 }] },
  ]).toBuffer();
}

const bySort = (a: CategoryRow, b: CategoryRow): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

function exampleMenuRows(): Cell[][] {
  const rows: Array<[string, string, string, string, number, string, string, string]> = [
    ['FB-PIZZA', 'Margherita Pizza', 'พิซซ่ามาร์เกอริต้า', 'Tomato, mozzarella, basil', 220, 'FOOD', 'FOOD-MAINS', 'kitchen'],
    ['FB-LATTE', 'Iced Latte', 'ลาเต้เย็น', '', 95, 'DRINKS', '', 'bar'],
    ['FB-POPCORN', 'Popcorn', 'ป๊อปคอร์น', '', 60, 'SNACKS', '', 'none'],
  ];
  return rows.map(([code, name, nameTh, description, price, category, sub, prep]) =>
    [
      text(null),
      text(code),
      text(name),
      text(nameTh),
      text(description),
      text(null),
      text(category),
      text(sub),
      number(price),
      number(null),
      number(null),
      text(prep),
      text(null),
      text('yes'),
      text(null),
      text('example'),
    ].map(sample),
  );
}

function exampleCategoryRows(): Cell[][] {
  const rows: Array<[string, string, string, string, number, PrepStation, TaxableCategory]> = [
    ['FOOD', 'Food', 'อาหาร', '', 0, 'kitchen', 'fnb'],
    ['FOOD-MAINS', 'Mains', 'อาหารจานหลัก', 'FOOD', 0, 'none', 'fnb'],
    ['DRINKS', 'Drinks', 'เครื่องดื่ม', '', 1, 'bar', 'fnb'],
  ];
  return rows.map(([code, name, nameTh, parent, sort, prep, taxable]) =>
    [
      text(null),
      text(code),
      text(name),
      text(nameTh),
      text(parent),
      number(sort),
      text(parent ? null : prep),
      text(parent ? null : taxable),
      text('example'),
    ].map(sample),
  );
}

function helpRows(): Cell[][] {
  const rows: Array<[string, string]> = [
    ['Column', 'What it means'],
    [`— ${MENU_SHEET} —`, ''],
    ['id', 'Ours. Filled in by Export, never typed. Leave it blank for a new item.'],
    ['code', 'Required on a NEW item. The key that makes a re-import an update instead of a duplicate: 2–32 characters of A–Z, 0–9, hyphen or underscore, and unique. A row that already carries an id is matched on that, so an item without a code keeps working.'],
    ['name_en', 'Required. The name on the till and the receipt. Up to 80 characters.'],
    ['name_th', 'Optional. The Thai name on the customer display. Blank removes the Thai name.'],
    ['description_en', 'Optional. Up to 200 characters.'],
    ['description_th', 'Optional Thai description.'],
    ['category', `Required on a NEW item: the top-level category's code, from the "${CATEGORY_SHEET}" sheet. Left blank on an existing item, it stays in the category it is already in.`],
    ['subcategory', 'Optional. A sub-category code whose parent_code is the category above.'],
    ['price_weekday', `Required. In baht, as you would type it — 220 or 220.50. At most ${MAX_BAHT.toLocaleString('en-US')}.`],
    ['price_weekend', 'Optional. BLANK MEANS THE SAME AS WEEKDAY. Fill it in only when the weekend price differs.'],
    ['cost', 'Optional. What the item costs the park, in baht. Feeds the profit report.'],
    ['prep_station', `Optional. ${PREP_STATIONS.join(' / ')}. Blank inherits the category's.`],
    ['tax_category', `Optional. ${TAXABLE_CATEGORIES.join(' / ')}. Blank inherits the category's.`],
    ['available', 'Optional. yes or no. Blank means yes. "no" keeps the item on the menu but off the sell screen.'],
    ['modifier_groups', 'Optional. Shared modifier groups to ask for this item, by name, separated by a semicolon — for example: Ice level; Milk. Blank means none.'],
    ['action', 'Blank for a normal row. archive withdraws the item. example marks a sample row the import ignores.'],
    ['', ''],
    [`— ${CATEGORY_SHEET} —`, ''],
    ['id', 'Ours. Filled in by Export, never typed. Leave it blank for a new category.'],
    ['code', 'Required on a NEW category. The key the Menu items sheet refers to.'],
    ['name_en', 'Required. The tab label, up to 40 characters.'],
    ['name_th', 'Optional Thai tab label.'],
    ['parent_code', 'Blank for a top-level tab. Otherwise the code of a top-level category. The menu is two levels deep — a sub-category cannot have sub-categories of its own.'],
    ['sort_order', 'Required. A whole number from 0. The order of the tabs within their level.'],
    [
      'default_prep_station',
      `Optional. ${PREP_STATIONS.join(' / ')}. Blank on a sub-category inherits its parent's; blank everywhere means prep tickets print in the kitchen.`,
    ],
    ['default_tax_category', `Required on a top-level category, optional on a sub-category (blank inherits). ${TAXABLE_CATEGORIES.join(' / ')}.`],
    ['action', 'Blank for a normal row. archive withdraws the category. example marks a sample row the import ignores.'],
    ['', ''],
    ['— How the import behaves —', ''],
    ['Nothing is removed by leaving it out', MENU_IMPORT_NOTICE],
    ['Preview first', 'Import always shows you what it would do and changes nothing until you confirm it.'],
    ['All or nothing', 'If any row is wrong, no row is applied — and the preview lists every bad row, not just the first.'],
    ['Re-importing is safe', 'Importing the same file twice changes nothing the second time: every row matches and reads as unchanged.'],
    ['This sheet is the menu', 'Shop items and ticket add-ons are not in this file yet — they are keyed on their own SKU and come later.'],
  ];
  return rows.map(([a, b], index) =>
    index === 0 ? [header(a), header(b)] : [{ ...text(a), fontWeight: a.startsWith('—') ? ('bold' as const) : undefined }, { ...text(b), wrap: true }],
  );
}

// --- Reading -----------------------------------------------------------------

type RawValue = string | number | boolean | Date | null;

interface RawRow {
  /** 1-based, as Excel shows it in the margin. */
  row: number;
  cells: Map<string, RawValue>;
}

interface ParsedSheet {
  rows: RawRow[];
  errors: SheetIssue[];
}

/** A cell's text, trimmed. Numbers become their text so a numeric code survives. */
function cellText(value: RawValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function readSheet(
  data: RawValue[][],
  sheet: string,
  columns: readonly string[],
): ParsedSheet {
  const errorsFound: SheetIssue[] = [];
  const [headerRow, ...body] = data;
  if (!headerRow) {
    return {
      rows: [],
      errors: [{ sheet, row: 1, column: null, message: `The "${sheet}" sheet is empty` }],
    };
  }
  const headers = headerRow.map((h) => cellText(h).toLowerCase());
  const index = new Map<string, number>();
  for (const column of columns) {
    const at = headers.indexOf(column);
    if (at >= 0) index.set(column, at);
  }
  const missing = columns.filter((c) => !index.has(c));
  // Only the columns a row cannot be read without. The rest may be absent from
  // a file somebody trimmed, and absent reads the same as blank.
  const required =
    sheet === MENU_SHEET
      ? ['code', 'name_en', 'category', 'price_weekday']
      : ['code', 'name_en', 'sort_order'];
  for (const column of required.filter((c) => missing.includes(c))) {
    errorsFound.push({
      sheet,
      row: 1,
      column,
      message: `The "${sheet}" sheet has no ${column} column`,
    });
  }

  const rows: RawRow[] = [];
  body.forEach((line, offset) => {
    const cells = new Map<string, RawValue>();
    for (const [column, at] of index) cells.set(column, line[at] ?? null);
    // A row whose every cell is blank is spacing, not data.
    const blank = [...cells.values()].every((v) => cellText(v) === '');
    if (!blank) rows.push({ row: offset + 2, cells });
  });
  return { rows, errors: errorsFound };
}

export interface ParsedWorkbook {
  categories: RawRow[];
  items: RawRow[];
  errors: SheetIssue[];
}

/** Open the uploaded file. A workbook that is not one fails here, in words. */
export async function parseMenuWorkbook(file: Buffer): Promise<ParsedWorkbook> {
  // The default export answers with EVERY sheet — `{ sheet, data }` each —
  // which is what this needs: the workbook is read as a whole, and a missing
  // sheet is reported here rather than thrown from inside the parser.
  let sheets: Array<{ sheet: string; data: RawValue[][] }>;
  try {
    sheets = (await readXlsxFile(file)) as Array<{ sheet: string; data: RawValue[][] }>;
  } catch (err) {
    throw errors.badRequest(
      'That file could not be opened as an Excel workbook. Export the menu, edit that file, ' +
        'and save it as .xlsx — not .csv.',
      { reason: err instanceof Error ? err.message : 'unreadable' },
    );
  }
  const find = (name: string) => sheets.find((s) => s.sheet.trim() === name);
  const menu = find(MENU_SHEET);
  const cats = find(CATEGORY_SHEET);
  if (!menu) {
    throw errors.badRequest(
      `That workbook has no "${MENU_SHEET}" sheet. Its sheets are: ${sheets
        .map((s) => s.sheet)
        .join(', ')}.`,
    );
  }
  const menuSheet = readSheet(menu.data, MENU_SHEET, MENU_SHEET_COLUMNS);
  const categorySheet = cats
    ? readSheet(cats.data, CATEGORY_SHEET, CATEGORY_SHEET_COLUMNS)
    : { rows: [], errors: [] };
  return {
    categories: categorySheet.rows,
    items: menuSheet.rows,
    errors: [...categorySheet.errors, ...menuSheet.errors],
  };
}

// --- Validating and diffing ---------------------------------------------------

interface CategoryPlan {
  row: number;
  id: string;
  code: string | null;
  name: string;
  nameTh: string | null;
  parentCode: string | null;
  sortOrder: number;
  defaultPrepStation: PrepStation | null;
  taxableCategory: TaxableCategory | null;
  effect: 'create' | 'update' | 'archive' | 'unchanged';
  before: CategoryRow | null;
}

interface ItemPlan {
  row: number;
  id: string;
  code: string | null;
  name: string;
  nameTh: string | null;
  description: string | null;
  descriptionTh: string | null;
  categoryCode: string;
  subcategoryCode: string | null;
  /**
   * Whether the row actually named a category.
   *
   * False leaves the item where it is. A category that carries no code cannot
   * be named by this sheet at all, so the export writes that cell blank — and
   * treating blank as "no category" would mean our own export silently
   * detached those items from their tab on the way back in.
   */
  categoryGiven: boolean;
  priceSatang: number;
  priceWeekendSatang: number | null;
  costSatang: number | null;
  prepStationOverride: PrepStation | null;
  taxCategoryOverride: TaxableCategory | null;
  active: boolean;
  modifierGroupNames: string[];
  effect: 'create' | 'update' | 'archive' | 'unchanged';
  before: ItemRow | null;
}

export interface MenuImportPlan {
  categories: CategoryPlan[];
  items: ItemPlan[];
  preview: MenuImportPreview;
}

class RowErrors {
  readonly list: SheetIssue[] = [];
  constructor(private readonly sheet: string) {}
  add(row: number, column: string | null, message: string): void {
    this.list.push({ sheet: this.sheet, row, column, message });
  }
}

function readAction(
  cells: Map<string, RawValue>,
  row: number,
  errorsFound: RowErrors,
): 'normal' | 'archive' | 'example' | 'invalid' {
  const raw = cellText(cells.get('action') ?? null).toLowerCase();
  if (raw === '') return 'normal';
  if (raw === 'archive') return 'archive';
  if (raw === 'example') return 'example';
  errorsFound.add(row, 'action', `"${raw}" is not an action — leave it blank, or write archive`);
  return 'invalid';
}

/** Baht as a person types it → satang, refusing what a person did not mean. */
function readPrice(
  cells: Map<string, RawValue>,
  column: string,
  row: number,
  errorsFound: RowErrors,
  required: boolean,
): number | null {
  const raw = cells.get(column) ?? null;
  const asText = cellText(raw);
  if (asText === '') {
    if (required) errorsFound.add(row, column, 'A price is required');
    return null;
  }
  const value = typeof raw === 'number' ? raw : Number(asText);
  if (!Number.isFinite(value)) {
    errorsFound.add(row, column, `expected a number, found "${asText}"`);
    return null;
  }
  if (value < 0) {
    errorsFound.add(row, column, 'a price cannot be negative');
    return null;
  }
  if (value > MAX_BAHT) {
    errorsFound.add(row, column, `${value} is above the ฿${MAX_BAHT.toLocaleString('en-US')} ceiling`);
    return null;
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    errorsFound.add(row, column, `${value} has more than two decimal places`);
    return null;
  }
  return Math.round(value * 100);
}

function readEnum<T extends string>(
  cells: Map<string, RawValue>,
  column: string,
  row: number,
  allowed: readonly T[],
  errorsFound: RowErrors,
): T | null {
  const raw = cellText(cells.get(column) ?? null).toLowerCase();
  if (raw === '') return null;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  errorsFound.add(row, column, `"${raw}" is not one of: ${allowed.join(', ')}`);
  return null;
}

const YES = new Set(['yes', 'y', '1', 'true', 'ใช่']);
const NO = new Set(['no', 'n', '0', 'false', 'ไม่']);

function readYesNo(
  cells: Map<string, RawValue>,
  column: string,
  row: number,
  errorsFound: RowErrors,
): boolean {
  const raw = cells.get(column) ?? null;
  if (typeof raw === 'boolean') return raw;
  const asText = cellText(raw).toLowerCase();
  if (asText === '') return true;
  if (YES.has(asText)) return true;
  if (NO.has(asText)) return false;
  errorsFound.add(row, column, `"${asText}" is not yes or no`);
  return true;
}

const CODE_PATTERN = /^[A-Z0-9_-]{2,32}$/;

/**
 * The code, when the row has one.
 *
 * **Required to CREATE a row, not to update one the file already identifies.**
 * Without a code a new row would be created afresh every time the file was
 * imported, which is the duplication this column exists to stop. A row that
 * carries our `id` is already matched, and rows with no code of their own do
 * exist — the admin form has no field to type one into — so demanding one
 * here would mean the export produced a file its own import refused.
 */
function readCode(
  cells: Map<string, RawValue>,
  row: number,
  errorsFound: RowErrors,
  required: boolean,
): string | null {
  const raw = cellText(cells.get('code') ?? null).toUpperCase();
  if (raw === '') {
    if (required) {
      errorsFound.add(
        row,
        'code',
        'A code is required on a new row — it is what makes importing this file again an update rather than a second copy',
      );
    }
    return null;
  }
  if (!CODE_PATTERN.test(raw)) {
    errorsFound.add(
      row,
      'code',
      `"${raw}" is not a valid code — 2 to 32 characters of A–Z, 0–9, hyphen or underscore`,
    );
    return null;
  }
  return raw;
}

/**
 * Read the whole workbook against the menu as it stands, and say what would
 * happen — without writing anything.
 *
 * Validation never stops at the first failure. A person who has to press
 * Import five times to be told about five bad rows will edit the file in a
 * text editor, and then the file really is broken.
 */
export function planMenuImport(
  parsed: ParsedWorkbook,
  snapshot: MenuSnapshot,
  scope: { operatorId: string; branchId: string },
  filename: string,
): MenuImportPlan {
  const categoryErrors = new RowErrors(CATEGORY_SHEET);
  const itemErrors = new RowErrors(MENU_SHEET);
  const changes: SheetRowChange[] = [];
  let ignored = 0;

  const liveCategories = snapshot.categories.filter((c) => !c.archivedAt);
  const liveItems = snapshot.items.filter((i) => !i.archivedAt);
  const library = snapshot.groups.filter((g) => g.productId === null && !g.archivedAt);

  const categoryByCode = new Map<string, CategoryRow>();
  for (const c of liveCategories) if (c.code) categoryByCode.set(c.code, c);
  const categoryById = new Map(liveCategories.map((c) => [c.id, c]));

  // --- Categories -----------------------------------------------------------
  const categoryPlans: CategoryPlan[] = [];
  const seenCategoryCodes = new Map<string, number>();
  /** What the sheet says the tree will look like, for the depth check below. */
  const sheetParentOf = new Map<string, string | null>();

  for (const { row, cells } of parsed.categories) {
    const action = readAction(cells, row, categoryErrors);
    if (action === 'example') {
      ignored += 1;
      continue;
    }
    // The id wins over the code, so a row whose code is being changed still
    // lands on the category it came from.
    const idCell = cellText(cells.get('id') ?? null);
    let before: CategoryRow | null = null;
    if (idCell !== '') {
      const found = categoryById.get(idCell);
      if (!found) {
        categoryErrors.add(
          row,
          'id',
          'That id is not a category on this menu — clear the cell to create a new one',
        );
      } else before = found;
    }
    const code = readCode(cells, row, categoryErrors, !before);
    if (!before && code) before = categoryByCode.get(code) ?? null;
    if (code) {
      const holder = categoryByCode.get(code);
      if (holder && before && holder.id !== before.id) {
        categoryErrors.add(
          row,
          'code',
          `${code} already belongs to the category "${holder.name}" — two categories cannot share a code`,
        );
        continue;
      }
    }

    const name = cellText(cells.get('name_en') ?? null);
    if (name === '') categoryErrors.add(row, 'name_en', 'A name is required');
    else if (name.length > 40) categoryErrors.add(row, 'name_en', 'Up to 40 characters');
    const parentCode = cellText(cells.get('parent_code') ?? null).toUpperCase() || null;
    const sortText = cellText(cells.get('sort_order') ?? null);
    const sortRaw = cells.get('sort_order') ?? null;
    let sortOrder = 0;
    if (sortText === '') {
      categoryErrors.add(row, 'sort_order', 'A sort order is required — 0 for the first tab');
    } else {
      const value = typeof sortRaw === 'number' ? sortRaw : Number(sortText);
      if (!Number.isInteger(value) || value < 0) {
        categoryErrors.add(row, 'sort_order', `"${sortText}" is not a whole number from 0`);
      } else sortOrder = value;
    }
    const prep = readEnum(cells, 'default_prep_station', row, PREP_STATIONS, categoryErrors);
    const taxable = readEnum(
      cells,
      'default_tax_category',
      row,
      TAXABLE_CATEGORIES,
      categoryErrors,
    );
    if (!parentCode && !taxable) {
      categoryErrors.add(
        row,
        'default_tax_category',
        'A top-level category sets the taxable area its items fall under — only a sub-category may leave it blank',
      );
    }
    /**
     * The prep station is NOT required here, on a top-level category or
     * anywhere else. The column is nullable in the database on purpose, and
     * the prototype's own resolver falls back to `kitchen` when nothing in the
     * chain sets one (`lib/menu.ts:85-94`) — so requiring it in the sheet
     * would refuse rows the admin screen creates every day.
     */

    // A row is addressed by its code, or — when it has none — by its id.
    const key = code ?? (before ? `id:${before.id}` : null);
    if (!key) continue;
    const duplicate = seenCategoryCodes.get(key);
    if (duplicate !== undefined) {
      categoryErrors.add(
        row,
        'code',
        `${code ?? 'This category'} is also on row ${duplicate} of this sheet`,
      );
      continue;
    }
    seenCategoryCodes.set(key, row);
    if (code) sheetParentOf.set(code, parentCode);

    if (action === 'archive') {
      if (!before) {
        categoryErrors.add(row, 'action', `There is no category ${code ?? ''} to withdraw`);
        continue;
      }
      categoryPlans.push({
        row,
        id: before.id,
        code,
        name: before.name,
        nameTh: null,
        parentCode,
        sortOrder: before.sortOrder,
        defaultPrepStation: before.defaultPrepStation,
        taxableCategory: before.taxableCategory,
        effect: 'archive',
        before,
      });
      changes.push({
        sheet: CATEGORY_SHEET,
        row,
        code,
        name: before.name,
        action: 'archive',
        changes: [],
      });
      continue;
    }
    const plan: CategoryPlan = {
      row,
      id: before?.id ?? newId(),
      code,
      name,
      nameTh: cellText(cells.get('name_th') ?? null) || null,
      parentCode,
      sortOrder,
      defaultPrepStation: prep,
      taxableCategory: taxable,
      effect: before ? 'update' : 'create',
      before,
    };
    categoryPlans.push(plan);
  }

  // The parent must exist — in this sheet or already on the menu — and must
  // itself be top-level. The database cannot express the depth rule, so this
  // and the menu service are the two places that hold it.
  for (const plan of categoryPlans) {
    if (plan.effect === 'archive' || !plan.parentCode) continue;
    const inSheet = sheetParentOf.has(plan.parentCode);
    const existing = categoryByCode.get(plan.parentCode);
    if (!inSheet && !existing) {
      categoryErrors.add(
        plan.row,
        'parent_code',
        `There is no category ${plan.parentCode} — add it to this sheet, or use one that is already on the menu`,
      );
      continue;
    }
    const parentIsSub = inSheet
      ? !!sheetParentOf.get(plan.parentCode)
      : !!existing?.parentId;
    if (parentIsSub) {
      categoryErrors.add(
        plan.row,
        'parent_code',
        `${plan.parentCode} is itself a sub-category, and the menu is two levels deep`,
      );
    }
  }

  for (const plan of categoryPlans) {
    if (plan.effect === 'archive') continue;
    const before = plan.before;
    if (!before) {
      changes.push({
        sheet: CATEGORY_SHEET,
        row: plan.row,
        code: plan.code,
        name: plan.name,
        action: 'create',
        changes: [],
      });
      continue;
    }
    const parentBefore = before.parentId
      ? (liveCategories.find((c) => c.id === before.parentId)?.code ?? null)
      : null;
    const diff = diffFields([
      ['code', before.code, plan.code],
      ['name_en', before.name, plan.name],
      ['name_th', translated(before.translations, 'th', 'name'), plan.nameTh],
      ['parent_code', parentBefore, plan.parentCode],
      ['sort_order', before.sortOrder, plan.sortOrder],
      ['default_prep_station', before.defaultPrepStation, plan.defaultPrepStation],
      ['default_tax_category', before.taxableCategory, plan.taxableCategory],
    ]);
    plan.effect = diff.length === 0 ? 'unchanged' : 'update';
    changes.push({
      sheet: CATEGORY_SHEET,
      row: plan.row,
      code: plan.code,
      name: plan.name,
      action: plan.effect,
      changes: diff,
    });
  }

  // --- Items ----------------------------------------------------------------
  // The tree the items are validated against is the menu PLUS whatever the
  // Categories sheet is about to add, because a person adding a Desserts tab
  // and its first three items does both in one file.
  const plannedCategoryCodes = new Set(
    categoryPlans.filter((p) => p.effect !== 'archive').map((p) => p.code),
  );
  const withdrawnCategoryCodes = new Set(
    categoryPlans.filter((p) => p.effect === 'archive').map((p) => p.code),
  );
  const categoryIsTopLevel = (code: string): boolean => {
    if (sheetParentOf.has(code)) return !sheetParentOf.get(code);
    return !categoryByCode.get(code)?.parentId;
  };
  const parentCodeOf = (code: string): string | null => {
    if (sheetParentOf.has(code)) return sheetParentOf.get(code) ?? null;
    const row = categoryByCode.get(code);
    if (!row?.parentId) return null;
    return liveCategories.find((c) => c.id === row.parentId)?.code ?? null;
  };
  const knownCategory = (code: string): boolean =>
    (plannedCategoryCodes.has(code) || categoryByCode.has(code)) &&
    !withdrawnCategoryCodes.has(code);

  const itemByCode = new Map<string, ItemRow>();
  for (const i of liveItems) if (i.code) itemByCode.set(i.code, i);
  const itemById = new Map(liveItems.map((i) => [i.id, i]));
  const libraryByName = new Map(library.map((g) => [g.name.toLowerCase(), g]));

  const itemPlans: ItemPlan[] = [];
  const seenItemCodes = new Map<string, number>();

  for (const { row, cells } of parsed.items) {
    const action = readAction(cells, row, itemErrors);
    if (action === 'example') {
      ignored += 1;
      continue;
    }
    // The id wins over the code, so a round-trip that renames a code still
    // lands on the row it came from.
    const idCell = cellText(cells.get('id') ?? null);
    let before: ItemRow | null = null;
    if (idCell !== '') {
      const found = itemById.get(idCell);
      if (!found) {
        itemErrors.add(
          row,
          'id',
          'That id is not an item on this branch’s menu — clear the cell to create a new item',
        );
      } else if (found.kind !== SHEET_KIND) {
        itemErrors.add(row, 'id', 'That id is a shop item or a ticket add-on, which this sheet does not carry');
      } else before = found;
    }
    const code = readCode(cells, row, itemErrors, !before);
    if (!before && code) {
      const found = itemByCode.get(code);
      if (found && found.kind !== SHEET_KIND) {
        itemErrors.add(
          row,
          'code',
          `${code} already belongs to a ${found.kind === 'merch' ? 'shop item' : 'ticket add-on'}, so it cannot name a menu item`,
        );
      } else before = found ?? null;
    }

    const name = cellText(cells.get('name_en') ?? null);
    if (name === '') itemErrors.add(row, 'name_en', 'A name is required');
    else if (name.length > 80) itemErrors.add(row, 'name_en', 'Up to 80 characters');

    const description = cellText(cells.get('description_en') ?? null) || null;
    if (description && description.length > 200) {
      itemErrors.add(row, 'description_en', 'Up to 200 characters');
    }
    const descriptionTh = cellText(cells.get('description_th') ?? null) || null;
    if (descriptionTh && descriptionTh.length > 200) {
      itemErrors.add(row, 'description_th', 'Up to 200 characters');
    }

    const categoryCode = cellText(cells.get('category') ?? null).toUpperCase();
    const subcategoryCode = cellText(cells.get('subcategory') ?? null).toUpperCase() || null;
    if (action !== 'archive') {
      // Required to create: a new item with no category would appear under no
      // tab at all. On a row that already exists, a blank cell means what a
      // blank cell means — no category — and the diff shows it moving.
      if (categoryCode === '' && !before) {
        itemErrors.add(row, 'category', 'A category is required on a new item');
      } else if (categoryCode !== '' && !knownCategory(categoryCode)) {
        itemErrors.add(
          row,
          'category',
          `There is no category ${categoryCode} — add it to the "${CATEGORY_SHEET}" sheet, or use one that is already on the menu`,
        );
      } else if (categoryCode !== '' && !categoryIsTopLevel(categoryCode)) {
        itemErrors.add(
          row,
          'category',
          `${categoryCode} is a sub-category — put it in the subcategory column and its parent here`,
        );
      }
      if (subcategoryCode) {
        if (!knownCategory(subcategoryCode)) {
          itemErrors.add(row, 'subcategory', `There is no category ${subcategoryCode}`);
        } else {
          const parent = parentCodeOf(subcategoryCode);
          if (!parent) {
            itemErrors.add(
              row,
              'subcategory',
              `${subcategoryCode} is a top-level category, not a sub-category`,
            );
          } else if (parent !== categoryCode) {
            itemErrors.add(
              row,
              'subcategory',
              `${subcategoryCode} belongs to ${parent}, not to ${categoryCode}`,
            );
          }
        }
      }
    }

    const priceSatang = readPrice(cells, 'price_weekday', row, itemErrors, action !== 'archive');
    const priceWeekendSatang = readPrice(cells, 'price_weekend', row, itemErrors, false);
    const costSatang = readPrice(cells, 'cost', row, itemErrors, false);
    const prep = readEnum(cells, 'prep_station', row, PREP_STATIONS, itemErrors);
    const taxable = readEnum(cells, 'tax_category', row, TAXABLE_CATEGORIES, itemErrors);
    const active = readYesNo(cells, 'available', row, itemErrors);

    const groupCell = cellText(cells.get('modifier_groups') ?? null);
    const modifierGroupNames = groupCell
      .split(';')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    for (const groupName of modifierGroupNames) {
      if (!libraryByName.has(groupName.toLowerCase())) {
        itemErrors.add(
          row,
          'modifier_groups',
          `There is no shared modifier group called "${groupName}" — the available ones are: ${
            library.map((g) => g.name).join(', ') || 'none yet'
          }`,
        );
      }
    }

    // Addressed by its code, or — for a row that has none — by its id.
    const key = code ?? (before ? `id:${before.id}` : null);
    if (!key) continue;
    const duplicate = seenItemCodes.get(key);
    if (duplicate !== undefined) {
      itemErrors.add(
        row,
        'code',
        `${code ?? 'This item'} is also on row ${duplicate} of this sheet`,
      );
      continue;
    }
    seenItemCodes.set(key, row);

    // A code that is live on another item is a collision, not a merge.
    const holder = code ? itemByCode.get(code) : undefined;
    if (holder && before && holder.id !== before.id) {
      itemErrors.add(
        row,
        'code',
        `${code} already belongs to "${holder.name}" — two items cannot share a code`,
      );
      continue;
    }

    if (action === 'archive') {
      if (!before) {
        itemErrors.add(row, 'action', `There is no item ${code ?? ''} to withdraw`);
        continue;
      }
      itemPlans.push({
        row,
        id: before.id,
        code,
        name: before.name,
        nameTh: null,
        description: before.description,
        descriptionTh: null,
        categoryCode,
        subcategoryCode,
        categoryGiven: false,
        priceSatang: before.priceSatang,
        priceWeekendSatang: before.priceWeekendSatang,
        costSatang: before.costSatang,
        prepStationOverride: before.prepStationOverride,
        taxCategoryOverride: before.taxCategoryOverride,
        active: false,
        modifierGroupNames: [],
        effect: 'archive',
        before,
      });
      changes.push({
        sheet: MENU_SHEET,
        row,
        code,
        name: before.name,
        action: 'archive',
        changes: [],
      });
      continue;
    }

    itemPlans.push({
      row,
      id: before?.id ?? newId(),
      code,
      name,
      nameTh: cellText(cells.get('name_th') ?? null) || null,
      description,
      descriptionTh,
      categoryCode,
      subcategoryCode,
      categoryGiven: categoryCode !== '',
      priceSatang: priceSatang ?? 0,
      priceWeekendSatang,
      costSatang,
      prepStationOverride: prep,
      taxCategoryOverride: taxable,
      active,
      modifierGroupNames,
      effect: before ? 'update' : 'create',
      before,
    });
  }

  for (const plan of itemPlans) {
    if (plan.effect === 'archive') continue;
    const before = plan.before;
    if (!before) {
      changes.push({
        sheet: MENU_SHEET,
        row: plan.row,
        code: plan.code,
        name: plan.name,
        action: 'create',
        changes: [],
      });
      continue;
    }
    const currentLinks = snapshot.links
      .filter((l) => l.productId === before.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => library.find((g) => g.id === l.modifierGroupId)?.name)
      .filter((n): n is string => !!n);
    const diff = diffFields([
      ['code', before.code, plan.code],
      ['name_en', before.name, plan.name],
      ['name_th', translated(before.translations, 'th', 'name'), plan.nameTh],
      ['description_en', before.description, plan.description],
      ['description_th', translated(before.translations, 'th', 'description'), plan.descriptionTh],
      ['price_weekday', bahtText(before.priceSatang), bahtText(plan.priceSatang)],
      ['price_weekend', bahtText(before.priceWeekendSatang), bahtText(plan.priceWeekendSatang)],
      ['cost', bahtText(before.costSatang), bahtText(plan.costSatang)],
      ['prep_station', before.prepStationOverride, plan.prepStationOverride],
      ['tax_category', before.taxCategoryOverride, plan.taxCategoryOverride],
      ['available', before.active, plan.active],
      ['modifier_groups', currentLinks.join('; '), plan.modifierGroupNames.join('; ')],
      // Only when the row named one: a blank cell leaves the item where it is.
      ...(plan.categoryGiven
        ? ([
            [
              'category',
              categoryPathOf(before, liveCategories),
              [plan.categoryCode, plan.subcategoryCode].filter(Boolean).join(' / '),
            ],
          ] as Array<[string, unknown, unknown]>)
        : []),
    ]);
    plan.effect = diff.length === 0 ? 'unchanged' : 'update';
    changes.push({
      sheet: MENU_SHEET,
      row: plan.row,
      code: plan.code,
      name: plan.name,
      action: plan.effect,
      changes: diff,
    });
  }

  const allErrors = [...parsed.errors, ...categoryErrors.list, ...itemErrors.list].sort(
    (a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row,
  );

  const tally = (sheet: string): MenuImportCounts => ({
    create: changes.filter((c) => c.sheet === sheet && c.action === 'create').length,
    update: changes.filter((c) => c.sheet === sheet && c.action === 'update').length,
    archive: changes.filter((c) => c.sheet === sheet && c.action === 'archive').length,
    unchanged: changes.filter((c) => c.sheet === sheet && c.action === 'unchanged').length,
  });

  return {
    categories: categoryPlans,
    items: itemPlans,
    preview: {
      previewToken: previewToken(parsed, snapshot, scope),
      filename,
      // Counted per sheet: the items land on this branch, and the categories
      // are operator-wide rows that every branch will then see.
      counts: { ...tally(MENU_SHEET), ignored },
      categories: tally(CATEGORY_SHEET),
      rows: changes,
      errors: allErrors,
      notice: MENU_IMPORT_NOTICE,
    },
  };
}

function categoryPathOf(item: ItemRow, categories: CategoryRow[]): string {
  const own = categories.find((c) => c.id === item.categoryId);
  if (!own) return '';
  const parent = own.parentId ? categories.find((c) => c.id === own.parentId) : undefined;
  return parent ? `${parent.code ?? parent.name} / ${own.code ?? own.name}` : (own.code ?? own.name);
}

/**
 * Only the fields that actually moved, named as the sheet names them.
 *
 * Every value is rendered the way the cell renders it, so the preview and the
 * file agree: prices in baht, availability as yes/no, an absent value as blank
 * rather than as the word "null".
 */
function diffFields(fields: Array<[string, unknown, unknown]>): MenuImportChange[] {
  const out: MenuImportChange[] = [];
  for (const [field, before, after] of fields) {
    const a = cellValue(before);
    const b = cellValue(after);
    if (a !== b) out.push({ field, from: a, to: b });
  }
  return out;
}

/** A value as the sheet shows it: blank for absent, plain text for the rest. */
function cellValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** Satang as the sheet writes it — baht, trimmed of a pointless `.00`. */
const bahtText = (satang: number | null | undefined): string | null =>
  satang === null || satang === undefined ? null : String(satang / 100);

// --- The preview token --------------------------------------------------------

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * `v1.<what the file says>.<what the menu says>`.
 *
 * Both halves matter and they fail differently. The FILE half means the
 * confirmed numbers describe the file being applied — a second upload of a
 * different file is refused rather than applied under the first one's counts.
 * The MENU half means nothing moved underneath between looking and confirming;
 * if somebody edited a price in the admin screen in between, the preview's
 * "4 changed" is no longer true and the answer is to look again.
 *
 * There is no clock on it. The design pass specified fifteen minutes, and a
 * content hash is the stronger version of the same promise: it stops being
 * valid exactly when it stops being TRUE, rather than at a time that is
 * either too early for somebody checking with a colleague or too late to
 * matter.
 */
function previewToken(
  parsed: ParsedWorkbook,
  snapshot: MenuSnapshot,
  scope: { operatorId: string; branchId: string },
): string {
  return `v1.${fileDigest(parsed, scope)}.${menuDigest(snapshot)}`;
}

/**
 * What the FILE says, and nothing else.
 *
 * Taken from the parsed cells rather than from the plan, because a plan is a
 * function of the file AND the menu: a row's effect flips from `unchanged` to
 * `update` when somebody edits a price elsewhere, and a digest built over that
 * would report an unchanged file as a changed one — naming the wrong cause on
 * the one screen whose job is to say what happened.
 */
function fileDigest(parsed: ParsedWorkbook, scope: { operatorId: string; branchId: string }): string {
  const rows = (list: RawRow[]) =>
    list.map((r) => [
      r.row,
      [...r.cells.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, cellText(v)]),
    ]);
  return digest([scope.operatorId, scope.branchId, rows(parsed.categories), rows(parsed.items)]);
}

/** The menu as the preview saw it. Ordered by id so the digest is stable. */
export function menuDigest(snapshot: MenuSnapshot): string {
  return digest([
    [...snapshot.categories]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => [c.id, c.code, c.name, c.parentId, c.sortOrder, c.defaultPrepStation, c.taxableCategory, c.archivedAt, c.translations]),
    [...snapshot.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => [i.id, i.code, i.name, i.description, i.categoryId, i.priceSatang, i.priceWeekendSatang, i.costSatang, i.prepStationOverride, i.taxCategoryOverride, i.active, i.archivedAt, i.translations]),
    [...snapshot.links]
      .map((l) => [l.productId, l.modifierGroupId, l.sortOrder])
      .sort((a, b) => String(a).localeCompare(String(b))),
  ]);
}

/** Refuse a confirmation that no longer describes what would happen. */
export function assertPreviewStillTrue(supplied: string, fresh: string): void {
  if (supplied === fresh) return;
  const [, suppliedFile] = supplied.split('.');
  const [, freshFile] = fresh.split('.');
  if (suppliedFile !== freshFile) {
    throw errors.conflict(
      'IMPORT_FILE_CHANGED',
      'This is not the file that was previewed. Preview it again so the numbers you confirm are the ones that will be applied.',
    );
  }
  throw errors.conflict(
    'MENU_CHANGED',
    'The menu was changed by somebody else while you were looking at this preview, so it no longer describes what would happen. Preview the file again.',
  );
}

// --- Applying -----------------------------------------------------------------

export interface ImportContext {
  operatorId: string;
  branchId: string;
  actorAccountId: string;
  requestId: string;
  filename: string;
}

/**
 * Write the plan. One transaction, handed in: the caller opens it, so the
 * whole file lands or none of it does, and the audit rows land with it.
 */
export async function applyMenuImport(
  tx: Exec,
  ctx: ImportContext,
  plan: MenuImportPlan,
  snapshot: MenuSnapshot,
): Promise<MenuImportResult> {
  const now = new Date();
  const idByCode = new Map<string, string>();
  for (const c of snapshot.categories) if (c.code) idByCode.set(c.code, c.id);
  // A category with no code cannot be named by an item row, so only coded
  // ones go into the lookup the items resolve against.
  for (const c of plan.categories) if (c.code) idByCode.set(c.code, c.id);

  const recordRow = async (
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) => {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: ctx.operatorId,
      branchId: ctx.branchId,
      action,
      entityType,
      entityId,
      before: before as never,
      after: after as never,
      requestId: ctx.requestId,
    });
  };

  // Parents first: a sub-category's row carries its parent's id.
  const ordered = [
    ...plan.categories.filter((c) => !c.parentCode),
    ...plan.categories.filter((c) => !!c.parentCode),
  ];
  for (const c of ordered) {
    if (c.effect === 'unchanged') continue;
    if (c.effect === 'archive') {
      await tx
        .update(productCategory)
        .set({ archivedAt: now })
        .where(eq(productCategory.id, c.id));
      await recordRow('menu_category.archive', 'product_category', c.id, c.before, null);
      continue;
    }
    const values = {
      operatorId: ctx.operatorId,
      code: c.code,
      name: c.name,
      parentId: c.parentCode ? (idByCode.get(c.parentCode) ?? null) : null,
      taxableCategory: c.taxableCategory,
      defaultPrepStation: c.defaultPrepStation,
      sortOrder: c.sortOrder,
      translations: mergeThai(c.before?.translations, c.nameTh, null),
    };
    if (c.effect === 'create') {
      await tx.insert(productCategory).values({ id: c.id, ...values });
      await recordRow('menu_category.create', 'product_category', c.id, null, values);
    } else {
      await tx.update(productCategory).set(values).where(eq(productCategory.id, c.id));
      await recordRow('menu_category.update', 'product_category', c.id, c.before, values);
    }
  }

  for (const i of plan.items) {
    if (i.effect === 'unchanged') continue;
    if (i.effect === 'archive') {
      await tx
        .update(product)
        .set({ archivedAt: now, active: false })
        .where(eq(product.id, i.id));
      await recordRow('menu_item.archive', 'product', i.id, i.before, null);
      continue;
    }
    const categoryCode = i.subcategoryCode ?? i.categoryCode;
    const values = {
      operatorId: ctx.operatorId,
      branchId: ctx.branchId,
      categoryId: i.categoryGiven
        ? (idByCode.get(categoryCode) ?? null)
        : (i.before?.categoryId ?? null),
      kind: SHEET_KIND as 'menu',
      code: i.code,
      name: i.name,
      description: i.description,
      priceSatang: i.priceSatang,
      priceWeekendSatang: i.priceWeekendSatang,
      costSatang: i.costSatang,
      prepStationOverride: i.prepStationOverride,
      taxCategoryOverride: i.taxCategoryOverride,
      active: i.active,
      translations: mergeThai(i.before?.translations, i.nameTh, i.descriptionTh),
    };
    if (i.effect === 'create') {
      await tx.insert(product).values({ id: i.id, ...values });
      await recordRow('menu_item.create', 'product', i.id, null, values);
    } else {
      await tx.update(product).set(values).where(eq(product.id, i.id));
      await recordRow('menu_item.update', 'product', i.id, i.before, values);
    }

    // The links are replaced with exactly what the cell said, which is why a
    // blank cell means none rather than "leave them".
    const library = snapshot.groups.filter((g) => g.productId === null && !g.archivedAt);
    const wanted = i.modifierGroupNames
      .map((name) => library.find((g) => g.name.toLowerCase() === name.toLowerCase())?.id)
      .filter((id): id is string => !!id);
    await tx.delete(productModifierGroup).where(eq(productModifierGroup.productId, i.id));
    if (wanted.length > 0) {
      await tx.insert(productModifierGroup).values(
        wanted.map((modifierGroupId, sortOrder) => ({
          operatorId: ctx.operatorId,
          productId: i.id,
          modifierGroupId,
          sortOrder,
        })),
      );
    }
  }

  const result: MenuImportResult = {
    created: plan.preview.counts.create,
    updated: plan.preview.counts.update,
    archived: plan.preview.counts.archive,
    categoriesCreated: plan.preview.categories.create,
    categoriesUpdated: plan.preview.categories.update,
    categoriesArchived: plan.preview.categories.archive,
  };
  // One row for the file itself, beside the row-by-row trail: what was
  // uploaded, what it did, and the digest that ties it to the preview.
  await recordRow('menu.import', 'menu', ctx.branchId, null, {
    filename: ctx.filename,
    result,
    previewToken: plan.preview.previewToken,
  });
  return result;
}

/**
 * Set or clear the Thai name and description, leaving every other language
 * alone.
 *
 * The sheet has columns for English and Thai only. Zh, ru and fr are in the
 * prototype's own seed and nobody asked for eight more columns, so an import
 * must not be the thing that quietly deletes them.
 */
function mergeThai(
  existing: unknown,
  nameTh: string | null,
  descriptionTh: string | null,
): MenuTranslations | null {
  const base: MenuTranslations =
    existing && typeof existing === 'object' ? { ...(existing as MenuTranslations) } : {};
  if (!nameTh && !descriptionTh) delete base.th;
  else {
    base.th = {
      ...(nameTh ? { name: nameTh } : {}),
      ...(descriptionTh ? { description: descriptionTh } : {}),
    };
  }
  return Object.keys(base).length === 0 ? null : base;
}
