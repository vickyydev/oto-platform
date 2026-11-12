import type {
  AddOn,
  AddOnVariantQty,
  CartLine,
  CustomerTier,
  Discount,
  DiscountComponentTarget,
  ManualDiscount,
  SelectedAddOn,
  TicketType,
} from '@/types';
import {
  PARTY_INCLUDED_COMPONENT,
  PARTY_PACKAGE_COMPONENT,
  eventPassService,
  type TaxBreakdown as EngineTaxBreakdown,
} from '@oto/shared';
import { isVoucherDiscount, type ApiSaleDetail, type ApiSaleDiscount, type ApiSaleLine } from '@/api/history';
import type { CartQuote, OrderTotals } from '@/api/sales';
import type { CartQuoteState } from '@/lib/cartQuote';
import { breakdownToBaht, toBaht } from '@/lib/cartWire';
import { satangText } from '@/lib/bahtText';
import type { RateMode } from '@/lib/pricingMode';

/**
 * A RUNG-UP SALE, BACK ON THE TICKET TILL'S SCREEN AFTER A RELOAD.
 *
 * Pay writes the sale to the platform in `tendering` and the till then holds
 * the cart only in its own memory (`pages/Till.tsx`). A reload lost that
 * memory, and the only way back was to void the sale and ring the family up
 * again. The platform holds everything the payment screen needs — the sale's
 * lines (`pos.sale_line`, one row per component of each cart line), its
 * discounts, its totals and the money already taken on it — so this rebuilds
 * the cart the till shows from that read (`GET /sales/:id`) and hands the
 * payment screen the platform's own figures.
 *
 * WHAT IS REBUILT, AND FROM WHERE. Each cart line is the group of ledger rows
 * sharing its `cartLineId`: the kids row gives the count, the paid and free
 * adults rows the adults, the socks row the socks, each add-on row an add-on
 * at the price it was sold at, and the line's total is the sum of what those
 * rows charge. The package is the catalogue's when it still lists it, so the
 * panel's per-row breakdown draws from the real rules; a package the catalogue
 * no longer carries gets a stand-in built from the rows themselves, named by
 * its stay. A supervised child's line (a service fee or prepaid food row) is
 * drawn as the plain line it charges for: the registration behind it belongs
 * to the Drop-Off board, which the platform's own finalisation already hands
 * the child's band to.
 *
 * WHAT IS NOT: nothing is re-priced. The totals the panel, the display and the
 * payment screen show are the sale's (`resumedCart`), labelled as the
 * platform's, and the order cannot be changed on a resumed sale — Cancel voids
 * it and a new sale is rung up. A voucher on the sale stays on it on the
 * platform, which uses it up at the close; its code comes back masked and is
 * shown as the discount it took, not held again.
 */

/** The catalogue a rebuild reads: what the till holds for this branch. */
export interface ResumeCatalogue {
  ticketTypes: readonly TicketType[];
  addOns: readonly AddOn[];
  /** A park promo code by its code, as the till's own list holds it. */
  discountByCode: (code: string) => Discount | null;
}

export interface ResumedCart {
  tier: CustomerTier;
  lines: CartLine[];
  discounts: Discount[];
  manualDiscounts: ManualDiscount[];
  /** The sale's figures in the shape every money component renders. */
  cart: CartQuoteState;
  /** True when a line is a supervised child's: its registration is on the Drop-Off board. */
  supervised: boolean;
  /** SCRUM-732 — an event pass rung up for a QR or a card: its child waits on this sale. */
  eventPass: boolean;
}

/** The ledger kinds a ticket cart line is made of; anything else is another counter's. */
const TICKET_KINDS = new Set([
  'kids',
  'adults_paid',
  'adults_free',
  'socks',
  'addon',
  'service_fee',
  'food_provision',
  'promo_item',
]);

const PROMO_ITEM_PREFIX = 'promo-item:';

/**
 * A stand-in package for a line whose package the catalogue no longer lists,
 * priced from the sale's own rows so the row breakdown matches what was
 * charged: the kids row's unit price at the sale's tier, and the paid adults
 * row's as a set adult price (free adults counted when the sale had them).
 */
