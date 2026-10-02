import type {
  CartLine,
  Discount,
  FnbOrderLine,
  ManualDiscount,
  MenuCategoryDef,
  MenuItem,
  MerchItem,
  MerchOrderLine,
  SelectedModifier,
  TaxConfig,
  TaxableCategory,
  TaxMode,
  TicketType,
  WeekdayWeekendPrice,
} from '@/types';
import { getAddOns, getMenuCategories, getTaxConfig } from '@/store/catalogStore';
import { effectiveTaxCategory, getEffectiveModifierGroups } from '@/lib/menu';
import { resolveRate, todayRateMode, type RateMode } from '@/lib/pricingMode';
import {
  computeTicketCartTotals,
  findStaleLines,
  itemCartLine,
  itemCategoryWalk,
  itemLineTotal,
  itemTaxCategory,
  itemUnitPrice,
  newId,
  satangFromBaht,
  summarizeTax,
  type AppliedPromo,
  type CartAddOn,
  type ManualDiscount as EngineManualDiscount,
  type PackagePricingShape,
  type PricingContext,
  type PromoDiscount,
  type TaxBreakdown as EngineTaxBreakdown,
  type TaxConfigShape,
  type TicketCartLine,
  type TicketCartTotals,
  type WWPrice,
} from '@oto/shared';

/**
 * THE TILL'S CART, IN THE PLATFORM'S OWN TERMS.
 *
 * S2-09a (SCRUM-203). Until this file the till priced in the browser, in baht
 * floats, from the prototype's own copy of the rules (`lib/pricing.ts`,
 * `lib/sale.ts`, `lib/tax.ts`) — about 1,100 lines of arithmetic with no test
 * runner behind it, while `@oto/shared` held the same rules ported to integer
 * satang with a 1,694-line suite and a regression fixture and had exactly one
 * caller in the whole system: the public booking quote. The two are not the
 * same arithmetic. `cart-totals.ts` records two deliberate rulings where the
 * engine's answer differs from the prototype's, both measured — and in both
 * the prototype undercharged: it gave a free item away twice (ruling 1) and
 * let a scoped code discount what a staff discount had already taken off
 * (ruling 2). The parity fixture pins both against the prototype's own
 * figures (`apps/pos/test/one-calculator-parity.test.ts`).
 *
 * This module is the translation layer, and it is the only one: everything the
 * till sends the platform, and everything the till prices locally when the
 * platform cannot be reached, goes through these functions. It is pure — no
 * React, no fetch, one read of the catalogue store per call — so the same input
 * always produces the same cart. The one thing it remembers is the ids it has
 * minted for the cart's own (`platformId`), which is what keeps that true.
 *
 * WHAT IT DOES NOT DO: decide money. Every figure here is either copied from
 * the cart or converted between baht and satang. The arithmetic is the
 * engine's, at `apps/pos/src/api/sales.ts` (locally) or on the platform.
 *
 * ONE CALCULATOR — SCRUM-271, plan `docs/progress/plans/offline/PLAN.md` §2.7
 * and Round 2. Until then the till kept a second, older one beside this file —
 * the prototype's baht-float `lib/tax.ts`, with `computeTotals`,
 * `computeFnbTotals`, `computeMerchTotals` and the F&B and shop line prices in
 * `lib/sale.ts`, `lib/fnb.ts` and `lib/merch.ts` — and thirty-odd screens and
 * the reports read their money from it. That calculator is gone. Every figure a
 * screen shows now comes from the satang engine in `@oto/shared` through the
 * functions below, and is divided by 100 only here, at the edge, for the
 * prototype's components (CLAUDE.md §7: their shapes stay, so no screen was
 * redesigned to take satang). The F&B and shop lines are priced by the same
 * item engine the platform prices them with (`item-cart.ts`). The figures each
 * screen showed before and after are pinned against the prototype's own in
 * `apps/pos/test/one-calculator-parity.test.ts`.
 *
 * SATANG, AND WHERE THE EDGES ARE. The prototype's catalogue is entered in
 * whole baht and its cart holds baht numbers; the platform holds satang
 * integers everywhere. `satangFromBaht` rounds, so a catalogue price that is
 * somehow fractional (nothing in the seed is) lands on the nearest satang once,
 * here, rather than drifting through the cascade.
 */

/** ฿ → satang, the one conversion point for a cart. */
export const toSatang = (baht: number): number => satangFromBaht(baht);

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every id this till has minted for one of its cart's own ids, for the life of
 * the page. Written by `platformId`, read back by `localIdFor`.
 */
const minted = new Map<string, string>();

