// The menu, the shop, the ticket add-ons and the discount codes — the half of
// the catalogue that `product`, `product_category`, `modifier_group`,
// `modifier_option`, `product_modifier_group` and `discount_definition` hold
// (SCRUM-232, SCRUM-230).
//
// The row shapes below mirror `packages/db/src/schema/catalog.ts` column for
// column, because that is what makes this file a contract rather than a guess:
// the API slice implements these routes and this file is what it has to
// satisfy. Where the schema is nullable, so is the type, and each null carries
// the same meaning it does in the column's comment — most importantly
// `priceWeekendSatang: null`, which means "the same as the weekday price"
// (the prototype's `wwp`), and is NOT the same as zero.
//
// Money crosses the wire in satang and is turned into the prototype's whole
// baht here, in the mappers, the way `mappers.ts` already does for a ticket
// package. Nothing downstream of this file sees satang.

import { ApiError, NetworkError, api, idemKey } from './client';
import type { MenuImportPreview, MenuImportResult } from '@oto/shared';
import type { SupportedLang } from '@/i18n/types';
import type {
  MenuCategoryDef,
  MenuItem,
  ModifierGroup,
  ModifierOption,
  PrepStation,
  TaxableCategory,
} from '@/types';

type Translations = Partial<Record<SupportedLang, { name: string; description?: string }>>;

/** `pos.product.kind` — one table, three things it can be. */
export type ProductKind = 'menu' | 'merch' | 'addon';

export interface ApiMenuCategory {
  id: string;
  /** The stable key sheet 2 of the import workbook carries. Null on rows made before it existed. */
  code: string | null;
  name: string;
  /** Null = a top-level tab. Set = a sub-category of it. Two levels only. */
  parentId: string | null;
  /** Null only on a sub-category, which inherits its parent's. */
  taxableCategory: TaxableCategory | null;
  /** Null anywhere in the chain resolves to `kitchen`. */
  defaultPrepStation: PrepStation | null;
  sortOrder: number;
  translations: Translations | null;
  archivedAt: string | null;
}

export interface ApiModifierOption {
  id: string;
  name: string;
  priceSatang: number;
  /** Null = the same as `priceSatang`. */
  priceWeekendSatang: number | null;
  costSatang: number | null;
  sortOrder: number;
}

export interface ApiModifierGroup {
  id: string;
  /** Set = inline to that item. Null = a shared library group any item may link. */
  productId: string | null;
  name: string;
  required: boolean;
  selectionType: 'single' | 'multi';
  /** Only meaningful on a `multi` group. */
  minSelect: number | null;
  maxSelect: number | null;
  sortOrder: number;
  options: ApiModifierOption[];
}

export interface ApiProduct {
  id: string;
  kind: ProductKind;
  code: string | null;
  categoryId: string | null;
  name: string;
  description: string | null;
  priceSatang: number;
  /** Null = the same as `priceSatang`. */
  priceWeekendSatang: number | null;
  costSatang: number | null;
  /** Null = inherit the category's. */
  prepStationOverride: PrepStation | null;
  /** Null = inherit the category's. */
  taxCategoryOverride: TaxableCategory | null;
  translations: Translations | null;
  /** Merch only. */
  sku: string | null;
  /** Set = stock-tracked (the prototype's `inventoryItemId`). */
  stockItemId: string | null;
  sortOrder: number;
  active: boolean;
  archivedAt: string | null;
  /** `product_modifier_group` — the shared groups this item asks, in order. */
  linkedModifierGroupIds: string[];
}

export interface ApiMenu {
  categories: ApiMenuCategory[];
  /** The shared library AND every item's inline groups; `productId` tells them apart. */
  modifierGroups: ApiModifierGroup[];
  products: ApiProduct[];
}