function standInPackage(cartLineId: string, tier: CustomerTier, rows: readonly ApiSaleLine[]): TicketType {
  const kids = rows.find((r) => r.kind === 'kids');
  const paidAdults = rows.find((r) => r.kind === 'adults_paid');
  const freeAdults = rows.find((r) => r.kind === 'adults_free');
  const stay = kids?.stayDurationLabel ?? rows.find((r) => r.stayDurationLabel)?.stayDurationLabel ?? null;
  const hours = kids?.stayHours ?? rows.find((r) => r.stayHours !== null)?.stayHours ?? 0;
  const kidUnit = toBaht(kids?.unitSatang ?? 0);
  const adultUnit = toBaht(paidAdults?.unitSatang ?? kids?.unitSatang ?? 0);
  return {
    id: kids?.ticketPackageId ?? `resumed-${cartLineId}`,
    name: stay ? `${stay} Play` : 'Play ticket',
    durationLabel: stay ?? '',
    hours,
    prices: { [tier]: { weekday: kidUnit, weekend: kidUnit } },
    adultRules: {
      [tier]: freeAdults && freeAdults.quantity > 0
        ? {
            kind: 'free_adults',
            freeAdults: freeAdults.quantity,
            overflow: 'set_price',
            price: { weekday: adultUnit, weekend: adultUnit },
          }
        : { kind: 'set_price', price: { weekday: adultUnit, weekend: adultUnit } },
    },
  };
}

/**
 * One add-on of a cart line, from every ledger row filed under its id.
 *
 * SCRUM-768 — a ticket's free add-on is filed as two rows under the same id:
 * the units charged at the add-on's price, and the free units at ฿0. The cart
 * held them as ONE add-on, and the till's engine splits it again from the
 * ticket's free items, so the rows are put back together here: the count is
 * both rows', the price is the charged row's, and the sizes are the free
 * row's first, as the split took them from the front of the add-on's sizes.
 */
function addOnOf(rows: readonly ApiSaleLine[], catalogue: ResumeCatalogue): SelectedAddOn {
  const first = rows[0]!;
  const id = first.componentKey ?? first.id;
  const known = catalogue.addOns.find((a) => a.id === id);
  const charged = rows.find((r) => r.unitSatang > 0) ?? first;
  const ordered = [...rows.filter((r) => r.unitSatang === 0), ...rows.filter((r) => r.unitSatang !== 0)];
  const breakdown: AddOnVariantQty[] = [];
  for (const part of ordered.flatMap((r) => r.variantBreakdown ?? [])) {
    if (part.quantity <= 0) continue;
    const same = breakdown.find((b) => b.variantId === part.variantId);
    if (same) same.quantity += part.quantity;
    else breakdown.push({ ...part });
  }
  return {
    id,
    name: known?.name ?? charged.label,
    price: toBaht(charged.unitSatang),
    quantity: rows.reduce((sum, r) => sum + r.quantity, 0),
    ...(known?.inventoryItemId ? { inventoryItemId: known.inventoryItemId } : {}),
    ...(known?.taxCategoryOverride ? { taxCategoryOverride: known.taxCategoryOverride } : {}),
    ...(breakdown.length > 1 ? { variantBreakdown: breakdown } : {}),
    ...(breakdown.length === 1 ? { variantId: breakdown[0]!.variantId } : {}),
  };
}

/** One cart line from the ledger rows that share its id, in the order they were written. */
function cartLineOf(
  cartLineId: string,
  rows: readonly ApiSaleLine[],
  tier: CustomerTier,
  catalogue: ResumeCatalogue,
): { line: CartLine; supervised: boolean } {
  const lineTier = rows[0]?.customerTier || tier;
  let kids = 0;
  let adults = 0;
  let socks = 0;
  // Each add-on's rows by its id, in the order the ledger first names it.
  const addOnRows = new Map<string, ApiSaleLine[]>();
  let promoItem: CartLine['promoItem'];
  let supervised = false;
  let gross = 0;
  for (const row of rows) {
    gross += row.grossSatang;
    switch (row.kind) {
      case 'kids':
        kids += row.quantity;
        break;
      case 'adults_paid':
      case 'adults_free':
        adults += row.quantity;
        break;
      case 'socks':
        socks += row.quantity;
        break;
      case 'addon': {
        const key = row.componentKey ?? row.id;
        addOnRows.set(key, [...(addOnRows.get(key) ?? []), row]);
        break;
      }
      case 'promo_item':
        promoItem = {
          itemId: row.componentKey?.startsWith(PROMO_ITEM_PREFIX)
            ? row.componentKey.slice(PROMO_ITEM_PREFIX.length)
            : (row.productId ?? row.componentKey ?? row.id),
          itemKind: 'menu',
          name: row.label,
          priceTHB: toBaht(row.unitSatang),
        };
        break;
      case 'service_fee':
      case 'food_provision':
        // Charged on a supervised child's line; its registration is the board's.
        supervised = true;
        break;
      default:
        break;
    }
  }
  const addOns = [...addOnRows.values()].map((group) => addOnOf(group, catalogue));
  const packageId = rows.find((r) => r.ticketPackageId)?.ticketPackageId ?? null;
  const ticketType =
    (packageId ? catalogue.ticketTypes.find((t) => t.id === packageId) : undefined) ??
    standInPackage(cartLineId, lineTier, rows);
  return {
    line: {
      id: cartLineId,
      ticketType,
      tier: lineTier,
      kids,
      adults,
      socks,
      addOns,
      lineTotal: toBaht(gross),
      ...(promoItem ? { promoItem } : {}),
    },
    supervised: supervised || rows.some((r) => r.supervised === true),
  };
}