/**
 * THE TILL NAMES WHAT IT SELLS BEFORE IT IS SAVED — SCRUM-270, plan
 * `docs/progress/plans/offline/PLAN.md` §2.7 and OD-12.
 *
 * `pos.sale_line.cart_line_id` is a `uuid`, and `POST /sales` refuses anything
 * else. The prototype's cart mints `Math.random().toString(36).substring(7)`
 * for a ticket line (`pages/Till.tsx`), `line-<checkInId>` for a drop-off child
 * (`lib/dropoff.ts:80`), `line-<n>` and `mline-<n>` for an F&B or shop row,
 * `promo-<CODE>` for a free-item promo line — a shape `@oto/shared`'s
 * `freeItemLineId` depends on to resolve that promo's scope — and
 * `md-<random>` for a staff discount (`ManualDiscountModal`). Those stay the
 * screen's own keys: the prototype's components find their rows by them
 * (CLAUDE.md §7).
 *
 * WHAT THE PLATFORM IS SENT IS A UUIDv7 THIS TILL MINTED, once per local id,
 * the first time that id reaches the wire, and the same one every time after.
 * The platform names every row a cart line fans out into from it and the
 * sale's own id (`deriveSaleLineId` in `@oto/shared`), so the till can name
 * each sale line before the sale is saved — what a box needs in order to finish
 * a sale this till began (plan §2.1) — and a replay of a sale id carrying other
 * lines is refused as the conflict it is (`SALE_LINES_DIFFER`).
 *
 * STABLE FOR THE PAGE, which is the life of every cart: the quote and the
 * commit describe the same cart, every retry of one Pay press sends the same
 * body (`lib/saleWriter.ts` keys the sale id on it), and the platform answers
 * keyed by whatever it was sent, so an answer has to be translatable back
 * (`localIdFor`). Nothing holds a cart across a reload, and a reload mints
 * afresh. A local id that recurs from one cart to the next on the same page —
 * `promo-<CODE>` does — keeps the one id it was given; that is harmless,
 * because a sale line's own id is named from the sale's id as well, and the
 * platform compares line ids only within one sale.
 *
 * UNTIL SCRUM-270 these ids were derived, not minted: an FNV hash of the local
 * id's text, so `promo-ICECREAM` or `line-1` became the same uuid in every
 * sale from every till, and nothing about the id said where or when it was
 * made. A local id that is already a uuid still passes through untouched.
 */
export function platformId(localId: string): string {
  if (UUID_SHAPE.test(localId)) return localId;
  const known = minted.get(localId);
  if (known) return known;
  const id = newId();
  minted.set(localId, id);
  return id;
}

/**
 * The till's own id for something the platform answered about.
 *
 * The platform keys its answer by whatever it was sent, so a response has to be
 * translated back before the screen can find the row it belongs to — without
 * this, a staff discount's amount comes back under a minted key, the panel
 * looks it up by the id it knows, finds nothing, and the discount row silently
 * renders as ฿0 while the total below it is correct.
 *
 * A lookup, so it mints nothing: an id this till never sent cannot be the key
 * of an answer about it.
 */
export function localIdFor(localIds: readonly string[], platformKey: string): string | null {
  for (const id of localIds) {
    const sent = UUID_SHAPE.test(id) ? id : minted.get(id);
    if (sent === platformKey) return id;
  }
  return null;
}

/** satang → ฿, for feeding an engine answer back into the prototype's components. */
export const toBaht = (satang: number): number => satang / 100;

/** The prototype's hard-coded socks add-on id (`lib/pricing.ts:10`, and seven other files). */
export const SOCKS_ADDON_ID = 'a-socks';

/** The prototype's socks row label (`lib/pricing.ts:331`). */
export const SOCKS_LABEL = 'Regular Socks';

function wwSatang(price: WeekdayWeekendPrice | undefined): WWPrice {
  return { weekday: toSatang(price?.weekday ?? 0), weekend: toSatang(price?.weekend ?? 0) };
}

/**
 * A ticket package as the engine prices it.
 *
 * A tier with no entry stays missing rather than becoming a zero: `priceForTier`
 * resolves an absent tier to 0 defensively, and `unpricedCartLines` (SCRUM-228)
 * is what refuses the sale. Inventing a ฿0 entry here would make an unpriced
 * tier look like a deliberately free one to every reader after this point.
 */
export function packagePricingShape(ticket: TicketType): PackagePricingShape {
  const prices: Record<string, WWPrice> = {};
  for (const [tier, price] of Object.entries(ticket.prices)) prices[tier] = wwSatang(price);

  const adultRules: PackagePricingShape['adultRules'] = {};
  for (const [tier, rule] of Object.entries(ticket.adultRules ?? {})) {
    adultRules[tier] = {
      kind: rule.kind,
      ...(rule.price ? { price: wwSatang(rule.price) } : {}),
      ...(rule.freeAdults !== undefined ? { freeAdults: rule.freeAdults } : {}),
      ...(rule.overflow ? { overflow: rule.overflow } : {}),
    };
  }
  return { prices, adultRules: Object.keys(adultRules).length > 0 ? adultRules : null };
}

/**
 * The branch catalogue facts the engine needs beyond the packages: the rate
 * mode, and the socks price.
 *
 * Socks are read live from the catalogue and NOT snapshotted onto the line,
 * which is the prototype's behaviour and is preserved deliberately
 * (`lib/pricing.ts:252-255`, and the note on `PricingContext` in
 * `packages/shared/src/pricing.ts`). Every other add-on carries the price it
 * was added at.
 */
