import type { Satang } from './money';
import type { TaxableCategory } from './catalog-shapes';
import type { CartUnit, TicketCartTotals } from './cart-totals';
import { SERVICE_FEE_ROW_KEY } from './pricing';
import { apportion } from './rounding';

/**
 * THE LEDGER'S LINES — one row per priced unit, with its share of the money
 * (offline plan §2.5, Round 4).
 *
 * The platform writes one `pos.sale_line` per unit the engine computed
 * (`cartUnits`), and splits each taxable category's post-discount base, its
 * service charge and its tax across the units that make it up. That split used
 * to live inside `buildPricedLines` in the api, which a box pricing a sale
 * with no internet cannot call — so the receipt it printed could not carry the
 * same per-line figures the ledger will hold.
 *
 * It lives here now, moved rather than copied: the platform's commit and the
 * box's finalise run this one function over the same units and the same
 * totals, so the line a guest reads on paper at the counter is the line the
 * ledger files when the link comes back.
 */

/** What a unit of the engine's decomposition is, as the ledger names it. */
export type LedgerUnitKind =
  | 'promo_item'
  | 'food_provision'
  | 'service_fee'
  | 'kids'
  | 'adults_free'
  | 'adults_paid'
  | 'socks'
  | 'addon';

/** A unit's kind, from what the engine made of it. Item lines are named by their caller. */
export function ledgerUnitKindOf(unit: CartUnit): LedgerUnitKind {
  if (unit.promoItem) return 'promo_item';
  const row = unit.row;
  if (!row) return 'food_provision';
  if (row.key === SERVICE_FEE_ROW_KEY) return 'service_fee';
  if (row.kind === 'kids') return 'kids';
  if (row.kind === 'adults') return row.key === 'adults-free' ? 'adults_free' : 'adults_paid';
  if (row.kind === 'socks') return 'socks';
  return 'addon';
}

/** The component key a unit's sale line is named from (`deriveSaleLineId`). */
export function ledgerUnitComponentKey(unit: CartUnit): string {
  return unit.row
    ? unit.row.key
    : unit.promoItem
      ? `promo-item:${unit.promoItem.itemId}`
      : 'food-provision';
}

/** What a unit's line is called on the receipt and in History. */
export function ledgerUnitLabel(unit: CartUnit): string {
  return unit.row?.label ?? unit.promoItem?.name ?? 'Prepaid food';
}

/** One unit's share of the sale's money. Every figure is satang. */
export interface LedgerUnitMoney {
  /** Undiscounted: what the unit was worth before any discount ran. */
  base: Satang;
  discount: Satang;
  /** The base the unit is left with once its discount is taken. */
  baseAfter: Satang;
  service: Satang;
  /** Tax already inside `baseAfter`. */
  taxInclusive: Satang;
  /** Tax added on top of it. */
  taxExclusive: Satang;
  /** `baseAfter` less its inclusive tax. */
  net: Satang;
  /** What the unit's line charges: net, both taxes and its service charge. */
  gross: Satang;
  category: TaxableCategory;
}

/**
 * Each unit's share of the money, in unit order.
 *
 * THE SPLIT IS AN APPORTIONMENT, and the authoritative per-category figures
 * are the sale's `tax_breakdown`. Each category's post-discount base, service
 * charge and tax are divided across its units in proportion to their
 * undiscounted bases, largest remainder, so the parts sum back exactly. A unit
 * worth nothing (the free-adults row) takes nothing.
 *
 * WHAT A LINE-AIMED PROMO TOOK stays on the unit it took it from: a voucher's
 * free item on the voucher's own line, a 1+1 on one line's kids. The engine
 * reports it (`AppliedPromo.units`, indexed like `cartUnits` over the same
 * lines and context). Spread by the category rule instead, a free pizza beside
 * a paid one would put ฿110 off on each — the right total, two wrong receipt
 * lines, and a refund of the paid pizza returning ฿110.
 */
