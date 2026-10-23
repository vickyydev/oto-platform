import type { ApiResponse } from '@oto/api-types';
import type { AddOn, Discount, DiscountTarget, MenuCategoryDef, MenuItem, MerchItem, MerchVariant, ModifierGroup, ModifierOption, TaxableCategory } from '@/types';
import { hydrateFromApi } from '@/store/catalogStore';
import { api } from './client';

/** Read and hydrate the native selling catalogue; administration is hosted by Admin. */
const menuApi = {
load: (branchId: string) => api.get<ApiResponse<'/branches/{branchId}/menu', 'get'>>(`/branches/${branchId}/menu`),
discounts: () => api.get<ApiResponse<'/menu/discounts', 'get'>>('/menu/discounts'),
};

export type ProductKind = 'menu' | 'merch' | 'addon';

type MenuRead = ApiResponse<'/branches/{branchId}/menu', 'get'>;

export type ApiMenuCategory = Pick<MenuRead['categories'][number],
  'id' | 'code' | 'name' | 'parentId' | 'taxableCategory' | 'defaultPrepStation' | 'sortOrder' | 'translations' | 'archivedAt'> &
  Partial<Pick<MenuRead['categories'][number], 'effectiveTaxCategory' | 'effectivePrepStation'>>;

export type ApiModifierOption = Pick<MenuRead['modifierGroups'][number]['options'][number],
  'id' | 'name' | 'priceSatang' | 'priceWeekendSatang' | 'costSatang' | 'sortOrder'> &
  Partial<Pick<MenuRead['modifierGroups'][number]['options'][number], 'translations'>>;

export type ApiModifierGroup = Pick<MenuRead['modifierGroups'][number],
  'id' | 'productId' | 'name' | 'required' | 'selectionType' | 'minSelect' | 'maxSelect' | 'sortOrder'> &
  { options: ApiModifierOption[] } & Partial<Pick<MenuRead['modifierGroups'][number], 'translations'>>;

export type ApiProduct = Pick<MenuRead['products'][number],
  'id' | 'kind' | 'code' | 'categoryId' | 'name' | 'description' | 'priceSatang' | 'priceWeekendSatang' | 'costSatang' |
  'prepStationOverride' | 'taxCategoryOverride' | 'translations' | 'sku' | 'stockItemId' | 'sortOrder' | 'active' |
  'archivedAt' | 'linkedModifierGroupIds'> & Partial<Pick<MenuRead['products'][number],
  'branchId' | 'effectiveWeekendSatang' | 'effectivePrepStation' | 'effectiveTaxCategory' | 'variants' | 'stockLinks'>>;

export type ApiProductStockLink = MenuRead['products'][number]['stockLinks'][number];

export type ApiProductVariant = MenuRead['products'][number]['variants'][number];

export interface ApiMenu {
  categories: ApiMenuCategory[];
  modifierGroups: ApiModifierGroup[];
  products: ApiProduct[];
}

type DiscountRead = ApiResponse<'/menu/discounts', 'get'>['discounts'][number];

export type ApiDiscount = Omit<DiscountRead, 'usedCount' | 'operatorId' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<DiscountRead, 'usedCount' | 'operatorId' | 'createdAt' | 'updatedAt'>>;

interface ServerFields {
  kind: ProductKind;
  /** Missing on older reads; live write offers fail closed for an unknown owner. */
  branchId: string | null | undefined;
  code: string | null;
  sku: string | null;
  active: boolean;
  sortOrder: number;
  description: string | null;
  /** S2-14b — the item's stock links at this branch, as last read. */
  stockLinks: ApiProductStockLink[];
  /** S2-14b — the sizes the catalogue sells it in, as last read (`[]` for one size). */
  sizes: Array<{ id: string; label: string }>;
}

export interface MappedMenu {
  categories: MenuCategoryDef[];
  menuItems: MenuItem[];
  modifierGroups: ModifierGroup[];
  merchItems: MerchItem[];
  addOns: AddOn[];
}

const baht = (satang: number): number => satang / 100;

const serverFields = new Map<string, ServerFields>();

const categoryCodes = new Map<string, string>();