export function pricingContext(mode: RateMode = todayRateMode().mode): PricingContext {
  const socks = getAddOns().find((a) => a.id === SOCKS_ADDON_ID);
  return {
    mode,
    socks: {
      addOnId: SOCKS_ADDON_ID,
      price: socks ? toSatang(resolveRate(socks.price, mode)) : 0,
      label: SOCKS_LABEL,
    },
  };
}

function engineAddOns(line: CartLine): CartAddOn[] {
  return line.addOns.map((addOn) => ({
    id: addOn.id,
    name: addOn.name,
    price: toSatang(addOn.price),
    quantity: addOn.quantity,
    ...(addOn.variantBreakdown && addOn.variantBreakdown.length > 0
      ? { variantBreakdown: addOn.variantBreakdown }
      : {}),
    ...(addOn.taxCategoryOverride ? { taxCategoryOverride: addOn.taxCategoryOverride } : {}),
  }));
}

/**
 * The drop-off / nanny service fee row, with the label the prototype prints
 * (`lib/pricing.ts:356-363`). The engine renders whatever label it is given, so
 * the two have to be built the same way or the receipt and the screen part
 * company on the one row a guest queries.
 */
function engineServiceFee(line: CartLine): TicketCartLine['serviceFee'] {
  const dropOff = line.dropOff;
  if (!dropOff || dropOff.serviceFeeTHB <= 0) return null;
  return {
    label: dropOff.service === 'nanny' ? `Nanny (${dropOff.hours}h)` : 'Drop-off service',
    amount: toSatang(dropOff.serviceFeeTHB),
  };
}

/** One cart line in the engine's terms. */
export function engineCartLine(line: CartLine): TicketCartLine {
  const food = line.dropOff?.foodProvision;
  return {
    id: line.id,
    packageId: line.ticketType.id,
    package: packagePricingShape(line.ticketType),
    tier: line.tier,
    kids: line.kids,
    adults: line.adults,
    socks: line.socks,
    addOns: engineAddOns(line),
    serviceFee: engineServiceFee(line),
    lineTotal: toSatang(line.lineTotal),
    ...(line.promoItem
      ? {
          promoItem: {
            itemId: line.promoItem.itemId,
            itemKind: line.promoItem.itemKind,
            name: line.promoItem.name,
            price: toSatang(line.promoItem.priceTHB),
          },
        }
      : {}),
    ...(food && food.paidTHB > 0
      ? {
          foodProvision: {
            // The engine knows two kinds of prepaid food, and the prototype's
            // categoriser is a two-way branch on the same question: prepaid
            // ITEMS are F&B and taxed now, anything else that was paid for is a
            // stored-value load and is not (`lib/sale.ts:52-60`). A provision
            // recorded as `none` that still carries money follows the same
            // else-branch here as it does there.
            mode: food.mode === 'prepaid_items' ? ('prepaid_items' as const) : ('prepaid_credit' as const),
            paid: toSatang(food.paidTHB),
          },
        }
      : {}),
  };
}

/**
 * An applied promo code in the engine's terms.
 *
 * `percent` keeps its percentage; `fixed` and `free_item` carry money and are
 * converted. A free-item code's value is the item's shelf price, already
 * resolved by the till when the code was applied (`pages/Till.tsx:673`), which
 * is the same convention `PromoDiscount` documents.
 */
export function enginePromo(discount: Discount): PromoDiscount {
  return {
    code: discount.code,
    label: discount.label,
    type: discount.type,
    value: discount.type === 'percent' ? discount.value : toSatang(discount.value),
    ...(discount.freeItemId ? { freeItemId: discount.freeItemId } : {}),
    ...(discount.freeItemKind ? { freeItemKind: discount.freeItemKind } : {}),
    ...(discount.target ? { target: discount.target } : {}),
    ...(discount.validFrom ? { validFrom: discount.validFrom } : {}),
    ...(discount.validUntil ? { validUntil: discount.validUntil } : {}),
    ...(discount.usageLimit !== undefined ? { usageLimit: discount.usageLimit } : {}),
    ...(discount.usedCount !== undefined ? { usedCount: discount.usedCount } : {}),
    ...(discount.stackable !== undefined ? { stackable: discount.stackable } : {}),
    ...(discount.active !== undefined ? { active: discount.active } : {}),
  };
}

/**
 * A staff discount in the engine's terms. `percent` is a percentage, `fixed` is
 * money, `comp` carries neither — the same split the engine's own
 * `resolveManualDiscountAmount` applies.
 */
export function engineManualDiscount(discount: ManualDiscount): EngineManualDiscount {
  return {
    id: discount.id,
    scope: discount.scope,
    ...(discount.targetLineId ? { targetLineId: discount.targetLineId } : {}),
    ...(discount.targetComponent ? { targetComponent: discount.targetComponent } : {}),
    ...(discount.targetLabel ? { targetLabel: discount.targetLabel } : {}),
    type: discount.type,
    value: discount.type === 'percent' ? discount.value : toSatang(discount.value),
    reason: discount.reason,
    ...(discount.note ? { note: discount.note } : {}),
  };
}

/**
 * The tax configuration, which needs no conversion: every number in it is a
 * percentage or a basis point, not money. The two types are structurally the
 * same by construction — `catalogBridge` already hydrates the prototype's
 * `TaxConfig` straight from the platform's `TaxConfigShape` payload.
 */