// --- Import -----------------------------------------------------------------
// Two steps, and nothing is written between them. The preview parses and
// validates, returns the counts and a per-row diff, and writes nothing; the
// commit takes the token the preview issued, plus the same file again, and
// applies it in one transaction. The token carries a hash of BOTH the file and
// the menu it was computed against, so a commit of a different file, or against
// a menu that moved underneath, is refused rather than applying numbers that
// are no longer true.
//
// The shapes are the platform's own (`@oto/shared/menu-shapes`), re-exported
// rather than restated. They were restated once and drifted within the sprint —
// the counts grew an `ignored`, the rows grew a `sheet`, the preview grew the
// `notice` this dialog is supposed to show — and a copy cannot be wrong about
// the wire if there is no copy.

export type {
  MenuImportAction,
  MenuImportChange,
  MenuImportCounts,
  MenuImportPreview,
  MenuImportResult,
  SheetIssue,
  SheetRowChange,
} from '@oto/shared';

// --- The routes -------------------------------------------------------------

export const menuApi = {
  /** Everything the admin catalogue screens read, in one round trip. */
  load: (branchId: string) => api.get<ApiMenu>(`/branches/${branchId}/menu`),

  createCategory: (body: Partial<ApiMenuCategory> & { name: string }) =>
    api.post<{ id: string }>('/menu/categories', body, { idempotencyKey: idemKey() }),
  updateCategory: (id: string, body: Partial<ApiMenuCategory>) =>
    api.patch<{ ok: true }>(`/menu/categories/${id}`, body),
  archiveCategory: (id: string) => api.delete<{ ok: true }>(`/menu/categories/${id}`),

  createProduct: (branchId: string, body: Partial<ApiProduct> & { name: string; kind: ProductKind }) =>
    api.post<{ id: string }>(`/branches/${branchId}/menu/products`, body, {
      idempotencyKey: idemKey(),
    }),
  updateProduct: (branchId: string, id: string, body: Partial<ApiProduct>) =>
    api.patch<{ ok: true }>(`/branches/${branchId}/menu/products/${id}`, body),
  archiveProduct: (branchId: string, id: string) =>
    api.delete<{ ok: true }>(`/branches/${branchId}/menu/products/${id}`),

  createModifierGroup: (body: Partial<ApiModifierGroup> & { name: string }) =>
    api.post<{ id: string }>('/menu/modifier-groups', body, { idempotencyKey: idemKey() }),
  updateModifierGroup: (id: string, body: Partial<ApiModifierGroup>) =>
    api.patch<{ ok: true }>(`/menu/modifier-groups/${id}`, body),
  archiveModifierGroup: (id: string) => api.delete<{ ok: true }>(`/menu/modifier-groups/${id}`),

  /**
   * Parse and validate; write nothing.
   *
   * The workbook travels as base64 in a JSON body rather than a multipart
   * upload or a presigned object: a menu file is a few hundred rows, the API
   * has no multipart plugin, and the presigned path restricts the owning entity
   * to an account, a member or a child — a menu file fits none of them, and it
   * would inherit the bucket's still-open browser permission problem.
   */
  importPreview: (branchId: string, body: { filename: string; contentBase64: string }) =>
    api.post<MenuImportPreview>(`/branches/${branchId}/menu/import/preview`, body),

  /**
   * Apply a preview. One transaction, all rows or none.
   *
   * The FILE goes up a second time, beside the token. The platform holds no
   * uploaded copy between the two calls — the preview writes nothing at all,
   * which is the property the two steps exist for — so the commit re-parses and
   * re-plans, and the token's file half is what proves the bytes it re-parsed
   * are the bytes whose counts were on screen. A commit sent without them is
   * refused by the route's schema, which is exactly what this client used to do.
   */
  importCommit: (
    branchId: string,
    body: { previewToken: string; filename: string; contentBase64: string },
  ) =>
    api.post<MenuImportResult>(`/branches/${branchId}/menu/import/commit`, body, {
      idempotencyKey: idemKey(),
    }),

  /** The menu as the workbook Import reads back. See `fetchMenuWorkbook`. */
  exportWorkbook: (branchId: string) => fetchMenuWorkbook(branchId),
};

