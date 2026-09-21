import { TicketType, CustomerTier, AddOn, SelectedAddOn, AddOnVariantQty, CartLine, DiscountComponentTarget } from '@/types';
// Import the catalog getters from their source (the store), NOT from mockApi.
// mockApi -> lib/sale -> lib/pricing already forms an import cycle; pulling
// getAddOns from mockApi closed that loop, so when a module evaluated pricing.ts
// first (e.g. under HMR) mockApi's seed code ran pricing helpers while this
// module's `SOCKS_ID` const was still in its temporal dead zone -> crash.
import { getAddOns } from '@/store/catalogStore';
import { RateMode, resolveRate, todayRateMode } from '@/lib/pricingMode';

const SOCKS_ID = 'a-socks';

/**
 * Defensive per-tier ticket price lookup, resolved to a concrete ฿ number for
 * `mode` (defaults to today's active rate). A tier with no entry in the price
 * map is "not priced" yet (e.g. a tier the owner just added but hasn't priced
 * on this ticket) — treat it as 0 rather than letting `undefined` poison the math.
 */
export function priceForTier(
  ticket: TicketType,
  tier: CustomerTier,
  mode: RateMode = todayRateMode().mode,
): number {
  return resolveRate(ticket.prices[tier], mode);
}

/**
 * Whether this ticket carries a kid price for this tier at all.
 *
 * A missing entry is not "free" — it is a tier nobody has priced on this
 * ticket, and `priceForTier` resolves it to 0 because a number has to come
 * back for the card to render. Every path that takes money asks this first
 * (SCRUM-228). An explicit 0 is a real price and passes.
 */
export function isTierPriced(ticket: TicketType, tier: CustomerTier): boolean {
  const p = ticket.prices[tier];
  return !!p && Number.isFinite(p.weekday) && Number.isFinite(p.weekend);
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
  const { ticketType, tier, kids, adults, socks, addOns, serviceFeeTHB } = input;
  const ticketPrice = priceForTier(ticketType, tier, mode);
  const adultLine = resolveAdultLine(ticketType, tier, adults, mode);

  let total = kids * ticketPrice + adultLine.total;

  const socksItem = getAddOns().find((a) => a.id === SOCKS_ID);
  if (socksItem) {
    total += resolveRate(socksItem.price, mode) * socks;
  }

  // addOns already carry a resolved concrete `price` snapshot (see setAddOnQty).
  addOns.forEach((a) => {
    total += a.price * a.quantity;
  });

  total += serviceFeeTHB ?? 0;

  return total;
}

export type LineBreakdownKind = 'kids' | 'adults' | 'socks' | 'addon';

export interface LineBreakdownItem {
  key: string;
  kind: LineBreakdownKind;
  label: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

/**
 * Itemized price breakdown for a cart line (per-unit price, quantity, subtotal).
 * Mirrors computeLineTotal exactly so the customer display and the receipt agree.
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

  if (line.kids > 0) {
    items.push({
      key: 'kids',
      kind: 'kids',
      label: 'Kids',
      unitPrice: ticketPrice,
      quantity: line.kids,
      subtotal: line.kids * ticketPrice,
    });
  }
  if (line.adults > 0) {
    const adultLine = resolveAdultLine(line.ticketType, line.tier, line.adults, mode);
    if (adultLine.paidCount > 0) {
      items.push({
        key: 'adults',
        kind: 'adults',
        label: 'Adults',
        unitPrice: adultLine.paidUnit,
        quantity: adultLine.paidCount,
        subtotal: adultLine.paidCount * adultLine.paidUnit,
      });
    }
    if (adultLine.freeCount > 0) {
      items.push({
        key: 'adults-free',
        kind: 'adults',
        label: 'Adults (free)',
        unitPrice: 0,
        quantity: adultLine.freeCount,
        subtotal: 0,
      });
    }
  }
  if (line.socks > 0) {
    const socksItem = getAddOns().find((a) => a.id === SOCKS_ID);
    const socksPrice = socksItem ? resolveRate(socksItem.price, mode) : 0;
    items.push({
      key: 'socks',
      kind: 'socks',
      label: 'Regular Socks',
      unitPrice: socksPrice,
      quantity: line.socks,
      subtotal: line.socks * socksPrice,
    });
  }
  line.addOns.forEach((a) => {
    const label =
      a.variantBreakdown && a.variantBreakdown.length > 0
        ? `${a.name} (${addOnVariantSummary(a.variantBreakdown)})`
        : a.name;
    items.push({
      key: a.id,
      kind: 'addon',
      label,
      unitPrice: a.price,
      quantity: a.quantity,
      subtotal: a.price * a.quantity,
    });
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