export function engineTaxConfig(config: TaxConfig = getTaxConfig()): TaxConfigShape {
  return config as TaxConfigShape;
}

/**
 * A line the engine would refuse to total: a drop-off child whose play length
 * staff have not chosen yet.
 *
 * The prototype keeps that line in the cart at `lineTotal: 0` on purpose
 * (`lib/dropoff.ts:87`), and the engine's `findStaleLines` cannot tell "not yet
 * priced" from "priced under another rate mode" — it says so at length, and
 * says the choice belongs to S2-13, the drop-off ticket. So this till does not
 * make that choice: while such a line is in the cart the platform is not asked
 * to quote, the running total stays the till's own, and the existing preflight
 * in `handleCompletePayment` still refuses to take money for it. Nothing is
 * sold at a price the platform has not seen.
 */
export function unpricedDropOffLines(lines: readonly CartLine[]): string[] {
  return lines.filter((line) => line.dropOff && !line.dropOff.lengthChosen).map((line) => line.id);
}

/** The whole cart, in the engine's terms. */
export interface EngineCart {
  lines: TicketCartLine[];
  promos: PromoDiscount[];
  manualDiscounts: EngineManualDiscount[];
  config: TaxConfigShape;
  ctx: PricingContext;
}

export function engineCart(
  lines: readonly CartLine[],
  discounts: readonly Discount[],
  manualDiscounts: readonly ManualDiscount[],
  options: { mode?: RateMode; config?: TaxConfig } = {},
): EngineCart {
  return {
    lines: lines.map(engineCartLine),
    promos: discounts.map(enginePromo),
    manualDiscounts: manualDiscounts.map(engineManualDiscount),
    config: engineTaxConfig(options.config),
    ctx: pricingContext(options.mode ?? todayRateMode().mode),
  };
}

// --- The F&B and shop carts, in the platform's own terms (S2-09b) -----------
//
// A ticket cart line is a package with participants on it; an F&B or shop line
// is a CATALOGUE ROW with a quantity, a set of chosen modifier options, a
// kitchen note and — for a sized item — a variant. The two are priced by
// different halves of the platform (`ticket_package` against the tier table,
// `pos.product` against its own price and its modifier options) and they are
// translated separately here for the same reason `engineCartLine` exists: so
// that the till's screens keep the prototype's shapes and the platform is sent
// nothing but ids, counts and the figures the screen showed.
//
// WHAT IS A SNAPSHOT AND WHAT IS AN INSTRUCTION. `unitSatang` and
// `lineTotalSatang` are what the order panel had on it when the cart was sent;
// they are reconciled by the platform and never charged (the same rule as
// `SaleCartLinePayload.lineTotalSatang`). The product id, the modifier option
// ids, the quantity, the note and the variant are the instruction: they say
// WHAT was ordered, and the price comes back from the catalogue.

/**
 * One question the item asks and the answers given to it — the prototype's own
 * `SelectedModifier`, which is also the shape the platform's route declares
 * (`CartItemLine.modifiers` in `apps/api/src/routes/sales.ts`).
 *
 * NO NAME AND NO PRICE TRAVELS WITH IT, deliberately: the platform composes the
 * unit price from `pos.product` and `pos.modifier_option` and freezes the
 * option's name onto the sale line from its own row, so anything the till sent
 * about either could only be a second opinion about money.
 */
export interface ItemModifierSelection {
  groupId: string;
  optionIds: string[];
}

/** An F&B or shop cart row in the platform's terms. */
export interface ItemCartLine {
  /** The till's own cart line id, as the UUIDv7 it minted for the wire (see `platformId`). */
  id: string;
  /** `pos.product.id` — what the platform prices from. */
  productId: string;
  quantity: number;
  modifiers: ItemModifierSelection[];
  /** The kitchen/bar note. Distinct notes keep two otherwise identical rows apart. */
  note?: string;
  /** The size or flavour sold, when the item has more than one. */
  variant?: { variantId: string; variantLabel: string } | null;
  /** What the screen showed for this row. Reconciled, never charged. */
  lineTotalSatang: number;
  /** SCRUM-494 — served from the band holder's prepaid items: the platform prices it at ฿0. */
  prepaid?: { checkinId: string };
}

/**
 * The chosen options of an F&B line, in the order the item asks its questions.
 *
 * Walked through `getEffectiveModifierGroups` — the item's inline groups plus
 * the shared library groups it links — rather than passed through from
 * `selectedModifiers` as it stands, for two reasons: the walk puts the answers
 * in GROUP ORDER, which is the order the sheet, the cart row and the prep
 * ticket print them in, and it drops a selection whose group or option the menu
 * no longer has. The platform refuses both of those by name
 * (`assertModifierSelection`), and a refusal for a stale option nobody can see
 * on screen is a refusal staff cannot act on.
 */
