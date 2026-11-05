import { TicketType, CustomerTier, AddOn, SelectedAddOn, AddOnVariantQty, CartLine, DiscountComponentTarget, WeekdayWeekendPrice } from '@/types';
import { tierLabel } from '@/lib/membership';
import type { SupportedLang } from '@/i18n/types';
// Import the catalog getters from their source (the store), NOT from mockApi.
// mockApi -> lib/sale -> lib/pricing already forms an import cycle; pulling
// getAddOns from mockApi closed that loop, so when a module evaluated pricing.ts
// first (e.g. under HMR) mockApi's seed code ran pricing helpers while this
// module's `SOCKS_ID` const was still in its temporal dead zone -> crash.
import { getAddOns } from '@/store/catalogStore';
import { socksAddOnOf } from '@/api/menu';
import { RateMode, resolveRate, todayRateMode } from '@/lib/pricingMode';
import { resolveLineFreebies, splitVariantBreakdown, type LineFreebies } from '@oto/shared';

const SOCKS_ID = 'a-socks';

/**
 * SCRUM-768 — the socks the order panel's counter sells, priced at and freed
 * by the branch's Regular Socks product (`socksAddOnOf`). The line still counts
 * them under the prototype's `a-socks`, as the till sends them.
 */
export function counterSocksAddOn(): AddOn | undefined {
  return socksAddOnOf(getAddOns());
}

/** Today's price of one sock on the counter, in baht: ฿0 when the branch sells none. */
export function counterSocksPrice(mode: RateMode = todayRateMode().mode): number {
  const socks = counterSocksAddOn();
  return socks ? resolveRate(socks.price, mode) : 0;
}

/**
 * SCRUM-768 — WHAT THE TICKET'S FREE ITEMS MAKE FREE ON THIS LINE.
 *
 * Admin → Tickets saves them as "Free items in the rate" for chosen tiers; the
 * count is the shared engine's (`resolveLineFreebies`), so the till, the
 * platform and the box take the same units off. `adultsCharged` is what the
 * adult rule charges before the bundle.
 */
export function ticketFreebiesOnLine(
  ticket: TicketType,
  tier: CustomerTier,
  line: { kids: number; socks: number; addOns: readonly { id: string; quantity: number }[] },
  adultsCharged: number,
): LineFreebies {
  // The counter's socks answer to the prototype's id and to the branch's socks
  // product, which is the id Admin saves a free Regular Socks under.
  const socks = counterSocksAddOn();
  const socksIds = socks && socks.id !== SOCKS_ID ? [SOCKS_ID, socks.id] : [SOCKS_ID];
  return resolveLineFreebies({ freebies: ticket.freebies ?? null }, tier, line, adultsCharged, socksIds);
}

/**
 * The weekday/weekend pair this ticket charges a tier, or null when nobody has
 * set one — the tier was added in Admin and this ticket was never given a price
 * for it. A pair missing either half is not half-priced, it is unpriced.
 */
function pricedPair(ticket: TicketType, tier: CustomerTier): WeekdayWeekendPrice | null {
  const p = ticket.prices[tier];
  return p && Number.isFinite(p.weekday) && Number.isFinite(p.weekend) ? p : null;
}

/**
 * THE KID PRICE, OR NOTHING — SCRUM-228.
 *
 * "No price set" and "฿0" are different answers and this is where they are kept
 * apart. `null` means nobody priced this tier on this ticket; a number, 0
 * included, means somebody did. Every surface that decides whether a ticket can
 * be sold, and every surface that prints a figure at a visitor, reads this one
 * rather than the number below.
 */
export function tierPriceTHB(
  ticket: TicketType,
  tier: CustomerTier,
  mode: RateMode = todayRateMode().mode,
): number | null {
  const pair = pricedPair(ticket, tier);
  return pair ? resolveRate(pair, mode) : null;
}

/**
 * The same lookup flattened to a ฿ number, with an unpriced tier as 0.
 *
 * The zero is for arithmetic and layout — a subtotal, a row that has to render
 * something — and it is why an unpriced tier used to reach the payment screen
 * as a free ticket. It is safe only behind a refusal, and the refusals are the
 * ticket card, which does not answer a press for a tier it cannot price; the
 * order panel, which does not open Pay on a cart `unpricedCartLines` names; and
 * both tills' preflights, which refuse the write.
 */
