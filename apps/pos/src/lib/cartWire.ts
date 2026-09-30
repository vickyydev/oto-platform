import type {
  CartLine,
  Discount,
  FnbOrderLine,
  ManualDiscount,
  MenuItem,
  MerchOrderLine,
  SelectedModifier,
  TaxConfig,
  TicketType,
  WeekdayWeekendPrice,
} from '@/types';
import { getAddOns, getTaxConfig } from '@/store/catalogStore';
import { getEffectiveModifierGroups } from '@/lib/menu';
import { resolveRate, todayRateMode, type RateMode } from '@/lib/pricingMode';
import {
  newId,
  satangFromBaht,
  type CartAddOn,
  type ManualDiscount as EngineManualDiscount,
  type PackagePricingShape,
  type PricingContext,
  type PromoDiscount,
  type TaxConfigShape,
  type TicketCartLine,
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
 * engine's answer differs from the prototype's, both measured, both in the
 * guest's favour.
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
 * A line the platform cannot be asked about: one that was not bought.
 *
 * A prepaid entitlement line is ฿0 on the order panel because it was paid for
 * at booking, and the platform has no wallet or entitlement ledger to take it
 * off (S2-14a). Sending it would offer the catalogue price of an item nobody is
 * paying for now and be refused as a price mismatch. It is therefore kept off
 * the payload and SAID on the screen, which is the same rule the rest of this
 * file follows: nothing the platform did not price is presented as if it had.
 */
export function isOffLedgerFnbLine(line: FnbOrderLine): boolean {
  return line.isPrepaid === true;
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