export function itemModifierSelections(
  item: MenuItem,
  selected: readonly SelectedModifier[],
): ItemModifierSelection[] {
  const selections: ItemModifierSelection[] = [];
  for (const group of getEffectiveModifierGroups(item)) {
    const chosen = selected.find((s) => s.groupId === group.id);
    if (!chosen) continue;
    const offered = new Set(group.options.map((o) => o.id));
    const optionIds = chosen.optionIds.filter((id) => offered.has(id));
    if (optionIds.length > 0) selections.push({ groupId: group.id, optionIds });
  }
  return selections;
}

/** An F&B order line as the platform receives it. */
export function itemCartLineFromFnb(line: FnbOrderLine): ItemCartLine {
  // SCRUM-494 — a prepaid line is served as it was paid for: ฿0, no options,
  // naming the stay whose entitlement it is taken from.
  if (line.isPrepaid && line.prepaidStayId) {
    return {
      id: platformId(line.id),
      productId: line.menuItem.id,
      quantity: line.qty,
      modifiers: [],
      ...(line.note ? { note: line.note } : {}),
      ...(line.variantId
        ? { variant: { variantId: line.variantId, variantLabel: line.variantLabel ?? line.variantId } }
        : {}),
      lineTotalSatang: 0,
      prepaid: { checkinId: line.prepaidStayId },
    };
  }
  return {
    id: platformId(line.id),
    productId: line.menuItem.id,
    quantity: line.qty,
    modifiers: itemModifierSelections(line.menuItem, line.selectedModifiers),
    ...(line.note ? { note: line.note } : {}),
    ...(line.variantId
      ? { variant: { variantId: line.variantId, variantLabel: line.variantLabel ?? line.variantId } }
      : {}),
    lineTotalSatang: toSatang(line.lineTotal),
  };
}

/** A shop line as the platform receives it. A merch row asks no questions. */
export function itemCartLineFromMerch(line: MerchOrderLine): ItemCartLine {
  return {
    id: platformId(line.id),
    productId: line.merchItem.id,
    quantity: line.qty,
    modifiers: [],
    ...(line.variantId
      ? { variant: { variantId: line.variantId, variantLabel: line.variantLabel ?? line.variantId } }
      : {}),
    lineTotalSatang: toSatang(line.lineTotal),
  };
}

/**
 * A line the platform cannot be asked about: a prepaid line with no platform
 * stay behind it.
 *
 * A prepaid line served from a stay the counter's scan resolved
 * (`Wristband.stayId`) goes to the platform, which prices it at ฿0 and takes it
 * off the stay's entitlements when the order is confirmed (SCRUM-494). One with
 * no stay has no entitlement the platform can take it off, so it is kept off
 * the payload and SAID on the screen: nothing the platform did not price is
 * presented as if it had.
 */
export function isOffLedgerFnbLine(line: FnbOrderLine): boolean {
  return line.isPrepaid === true && !line.prepaidStayId;
}

/**
 * Both carts as the quote and the commit carry them: the rows that are on the
 * ledger, and the till's own ids for them so an answer can be read back.
 */
export function itemCart(
  lines: readonly FnbOrderLine[] | readonly MerchOrderLine[],
): ItemCartLine[] {
  return (lines as readonly (FnbOrderLine | MerchOrderLine)[])
    .filter((line) => !('menuItem' in line) || !isOffLedgerFnbLine(line))
    .map((line) => ('menuItem' in line ? itemCartLineFromFnb(line) : itemCartLineFromMerch(line)));
}

// --- The display edge: satang in, baht out ----------------------------------
//
// The prototype's components draw money in baht and were built around the
// shapes its own calculator returned (CLAUDE.md §7: their shapes stay). So the
// engine's satang is divided by 100 HERE, once, into those shapes, and nothing
// on the baht side is arithmetic: a sum, a split or a rounding of money happens
// in satang first and is converted afterwards. That is what lets the baht
// figures be exact — every one of them is a whole number of satang over 100.

/** One category's tax and service, in baht: the engine's satang over 100, nothing computed. */
export interface CategoryTaxLineBaht {
  category: TaxableCategory;
  /** Base after discount apportionment (before_tax), or the full base (after_tax). */
  base: number;
  taxMode: TaxMode;
  taxRateId?: string;
  taxName?: string;
  /** Whole percent, e.g. 7. */
  taxPercent: number;
  serviceCharge: number;
  /** Tax ADDED (exclusive) or INCLUDED and reported (inclusive); 0 for none. */
  tax: number;
  secondaryTaxRateId?: string;
  secondaryTaxName?: string;
  secondaryTaxMode: TaxMode;
  secondaryTaxPercent: number;
  secondaryTax: number;
  /** What the customer pays for this category (before any after_tax discount). */
  gross: number;
}

/**
 * A tax breakdown in baht — the shape the prototype's `lib/tax.ts` returned,
 * which every summary, receipt and display renders, now filled from the engine.
 */
export interface TaxBreakdownBaht {
  netSubtotal: number;
  discountTotal: number;
  serviceChargeTotal: number;
  exclusiveTaxTotal: number;
  inclusiveTaxTotal: number;
  taxTotal: number;
  categories: CategoryTaxLineBaht[];
  grandTotal: number;
}