export function priceForTier(
  ticket: TicketType,
  tier: CustomerTier,
  mode: RateMode = todayRateMode().mode,
): number {
  return tierPriceTHB(ticket, tier, mode) ?? 0;
}

/**
 * Whether this ticket carries a kid price for this tier at all.
 *
 * A missing entry is not "free" — it is a tier nobody has priced on this
 * ticket. Every path that takes money asks this first (SCRUM-228). An explicit
 * 0 is a real price and passes.
 */
export function isTierPriced(ticket: TicketType, tier: CustomerTier): boolean {
  return pricedPair(ticket, tier) !== null;
}

/** Whether the adult rule that charges for this tier carries the price it charges. */
export function isAdultRulePriced(ticket: TicketType, tier: CustomerTier, adults: number): boolean {
  if (adults <= 0) return true;
  const rule = ticket.adultRules?.[tier];
  if (!rule || rule.kind === 'same_as_kid') return isTierPriced(ticket, tier);
  if (rule.kind === 'set_price') {
    return !!rule.price && Number.isFinite(rule.price.weekday) && Number.isFinite(rule.price.weekend);
  }
  // free_adults: only the adults past the free allowance are charged.
  const paid = adults - Math.min(adults, Math.max(0, rule.freeAdults ?? 0));
  if (paid <= 0) return true;
  return rule.overflow === 'set_price'
    ? !!rule.price && Number.isFinite(rule.price.weekday) && Number.isFinite(rule.price.weekend)
    : isTierPriced(ticket, tier);
}

/** One cart line that would be charged from a price nobody has set. */
export interface UnpricedLine {
  ticketName: string;
  tier: CustomerTier;
  /** 'kid' — the tier has no price on this ticket; 'adult' — its adult rule has none. */
  what: 'kid' | 'adult';
}

/**
 * The lines in a cart whose price does not exist. Selling one charges ฿0 with
 * nothing on screen to say so, which is why the till refuses the sale and
 * names them instead (SCRUM-228).
 */
export function unpricedCartLines(lines: CartLine[]): UnpricedLine[] {
  const out: UnpricedLine[] = [];
  for (const line of lines) {
    // A promo line carries its own given price and never resolves a tier rate.
    if (line.promoItem) continue;
    const needsKidPrice = line.kids > 0 || line.dropOff !== undefined;
    if (needsKidPrice && !isTierPriced(line.ticketType, line.tier)) {
      out.push({ ticketName: line.ticketType.name, tier: line.tier, what: 'kid' });
      continue;
    }
    if (!isAdultRulePriced(line.ticketType, line.tier, line.adults)) {
      out.push({ ticketName: line.ticketType.name, tier: line.tier, what: 'adult' });
    }
  }
  return out;
}

/**
 * What to put in front of the person at the till when a price is missing: which
 * tier, on which ticket, and where it is set. One wording, used by the ticket
 * card that refuses the choice, the order panel that refuses the payment and
 * the preflight that refuses the write, so staff are told the same thing
 * wherever they meet it.
 */
export function unpricedReason(
  ticketName: string,
  tier: CustomerTier,
  what: 'kid' | 'adult' = 'kid',
): string {
  const kind = what === 'adult' ? 'adult price' : 'price';
  return `No ${tierLabel(tier)} ${kind} for ${ticketName} — set it in Admin → Tickets`;
}

/** The same sentence for a cart line `unpricedCartLines` named. */
export function unpricedLineReason(line: UnpricedLine): string {
  return unpricedReason(line.ticketName, line.tier, line.what);
}

export interface ResolvedAdultLine {
  freeCount: number; // adults entering free (free_adults rule)
  paidCount: number; // adults charged paidUnit
  paidUnit: number; // ฿ each paid adult is charged
  total: number; // paidCount * paidUnit
}