export function splitLedgerUnitMoney(
  units: readonly CartUnit[],
  totals: TicketCartTotals,
): LedgerUnitMoney[] {
  const byCategory = new Map<TaxableCategory, number[]>();
  units.forEach((unit, index) => {
    const list = byCategory.get(unit.category) ?? [];
    list.push(index);
    byCategory.set(unit.category, list);
  });

  const discount = new Array<number>(units.length).fill(0);
  const baseAfter = new Array<number>(units.length).fill(0);
  const service = new Array<number>(units.length).fill(0);
  const taxIncl = new Array<number>(units.length).fill(0);
  const taxExcl = new Array<number>(units.length).fill(0);

  const pinned = new Array<number>(units.length).fill(0);
  for (const applied of totals.appliedPromos) {
    for (const aimed of applied.units ?? []) {
      if (aimed.index < 0 || aimed.index >= units.length) {
        throw new Error('a line-aimed discount names a unit this cart does not have');
      }
      pinned[aimed.index] = (pinned[aimed.index] ?? 0) + aimed.amount;
    }
  }

  for (const [category, indexes] of byCategory) {
    const weights = indexes.map((i) => units[i]?.base ?? 0);
    const originalBase = weights.reduce((sum, w) => sum + w, 0);
    const row = totals.taxBreakdown.categories.find((c) => c.category === category);
    // A category with no row in the breakdown contributed no base at all.
    const after = row?.base ?? originalBase;
    const inclusive =
      (row?.taxMode === 'inclusive' ? (row?.tax ?? 0) : 0) +
      (row?.secondaryTaxMode === 'inclusive' ? (row?.secondaryTax ?? 0) : 0);
    const exclusive =
      (row?.taxMode === 'exclusive' ? (row?.tax ?? 0) : 0) +
      (row?.secondaryTaxMode === 'exclusive' ? (row?.secondaryTax ?? 0) : 0);

    const categoryDiscount = Math.max(0, originalBase - after);
    const pins = indexes.map((i) => pinned[i] ?? 0);
    const pinnedTotal = pins.reduce((sum, pin) => sum + pin, 0);

    if (pinnedTotal === 0) {
      // Nothing aimed at a line in this category: every figure spread across
      // its units in proportion to their undiscounted bases.
      const shares = {
        base: apportion(after, weights),
        discount: apportion(categoryDiscount, weights),
        service: apportion(row?.serviceCharge ?? 0, weights),
        inclusive: apportion(inclusive, weights),
        exclusive: apportion(exclusive, weights),
      };
      indexes.forEach((unitIndex, position) => {
        baseAfter[unitIndex] = shares.base[position] ?? 0;
        discount[unitIndex] = shares.discount[position] ?? 0;
        service[unitIndex] = shares.service[position] ?? 0;
        taxIncl[unitIndex] = shares.inclusive[position] ?? 0;
        taxExcl[unitIndex] = shares.exclusive[position] ?? 0;
      });
      continue;
    }

    // The aimed markdown on its own units — never more than the category's own
    // discount, which is none when discounts are placed after tax ...
    const aimedShares = pinnedTotal <= categoryDiscount ? pins : apportion(categoryDiscount, pins);
    const aimedTotal = aimedShares.reduce((sum, share) => sum + share, 0);
    // ... and the rest of the category's discount over what each unit has left.
    const room = indexes.map((i, position) =>
      Math.max(0, (units[i]?.base ?? 0) - (aimedShares[position] ?? 0)),
    );
    const restShares = apportion(categoryDiscount - aimedTotal, room);
    const discounts = indexes.map(
      (_, position) =>
        (aimedShares[position] ?? 0) + Math.min(restShares[position] ?? 0, room[position] ?? 0),
    );
    const bases = indexes.map((i, position) => (units[i]?.base ?? 0) - (discounts[position] ?? 0));
    // Service charge and tax follow the base each unit is left with: an item
    // handed over for nothing carries none of either.
    const chargeWeights = bases.some((base) => base > 0) ? bases : weights;
    const shares = {
      service: apportion(row?.serviceCharge ?? 0, chargeWeights),
      inclusive: apportion(inclusive, chargeWeights),
      exclusive: apportion(exclusive, chargeWeights),
    };
    indexes.forEach((unitIndex, position) => {
      baseAfter[unitIndex] = bases[position] ?? 0;
      discount[unitIndex] = discounts[position] ?? 0;
      service[unitIndex] = shares.service[position] ?? 0;
      taxIncl[unitIndex] = shares.inclusive[position] ?? 0;
      taxExcl[unitIndex] = shares.exclusive[position] ?? 0;
    });
  }

  return units.map((unit, index) => {
    const base = baseAfter[index] ?? 0;
    const incl = taxIncl[index] ?? 0;
    const excl = taxExcl[index] ?? 0;
    const serviceCharge = service[index] ?? 0;
    // Inclusive tax is already inside the base; exclusive tax is added to it.
    const net = base - incl;
    return {
      base: unit.base,
      discount: discount[index] ?? 0,
      baseAfter: base,
      service: serviceCharge,
      taxInclusive: incl,
      taxExclusive: excl,
      net,
      gross: net + incl + excl + serviceCharge,
      category: unit.category,
    };
  });
}