/** A receipt row — service charge, included tax or added tax — in baht. */
export interface TaxRowBaht {
  key: string;
  /** e.g. "Service charge", "VAT included", "VAT". */
  label: string;
  amount: number;
  kind: 'service' | 'tax_included' | 'tax_added';
}

/** The engine's breakdown, in baht. */
export function breakdownToBaht(breakdown: EngineTaxBreakdown): TaxBreakdownBaht {
  const categories: CategoryTaxLineBaht[] = breakdown.categories.map((category) => ({
    category: category.category,
    base: toBaht(category.base),
    taxMode: category.taxMode,
    ...(category.taxRateId ? { taxRateId: category.taxRateId } : {}),
    ...(category.taxName ? { taxName: category.taxName } : {}),
    taxPercent: category.taxPercent,
    serviceCharge: toBaht(category.serviceCharge),
    tax: toBaht(category.tax),
    ...(category.secondaryTaxRateId ? { secondaryTaxRateId: category.secondaryTaxRateId } : {}),
    ...(category.secondaryTaxName ? { secondaryTaxName: category.secondaryTaxName } : {}),
    secondaryTaxMode: category.secondaryTaxMode,
    secondaryTaxPercent: category.secondaryTaxPercent,
    secondaryTax: toBaht(category.secondaryTax),
    gross: toBaht(category.gross),
  }));
  return {
    netSubtotal: toBaht(breakdown.netSubtotal),
    discountTotal: toBaht(breakdown.discountTotal),
    serviceChargeTotal: toBaht(breakdown.serviceChargeTotal),
    exclusiveTaxTotal: toBaht(breakdown.exclusiveTaxTotal),
    inclusiveTaxTotal: toBaht(breakdown.inclusiveTaxTotal),
    taxTotal: toBaht(breakdown.taxTotal),
    categories,
    grandTotal: toBaht(breakdown.grandTotal),
  };
}

/**
 * A baht breakdown back in satang — for a screen that was handed one (a
 * captured display frame, a prop) and has to summarise it. Conversion only:
 * each figure is a whole number of satang over 100 by construction.
 */
function breakdownToSatang(breakdown: TaxBreakdownBaht): EngineTaxBreakdown {
  return {
    netSubtotal: toSatang(breakdown.netSubtotal),
    discountTotal: toSatang(breakdown.discountTotal),
    serviceChargeTotal: toSatang(breakdown.serviceChargeTotal),
    exclusiveTaxTotal: toSatang(breakdown.exclusiveTaxTotal),
    inclusiveTaxTotal: toSatang(breakdown.inclusiveTaxTotal),
    taxTotal: toSatang(breakdown.taxTotal),
    categories: breakdown.categories.map((category) => ({
      ...category,
      category: category.category as EngineTaxBreakdown['categories'][number]['category'],
      base: toSatang(category.base),
      serviceCharge: toSatang(category.serviceCharge),
      tax: toSatang(category.tax),
      secondaryTax: toSatang(category.secondaryTax),
      gross: toSatang(category.gross),
    })),
    grandTotal: toSatang(breakdown.grandTotal),
    unappliedDiscount: 0,
  };
}

/**
 * THE ROWS A RECEIPT OR A SUMMARY PRINTS under the subtotal — the service
 * charge, then one row per tax and mode — from the engine's `summarizeTax`,
 * summed in satang and converted after. Replaces the prototype's `summarizeTax`
 * (`lib/tax.ts:217`), which added baht floats and left each screen to round
 * the result with `roundTHB`.
 */
export function taxRowsOf(breakdown: TaxBreakdownBaht): TaxRowBaht[] {
  return summarizeTax(breakdownToSatang(breakdown)).map((row) => ({ ...row, amount: toBaht(row.amount) }));
}

/**
 * A baht figure to the satang, for printing — the one rounding of money at the
 * display edge, for a figure a screen did not get from the engine as it is.
 */
export function shownBaht(baht: number): number {
  return toBaht(toSatang(baht));
}

/**
 * "฿33.33 each × 3": a row's own total over its count, in satang, for the line
 * a display prints under an F&B row. Division for show only — the row's total
 * is the figure that was charged.
 */
export function perUnitBaht(lineTotal: number, quantity: number): number {
  if (quantity <= 0) return 0;
  return toBaht(Math.round(toSatang(lineTotal) / quantity));
}

// --- Totals, in the shape the prototype's components render ------------------

/** One applied code, as `OrderSummary` and the customer display draw it. */
export interface QuotedPromoLine {
  code: string;
  label: string;
  type: Discount['type'];
  amount: number;
  exhaustedReason?: string;
}

/**
 * EXACTLY THE SHAPE the prototype's `lib/sale.ts:computeTotals` RETURNED, in
 * baht.
 *
 * That is the point: every component that shows money already destructures
 * this, so the source of the numbers changed without a single one of them being
 * redesigned. `CartQuote.source` says where a quote's came from.
 */
export interface OrderTotals {
  subtotal: number;
  discountAmount: number;
  scannedDiscounts: QuotedPromoLine[];
  manualDiscountAmount: number;
  manualAmounts: Record<string, number>;
  serviceChargeTotal: number;
  taxTotal: number;
  taxBreakdown: TaxBreakdownBaht;
  total: number;
}