/**
 * Resolve how a line's adults are charged from the ticket's own per-tier adult
 * rule (the ticket owns its full entry package — there is no park-wide adult
 * admission product). A tier with no rule defaults to same_as_kid.
 *   same_as_kid → every adult pays the kid price for that tier
 *   set_price   → every adult pays rule.price
 *   free_adults → the first rule.freeAdults enter free, then overflow adults pay
 *                 the kid price (overflow 'same_as_kid') or rule.price ('set_price')
 */
export function resolveAdultLine(
  ticket: TicketType,
  tier: CustomerTier,
  adults: number,
  mode: RateMode = todayRateMode().mode,
): ResolvedAdultLine {
  const kidPrice = priceForTier(ticket, tier, mode);
  const rule = ticket.adultRules?.[tier];
  if (!rule || rule.kind === 'same_as_kid') {
    return { freeCount: 0, paidCount: adults, paidUnit: kidPrice, total: adults * kidPrice };
  }
  if (rule.kind === 'set_price') {
    const unit = resolveRate(rule.price, mode);
    return { freeCount: 0, paidCount: adults, paidUnit: unit, total: adults * unit };
  }
  // free_adults
  const freeCount = Math.min(adults, Math.max(0, rule.freeAdults ?? 0));
  const paidCount = adults - freeCount;
  const paidUnit = rule.overflow === 'set_price' ? resolveRate(rule.price, mode) : kidPrice;
  return { freeCount, paidCount, paidUnit, total: paidCount * paidUnit };
}

export interface AdultUnitDisplay {
  /** ฿ each PAID adult on the line is charged — 0 when every adult is free. */
  unitPrice: number;
  /** Free allowance to show beside it, e.g. "1 free", when the line mixes free and paid adults. */
  note?: string;
}

/**
 * What the Adults row on the staff order panel should say, taken from the same
 * resolver that charges the line.
 *
 * SCRUM-226: the panel used to show `priceForTier(...)` — the KID price — on the
 * Adults row, so on every package this branch sells (all `set_price` or
 * `free_adults`) the person taking the money read a figure nobody was charged:
 * "Adults ฿1090 each" beside an adult costing ฿350, or "฿620 each" beside an
 * adult entering free. The total and the visitor display were right throughout,
 * because both come from `resolveAdultLine`. This makes the panel read from it too.
 *
 * With no adults on the line yet, it prices the NEXT one, which is what a row
 * showing 0 is being read for. Where a rule gives free adults and the line has
 * gone past the allowance, `note` carries the free count, so a row whose
 * quantity mixes free and paid adults cannot be multiplied out to a wrong quote.
 */
export function adultUnitDisplay(
  ticket: TicketType,
  tier: CustomerTier,
  adults: number,
  mode: RateMode = todayRateMode().mode,
): AdultUnitDisplay {
  const resolved = resolveAdultLine(ticket, tier, Math.max(adults, 1), mode);
  const unitPrice = resolved.paidCount > 0 ? resolved.paidUnit : 0;
  const mixed = adults > 0 && resolved.freeCount > 0 && resolved.paidCount > 0;
  return mixed ? { unitPrice, note: `${resolved.freeCount} free` } : { unitPrice };
}

/**
 * SCRUM-768 — WHAT A LINE'S SOCKS AND ADD-ONS CHARGE ON THE TILL'S PANELS, less
 * the units the ticket bundles free. The order panel and a drop-off or nanny
 * child's own panel (`DropOffLineConfig`) both read these figures, so the two
 * show the same amount for the same line. `socksPrice` is the panel's own
 * reading of today's socks rate; each figure is in baht.
 */
export function lineExtrasCharge(
  line: Pick<CartLine, 'ticketType' | 'tier' | 'kids' | 'socks' | 'addOns'>,
  socksPrice: number,
): {
  socks: { amount: number; free: number };
  addOns: { amount: number; free: number }[];
  total: number;
} {
  const free = ticketFreebiesOnLine(line.ticketType, line.tier, line, 0);
  const socks = { amount: (line.socks - free.freeSocks) * socksPrice, free: free.freeSocks };
  const addOns = line.addOns.map((a, i) => {
    const units = free.freeAddOns[i] ?? 0;
    return { amount: a.price * (a.quantity - units), free: units };
  });
  return { socks, addOns, total: socks.amount + addOns.reduce((sum, a) => sum + a.amount, 0) };
}