// --- The bands a sale owes (S2-11; offline plan OD-13) ---------------------------

/** What band planning reads off a ledger line. */
export interface LedgerBandLine {
  id: string;
  cartLineId: string | null;
  kind: string;
  /** A ticket line's unit (`ticket_package_id` set). Only these owe bands. */
  ticket: boolean;
  kidCount: number;
  adultCount: number;
  freeAdultCount: number;
}

/** One band a sale owes: which kind, and which ticket unit it is issued against. */
export interface PlannedLedgerBand {
  kind: 'kid' | 'adult';
  saleLineId: string | null;
  cartLineId: string | null;
}

/**
 * The bands a sale's ticket lines owe, in cart order: each cart line's kids,
 * then its adults — the prototype's `sale.bracelets` (`lib/sale.ts:293-315`),
 * one kids band per child ticket and one adult band per adult on every ticket
 * line, free adults included. A kids band is issued against the line's `kids`
 * unit; an adult band against `adults_paid` for the paid adults and
 * `adults_free` for the free ones, falling back to any unit of the line when
 * that row is absent.
 *
 * Shared because a box mints the bands of a sale it takes with no internet
 * (OD-13) and the platform mints them online, and both must owe the same
 * bands for the same sale — lines passed in ledger order.
 */
export function planLedgerBands(lines: readonly LedgerBandLine[]): PlannedLedgerBand[] {
  const byCart = new Map<string, LedgerBandLine[]>();
  for (const line of lines) {
    if (!line.ticket) continue;
    const key = line.cartLineId ?? line.id;
    const group = byCart.get(key) ?? [];
    group.push(line);
    byCart.set(key, group);
  }
  const plan: PlannedLedgerBand[] = [];
  for (const [cartLineId, group] of byCart) {
    const first = group[0];
    if (!first) continue;
    const kids = first.kidCount;
    const adults = first.adultCount;
    const free = Math.min(first.freeAdultCount, adults);
    const kidsRow = group.find((l) => l.kind === 'kids') ?? first;
    const paidRow = group.find((l) => l.kind === 'adults_paid');
    const freeRow = group.find((l) => l.kind === 'adults_free');
    for (let i = 0; i < kids; i += 1) {
      plan.push({ kind: 'kid', saleLineId: kidsRow.id, cartLineId });
    }
    for (let i = 0; i < adults; i += 1) {
      const row = i < adults - free ? (paidRow ?? freeRow ?? first) : (freeRow ?? paidRow ?? first);
      plan.push({ kind: 'adult', saleLineId: row.id, cartLineId });
    }
  }
  return plan;
}
