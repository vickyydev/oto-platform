import {
  businessDate,
  cartUnits,
  computeTicketCartTotals,
  deriveSaleLineId,
  getRateModeForDate,
  isLegacyBoothCode,
  itemCartLine,
  itemCategoryWalk,
  itemPricePair,
  itemTaxCategory,
  itemUnitPrice,
  ledgerUnitComponentKey,
  ledgerUnitKindOf,
  ledgerUnitLabel,
  normaliseBoothCode,
  parseDayStart,
  priceCartLine,
  PRICING_ENGINE_VERSION,
  splitLedgerUnitMoney,
  TaxConfigSchema,
  TaxableCategorySchema,
  verifyBoothCode,
  type BridgeCart,
  type OfflinePriceBasis,
  type CartAddOn,
  type CartPromo,
  type DiscountTarget,
  type ManualDiscount,
  type PricingContext,
  type SalePrintLine,
  type TaxableCategory,
  type TaxConfigShape,
  type TicketCartLine,
  type TicketCartTotals,
} from '@oto/shared';

/**
 * PRICING A CART ON THE BOX (offline plan §2.4 step 1, Round 3).
 *
 * The platform prices a cart in `priceCart` (`apps/api/src/services/sale.ts`)
 * from rows it reads on the spot. A box with no internet has only the
 * `catalogue` scope of its cache, so this is the same resolution done over that
 * document, and nothing else: the arithmetic is the shared satang engine's —
 * `priceCartLine`, `itemUnitPrice`, `itemCartLine`, `computeTicketCartTotals` —
 * which round 2 made the one calculator every surface prices with. What lives
 * here is only what the platform reads from its database: which package, which
 * product, which options an item offers, which tax area an item's money lands
 * in, which trading day it is and whether that day prices as a weekend.
 *
 * The same refusals, in the platform's words where the platform has words: a
 * package the box does not hold, an item off the menu, a question left
 * unanswered, a size not chosen. A cart the platform would refuse is refused
 * here too, so a sale rung up offline is one the platform can file.
 *
 * THE ONE PLACE IT DIFFERS, ON PURPOSE. Promo codes are priced from the TILL'S
 * copy (plan §2.8, "Promo code — till's copy; filed as applied"), because the
 * definitions and their usage limits are the platform's to judge and a box
 * cannot count uses across counters. The platform files such a sale with the
 * code as applied and raises an alert on any difference (SCRUM-401).
 */

/** A refusal, with the code the till tells apart. */
export class OfflinePriceError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'OfflinePriceError';
    this.code = code;
    this.details = details;
  }
}

const refuse = (message: string, details?: Record<string, unknown>): never => {
  throw new OfflinePriceError('VALIDATION', message, details);
};

// --- The cached catalogue, read ------------------------------------------------

interface PackageRow {
  id: string;
  name: string;
  prices: Record<string, { weekday: number; weekend: number }>;
  adultRules: unknown;
  active: boolean;
  archivedAt: string | null;
  /** How long a band from it admits: the receipt and the band print it. */
  hours: number | null;
  durationLabel: string | null;
}

interface CategoryRow {
  id: string;
  parentId: string | null;
  taxableCategory: TaxableCategory | null;
  name: string;
  /** Where an item filed here prints its prep ticket, unless it says otherwise. */
  defaultPrepStation: string | null;
}

interface ProductRow {
  id: string;
  kind: string;
  name: string;
  priceSatang: number;
  priceWeekendSatang: number | null;
  categoryId: string | null;
  taxCategoryOverride: TaxableCategory | null;
  prepStationOverride: string | null;
  variants: Array<{ id: string; label: string }>;
  active: boolean;
  archivedAt: string | null;
}

interface GroupRow {
  id: string;
  productId: string | null;
  name: string;
  required: boolean;
  selectionType: 'single' | 'multi';
  minSelect: number | null;
  maxSelect: number | null;
  sortOrder: number;
}

interface OptionRow {
  id: string;
  modifierGroupId: string;
  name: string;
  priceSatang: number;
  priceWeekendSatang: number | null;
  sortOrder: number;
}

interface LinkRow {
  productId: string;
  modifierGroupId: string;
  sortOrder: number;
}