function manualDiscountOf(row: ApiSaleDiscount): ManualDiscount {
  const type: ManualDiscount['type'] =
    row.discountType === 'percent' || row.discountType === 'comp' ? row.discountType : 'fixed';
  const value =
    type === 'percent'
      ? (row.percentBp ?? 0) / 100
      : type === 'fixed'
        ? toBaht(row.valueSatang ?? row.amountSatang)
        : 0;
  const target = row.targetComponent as DiscountComponentTarget | null | undefined;
  return {
    id: row.id,
    scope: row.scope === 'line' ? 'line' : 'order',
    ...(row.targetLineId ? { targetLineId: row.targetLineId } : {}),
    ...(target && typeof target === 'object' && 'kind' in target ? { targetComponent: target } : {}),
    ...(row.targetLabel ? { targetLabel: row.targetLabel } : {}),
    type,
    value,
    reason: row.reason ?? '',
    ...(row.note ? { note: row.note } : {}),
    amountTHB: toBaht(row.amountSatang),
    appliedBy: row.appliedByName ?? '',
    appliedById: row.appliedByAccountId ?? '',
    appliedAt: row.appliedAt ?? '',
  };
}

/** A promo row as the till's own code, or as the sale describes it when the till no longer holds the code. */
function promoOf(row: ApiSaleDiscount, catalogue: ResumeCatalogue): Discount | null {
  if (!row.code) return null;
  const known = catalogue.discountByCode(row.code);
  if (known) return known;
  const type: Discount['type'] =
    row.discountType === 'percent' || row.discountType === 'free_item' ? row.discountType : 'fixed';
  return {
    code: row.code,
    label: row.label ?? row.code,
    type,
    value: type === 'percent' ? (row.percentBp ?? 0) / 100 : toBaht(row.valueSatang ?? row.amountSatang),
  };
}

/** Whether the detail's `taxBreakdown` is the engine's whole breakdown, in satang. */
function isEngineBreakdown(value: unknown): value is EngineTaxBreakdown {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EngineTaxBreakdown).netSubtotal === 'number' &&
    typeof (value as EngineTaxBreakdown).grandTotal === 'number' &&
    Array.isArray((value as EngineTaxBreakdown).categories)
  );
}

/**
 * The sale's figures as every money component renders them — `OrderTotals` —
 * and the quote that says they are the platform's.
 */
export function resumedCart(detail: ApiSaleDetail): CartQuoteState {
  const { totals } = detail.sale;
  const manualAmounts: Record<string, number> = {};
  const scannedDiscounts: OrderTotals['scannedDiscounts'] = [];
  for (const row of detail.discounts ?? []) {
    if (row.kind === 'manual') {
      manualAmounts[row.id] = toBaht(row.amountSatang);
    } else if (row.kind === 'promo' && row.code) {
      scannedDiscounts.push({
        code: row.code,
        label: row.label ?? row.code,
        type: row.discountType === 'percent' || row.discountType === 'free_item' ? row.discountType : 'fixed',
        amount: toBaht(row.amountSatang),
        ...(row.exhaustedReason ? { exhaustedReason: row.exhaustedReason } : {}),
      });
    }
  }
  const total = toBaht(totals.grossSatang);
  const taxBreakdown = isEngineBreakdown(detail.taxBreakdown)
    ? breakdownToBaht(detail.taxBreakdown)
    : {
        netSubtotal: toBaht(totals.netSatang),
        discountTotal: toBaht(totals.discountSatang),
        serviceChargeTotal: toBaht(totals.serviceChargeSatang),
        exclusiveTaxTotal: toBaht(totals.taxExclusiveSatang),
        inclusiveTaxTotal: toBaht(totals.taxInclusiveSatang),
        taxTotal: toBaht(totals.taxInclusiveSatang + totals.taxExclusiveSatang),
        categories: [],
        grandTotal: total,
      };
  const orderTotals: OrderTotals = {
    subtotal: toBaht(totals.subtotalSatang),
    discountAmount: toBaht(totals.promoDiscountSatang),
    scannedDiscounts,
    manualDiscountAmount: toBaht(totals.manualDiscountSatang),
    manualAmounts,
    serviceChargeTotal: toBaht(totals.serviceChargeSatang),
    taxTotal: toBaht(totals.taxInclusiveSatang + totals.taxExclusiveSatang),
    taxBreakdown,
    total,
  };
  const quote: CartQuote = {
    totals: orderTotals,
    satang: null,
    source: 'platform',
    pricingMode: (detail.sale.pricingMode === 'weekend' ? 'weekend' : 'weekday') as RateMode,
    pricingModeReason: detail.sale.pricingModeReason ?? '',
    engineVersion: detail.sale.engineVersion ?? 'resumed',
  };
  return { totals: orderTotals, quote, pending: false, error: null };
}