/**
 * SCRUM-768 — the order panel's "N free" hint for a line's kids, adults, socks
 * and each add-on, from the same count that charges the line. Empty when the
 * ticket bundles nothing for this tier.
 */
export function lineFreeNotes(line: Pick<CartLine, 'ticketType' | 'tier' | 'kids' | 'adults' | 'socks' | 'addOns'>, mode: RateMode = todayRateMode().mode): {
  kids?: string;
  adults?: string;
  socks?: string;
  addOns: Record<string, string>;
} {
  const adultLine = resolveAdultLine(line.ticketType, line.tier, line.adults, mode);
  const free = ticketFreebiesOnLine(line.ticketType, line.tier, line, adultLine.paidCount);
  const freeAdults = adultLine.freeCount + free.freeAdults;
  const addOns: Record<string, string> = {};
  line.addOns.forEach((a, i) => {
    const units = free.freeAddOns[i] ?? 0;
    if (units > 0) addOns[a.id] = `${units} free`;
  });
  return {
    ...(free.freeKids > 0 ? { kids: `${free.freeKids} free` } : {}),
    ...(free.freeAdults > 0 && freeAdults > 0 ? { adults: `${freeAdults} free` } : {}),
    ...(free.freeSocks > 0 ? { socks: `${free.freeSocks} free` } : {}),
    addOns,
  };
}

export interface LinePricingInput {
  ticketType: TicketType;
  tier: CustomerTier;
  kids: number;
  adults: number;
  socks: number;
  addOns: SelectedAddOn[];
  // Drop-off/nanny service fee for a drop-off line (added on top of the ticket).
  serviceFeeTHB?: number;
}

/**
 * Set the quantity of one add-on on a line's add-on list. Quantity <= 0 removes
 * it; otherwise it updates the existing entry or appends a fresh one priced from
 * the catalog (resolved to a concrete ฿ number for `mode` — the SelectedAddOn
 * snapshot never carries the raw weekday/weekend pair). Shared by every "Extras
 * & Add-ons" surface so quantity handling never diverges.
 */
export function setAddOnQty(
  current: SelectedAddOn[],
  catalog: AddOn[],
  addOnId: string,
  quantity: number,
  variantId?: string,
  mode: RateMode = todayRateMode().mode,
): SelectedAddOn[] {
  if (quantity <= 0) return current.filter((a) => a.id !== addOnId);
  if (current.some((a) => a.id === addOnId)) {
    return current.map((a) =>
      a.id === addOnId
        ? { ...a, quantity, ...(variantId !== undefined ? { variantId } : {}) }
        : a
    );
  }
  const catalogItem = catalog.find((a) => a.id === addOnId);
  if (!catalogItem) return current;
  return [
    ...current,
    {
      ...catalogItem,
      price: resolveRate(catalogItem.price, mode),
      quantity,
      ...(variantId !== undefined ? { variantId } : {}),
    },
  ];
}

/**
 * Set the per-variant breakdown of a multi-variant stocked add-on on a line, so
 * one ticket can carry different sizes (e.g. 1×S + 2×M grip socks). The total
 * `quantity` is the sum of the breakdown; an empty/all-zero breakdown removes the
 * add-on. Keeps ONE entry per add-on id (variantBreakdown holds the split), so it
 * never ripples into the discount/tax/display seams that key on a.id.
 */
export function setAddOnVariants(
  current: SelectedAddOn[],
  catalog: AddOn[],
  addOnId: string,
  breakdown: AddOnVariantQty[],
  mode: RateMode = todayRateMode().mode,
): SelectedAddOn[] {
  const cleaned = breakdown.filter((b) => b.quantity > 0);
  const total = cleaned.reduce((sum, b) => sum + b.quantity, 0);
  if (total <= 0) return current.filter((a) => a.id !== addOnId);
  if (current.some((a) => a.id === addOnId)) {
    return current.map((a) =>
      a.id === addOnId
        ? { ...a, quantity: total, variantBreakdown: cleaned, variantId: undefined }
        : a,
    );
  }
  const catalogItem = catalog.find((a) => a.id === addOnId);
  if (!catalogItem) return current;
  return [
    ...current,
    { ...catalogItem, price: resolveRate(catalogItem.price, mode), quantity: total, variantBreakdown: cleaned },
  ];
}