/** The `catalogue` scope of a box's cache, read into what pricing needs. */
export interface OfflineCatalogue {
  /** The catalogue's own version hash (OD-8); null from an api that sends none. */
  version: string | null;
  packages: Map<string, PackageRow>;
  categories: CategoryRow[];
  products: Map<string, ProductRow>;
  groups: GroupRow[];
  options: OptionRow[];
  links: LinkRow[];
  defaultTier: string;
  holidays: Array<{ name: string; startsOn: string; endsOn: string }>;
  taxConfig: TaxConfigShape | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((r): r is Record<string, unknown> => !!r)
    : [];
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

function taxArea(value: unknown): TaxableCategory | null {
  const parsed = TaxableCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Read the one item of the `catalogue` scope. Null when the box holds none —
 * a box that has never pulled cannot price anything, and says so.
 */
export function readOfflineCatalogue(
  payload: Record<string, unknown> | null | undefined,
): OfflineCatalogue | null {
  const items = Array.isArray(payload?.items) ? (payload.items as unknown[]) : [];
  const item = record(items[0]);
  if (!item) return null;

  const packages = new Map<string, PackageRow>();
  for (const row of rows(item.packages)) {
    const id = str(row.id);
    if (!id) continue;
    packages.set(id, {
      id,
      name: str(row.name) ?? 'Ticket',
      prices: (record(row.prices) ?? {}) as PackageRow['prices'],
      adultRules: row.adultRules ?? null,
      active: row.active !== false,
      archivedAt: str(row.archivedAt),
      hours: int(row.hours),
      durationLabel: str(row.durationLabel),
    });
  }

  const products = new Map<string, ProductRow>();
  for (const row of rows(item.products)) {
    const id = str(row.id);
    if (!id) continue;
    products.set(id, {
      id,
      kind: str(row.kind) ?? 'menu',
      name: str(row.name) ?? 'Item',
      priceSatang: int(row.priceSatang) ?? 0,
      priceWeekendSatang: int(row.priceWeekendSatang),
      categoryId: str(row.categoryId),
      taxCategoryOverride: taxArea(row.taxCategoryOverride),
      prepStationOverride: str(row.prepStationOverride),
      variants: rows(row.variants).flatMap((v) => {
        const vid = str(v.id);
        return vid ? [{ id: vid, label: str(v.label) ?? vid }] : [];
      }),
      active: row.active !== false,
      archivedAt: str(row.archivedAt),
    });
  }

  const tiers = rows(item.tiers).filter((t) => !t.archivedAt);
  const defaultTier = str(tiers.find((t) => t.isDefault === true)?.code) ?? 'tourist';
  const taxRow = record(item.taxConfig);
  const tax = TaxConfigSchema.safeParse(taxRow?.config ?? taxRow);

  return {
    version: str(item.version),
    packages,
    categories: rows(item.categories).flatMap((c) => {
      const id = str(c.id);
      return id
        ? [
            {
              id,
              parentId: str(c.parentId),
              taxableCategory: taxArea(c.taxableCategory),
              name: str(c.name) ?? '',
              defaultPrepStation: str(c.defaultPrepStation),
            },
          ]
        : [];
    }),
    products,
    groups: rows(item.modifierGroups).flatMap((g) => {
      const id = str(g.id);
      return id
        ? [
            {
              id,
              productId: str(g.productId),
              name: str(g.name) ?? '',
              required: g.required === true,
              selectionType: g.selectionType === 'multi' ? ('multi' as const) : ('single' as const),
              minSelect: int(g.minSelect),
              maxSelect: int(g.maxSelect),
              sortOrder: int(g.sortOrder) ?? 0,
            },
          ]
        : [];
    }),
    options: rows(item.modifierOptions).flatMap((o) => {
      const id = str(o.id);
      const group = str(o.modifierGroupId);
      return id && group
        ? [
            {
              id,
              modifierGroupId: group,
              name: str(o.name) ?? '',
              priceSatang: int(o.priceSatang) ?? 0,
              priceWeekendSatang: int(o.priceWeekendSatang),
              sortOrder: int(o.sortOrder) ?? 0,
            },
          ]
        : [];
    }),
    links: rows(item.modifierLinks).flatMap((l) => {
      const productId = str(l.productId);
      const modifierGroupId = str(l.modifierGroupId);
      return productId && modifierGroupId
        ? [{ productId, modifierGroupId, sortOrder: int(l.sortOrder) ?? 0 }]
        : [];
    }),
    defaultTier,
    holidays: rows(item.holidays)
      .filter((h) => !h.archivedAt)
      .flatMap((h) => {
        const startsOn = str(h.startsOn);
        const endsOn = str(h.endsOn);
        return startsOn && endsOn ? [{ name: str(h.name) ?? 'Holiday', startsOn, endsOn }] : [];
      }),
    taxConfig: tax.success ? tax.data : null,
  };
}

// --- The walks the platform does in SQL ------------------------------------------

/** The item's override, else its category's area, else the parent's (`itemTaxCategory` in the api's menu). */
function resolvedTaxArea(
  item: Pick<ProductRow, 'categoryId' | 'taxCategoryOverride'>,
  categories: readonly CategoryRow[],
): TaxableCategory | undefined {
  if (item.taxCategoryOverride) return item.taxCategoryOverride;
  const own = categories.find((c) => c.id === item.categoryId);
  if (!own) return undefined;
  if (own.taxableCategory) return own.taxableCategory;
  const parent = own.parentId ? categories.find((c) => c.id === own.parentId) : undefined;
  return parent?.taxableCategory ?? undefined;
}

/** Inline groups first, then the library groups the item links (`effectiveModifierGroups`). */
function effectiveGroups(itemId: string, catalogue: OfflineCatalogue): GroupRow[] {
  const own = catalogue.groups
    .filter((g) => g.productId === itemId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const seen = new Set(own.map((g) => g.id));
  const linked: GroupRow[] = [];
  for (const link of catalogue.links
    .filter((l) => l.productId === itemId)
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (seen.has(link.modifierGroupId)) continue;
    const group = catalogue.groups.find(
      (g) => g.id === link.modifierGroupId && g.productId === null,
    );
    if (group) {
      linked.push(group);
      seen.add(group.id);
    }
  }
  return [...own, ...linked];
}

/** The prototype's `isGroupSatisfied`, as `modifierGroupSatisfied` in the api ports it. */
function groupSatisfied(group: GroupRow, count: number): boolean {
  if (group.selectionType === 'single') return group.required ? count === 1 : count <= 1;
  const min = group.required ? (group.minSelect ?? 1) : (group.minSelect ?? 0);
  const max = group.maxSelect ?? Number.POSITIVE_INFINITY;
  return count >= min && count <= max;
}

/** The scopes the engine reads, as `engineTarget` in the api reads them. */
function engineTarget(raw: unknown): DiscountTarget | undefined | null {
  const target = record(raw);
  if (!target) return raw === undefined || raw === null ? undefined : null;
  switch (target.kind) {
    case 'everything':
      return undefined;
    case 'tickets':
    case 'addOns':
    case 'fnb':
    case 'merch':
    case 'event_pass':
      return { kind: target.kind };
    case 'ticketGroup':
      return target.group === 'kids' || target.group === 'adults'
        ? { kind: 'ticketGroup', group: target.group }
        : null;
    case 'ticketType':
      return typeof target.ticketTypeId === 'string' && target.ticketTypeId
        ? { kind: 'ticketType', ticketTypeId: target.ticketTypeId }
        : null;
    case 'addOn':
      return typeof target.addOnId === 'string' && target.addOnId
        ? { kind: 'addOn', addOnId: target.addOnId }
        : null;
    case 'fnbCategory':
      return typeof target.category === 'string' && target.category
        ? { kind: 'fnbCategory', category: target.category }
        : null;
    case 'menuItems':
      return Array.isArray(target.menuItemIds)
        ? {
            kind: 'menuItems',
            menuItemIds: target.menuItemIds.filter((x): x is string => typeof x === 'string'),
          }
        : null;
    default:
      return null;
  }
}

// --- The quote -------------------------------------------------------------------

export interface OfflineQuoteContext {
  now: Date;
  timezone: string;
  businessDayStart: string;
  /** The member's tier from the box's copy, or null for a walk-in. */
  memberTier: string | null;
}

/** What the till reads back — the platform's `ApiSaleQuote`, from the box. */
export interface OfflineQuote {
  source: 'box';
  businessDate: string;
  pricingMode: 'weekday' | 'weekend';
  pricingModeReason: string;
  holidayName: string | null;
  tier: string;
  tierSource: 'member' | 'default';
  tierClaimRefusal: null;
  customerTier: string;
  engineVersion: string;
  catalogueVersion: string | null;
  /** How old the catalogue behind this quote is (OD-5), set by the bridge. */
  catalogueState?: 'fresh' | 'stale' | 'refused' | 'missing';
  catalogueAppliedAt?: string | null;
  totals: {
    subtotalSatang: number;
    manualDiscountSatang: number;
    promoDiscountSatang: number;
    discountSatang: number;
    netSatang: number;
    serviceChargeSatang: number;
    taxInclusiveSatang: number;
    taxExclusiveSatang: number;
    grossSatang: number;
    unappliedDiscountSatang: number;
  };
  lineTotals: Record<string, number>;
  itemPresentation: Record<
    string,
    {
      name: string;
      basePriceSatang: number;
      modifiers: { groupName: string; optionName: string; priceSatang: number }[];
    }
  >;
  manualAmounts: Record<string, number>;
  appliedPromos: {
    code: string;
    label: string;
    type: 'percent' | 'fixed' | 'free_item';
    amountSatang: number;
    exhaustedReason?: string;
  }[];
  rejectedPromoCodes: { code: string; reason: string }[];
  voucher: null;
  taxBreakdown: TicketCartTotals['taxBreakdown'];
  disagreements: {
    pricingModeSentByTill: string | null;
    tierSentByTill: string | null;
    pricingModeDiffers: boolean;
    tierDiffers: boolean;
  };
}

/**
 * Price a cart from the box's catalogue.
 *
 * The trading day and its rate come from the box's clock and the branch's
 * calendar in the same bundle; the tier from the member's cached record, else
 * the operator's default — never from the cart, whatever it says (rule 2 of
 * `sale.ts`). A voucher is refused outright: single use across counters is the
 * platform's to judge (plan §2.8).
 */
export function priceOfflineCart(
  catalogue: OfflineCatalogue,
  cart: BridgeCart,
  context: OfflineQuoteContext,
): OfflineQuote {
  return priceOfflineSale(catalogue, cart, context).quote;
}

/** An F&B or shop line's own facts, beside its money: what the ledger's line payload carries. */
export interface OfflineItemLine {
  kind: 'fnb_item' | 'merch_item';
  productId: string;
  payload: {
    modifiers?: {
      groupId: string;
      groupName: string;
      optionId: string;
      optionName: string;
      unitSatang: number;
    }[];
    note?: string;
    variant?: { variantId: string; variantLabel: string };
    prepStation?: string;
  };
}

/** Everything a sale taken on the box is priced from, beside the till's quote. */
export interface OfflineSalePricing {
  quote: OfflineQuote;
  cartLines: TicketCartLine[];
  ctx: PricingContext;
  totals: TicketCartTotals;
  /** The F&B and shop lines, by cart line id. */
  items: Map<string, OfflineItemLine>;
  /** The rows the price came from, for the fact (OD-8). */
  basis: OfflinePriceBasis;
}

/**
 * Where an item's prep ticket prints: its own override, else its category's,
 * else the parent's, else the kitchen — `effectivePrepStation` in the api's
 * menu, walked over the cached catalogue.
 */
function prepStationOf(product: ProductRow, categories: readonly CategoryRow[]): string {
  if (product.prepStationOverride) return product.prepStationOverride;
  const own = categories.find((c) => c.id === product.categoryId);
  if (own?.defaultPrepStation) return own.defaultPrepStation;
  const parent = own?.parentId ? categories.find((c) => c.id === own.parentId) : undefined;
  return parent?.defaultPrepStation ?? 'kitchen';
}

/**
 * Price a sale from the box's catalogue: the quote the till shows, and the
 * engine's own cart lines and totals, which the ledger lines of an offline
 * receipt are split from (`splitLedgerUnitMoney`), and the price basis the
 * fact carries (OD-8).
 */
export function priceOfflineSale(
  catalogue: OfflineCatalogue,
  cart: BridgeCart,
  context: OfflineQuoteContext,
): OfflineSalePricing {
  const items = new Map<string, OfflineItemLine>();
  const optionsUsed = new Map<string, OptionRow>();
  if (!catalogue.taxConfig) {
    throw new OfflinePriceError(
      'VALIDATION',
      'This branch has no tax configuration on this box, so nothing can be priced',
    );
  }
  /**
   * A code named alone is a voucher's or nobody's. A voucher is refused
   * outright (single use across counters is the platform's to judge, plan
   * §2.8); anything else is refused by name with nothing taken off, in the
   * words the platform's quote uses.
   */
  const rejectedPromoCodes: OfflineQuote['rejectedPromoCodes'] = [];
  for (const raw of cart.promoCodes) {
    const code = normaliseBoothCode(raw);
    if (verifyBoothCode(code).ok || isLegacyBoothCode(code)) {
      throw new OfflinePriceError(
        'VOUCHER_NEEDS_INTERNET',
        'Vouchers need the internet — take this one when the connection is back',
      );
    }
    rejectedPromoCodes.push({ code: raw, reason: `Code "${raw}" was not found.` });
  }
  const date = businessDate(context.now, context.timezone, parseDayStart(context.businessDayStart));
  const rate = getRateModeForDate(date, catalogue.holidays);
  const tierCode = context.memberTier ?? catalogue.defaultTier;
  const tierSource: OfflineQuote['tierSource'] = context.memberTier ? 'member' : 'default';

  const socksProduct = cart.socks ? catalogue.products.get(cart.socks.addOnId) : undefined;
  const ctx: PricingContext = {
    mode: rate.mode,
    socks: {
      addOnId: socksProduct?.id ?? cart.socks?.addOnId ?? 'socks-not-configured',
      price: socksProduct?.priceSatang ?? cart.socks?.unitSatang ?? 0,
      label: socksProduct?.name ?? cart.socks?.label ?? 'Socks',
    },
  };

  const cartLines: TicketCartLine[] = [];
  for (const line of cart.lines) {
    const pkg = catalogue.packages.get(line.packageId);
    if (!pkg || !pkg.active || pkg.archivedAt) {
      refuse('A selected ticket is no longer available', { cartLineId: line.id });
    }
    const found = pkg!;
    if (!found.prices[tierCode]) {
      refuse(`"${found.name}" has no ${tierCode} price, so it cannot be sold at that tier`);
    }
    if ((line.socks ?? 0) > 0 && !cart.socks) {
      refuse('This cart has socks on it but no socks add-on was named');
    }
    const addOns: CartAddOn[] = (line.addOns ?? []).map((addOn) => {
      const product = catalogue.products.get(addOn.id);
      if (!product && (addOn.unitSatang === undefined || !addOn.name)) {
        refuse(`Add-on "${addOn.id}" is not in this branch catalogue and carries no price`);
      }
      const area = product
        ? resolvedTaxArea(product, catalogue.categories)
        : (taxArea(addOn.taxCategoryOverride) ?? undefined);
      return {
        id: product?.id ?? addOn.id,
        name: product?.name ?? addOn.name ?? 'Add-on',
        price: product?.priceSatang ?? addOn.unitSatang ?? 0,
        quantity: addOn.quantity,
        ...(area ? { taxCategoryOverride: area } : {}),
      };
    });
    const cartLine: TicketCartLine = {
      id: line.id,
      packageId: found.id,
      package: { prices: found.prices, adultRules: found.adultRules as never },
      tier: tierCode,
      kids: line.kids,
      adults: line.adults,
      socks: line.socks ?? 0,
      addOns,
      ...(line.serviceFee
        ? { serviceFee: { label: line.serviceFee.label, amount: line.serviceFee.amountSatang } }
        : {}),
      ...(line.foodProvision
        ? { foodProvision: { mode: line.foodProvision.mode, paid: line.foodProvision.paidSatang } }
        : {}),
      ...(line.promoItem
        ? {
            promoItem: {
              itemId: line.promoItem.itemId,
              itemKind: line.promoItem.itemKind,
              name: line.promoItem.name,
              price: line.promoItem.priceSatang,
            },
          }
        : {}),
      lineTotal: 0,
    };
    cartLine.lineTotal = priceCartLine(cartLine, ctx);
    if (line.lineTotalSatang !== undefined && line.lineTotalSatang !== cartLine.lineTotal) {
      throw new OfflinePriceError(
        'SALE_LINE_PRICE_MISMATCH',
        'The till and the box priced a line differently — refresh the catalogue and re-price',
        {
          cartLineId: line.id,
          tillLineTotalSatang: line.lineTotalSatang,
          boxLineTotalSatang: cartLine.lineTotal,
        },
      );
    }
    cartLines.push(cartLine);
  }

  const itemPresentation: OfflineQuote['itemPresentation'] = {};
  const freeItemLines: Array<{ lineId: string; productId: string }> = cartLines.flatMap((line) =>
    line.promoItem ? [{ lineId: line.id, productId: line.promoItem.itemId }] : [],
  );
  for (const line of cart.items) {
    const product = catalogue.products.get(line.productId);
    if (!product || !product.active || product.archivedAt) {
      refuse('That item is not on this branch’s menu any more, so it cannot be sold', {
        cartLineId: line.id,
        productId: line.productId,
      });
    }
    const row = product!;
    if (row.kind === 'addon') {
      refuse(`"${row.name}" is a ticket add-on: it goes on a ticket line, not on its own`, {
        cartLineId: line.id,
      });
    }
    const isMerch = row.kind === 'merch';
    const groups = effectiveGroups(row.id, catalogue).map((group) => ({
      group,
      options: catalogue.options
        .filter((o) => o.modifierGroupId === group.id)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }));
    const chosen = new Map((line.modifiers ?? []).map((m) => [m.groupId, m.optionIds]));
    for (const selection of line.modifiers ?? []) {
      if (!groups.some((g) => g.group.id === selection.groupId)) {
        refuse(`"${row.name}" does not ask that question, so those choices cannot be priced`, {
          modifierGroupId: selection.groupId,
        });
      }
    }
    for (const { group, options } of groups) {
      const optionIds = chosen.get(group.id) ?? [];
      const offered = new Set(options.map((o) => o.id));
      if (optionIds.some((id) => !offered.has(id))) {
        refuse(`That choice is not one of the answers to "${group.name}"`, {
          modifierGroupId: group.id,
        });
      }
      if (new Set(optionIds).size !== optionIds.length) {
        refuse(`"${group.name}" was answered twice with the same choice`, {
          modifierGroupId: group.id,
        });
      }
      if (!groupSatisfied(group, optionIds.length)) {
        refuse(
          group.required && optionIds.length === 0
            ? `"${group.name}" has to be answered before "${row.name}" can be ordered`
            : `The choices for "${group.name}" are not what that question allows`,
          { modifierGroupId: group.id },
        );
      }
    }
    let label = row.name;
    if (isMerch) {
      if (!line.variant) {
        if (row.variants.length >= 2) {
          refuse(
            `A size has to be chosen before "${row.name}" can be sold — it comes in ${row.variants
              .map((v) => v.label)
              .join(', ')}`,
          );
        }
      } else {
        const size = row.variants.find((v) => v.id === line.variant!.variantId);
        if (!size) refuse(`"${row.name}" has no size "${line.variant.variantId}"`);
        label = `${row.name} — ${size!.label}`;
      }
    }
    const picked = groups.flatMap(({ group, options }) =>
      (chosen.get(group.id) ?? []).map((optionId) => ({
        group,
        option: options.find((o) => o.id === optionId)!,
      })),
    );
    const priced = itemUnitPrice(
      itemPricePair(row.priceSatang, row.priceWeekendSatang),
      picked.map(({ option }) => itemPricePair(option.priceSatang, option.priceWeekendSatang)),
      ctx.mode,
    );
    const cartLine = itemCartLine(
      {
        id: line.id,
        itemId: row.id,
        name: label,
        itemKind: isMerch ? 'merch' : 'menu',
        unitPrice: priced.unit,
        quantity: line.quantity,
        taxCategory: itemTaxCategory(
          isMerch ? 'merch' : 'menu',
          resolvedTaxArea(row, catalogue.categories),
        ),
        categoryIds: itemCategoryWalk(
          row.categoryId,
          (id) => catalogue.categories.find((c) => c.id === id)?.parentId ?? null,
        ),
        tier: tierCode,
      },
      ctx,
    );
    if (line.lineTotalSatang !== undefined && line.lineTotalSatang !== cartLine.lineTotal) {
      throw new OfflinePriceError(
        'SALE_LINE_PRICE_MISMATCH',
        'The till and the box priced a line differently — refresh the catalogue and re-price',
        {
          cartLineId: line.id,
          tillLineTotalSatang: line.lineTotalSatang,
          boxLineTotalSatang: cartLine.lineTotal,
        },
      );
    }
    itemPresentation[line.id] = {
      name: label,
      basePriceSatang: priced.base,
      modifiers: picked.map(({ group, option }, index) => ({
        groupName: group.name,
        optionName: option.name,
        priceSatang: priced.options[index] ?? 0,
      })),
    };
    for (const { option } of picked) optionsUsed.set(option.id, option);
    const size =
      isMerch && line.variant ? row.variants.find((v) => v.id === line.variant!.variantId) : undefined;
    const note = (line.note ?? '').trim();
    items.set(line.id, {
      kind: isMerch ? 'merch_item' : 'fnb_item',
      productId: row.id,
      payload: {
        ...(picked.length > 0
          ? {
              modifiers: picked.map(({ group, option }, index) => ({
                groupId: group.id,
                groupName: group.name,
                optionId: option.id,
                optionName: option.name,
                unitSatang: priced.options[index] ?? 0,
              })),
            }
          : {}),
        ...(note ? { note } : {}),
        ...(size
          ? { variant: { variantId: size.id, variantLabel: size.label } }
          : !isMerch && line.variant
            ? { variant: line.variant }
            : {}),
        ...(isMerch ? {} : { prepStation: prepStationOf(row, catalogue.categories) }),
      },
    });
    freeItemLines.push({ lineId: line.id, productId: row.id });
    cartLines.push(cartLine);
  }

  if (cartLines.length === 0) refuse('The cart is empty');
  if (new Set(cartLines.map((l) => l.id)).size !== cartLines.length) {
    refuse('Two lines on this cart carry the same id, so it cannot be priced');
  }

  // The till's copy of each promo code, applied as it applied it (see the header).
  const aimed = new Set<string>();
  const promos: CartPromo[] = cart.promos.map((entry) => {
    const target = entry.type === 'free_item' ? undefined : engineTarget(entry.target);
    const line =
      entry.type === 'free_item' && entry.freeItemId
        ? freeItemLines.find((l) => l.productId === entry.freeItemId && !aimed.has(l.lineId))
        : undefined;
    if (line) aimed.add(line.lineId);
    return {
      code: entry.code,
      label: entry.label,
      type: entry.type,
      value: entry.value,
      ...(entry.freeItemId ? { freeItemId: entry.freeItemId } : {}),
      ...(entry.freeItemKind ? { freeItemKind: entry.freeItemKind } : {}),
      ...(target ? { target } : {}),
      ...(line ? { line: { lineId: line.lineId } } : {}),
    };
  });
  const manualDiscounts: ManualDiscount[] = cart.manualDiscounts.map((d) => ({
    id: d.id,
    scope: d.scope,
    ...(d.targetLineId ? { targetLineId: d.targetLineId } : {}),
    ...(d.targetComponent ? { targetComponent: d.targetComponent } : {}),
    ...(d.targetLabel ? { targetLabel: d.targetLabel } : {}),
    type: d.type,
    value: d.value,
    reason: d.reason,
  })) as ManualDiscount[];

  const totals = computeTicketCartTotals(
    cartLines,
    promos,
    manualDiscounts,
    catalogue.taxConfig,
    ctx,
  );
  const tb = totals.taxBreakdown;
  const net = tb.grandTotal - tb.serviceChargeTotal - tb.inclusiveTaxTotal - tb.exclusiveTaxTotal;
  if (net < 0) {
    refuse(
      "These totals cannot be recorded: the discount exceeds the taxed amount under this branch's after-tax discount placement",
    );
  }
  const lineTotals: Record<string, number> = {};
  for (const line of cartLines) lineTotals[line.id] = line.lineTotal;

  const productsUsed = new Set<string>([
    ...(socksProduct ? [socksProduct.id] : []),
    ...cart.lines.flatMap((line) => (line.addOns ?? []).map((a) => a.id)),
    ...cart.items.map((item) => item.productId),
  ]);
  const basis: OfflinePriceBasis = {
    catalogueVersion: catalogue.version,
    pricingMode: rate.mode,
    tier: tierCode,
    taxConfig: catalogue.taxConfig,
    packages: [...new Set(cart.lines.map((l) => l.packageId))].flatMap((id) => {
      const pkg = catalogue.packages.get(id);
      return pkg ? [{ id: pkg.id, prices: pkg.prices, adultRules: pkg.adultRules ?? null }] : [];
    }),
    products: [...productsUsed].flatMap((id) => {
      const product = catalogue.products.get(id);
      return product
        ? [
            {
              id: product.id,
              priceSatang: product.priceSatang,
              priceWeekendSatang: product.priceWeekendSatang,
            },
          ]
        : [];
    }),
    options: [...optionsUsed.values()].map((option) => ({
      id: option.id,
      priceSatang: option.priceSatang,
      priceWeekendSatang: option.priceWeekendSatang,
    })),
  };

  const quote: OfflineQuote = {
    source: 'box',
    businessDate: date,
    pricingMode: rate.mode,
    pricingModeReason: rate.reason,
    holidayName: rate.overrideName ?? null,
    tier: tierCode,
    tierSource,
    tierClaimRefusal: null,
    customerTier: tierCode,
    engineVersion: PRICING_ENGINE_VERSION,
    catalogueVersion: catalogue.version,
    totals: {
      subtotalSatang: totals.subtotal,
      manualDiscountSatang: totals.manualDiscountTotal,
      promoDiscountSatang: totals.promoDiscountTotal,
      discountSatang: totals.discountTotal,
      netSatang: net,
      serviceChargeSatang: tb.serviceChargeTotal,
      taxInclusiveSatang: tb.inclusiveTaxTotal,
      taxExclusiveSatang: tb.exclusiveTaxTotal,
      grossSatang: tb.grandTotal,
      unappliedDiscountSatang: tb.unappliedDiscount,
    },
    lineTotals,
    itemPresentation,
    manualAmounts: totals.manualAmounts,
    appliedPromos: totals.appliedPromos.map((promo) => ({
      code: promo.code,
      label: promo.label,
      type: promo.type,
      amountSatang: promo.amount,
      ...(promo.exhaustedReason ? { exhaustedReason: promo.exhaustedReason } : {}),
    })),
    rejectedPromoCodes,
    voucher: null,
    taxBreakdown: tb,
    disagreements: {
      pricingModeSentByTill: cart.pricingMode ?? null,
      tierSentByTill: cart.tier ?? null,
      pricingModeDiffers: cart.pricingMode !== undefined && cart.pricingMode !== rate.mode,
      tierDiffers: cart.tier !== undefined && cart.tier !== tierCode,
    },
  };
  return { quote, cartLines, ctx, totals, items, basis };
}

// --- The ledger's lines, on the box (plan §2.5, Round 4) ----------------------------

/** One ledger line of a sale taken on the box: what it prints, and what its bands are planned from. */
export interface OfflineLedgerLine extends SalePrintLine {
  cartLineId: string;
  kidCount: number;
  adultCount: number;
  freeAdultCount: number;
}

/**
 * The lines the platform will file this sale under, named and split exactly
 * as `commitSale` names and splits them: one per engine unit, the id derived
 * from the sale, the cart line and the unit's component key
 * (`deriveSaleLineId`), and each unit's money from `splitLedgerUnitMoney`. So
 * the receipt printed at an offline counter carries the ledger's own lines,
 * and a band minted here names the ledger line it admits against.
 */
export function offlineLedgerLines(
  saleId: string,
  catalogue: OfflineCatalogue,
  pricing: Pick<OfflineSalePricing, 'cartLines' | 'ctx' | 'totals' | 'items'>,
  pickupCode: string | null,
): OfflineLedgerLine[] {
  const units = cartUnits(pricing.cartLines, pricing.ctx);
  const money = splitLedgerUnitMoney(units, pricing.totals);
  const linesById = new Map(pricing.cartLines.map((line) => [line.id, line]));
  const occurrences = new Map<string, number>();
  return units.map((unit, index) => {
    const cartLine = linesById.get(unit.lineId);
    const item = pricing.items.get(unit.lineId);
    const kind = item ? item.kind : ledgerUnitKindOf(unit);
    const component = ledgerUnitComponentKey(unit);
    const key = `${unit.lineId}|${component}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const pkg = cartLine ? catalogue.packages.get(cartLine.packageId) : undefined;
    const row = unit.row;
    return {
      id: deriveSaleLineId(saleId, unit.lineId, component, occurrence),
      cartLineId: unit.lineId,
      kind,
      label: ledgerUnitLabel(unit),
      quantity: row?.quantity ?? 1,
      grossSatang: money[index]?.gross ?? 0,
      ticket: !!pkg,
      payload: item
        ? {
            ...item.payload,
            // The order's pick-up code, on every F&B line, as the platform stamps it.
            ...(item.kind === 'fnb_item' && pickupCode ? { pickupCode } : {}),
          }
        : null,
      stayHours: pkg?.hours ?? null,
      stayDurationLabel: pkg?.durationLabel ?? null,
      kidCount: cartLine?.kids ?? 0,
      adultCount: cartLine?.adults ?? 0,
      freeAdultCount: row?.key === 'adults-free' ? row.quantity : 0,
    };
  });
}