/**
 * SCRUM-889 — whether the sale settles a party: its package fee or an
 * included item is on it (`party_package` / `party_included`, written only by
 * Settle party). Such a sale is finished on the party page and never rebuilt
 * as a ticket order: its admission lines would come back as an editable Play
 * ticket, and the order panel would ask for the gross while the deposit is
 * already on it.
 */
export function isPartySettlementDetail(detail: Pick<ApiSaleDetail, 'lines'>): boolean {
  return (detail.lines ?? []).some(
    (row) => row.componentKey === PARTY_PACKAGE_COMPONENT || row.componentKey === PARTY_INCLUDED_COMPONENT,
  );
}

/**
 * SCRUM-889 — the order panel's Pay press on a resumed sale names what is
 * still to pay: the payment stage's own balance (the platform's figure, after
 * the money already taken on the sale), never the order's gross re-summed.
 * SCRUM-902 — and on a sale part-paid at its payment step, the same. Through
 * the till's one formatter (SCRUM-933): "Pay ฿15900", "Pay ฿12.50".
 */
export function resumedPayLabel(outstandingSatang: number): string {
  return `Pay ฿${satangText(outstandingSatang)}`;
}

/**
 * SCRUM-902 — WHEN THE ORDER PANEL'S PAY NAMES THE BALANCE: at the payment
 * step of a sale resumed after a reload or from Held sales (SCRUM-889), and of
 * a sale with money already taken on it on this screen — a part payment at the
 * payment step. Otherwise Pay names the order's total, as it always has.
 */
export function payNamesBalance(input: { resumed: boolean; step: number; paidOnScreenSatang: number }): boolean {
  return input.step === 5 && (input.resumed || input.paidOnScreenSatang > 0);
}

/**
 * The cart a rung-up sale was, rebuilt from the platform's read of it, or null
 * when the sale carries nothing a ticket cart is made of (an F&B or shop order,
 * which the ticket till never rang up) or is a party's settlement (SCRUM-889).
 */
export function rebuildResumedSale(detail: ApiSaleDetail, catalogue: ResumeCatalogue): ResumedCart | null {
  if (isPartySettlementDetail(detail)) return null;
  const tier = detail.sale.customerTier;
  const groups = new Map<string, ApiSaleLine[]>();
  for (const row of detail.lines ?? []) {
    if (!TICKET_KINDS.has(row.kind)) continue;
    const group = groups.get(row.cartLineId) ?? [];
    group.push(row);
    groups.set(row.cartLineId, group);
  }
  if (groups.size === 0) return null;
  const lines: CartLine[] = [];
  let supervised = false;
  for (const [cartLineId, rows] of groups) {
    const built = cartLineOf(cartLineId, rows, tier, catalogue);
    lines.push(built.line);
    supervised = supervised || built.supervised;
  }
  const discounts: Discount[] = [];
  const manualDiscounts: ManualDiscount[] = [];
  for (const row of detail.discounts ?? []) {
    if (row.kind === 'manual') manualDiscounts.push(manualDiscountOf(row));
    else if (row.kind === 'promo' && !isVoucherDiscount(row)) {
      const promo = promoOf(row, catalogue);
      if (promo) discounts.push(promo);
    }
  }
  const passLines = [eventPassService('camp').serviceId, eventPassService('event').serviceId];
  const eventPass = (detail.lines ?? []).some((row) => row.componentKey !== null && passLines.includes(row.componentKey));
  return { tier, lines, discounts, manualDiscounts, cart: resumedCart(detail), supervised, eventPass };
}