export function catalogueSizesOf(productId: string): Array<{ id: string; label: string }> {
  const sizes = serverFields.get(productId)?.sizes ?? [];
  return sizes.length > 1 ? sizes : [];
}

const SOCKS_PRODUCT_CODE = 'AO-SOCKS';

export function isSocksAddOnId(id: string): boolean {
  return id === 'a-socks' || serverFields.get(id)?.code === SOCKS_PRODUCT_CODE;
}

const categoryIdByArea = new Map<TaxableCategory, Map<string, string>>();

const categoryNameById = new Map<string, string>();

const categoryNamesByArea = new Map<TaxableCategory, string[]>();

const categoryIdByTaxArea = new Map<string, string>();

const discountIdByCode = new Map<string, string>();

const inlineGroupsByProduct = new Map<string, ApiModifierGroup[]>();

const modifierFields = new Map<string, ApiModifierGroup>();


const nameKey = (name: string): string => name.trim().toLowerCase();

function stockKeyOf(p: ApiProduct): { inventoryItemId?: string } {
  const tracked = (p.stockLinks?.length ?? 0) > 0 || (p.stockLinks === undefined && !!p.stockItemId);
  return tracked ? { inventoryItemId: p.id } : {};
}

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
    ...stockKeyOf(p),
    ...(p.translations ? { translations: p.translations } : {}),
  };
}