/**
 * `GET /branches/:id/menu/export.xlsx`, as the bytes the browser saves.
 *
 * It does not go through `api` in `./client`, which exposes a blob helper for
 * POST only and belongs to another slice this round. The two things that helper
 * does and a bare `fetch` would not are done here in as many words: the `/api`
 * prefix every route hangs off, and `credentials: 'same-origin'` so the session
 * cookie travels — without it the export answers 401 to a signed-in till.
 *
 * A refusal is re-read as the platform's error envelope rather than saved. A
 * 403 that reached the disk as a file called `menu.xlsx` full of JSON is the
 * version of this that wastes somebody's afternoon.
 */
export async function fetchMenuWorkbook(
  branchId: string,
): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/branches/${branchId}/menu/export.xlsx`, {
      credentials: 'same-origin',
    });
  } catch (err) {
    throw new NetworkError(err);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { error?: { code: string; message: string; details?: unknown } }
      | null;
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return {
    blob: await res.blob(),
    filename: filenameFrom(res.headers.get('content-disposition')) ?? 'oto-menu.xlsx',
  };
}

/** `attachment; filename="oto-menu-hkt-central-2026-09-23.xlsx"` → the name. */
function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const quoted = /filename="([^"]+)"/.exec(disposition);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename=([^;]+)/.exec(disposition);
  return bare?.[1]?.trim() || null;
}

// --- Mapping to the prototype's shapes --------------------------------------

const baht = (satang: number): number => satang / 100;
const satang = (value: number): number => Math.round(value * 100);

/**
 * The fields the platform holds that the prototype's types have nowhere to put.
 *
 * `MenuItem` and `MenuCategoryDef` carry no code, no archive flag and no `active`
 * — the prototype deletes outright and has no stable key. Rather than widen the
 * shared types (and every screen that reads them) this keeps the platform's
 * extra columns beside the row, keyed by id, filled on hydration, so a write
 * can send back unchanged the columns its form has no field for.
 */
interface ServerFields {
  code: string | null;
  sku: string | null;
  active: boolean;
  sortOrder: number;
  description: string | null;
}

const serverFields = new Map<string, ServerFields>();
const categoryCodes = new Map<string, string>();

export function serverFieldsFor(id: string): ServerFields | undefined {
  return serverFields.get(id);
}

/** True once `load` has answered, i.e. the menu on screen came from the database. */
let loaded = false;
export const menuIsServerBacked = (): boolean => loaded;

export function apiCategoryToDef(c: ApiMenuCategory): MenuCategoryDef {
  return {
    id: c.id,
    name: c.name,
    ...(c.parentId ? { parentId: c.parentId } : {}),
    ...(c.defaultPrepStation ? { defaultPrepStation: c.defaultPrepStation } : {}),
    ...(c.taxableCategory ? { defaultTaxCategory: c.taxableCategory } : {}),
    sortOrder: c.sortOrder,
    ...(c.translations ? { translations: c.translations } : {}),
  };
}

function apiOptionToOption(o: ApiModifierOption): ModifierOption {
  return {
    id: o.id,
    name: o.name,
    price: {
      weekday: baht(o.priceSatang),
      // Null means "the same", which the prototype expresses by writing the
      // weekday number into both halves of the pair.
      weekend: baht(o.priceWeekendSatang ?? o.priceSatang),
    },
    ...(o.costSatang != null ? { cost: baht(o.costSatang) } : {}),
  };
}

export function apiGroupToGroup(g: ApiModifierGroup): ModifierGroup {
  return {
    id: g.id,
    name: g.name,
    required: g.required,
    selectionType: g.selectionType,
    ...(g.minSelect != null ? { min: g.minSelect } : {}),
    ...(g.maxSelect != null ? { max: g.maxSelect } : {}),
    options: [...g.options].sort((a, b) => a.sortOrder - b.sortOrder).map(apiOptionToOption),
  };
}

export function apiProductToMenuItem(p: ApiProduct, inline: ApiModifierGroup[]): MenuItem {
  return {
    id: p.id,
    name: p.name,
    category: p.categoryId ?? '',
    price: {
      weekday: baht(p.priceSatang),
      weekend: baht(p.priceWeekendSatang ?? p.priceSatang),
    },
    ...(p.costSatang != null ? { cost: baht(p.costSatang) } : {}),
    ...(inline.length ? { modifierGroups: inline.map(apiGroupToGroup) } : {}),
    ...(p.linkedModifierGroupIds.length
      ? { linkedModifierGroupIds: p.linkedModifierGroupIds }
      : {}),
    ...(p.prepStationOverride ? { prepStationOverride: p.prepStationOverride } : {}),
    ...(p.taxCategoryOverride ? { taxCategoryOverride: p.taxCategoryOverride } : {}),
    ...(p.stockItemId ? { inventoryItemId: p.stockItemId } : {}),
    ...(p.translations ? { translations: p.translations } : {}),
  };
}

/** The body a menu item edit sends. Fields the form cannot set are carried through. */
export function menuItemToApiBody(item: MenuItem): Partial<ApiProduct> & { name: string; kind: ProductKind } {
  const held = serverFields.get(item.id);
  return {
    kind: 'menu',
    name: item.name,
    code: held?.code ?? null,
    description: held?.description ?? null,
    categoryId: item.category || null,
    priceSatang: satang(item.price.weekday),
    // Write null rather than the same number twice: the column's null IS the
    // "follows the weekday price" rule, and storing a copy would freeze today's
    // weekday price into the weekend one the next time only the weekday changed.
    priceWeekendSatang:
      item.price.weekend === item.price.weekday ? null : satang(item.price.weekend),
    costSatang: item.cost != null ? satang(item.cost) : null,
    prepStationOverride: item.prepStationOverride ?? null,
    taxCategoryOverride: item.taxCategoryOverride ?? null,
    translations: item.translations ?? null,
    stockItemId: item.inventoryItemId ?? null,
    sortOrder: held?.sortOrder ?? 0,
    active: held?.active ?? true,
    linkedModifierGroupIds: item.linkedModifierGroupIds ?? [],
  };
}

export function categoryToApiBody(c: MenuCategoryDef): Partial<ApiMenuCategory> & { name: string } {
  return {
    name: c.name,
    code: categoryCodes.get(c.id) ?? null,
    parentId: c.parentId ?? null,
    taxableCategory: c.defaultTaxCategory ?? null,
    defaultPrepStation: c.defaultPrepStation ?? null,
    sortOrder: c.sortOrder,
    translations: c.translations ?? null,
  };
}

export interface MappedMenu {
  categories: MenuCategoryDef[];
  menuItems: MenuItem[];
  modifierGroups: ModifierGroup[];
}

/** Turn one `GET /branches/:id/menu` into the collections the screens read. */
export function mapMenu(menu: ApiMenu): MappedMenu {
  serverFields.clear();
  categoryCodes.clear();
  for (const c of menu.categories) {
    if (c.code) categoryCodes.set(c.id, c.code);
  }
  for (const p of menu.products) {
    serverFields.set(p.id, {
      code: p.code,
      sku: p.sku,
      active: p.active,
      sortOrder: p.sortOrder,
      description: p.description,
    });
  }
  loaded = true;

  const inlineByProduct = new Map<string, ApiModifierGroup[]>();
  const library: ApiModifierGroup[] = [];
  for (const g of menu.modifierGroups) {
    if (g.productId) {
      const list = inlineByProduct.get(g.productId) ?? [];
      list.push(g);
      inlineByProduct.set(g.productId, list);
    } else {
      library.push(g);
    }
  }

  return {
    categories: menu.categories
      .filter((c) => !c.archivedAt)
      .map(apiCategoryToDef),
    menuItems: menu.products
      .filter((p) => p.kind === 'menu' && !p.archivedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => apiProductToMenuItem(p, inlineByProduct.get(p.id) ?? [])),
    modifierGroups: library
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(apiGroupToGroup),
  };
}