/** Compact size summary for a multi-variant add-on, e.g. "1×S, 2×M". */
export function addOnVariantSummary(breakdown: AddOnVariantQty[]): string {
  return breakdown.map((b) => `${b.quantity}×${b.variantLabel}`).join(', ');
}

export function computeLineTotal(
  input: LinePricingInput,
  mode: RateMode = todayRateMode().mode,
): number {
  const { ticketType, tier, adults, socks, addOns, serviceFeeTHB } = input;
  const ticketPrice = priceForTier(ticketType, tier, mode);
  const adultLine = resolveAdultLine(ticketType, tier, adults, mode);
  // SCRUM-768 — the ticket's free items take their units off what is charged.
  const free = ticketFreebiesOnLine(ticketType, tier, input, adultLine.paidCount);

  let total = free.paidKids * ticketPrice + (adultLine.paidCount - free.freeAdults) * adultLine.paidUnit;

  total += counterSocksPrice(mode) * (socks - free.freeSocks);

  // addOns already carry a resolved concrete `price` snapshot (see setAddOnQty).
  addOns.forEach((a, i) => {
    total += a.price * (a.quantity - (free.freeAddOns[i] ?? 0));
  });

  total += serviceFeeTHB ?? 0;

  return total;
}

export type LineBreakdownKind = 'kids' | 'adults' | 'socks' | 'addon';

