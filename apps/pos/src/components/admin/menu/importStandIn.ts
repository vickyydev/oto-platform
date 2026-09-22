// A stand-in for the menu import routes, running in the browser.
//
// WHAT THIS IS AND IS NOT. The real import parses and validates on the server
// (`POST /branches/:id/menu/import/preview` and `…/commit`, typed in
// `@/api/menu`), because only the server can hold a preview against the menu it
// was computed from and refuse a commit if that menu moved. This file exists so
// the dialog could be built and driven before those routes were deployed, and
// so the rules below — which are the specification, written out as code — are
// executable rather than prose. It applies to the in-memory catalogue store,
// which is what every other edit on this panel does today, and the dialog says
// so on screen in as many words.
//
// DELETE THIS FILE once the routes are live. `ImportMenuDialog` already calls
// the real client first and only falls back here when the route answers 404
// with no code of ours — the platform's own words for "that route is not on
// this deployment".

import type {
  MenuCategoryDef,
  MenuItem,
  ModifierGroup,
  PrepStation,
  TaxableCategory,
} from '@/types';
import type {
  MenuImportAction,
  MenuImportChange,
  MenuImportError,
  MenuImportPreview,
  MenuImportRow,
} from '@/api/menu';
import { CATEGORIES_SHEET, EXAMPLE_MARKER, ITEMS_SHEET } from './menuSheet';

// ============================================================================
// Reading a workbook
// ============================================================================

/** Find the end-of-central-directory record, scanning back from the tail. */
function findEocd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const from = Math.max(0, bytes.length - 0x10000 - 22);
  for (let i = bytes.length - 22; i >= from; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error('That file is not a spreadsheet — no zip directory in it.');
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Unzip the parts we need. Handles both stored and deflated entries. */
async function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = bytes.subarray(start, start + compressed);
      // eslint-disable-next-line no-await-in-loop -- a workbook holds a handful of parts.
      out.set(name, decoder.decode(method === 8 ? await inflate(raw) : raw));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** `B7` → 1. Excel omits empty cells, so a cell's column comes from its ref. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Read every sheet as a grid of trimmed strings, keyed by tab name. */
export async function readWorkbook(file: File): Promise<Map<string, string[][]>> {
  const parts = await unzip(new Uint8Array(await file.arrayBuffer()));
  const parser = new DOMParser();
  const doc = (name: string): Document | null => {
    const text = parts.get(name);
    return text ? parser.parseFromString(text, 'application/xml') : null;
  };

  const shared: string[] = [];
  const sst = doc('xl/sharedStrings.xml');
  if (sst) {
    for (const si of Array.from(sst.getElementsByTagName('si'))) {
      // A shared string can be split across runs; the concatenated text is it.
      shared.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent ?? '').join(''));
    }
  }

  const rels = new Map<string, string>();
  const relsDoc = doc('xl/_rels/workbook.xml.rels');
  for (const r of Array.from(relsDoc?.getElementsByTagName('Relationship') ?? [])) {
    rels.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');
  }

  const workbook = doc('xl/workbook.xml');
  if (!workbook) throw new Error('That file is not a spreadsheet — no workbook in it.');

  const sheets = new Map<string, string[][]>();
  for (const sheet of Array.from(workbook.getElementsByTagName('sheet'))) {
    const name = sheet.getAttribute('name') ?? '';
    const rid =
      sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ??
      sheet.getAttribute('r:id') ??
      '';
    const target = rels.get(rid);
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const sheetDoc = doc(path);
    if (!sheetDoc) continue;

    const grid: string[][] = [];
    for (const row of Array.from(sheetDoc.getElementsByTagName('row'))) {
      const cells: string[] = [];
      for (const c of Array.from(row.getElementsByTagName('c'))) {
        const at = columnIndex(c.getAttribute('r') ?? 'A');
        const type = c.getAttribute('t');
        let value = '';
        if (type === 's') {
          value = shared[Number(c.getElementsByTagName('v')[0]?.textContent ?? '0')] ?? '';
        } else if (type === 'inlineStr') {
          value = Array.from(c.getElementsByTagName('t')).map((t) => t.textContent ?? '').join('');
        } else {
          value = c.getElementsByTagName('v')[0]?.textContent ?? '';
        }
        while (cells.length < at) cells.push('');
        cells[at] = value.trim();
      }
      const at = Number(row.getAttribute('r') ?? grid.length + 1) - 1;
      while (grid.length < at) grid.push([]);
      grid[at] = cells;
    }
    sheets.set(name, grid);
  }
  return sheets;
}