export function apiProductToMerchItem(p: ApiProduct): MerchItem {
  return {
    id: p.id,
    name: p.name,
    active: p.active,
    price: {
      weekday: baht(p.priceSatang),
      weekend: baht(p.priceWeekendSatang ?? p.priceSatang),
    },
    ...(p.costSatang != null ? { cost: baht(p.costSatang) } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    // The chip on the shop grid is the category's NAME; the column is its id.
    ...(p.categoryId && categoryNameById.has(p.categoryId)
      ? { category: categoryNameById.get(p.categoryId)! }
      : {}),
    ...(p.taxCategoryOverride ? { taxCategoryOverride: p.taxCategoryOverride } : {}),
    ...stockKeyOf(p),
    ...(p.variants && p.variants.length > 0 ? { variants: p.variants.map(apiVariantToVariant) } : {}),
  };
}

function apiVariantToVariant(v: ApiProductVariant): MerchVariant {
  return {
    id: v.id,
    label: v.label,
    ...(v.sku ? { sku: v.sku } : {}),
    ...(v.barcode ? { barcode: v.barcode } : {}),
  };
}

export function apiProductToAddOn(p: ApiProduct): AddOn {
  return {
    id: p.id,
    name: p.name,
    price: {
      weekday: baht(p.priceSatang),
      weekend: baht(p.priceWeekendSatang ?? p.priceSatang),
    },
    ...stockKeyOf(p),
    ...(p.taxCategoryOverride ? { taxCategoryOverride: p.taxCategoryOverride } : {}),
    ...(p.translations ? { translations: p.translations } : {}),
  };
}

export function apiDiscountToDiscount(d: ApiDiscount): Discount {
  return {
    code: d.code,
    label: d.label,
    type: d.kind,
    // Basis points to whole per cent, satang to baht — the prototype's units.
    value:
      d.kind === 'percent'
        ? (d.valueBp ?? 0) / 100
        : d.kind === 'fixed'
          ? baht(d.valueSatang ?? 0)
          : 0,
    ...(d.freeProductId ? { freeItemId: d.freeProductId, freeItemKind: serverFields.get(d.freeProductId)?.kind === 'merch' ? 'merch' as const : 'menu' as const } : {}),
    ...(d.target ? { target: d.target as DiscountTarget } : {}),
    ...(d.validFrom ? { validFrom: d.validFrom } : {}),
    ...(d.validUntil ? { validUntil: d.validUntil } : {}),
    ...(d.usageLimit != null ? { usageLimit: d.usageLimit } : {}),
    ...(d.perCustomerLimit != null ? { perCustomerLimit: d.perCustomerLimit } : {}),
    ...(d.usedCount != null ? { usedCount: d.usedCount } : {}),
    stackable: d.stackable,
    active: d.active,
  };
}

export function mapDiscounts(rows: ApiDiscount[]): Discount[] {
  discountIdByCode.clear();
  const live = rows.filter((d) => !d.archivedAt);
  for (const d of live) discountIdByCode.set(d.code, d.id);
  return live.map(apiDiscountToDiscount);
}

export function mapMenu(menu: ApiMenu): MappedMenu {
  serverFields.clear();
  categoryCodes.clear();
  inlineGroupsByProduct.clear();
  modifierFields.clear();
  categoryIdByArea.clear();
  categoryNameById.clear();
  categoryNamesByArea.clear();
  categoryIdByTaxArea.clear();
  const categoryById = new Map(menu.categories.map((c) => [c.id, c]));
  /**
   * A sub-category leaves `taxableCategory` null and inherits its parent's —
   * the same rule the platform's own resolver applies — and the tree is two
   * levels deep, so one hop up answers it.
   */
  const areaOf = (c: ApiMenuCategory): TaxableCategory | null =>
    c.taxableCategory ??
    (c.parentId ? (categoryById.get(c.parentId)?.taxableCategory ?? null) : null);
  for (const c of menu.categories) {
    if (c.code) categoryCodes.set(c.id, c.code);
    if (c.archivedAt) continue;
    categoryNameById.set(c.id, c.name);
    const area = areaOf(c);
    if (!area) continue;
    // First wins, and the categories arrive in sort order, so "the retail
    // area's default" is the first retail tab rather than whichever row
    // Postgres happened to return last. The same rule settles two tabs of one
    // area sharing a name.
    if (!categoryIdByTaxArea.has(area)) categoryIdByTaxArea.set(area, c.id);
    const byName = categoryIdByArea.get(area) ?? new Map<string, string>();
    categoryIdByArea.set(area, byName);
    const key = nameKey(c.name);
    if (!byName.has(key)) {
      byName.set(key, c.id);
      categoryNamesByArea.set(area, [...(categoryNamesByArea.get(area) ?? []), c.name]);
    }
  }
  for (const p of menu.products) {
    serverFields.set(p.id, {
      kind: p.kind,
      branchId: p.branchId,
      code: p.code,
      sku: p.sku,
      active: p.active,
      sortOrder: p.sortOrder,
      description: p.description,
      stockLinks: p.stockLinks ?? [],
      sizes: (p.variants ?? []).map((v) => ({ id: v.id, label: v.label })),
    });
  }
  loaded = true;

  const inlineByProduct = new Map<string, ApiModifierGroup[]>();
  const library: ApiModifierGroup[] = [];
  for (const g of menu.modifierGroups) {
    modifierFields.set(g.id, g);
    if (g.productId) {
      const list = inlineByProduct.get(g.productId) ?? [];
      list.push(g);
      inlineByProduct.set(g.productId, list);
    } else {
      library.push(g);
    }
  }
  // In the order the questions are asked, not the order the rows arrived: the
  // item form writes each group's position back as its `sortOrder`, so the list
  // it was seeded from has to be the sorted one.
  for (const groups of inlineByProduct.values()) groups.sort((a, b) => a.sortOrder - b.sortOrder);
  for (const [productId, groups] of inlineByProduct) inlineGroupsByProduct.set(productId, groups);

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
    merchItems: menu.products
      .filter((p) => p.kind === 'merch' && !p.archivedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(apiProductToMerchItem),
    addOns: menu.products
      .filter((p) => p.kind === 'addon' && !p.archivedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(apiProductToAddOn),
  };
}

export async function reloadMenuInto(branchId: string, branchSlug: string): Promise<void> {
  const [menu, discountRows] = await Promise.all([menuApi.load(branchId), menuApi.discounts()]);
  const mapped = mapMenu(menu);
  hydrateFromApi({
    perBranch: {
      [branchSlug]: {
        menuCategories: mapped.categories,
        menuItems: mapped.menuItems,
        modifierGroups: mapped.modifierGroups,
        merchItems: mapped.merchItems,
        addOns: mapped.addOns,
        discounts: mapDiscounts(discountRows.discounts),
      },
    },
  });

}