export interface LineBreakdownItem {
  key: string;
  kind: LineBreakdownKind;
  /** English, as every staff screen reads it. A customer's screen names the row by its key. */
  label: string;
  /** An add-on's translated names, for the customer's screens (SCRUM-729). */
  translations?: Partial<Record<SupportedLang, string>>;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

/**
 * Itemized price breakdown for a cart line (per-unit price, quantity, subtotal).
 * Mirrors computeLineTotal exactly so the customer display and the receipt agree.
 *
 * SCRUM-768 — a ticket's free items show as their own ฿0 rows beside the row
 * they come out of, as the free adults always have: "Kids (free)", the bundled
 * adults inside "Adults (free)", "Regular Socks (free)" and "<add-on> (free)".
 * A free add-on row is keyed `<add-on id>:free` so the screens that key a row
 * by it hold one row each.
 */
export function computeLineBreakdown(
  line: CartLine,
  mode: RateMode = todayRateMode().mode,
): LineBreakdownItem[] {
  // promoItem lines have no ticket components — their price is wholly offset by
  // the matching discount and must not appear in the component breakdown.
  if (line.promoItem) return [];
  const ticketPrice = priceForTier(line.ticketType, line.tier, mode);
  const items: LineBreakdownItem[] = [];
  const adultLine = resolveAdultLine(line.ticketType, line.tier, line.adults, mode);
  const free = ticketFreebiesOnLine(line.ticketType, line.tier, line, adultLine.paidCount);

  if (line.kids > 0) {
    items.push({
      key: 'kids',
      kind: 'kids',
      label: 'Kids',
      unitPrice: ticketPrice,
      quantity: free.paidKids,
      subtotal: free.paidKids * ticketPrice,
    });
  }
  if (free.freeKids > 0) {
    items.push({
      key: 'kids-free',
      kind: 'kids',
      label: 'Kids (free)',
      unitPrice: 0,
      quantity: free.freeKids,
      subtotal: 0,
    });
  }
  if (line.adults > 0) {
    const paidAdults = adultLine.paidCount - free.freeAdults;
    const freeAdults = adultLine.freeCount + free.freeAdults;
    if (paidAdults > 0) {
      items.push({
        key: 'adults',
        kind: 'adults',
        label: 'Adults',
        unitPrice: adultLine.paidUnit,
        quantity: paidAdults,
        subtotal: paidAdults * adultLine.paidUnit,
      });
    }
    if (freeAdults > 0) {
      items.push({
        key: 'adults-free',
        kind: 'adults',
        label: 'Adults (free)',
        unitPrice: 0,
        quantity: freeAdults,
        subtotal: 0,
      });
    }
  }
  if (line.socks > 0) {
    const socksPrice = counterSocksPrice(mode);
    const paidSocks = line.socks - free.freeSocks;
    if (paidSocks > 0) {
      items.push({
        key: 'socks',
        kind: 'socks',
        label: 'Regular Socks',
        unitPrice: socksPrice,
        quantity: paidSocks,
        subtotal: paidSocks * socksPrice,
      });
    }
    if (free.freeSocks > 0) {
      items.push({
        key: 'socks-free',
        kind: 'socks',
        label: 'Regular Socks (free)',
        unitPrice: 0,
        quantity: free.freeSocks,
        subtotal: 0,
      });
    }
  }
  line.addOns.forEach((a, i) => {
    const freeUnits = free.freeAddOns[i] ?? 0;
    const sized = a.variantBreakdown && a.variantBreakdown.length > 0 ? a.variantBreakdown : null;
    const split = sized && freeUnits > 0 ? splitVariantBreakdown(sized, freeUnits) : null;
    const row = (parts: AddOnVariantQty[] | null, suffix: string) => {
      const variants = parts && parts.length > 0 ? ` (${addOnVariantSummary(parts)})` : '';
      const translations = a.translations
        ? Object.fromEntries(
            Object.entries(a.translations)
              .filter((entry): entry is [string, { name: string }] => !!entry[1])
              .map(([language, value]) => [language, `${value.name}${variants}${suffix}`]),
          )
        : undefined;
      return { label: `${a.name}${variants}${suffix}`, ...(translations ? { translations } : {}) };
    };
    const paidUnits = a.quantity - freeUnits;
    if (paidUnits > 0 || freeUnits === 0) {
      items.push({
        key: a.id,
        kind: 'addon',
        ...row(split ? split.paid : sized, ''),
        unitPrice: a.price,
        quantity: paidUnits,
        subtotal: a.price * paidUnits,
      });
    }
    if (freeUnits > 0) {
      items.push({
        key: `${a.id}:free`,
        kind: 'addon',
        ...row(split ? split.free : sized, ' (free)'),
        unitPrice: 0,
        quantity: freeUnits,
        subtotal: 0,
      });
    }
  });

  // Drop-off / nanny service fee row (uses the 'addon' kind so existing icon maps
  // stay exhaustive). Shown after the ticket so the breakdown sums to lineTotal.
  if (line.dropOff && line.dropOff.serviceFeeTHB > 0) {
    const { service, hours, serviceFeeTHB } = line.dropOff;
    items.push({
      key: 'dropoff-service',
      kind: 'addon',
      label: service === 'nanny' ? `Nanny (${hours}h)` : 'Drop-off service',
      unitPrice: serviceFeeTHB,
      quantity: 1,
      subtotal: serviceFeeTHB,
    });
  }

  return items;
}

// Stable string key for a component target, shared by the discount math, the
// modal picker, and both displays so they all agree on what's being targeted.
// kids/adults/socks → their kind; an add-on → `addon:<id>`.
export function componentKey(t: DiscountComponentTarget): string {
  return t.kind === 'addon' ? `addon:${t.addOnId}` : t.kind;
}

// The same key derived from a breakdown row, so a rendered component row can be
// matched back to a component-scoped discount.
export function breakdownComponentKey(item: LineBreakdownItem): string {
  return item.kind === 'addon' ? `addon:${item.key}` : item.kind;
}

/**
 * The ฿ subtotal of each discountable component of a line, keyed by componentKey.
 * Mirrors computeLineBreakdown so a component discount resolves against exactly
 * what the customer sees on that component row.
 */
export function lineComponentBases(
  line: CartLine,
  mode: RateMode = todayRateMode().mode,
): Record<string, number> {
  const bases: Record<string, number> = {};
  for (const item of computeLineBreakdown(line, mode)) {
    const key = breakdownComponentKey(item);
    bases[key] = (bases[key] ?? 0) + item.subtotal;
  }
  return bases;
}