// ============================================================================
// Validating — the rules, as code
// ============================================================================

const PREP_STATIONS: PrepStation[] = ['kitchen', 'bar', 'none'];
const TAXABLE: TaxableCategory[] = [
  'tickets', 'fnb', 'bar', 'drop_off', 'parties', 'addons', 'merch', 'stored_value',
];
const YES = new Set(['yes', 'y', '1', 'true', 'ใช่']);
const NO = new Set(['no', 'n', '0', 'false', 'ไม่']);
const CODE_RE = /^[A-Z0-9_-]{2,32}$/;

interface Sheet {
  name: string;
  header: Map<string, number>;
  rows: string[][];
  /** The row number Excel shows for `rows[i]`. */
  excelRow(i: number): number;
}

function sheetOf(grid: string[][] | undefined, name: string, errors: MenuImportError[]): Sheet | null {
  if (!grid || grid.length === 0) {
    errors.push({ row: 0, sheet: name, column: null, message: `This file has no "${name}" sheet.` });
    return null;
  }
  const header = new Map<string, number>();
  (grid[0] ?? []).forEach((cell, i) => {
    const key = cell.trim().toLowerCase();
    if (key && !header.has(key)) header.set(key, i);
  });
  // Header rows are matched by NAME, not position, so a column somebody moved
  // or a helper column somebody added between two of ours still reads.
  return {
    name,
    header,
    rows: grid.slice(1).filter((r) => r.some((c) => c !== '')),
    excelRow: (i) => i + 2,
  };
}

function cell(sheet: Sheet, row: string[], column: string): string {
  const at = sheet.header.get(column);
  return at === undefined ? '' : (row[at] ?? '').trim();
}

interface Ctx {
  sheet: Sheet;
  row: string[];
  at: number;
  errors: MenuImportError[];
}

function fail(ctx: Ctx, column: string | null, message: string): void {
  ctx.errors.push({
    row: ctx.sheet.excelRow(ctx.at),
    sheet: ctx.sheet.name,
    column,
    message,
  });
}

function required(ctx: Ctx, column: string, max: number): string | null {
  const value = cell(ctx.sheet, ctx.row, column);
  if (!value) {
    fail(ctx, column, `${column} is required.`);
    return null;
  }
  if (value.length > max) {
    fail(ctx, column, `${column} is ${value.length} characters; the most is ${max}.`);
    return null;
  }
  return value;
}

function optional(ctx: Ctx, column: string, max: number): string | null {
  const value = cell(ctx.sheet, ctx.row, column);
  if (!value) return null;
  if (value.length > max) {
    fail(ctx, column, `${column} is ${value.length} characters; the most is ${max}.`);
    return null;
  }
  return value;
}

function code(ctx: Ctx, column: string): string | null {
  const raw = cell(ctx.sheet, ctx.row, column);
  if (!raw) {
    fail(ctx, column, `${column} is required — it is the key that makes importing this file again an update rather than a second menu.`);
    return null;
  }
  const value = raw.toUpperCase();
  if (!CODE_RE.test(value)) {
    fail(ctx, column, `"${raw}" is not a usable code. Use 2 to 32 letters, digits, - or _ .`);
    return null;
  }
  return value;
}