export function promosToBaht(promos: readonly AppliedPromo[]): QuotedPromoLine[] {
  return promos.map((promo) => ({
    code: promo.code,
    label: promo.label,
    type: promo.type,
    amount: toBaht(promo.amount),
    ...(promo.exhaustedReason ? { exhaustedReason: promo.exhaustedReason } : {}),
  }));
}

/** The engine's totals, in the components' shape. */
export function totalsToBaht(totals: TicketCartTotals): OrderTotals {
  const manualAmounts: Record<string, number> = {};
  for (const [id, satang] of Object.entries(totals.manualAmounts)) manualAmounts[id] = toBaht(satang);
  return {
    subtotal: toBaht(totals.subtotal),
    discountAmount: toBaht(totals.promoDiscountTotal),
    scannedDiscounts: promosToBaht(totals.appliedPromos),
    manualDiscountAmount: toBaht(totals.manualDiscountTotal),
    manualAmounts,
    serviceChargeTotal: toBaht(totals.serviceChargeTotal),
    taxTotal: toBaht(totals.taxTotal),
    taxBreakdown: breakdownToBaht(totals.taxBreakdown),
    total: toBaht(totals.total),
  };
}

// --- A ticket cart's totals on this device -----------------------------------

/**
 * How a quote this till made says its figure was re-derived the way the
 * prototype re-derived it — see `ticketTotals`. The label the prototype's own
 * arithmetic carried until SCRUM-271, kept because it still names the answer.
 */
export const PROTOTYPE_REDERIVATION = 'prototype';

export interface TicketTotals extends OrderTotals {
  /** The same figures in satang. */
  satang: TicketCartTotals;
  /**
   * The lines this rate mode does not price at their stored totals (the
   * engine's `findStaleLines`). Empty on a cart the engine priced; otherwise the
   * figures are the prototype's re-derivation of it — see `ticketTotals`.
   */
  staleLineIds: string[];
}

/**
 * THE TOTALS OF A TICKET CART, ON THIS DEVICE — what the prototype's
 * `computeTotals` answered, now answered by the engine.
 *
 * For every cart the engine prices — each line's stored total is what this
 * rate mode prices it at — these ARE the engine's figures, the ones the
 * platform charges.
 *
 * For a cart it refuses, the engine re-derives it the way the prototype did
 * (`staleLines: 'trust_stored'`): the subtotal from the stored line totals,
 * every tax base at this rate mode. That is exactly the figure the prototype's
 * arithmetic put on these screens for such a cart, so none of them moves, and
 * nothing is sold from it. The three carts it is, each pinned in the parity
 * fixture:
 *   - a drop-off child whose play length nobody has chosen yet — the live cart
 *     shows it, the platform is not asked, and the pay preflight refuses it
 *     (`lib/cartQuote.ts`, `unpricedCartLines`);
 *   - a sale re-read on a day of the other rate mode — the history screens and
 *     the reports; whether they should re-price it at the mode it was sold under
 *     instead is a question for the owner (OPEN_QUESTIONS.md, SCRUM-271);
 *   - a seeded record whose lines no rate mode reproduces (`mockApi.ts`,
 *     sale D9N4T7).
 */
export function ticketTotals(
  lines: readonly CartLine[],
  discounts: readonly Discount[] = [],
  manualDiscounts: readonly ManualDiscount[] = [],
  options: { mode?: RateMode; config?: TaxConfig } = {},
): TicketTotals {
  const cart = engineCart(lines, discounts, manualDiscounts, options);
  const staleLineIds = findStaleLines(cart.lines, cart.ctx);
  const satang = computeTicketCartTotals(
    cart.lines,
    cart.promos,
    cart.manualDiscounts,
    cart.config,
    cart.ctx,
    staleLineIds.length > 0 ? { staleLines: 'trust_stored' } : {},
  );
  return { ...totalsToBaht(satang), satang, staleLineIds };
}

// --- An F&B or shop line's price, and the order's totals ---------------------
//
// The prototype priced these in baht: `computeUnitPrice` and `computeLineTotal`
// in `lib/fnb.ts`, `computeMerchLineTotal` in `lib/merch.ts`. They are priced
// now by the shared item engine (`packages/shared/src/item-cart.ts`) — the
// code the platform prices the same line with in `resolveItemLines` — and the
// order is totalled by the one cascade that totals a ticket cart.

/** The chosen options of an F&B item, as satang pairs, in the order the item asks its groups. */
function chosenOptionPrices(item: MenuItem, selected: readonly SelectedModifier[]): WWPrice[] {
  const prices: WWPrice[] = [];
  for (const group of getEffectiveModifierGroups(item)) {
    const chosen = selected.find((s) => s.groupId === group.id);
    if (!chosen) continue;
    for (const optionId of chosen.optionIds) {
      const option = group.options.find((o) => o.id === optionId);
      if (option) prices.push(wwSatang(option.price));
    }
  }
  return prices;
}

/** One of an F&B item with these options, in baht: the item plus every chosen option, at the rate mode. */
export function fnbUnitPrice(
  item: MenuItem,
  selected: readonly SelectedModifier[],
  mode: RateMode = todayRateMode().mode,
): number {
  return toBaht(itemUnitPrice(wwSatang(item.price), chosenOptionPrices(item, selected), mode).unit);
}