function money(ctx: Ctx, column: string, req: boolean): number | null {
  const raw = cell(ctx.sheet, ctx.row, column);
  if (!raw) {
    if (req) fail(ctx, column, `${column} is required.`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fail(ctx, column, `expected a number, found "${raw}".`);
    return null;
  }
  if (value < 0) {
    fail(ctx, column, `a price cannot be negative — found ${raw}.`);
    return null;
  }
  if (value > 100_000) {
    fail(ctx, column, `${raw} looks like a typo; the most is 100,000 baht.`);
    return null;
  }
  if (Math.round(value * 100) !== value * 100) {
    fail(ctx, column, `${raw} has more than two decimal places.`);
    return null;
  }
  return value;
}

function oneOf<T extends string>(ctx: Ctx, column: string, allowed: T[]): T | null {
  const raw = cell(ctx.sheet, ctx.row, column);
  if (!raw) return null;
  const value = raw.toLowerCase() as T;
  if (!allowed.includes(value)) {
    fail(ctx, column, `"${raw}" is not one of: ${allowed.join(', ')}.`);
    return null;
  }
  return value;
}

export interface CurrentMenu {
  items: MenuItem[];
  categories: MenuCategoryDef[];
  modifierGroups: ModifierGroup[];
  /** The code the platform holds for a row, when it holds one. */
  codeFor(id: string): string | null;
}

interface ParsedCategory {
  code: string;
  name: string;
  nameTh: string | null;
  parent: string | null;
  sortOrder: number;
  prep: PrepStation | null;
  tax: TaxableCategory | null;
}

interface ParsedItem {
  excelRow: number;
  id: string | null;
  code: string;
  name: string;
  nameTh: string | null;
  descriptionEn: string | null;
  descriptionTh: string | null;
  category: string;
  subcategory: string | null;
  priceWeekday: number;
  priceWeekend: number | null;
  cost: number | null;
  prep: PrepStation | null;
  tax: TaxableCategory | null;
  available: boolean;
  groups: string[];
  archive: boolean;
}

/** What a commit would apply, kept beside the preview the dialog renders. */
export interface StandInPlan {
  preview: MenuImportPreview;
  categories: ParsedCategory[];
  items: ParsedItem[];
}

export async function buildStandInPreview(file: File, menu: CurrentMenu): Promise<StandInPlan> {
  const sheets = await readWorkbook(file);
  const errors: MenuImportError[] = [];
  const catSheet = sheetOf(sheets.get(CATEGORIES_SHEET), CATEGORIES_SHEET, errors);
  const itemSheet = sheetOf(sheets.get(ITEMS_SHEET), ITEMS_SHEET, errors);

  // --- categories ----------------------------------------------------------
  const categories: ParsedCategory[] = [];
  const seenCategoryCodes = new Set<string>();
  if (catSheet) {
    catSheet.rows.forEach((row, at) => {
      const ctx: Ctx = { sheet: catSheet, row, at, errors };
      const c = code(ctx, 'code');
      const name = required(ctx, 'name_en', 40);
      const sortRaw = cell(catSheet, row, 'sort_order');
      const sortOrder = Number(sortRaw);
      if (!sortRaw || !Number.isInteger(sortOrder) || sortOrder < 0) {
        fail(ctx, 'sort_order', `expected a whole number of 0 or more, found "${sortRaw}".`);
      }
      const parent = optional(ctx, 'parent_code', 32)?.toUpperCase() ?? null;
      const prep = oneOf(ctx, 'default_prep_station', PREP_STATIONS);
      const tax = oneOf(ctx, 'default_tax_category', TAXABLE);
      if (!parent && !tax) {
        fail(ctx, 'default_tax_category', 'a top-level category must say which taxable area its items fall under.');
      }
      if (!parent && !prep) {
        fail(ctx, 'default_prep_station', 'a top-level category must say where its prep tickets print.');
      }
      if (c) {
        if (seenCategoryCodes.has(c)) fail(ctx, 'code', `"${c}" is on this sheet twice.`);
        seenCategoryCodes.add(c);
      }
      if (c && name) {
        categories.push({ code: c, name, nameTh: optional(ctx, 'name_th', 40), parent, sortOrder, prep, tax });
      }
    });

    // Two levels only. A parent that itself has a parent is the mistake the
    // prototype's own rule rules out (`types.ts:717-729`), and it has to be
    // caught here because the database only refuses a category parenting itself.
    const byCode = new Map(categories.map((c) => [c.code, c]));
    categories.forEach((c, i) => {
      if (!c.parent) return;
      const ctx: Ctx = { sheet: catSheet, row: catSheet.rows[i] ?? [], at: i, errors };
      const parent = byCode.get(c.parent);
      if (!parent) {
        fail(ctx, 'parent_code', `there is no category "${c.parent}" on this sheet.`);
      } else if (parent.parent) {
        fail(ctx, 'parent_code', `"${c.parent}" is itself inside "${parent.parent}". Categories go two levels deep, no further.`);
      }
    });
  }

  // Codes the sheet may reference: the ones it defines, plus the ones already on
  // the menu — so a file adding one dessert need not restate the whole tree.
  const existingCategoryCode = new Map<string, MenuCategoryDef>();
  for (const c of menu.categories) {
    const cc = menu.codeFor(c.id) ?? c.id.toUpperCase();
    existingCategoryCode.set(cc, c);
  }
  const knownCategory = (c: string): boolean =>
    seenCategoryCodes.has(c) || existingCategoryCode.has(c);
  const isTopLevel = (c: string): boolean => {
    const parsed = categories.find((x) => x.code === c);
    if (parsed) return !parsed.parent;
    return !existingCategoryCode.get(c)?.parentId;
  };
  const parentOf = (c: string): string | null => {
    const parsed = categories.find((x) => x.code === c);
    if (parsed) return parsed.parent;
    const existing = existingCategoryCode.get(c);
    if (!existing?.parentId) return null;
    return menu.codeFor(existing.parentId) ?? existing.parentId.toUpperCase();
  };

  // --- items ---------------------------------------------------------------
  const groupNames = new Set(menu.modifierGroups.map((g) => g.name.toLowerCase()));
  const itemsById = new Map(menu.items.map((i) => [i.id, i]));
  const itemsByCode = new Map(
    menu.items.map((i) => [menu.codeFor(i.id) ?? i.id.toUpperCase(), i] as const),
  );

  const items: ParsedItem[] = [];
  const rows: MenuImportRow[] = [];
  const seenItemCodes = new Set<string>();

  if (itemSheet) {
    itemSheet.rows.forEach((row, at) => {
      const ctx: Ctx = { sheet: itemSheet, row, at, errors };
      const action = cell(itemSheet, row, 'action');
      if (action === EXAMPLE_MARKER || action.toLowerCase().startsWith('example')) {
        fail(ctx, 'action', `this is one of the example rows the template ships with — "${EXAMPLE_MARKER}".`);
        return;
      }
      if (action && action.toLowerCase() !== 'archive') {
        fail(ctx, 'action', `"${action}" is not something I can do. Leave it blank, or put "archive".`);
      }

      const c = code(ctx, 'code');
      const name = required(ctx, 'name_en', 80);
      const category = cell(itemSheet, row, 'category').toUpperCase();
      const subcategory = cell(itemSheet, row, 'subcategory').toUpperCase() || null;
      if (!category) {
        fail(ctx, 'category', 'category is required.');
      } else if (!knownCategory(category)) {
        fail(ctx, 'category', `there is no category "${category}" — add it on the "${CATEGORIES_SHEET}" sheet first.`);
      } else if (!isTopLevel(category)) {
        fail(ctx, 'category', `"${category}" sits inside another category. Put it in subcategory and its parent in category.`);
      }
      if (subcategory) {
        if (!knownCategory(subcategory)) {
          fail(ctx, 'subcategory', `there is no category "${subcategory}".`);
        } else if (parentOf(subcategory) !== category) {
          fail(ctx, 'subcategory', `"${subcategory}" is not inside "${category}".`);
        }
      }

      const priceWeekday = money(ctx, 'price_weekday', true);
      const priceWeekend = money(ctx, 'price_weekend', false);
      const cost = money(ctx, 'cost', false);
      const prep = oneOf(ctx, 'prep_station', PREP_STATIONS);
      const tax = oneOf(ctx, 'tax_category', TAXABLE);

      const availableRaw = cell(itemSheet, row, 'available').toLowerCase();
      let available = true;
      if (availableRaw) {
        if (YES.has(availableRaw)) available = true;
        else if (NO.has(availableRaw)) available = false;
        else fail(ctx, 'available', `"${availableRaw}" is not yes or no.`);
      }

      const groupsRaw = cell(itemSheet, row, 'modifier_groups');
      const groups = groupsRaw ? groupsRaw.split(';').map((g) => g.trim()).filter(Boolean) : [];
      for (const g of groups) {
        if (!groupNames.has(g.toLowerCase())) {
          fail(ctx, 'modifier_groups', `there is no shared modifier group called "${g}". Build it under Modifiers first.`);
        }
      }

      if (c) {
        if (seenItemCodes.has(c)) fail(ctx, 'code', `"${c}" is on this sheet twice.`);
        seenItemCodes.add(c);
      }

      const id = cell(itemSheet, row, 'id') || null;
      // id first, then code, never the name: a renamed item is the same item,
      // and matching on the name would leave the old one on the till.
      const existing = (id ? itemsById.get(id) : undefined) ?? (c ? itemsByCode.get(c) : undefined);
      if (id && !itemsById.has(id) && !c) {
        fail(ctx, 'id', `no item here has the id "${id}".`);
      }
      if (existing && c) {
        const heldCode = menu.codeFor(existing.id) ?? existing.id.toUpperCase();
        const clash = itemsByCode.get(c);
        if (clash && clash.id !== existing.id) {
          fail(ctx, 'code', `"${c}" already belongs to "${clash.name}". Two items cannot share a code.`);
        } else if (id && heldCode !== c && itemsByCode.has(c)) {
          fail(ctx, 'code', `"${c}" already belongs to another item.`);
        }
      }

      if (!c || !name || priceWeekday == null) return;

      const parsed: ParsedItem = {
        excelRow: itemSheet.excelRow(at),
        id,
        code: c,
        name,
        nameTh: optional(ctx, 'name_th', 80),
        descriptionEn: optional(ctx, 'description_en', 200),
        descriptionTh: optional(ctx, 'description_th', 200),
        category,
        subcategory,
        priceWeekday,
        priceWeekend,
        cost,
        prep,
        tax,
        available,
        groups,
        archive: action.toLowerCase() === 'archive',
      };
      items.push(parsed);
      rows.push(diffRow(parsed, existing, menu));
    });
  }

  const counts: Record<MenuImportAction, number> = {
    create: 0, update: 0, archive: 0, unchanged: 0,
  };
  for (const r of rows) counts[r.action] += 1;

  const categoryCounts: Record<MenuImportAction, number> = {
    create: 0, update: 0, archive: 0, unchanged: 0,
  };
  for (const c of categories) {
    if (!existingCategoryCode.has(c.code)) categoryCounts.create += 1;
    else categoryCounts.unchanged += 1;
  }

  return {
    preview: {
      previewToken: 'stand-in',
      filename: file.name,
      counts,
      categories: categoryCounts,
      rows,
      errors: errors.sort((a, b) => a.row - b.row),
    },
    categories,
    items,
  };
}

function change(field: string, from: string | null, to: string | null): MenuImportChange | null {
  return from === to ? null : { field, from, to };
}

function diffRow(parsed: ParsedItem, existing: MenuItem | undefined, menu: CurrentMenu): MenuImportRow {
  if (!existing) {
    return { row: parsed.excelRow, code: parsed.code, name: parsed.name, action: 'create', changes: [] };
  }
  if (parsed.archive) {
    return { row: parsed.excelRow, code: parsed.code, name: parsed.name, action: 'archive', changes: [] };
  }
  const categoryId = resolveCategoryId(parsed, menu);
  const weekend = parsed.priceWeekend ?? parsed.priceWeekday;
  const changes = [
    change('name', existing.name, parsed.name),
    change('price_weekday', String(existing.price.weekday), String(parsed.priceWeekday)),
    change('price_weekend', String(existing.price.weekend), String(weekend)),
    change('cost', existing.cost != null ? String(existing.cost) : null, parsed.cost != null ? String(parsed.cost) : null),
    change('category', existing.category, categoryId),
    change('prep_station', existing.prepStationOverride ?? null, parsed.prep),
    change('tax_category', existing.taxCategoryOverride ?? null, parsed.tax),
    change('name_th', existing.translations?.th?.name ?? null, parsed.nameTh),
  ].filter((c): c is MenuImportChange => c !== null);

  return {
    row: parsed.excelRow,
    code: parsed.code,
    name: parsed.name,
    action: changes.length ? 'update' : 'unchanged',
    changes,
  };
}

function resolveCategoryId(parsed: ParsedItem, menu: CurrentMenu): string {
  const wanted = parsed.subcategory ?? parsed.category;
  for (const c of menu.categories) {
    if ((menu.codeFor(c.id) ?? c.id.toUpperCase()) === wanted) return c.id;
  }
  return wanted.toLowerCase();
}

// ============================================================================
// Applying — to the in-memory store, which is where this panel's edits go today
// ============================================================================

export interface StandInWriters {
  upsertMenuCategory(category: MenuCategoryDef): void;
  upsertMenuItem(item: MenuItem): void;
  deleteMenuItem(id: string): void;
}

/**
 * `available` is validated but NOT applied here. The column maps to
 * `pos.product.active`, and the prototype's `MenuItem` has no such field —
 * only `MerchItem` does. The real commit sets it; this cannot, so a row saying
 * `available = no` is accepted and its item stays on the sell surface until
 * the routes land.
 */
export function applyStandIn(plan: StandInPlan, menu: CurrentMenu, write: StandInWriters): void {
  for (const c of plan.categories) {
    const existing = menu.categories.find(
      (x) => (menu.codeFor(x.id) ?? x.id.toUpperCase()) === c.code,
    );
    write.upsertMenuCategory({
      id: existing?.id ?? c.code.toLowerCase(),
      name: c.name,
      ...(c.parent ? { parentId: c.parent.toLowerCase() } : {}),
      ...(c.prep ? { defaultPrepStation: c.prep } : {}),
      ...(c.tax ? { defaultTaxCategory: c.tax } : {}),
      sortOrder: c.sortOrder,
      ...(c.nameTh ? { translations: { th: { name: c.nameTh } } } : {}),
    });
  }

  const groupIdByName = new Map(menu.modifierGroups.map((g) => [g.name.toLowerCase(), g.id]));
  for (const parsed of plan.items) {
    const existing =
      (parsed.id ? menu.items.find((i) => i.id === parsed.id) : undefined) ??
      menu.items.find((i) => (menu.codeFor(i.id) ?? i.id.toUpperCase()) === parsed.code);

    if (parsed.archive) {
      if (existing) write.deleteMenuItem(existing.id);
      continue;
    }

    const linked = parsed.groups
      .map((g) => groupIdByName.get(g.toLowerCase()))
      .filter((id): id is string => !!id);
    const translations: MenuItem['translations'] = { ...existing?.translations };
    if (parsed.nameTh || parsed.descriptionTh) {
      translations.th = {
        name: parsed.nameTh ?? translations.th?.name ?? parsed.name,
        ...(parsed.descriptionTh ? { description: parsed.descriptionTh } : {}),
      };
    }
    if (parsed.descriptionEn) {
      translations.en = { name: parsed.name, description: parsed.descriptionEn };
    }

    write.upsertMenuItem({
      id: existing?.id ?? parsed.code.toLowerCase(),
      name: parsed.name,
      category: resolveCategoryId(parsed, menu),
      price: { weekday: parsed.priceWeekday, weekend: parsed.priceWeekend ?? parsed.priceWeekday },
      ...(parsed.cost != null ? { cost: parsed.cost } : {}),
      ...(existing?.modifierGroups ? { modifierGroups: existing.modifierGroups } : {}),
      ...(linked.length ? { linkedModifierGroupIds: linked } : {}),
      ...(parsed.prep ? { prepStationOverride: parsed.prep } : {}),
      ...(parsed.tax ? { taxCategoryOverride: parsed.tax } : {}),
      ...(existing?.inventoryItemId ? { inventoryItemId: existing.inventoryItemId } : {}),
      ...(Object.keys(translations).length ? { translations } : {}),
    });
  }
}