/** An F&B row's total, in baht: the unit price times the quantity. */
export function fnbLineTotal(
  item: MenuItem,
  selected: readonly SelectedModifier[],
  quantity: number,
  mode: RateMode = todayRateMode().mode,
): number {
  const { unit } = itemUnitPrice(wwSatang(item.price), chosenOptionPrices(item, selected), mode);
  return toBaht(itemLineTotal(unit, quantity));
}

/** A shop row's total, in baht: one price, no options, no tier, times the quantity. */
export function merchLineTotal(
  item: MerchItem,
  quantity: number,
  mode: RateMode = todayRateMode().mode,
): number {
  return toBaht(itemLineTotal(itemUnitPrice(wwSatang(item.price), [], mode).unit, quantity));
}

/**
 * The tier frozen onto an item row on this device. No item price is resolved
 * from a tier (the item engine's rule 2), so it names nothing.
 */
const ITEM_LINE_TIER = 'item';

/** An F&B line, told from a shop line by the field that carries its item. */
function isFnbLine(line: FnbOrderLine | MerchOrderLine): line is FnbOrderLine {
  return 'menuItem' in line;
}

/**
 * One F&B or shop row as the engine prices it — the line the platform builds
 * for the same row (`itemCartLine`), carrying what the row IS so a scoped code
 * can find it.
 *
 * The unit price is taken from the row's own total rather than re-read from the
 * catalogue, so the figure on the screen is the figure the engine totals and a
 * code is applied to.
 */
function engineItemLine(
  line: FnbOrderLine | MerchOrderLine,
  categories: readonly MenuCategoryDef[],
  ctx: PricingContext,
): TicketCartLine {
  const fnb = isFnbLine(line);
  const item = fnb ? line.menuItem : line.merchItem;
  const quantity = Math.max(0, line.qty);
  const unit = quantity > 0 ? Math.round(toSatang(line.lineTotal) / quantity) : 0;
  return itemCartLine(
    {
      id: line.id,
      itemId: item.id,
      name: item.name,
      itemKind: fnb ? 'menu' : 'merch',
      unitPrice: unit,
      quantity,
      taxCategory: fnb
        ? effectiveTaxCategory(line.menuItem, [...categories])
        : itemTaxCategory('merch', line.merchItem.taxCategoryOverride),
      categoryIds: fnb
        ? itemCategoryWalk(line.menuItem.category, (id) => categories.find((c) => c.id === id)?.parentId)
        : [],
      tier: ITEM_LINE_TIER,
    },
    ctx,
  );
}

/**
 * The rows the engine totals: every line except one that was not bought here.
 *
 * A prepaid F&B line was paid for at the door. It is ฿0 on the platform too
 * (SCRUM-494), where it is a row with no base, so leaving it out of this
 * device's cart moves no total and gives a food-scoped code no base the
 * platform would not also see.
 */
export function engineItemLines(
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  categories: readonly MenuCategoryDef[] = getMenuCategories(),
  ctx: PricingContext = pricingContext(),
): TicketCartLine[] {
  return lines
    .filter((line) => !isFnbLine(line) || line.isPrepaid !== true)
    .map((line) => engineItemLine(line, categories, ctx));
}

/**
 * An F&B or shop order's totals: `OrderTotals`, plus the two names the
 * prototype's `computeFnbTotals` and `computeMerchTotals` gave the code figures,
 * which the item screens still read.
 */
export interface ItemOrderTotals extends OrderTotals {
  promoDiscountAmount: number;
  appliedPromos: QuotedPromoLine[];
  /** The same figures in satang. */
  satang: TicketCartTotals;
}

export interface ItemOrderOptions {
  /** The park's codes on the order (SCRUM-362); none by default. */
  promos?: readonly Discount[];
  config?: TaxConfig;
  mode?: RateMode;
  categories?: readonly MenuCategoryDef[];
}

/**
 * THE TOTALS OF AN F&B OR SHOP ORDER, ON THIS DEVICE — what the prototype's
 * `computeFnbTotals` and `computeMerchTotals` answered, now answered by the
 * engine in one pass: the staff discounts first, then the codes against what
 * they left, then the whole discount placed in the tax cascade by the category
 * it was aimed at. The pass the platform runs on the same order.
 */
export function itemOrderTotals(
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  manualDiscounts: readonly ManualDiscount[] = [],
  options: ItemOrderOptions = {},
): ItemOrderTotals {
  const ctx = pricingContext(options.mode ?? todayRateMode().mode);
  const satang = computeTicketCartTotals(
    engineItemLines(lines, options.categories ?? getMenuCategories(), ctx),
    (options.promos ?? []).map(enginePromo),
    manualDiscounts.map(engineManualDiscount),
    engineTaxConfig(options.config),
    ctx,
  );
  const totals = totalsToBaht(satang);
  return {
    ...totals,
    promoDiscountAmount: totals.discountAmount,
    appliedPromos: totals.scannedDiscounts,
    satang,
  };
}
