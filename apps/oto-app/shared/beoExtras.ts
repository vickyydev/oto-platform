import { sameKitchenDish } from "./kitchenAdults";

/**
 * AN EXTRA LINE OF THE BEO'S KITCHEN AND BAR PLAN AND WHAT THE TILL CHARGES
 * FOR IT (SCRUM-949), as the BEO editor shows it beside the line's price box
 * and in the plan's extras total.
 *
 * The owner's decision of 12 November ("Not 0 baht, charge it according to
 * the right entered price"; "its price per item"), as the platform's party
 * settlement applies it (apps/api/src/services/party-settlement.ts,
 * `partyExtraChargesOf` and `partyMenuChargesOf`, over the plan the till
 * reads, app migration 0050 and apps/api/src/services/party-plan.ts) — this
 * file mirrors that arithmetic and changes none of it:
 *
 *   - a line the BEO badges SET is part of the package: not charged;
 *   - an EXTRA line (any line not SET, a line from before the badge too) is
 *     charged at the price entered on it for each item, times its count; a
 *     price of 0 is no price;
 *   - with no price entered, a line whose till code a live item of the till
 *     carries is charged at the till's price for the party's day (the
 *     weekend price on a Saturday or a Sunday; the till's branch holidays
 *     are not known here), times its count;
 *   - a line with neither (typed by hand, or a code the till no longer has)
 *     is not charged: it prints for the kitchen, no price is invented;
 *   - an item made from the BEO for this party (a PARTY- code) on the food
 *     lists is charged at the till's own price for it, whatever the line
 *     shows; on the bar plan the settlement charges it nowhere;
 *   - the adults' list counts only while "Different for adults" is on, and
 *     an adults' line that is the same dish as a kids' line (name, count and
 *     code) is charged once, on the kids' line;
 *   - a line with no name never reaches the till.
 *
 * With the till's menu not read, a coded line with no price entered cannot
 * be priced here: it is "unknown", and the total is not shown (nothing
 * rather than a wrong figure). Money is satang; a BEO line holds baht.
 */

/** A kitchen or bar plan line, as the editor holds it (only these fields matter here). */
export interface BeoExtraLine {
  itemName: string;
  quantity: number;
  /** Baht for each item, as entered on the line; 0 or none is no price. */
  price?: number | null;
  source?: string | null;
  productCode?: string | null;
}

/** The till's item a code names, as the till's menu answers it (satang). */
export interface BeoExtraTillItem {
  priceSatang: number;
  priceWeekendSatang: number;
}

export interface BeoExtraContext {
  /** The till's menu as read: whether it was read at all, and its items by code. */
  till: { known: boolean; byCode: ReadonlyMap<string, BeoExtraTillItem> };
  /** The party's date (YYYY-MM-DD), for the till's weekend price; null when not set. */
  partyDate: string | null;
}

export type BeoExtraCharge =
  | { kind: "charged"; unitSatang: number; quantity: number; totalSatang: number; from: "entered" | "till" | "party_item"; weekend: boolean }
  | { kind: "set" }
  | { kind: "not_charged"; why: "no_price" | "not_on_till" | "party_item_on_bar" }
  | { kind: "with_kids" }
  | { kind: "unknown" }
  | { kind: "unnamed" };

/** An item made from the BEO for one party (the platform's `isPartyMenuCode`). */
const PARTY_CODE = /^PARTY-(?:[0-9A-F]{8}|[0-9A-F]{12})$/;
export const isPartyItemCode = (code: string | null | undefined): boolean => typeof code === "string" && PARTY_CODE.test(code.trim());

/** Whether the party's date is a Saturday or a Sunday (the till's weekend price). */
export function isWeekendDate(date: string | null | undefined): boolean {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  if (!m) return false;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return day === 0 || day === 6;
}

/** The line's count as the till reads it: a whole number from 1, else 1. */
const countOf = (q: unknown): number => (typeof q === "number" && Number.isFinite(q) && Math.round(q) >= 1 && Math.round(q) <= 999_999 ? Math.round(q) : 1);
/** The price entered on the line, in satang; null for none (0 is none). */
const enteredOf = (p: unknown): number | null => (typeof p === "number" && Number.isFinite(p) && p > 0 ? Math.round(p * 100) : null);

/** What the till charges for one line of the kitchen's food lists ("food") or the bar plan ("bar"). */
export function beoExtraChargeOf(line: BeoExtraLine, area: "food" | "bar", ctx: BeoExtraContext): BeoExtraCharge {
  if (!line.itemName?.trim()) return { kind: "unnamed" };
  const quantity = countOf(line.quantity);
  const code = typeof line.productCode === "string" && line.productCode.trim() ? line.productCode.trim() : null;
  const weekend = isWeekendDate(ctx.partyDate);
  const tillPrice = (item: BeoExtraTillItem) => (weekend ? item.priceWeekendSatang : item.priceSatang);
  if (code && isPartyItemCode(code)) {
    if (area === "bar") return line.source === "set_menu" ? { kind: "set" } : { kind: "not_charged", why: "party_item_on_bar" };
    // The food lists' party item: the till's own price for it, whatever the badge or the line shows.
    if (!ctx.till.known) return { kind: "unknown" };
    const item = ctx.till.byCode.get(code);
    if (!item) return { kind: "not_charged", why: "not_on_till" };
    const unit = tillPrice(item);
    return { kind: "charged", unitSatang: unit, quantity, totalSatang: unit * quantity, from: "party_item", weekend };
  }
  if (line.source === "set_menu") return { kind: "set" };
  const entered = enteredOf(line.price);
  if (entered !== null) return { kind: "charged", unitSatang: entered, quantity, totalSatang: entered * quantity, from: "entered", weekend };
  if (!code) return { kind: "not_charged", why: "no_price" };
  if (!ctx.till.known) return { kind: "unknown" };
  const item = ctx.till.byCode.get(code);
  if (!item) return { kind: "not_charged", why: "not_on_till" };
  const unit = tillPrice(item);
  return { kind: "charged", unitSatang: unit, quantity, totalSatang: unit * quantity, from: "till", weekend };
}

/** A line as the kitchen's lists compare it (`sameKitchenDish`: name, count and code). */
const asKitchenLine = (l: BeoExtraLine) => ({ itemName: l.itemName, quantity: l.quantity, productCode: l.productCode ?? undefined });

/**
 * Each line's charge on the kitchen's two lists: the kids' as they are; the
 * adults' only while their list is their own, a line that is the same dish
 * as a kids' line being charged with it (`with_kids`).
 */
export function beoKitchenChargesOf(
  kids: readonly BeoExtraLine[],
  adults: readonly BeoExtraLine[],
  adultsDiffer: boolean,
  ctx: BeoExtraContext,
): { kids: BeoExtraCharge[]; adults: BeoExtraCharge[] } {
  return {
    kids: kids.map((l) => beoExtraChargeOf(l, "food", ctx)),
    adults: adultsDiffer
      ? adults.map((l) => (kids.some((k) => sameKitchenDish(asKitchenLine(k), asKitchenLine(l))) ? { kind: "with_kids" as const } : beoExtraChargeOf(l, "food", ctx)))
      : [],
  };
}

/** What a set of charges comes to, in satang; null when one cannot be priced here (the till's menu not read). */
export function beoExtrasTotalOf(charges: readonly BeoExtraCharge[]): number | null {
  let sum = 0;
  for (const c of charges) {
    if (c.kind === "unknown") return null;
    if (c.kind === "charged") sum += c.totalSatang;
  }
  return sum;
}

/** Whether a set of charges holds an EXTRA line at all (a total is shown only then). */
export const hasExtraLines = (charges: readonly BeoExtraCharge[]): boolean =>
  charges.some((c) => c.kind === "charged" || c.kind === "not_charged" || c.kind === "unknown");

const baht = (satang: number) => (Math.round(satang) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The words beside an EXTRA line's price box: what the till will charge for
 * it. Nothing for a SET line, a line with no name, or a coded line the till's
 * menu could not price (nothing rather than a wrong figure).
 */
export function beoExtraHintOf(charge: BeoExtraCharge): string | null {
  switch (charge.kind) {
    case "charged":
      if (charge.from === "entered") return "each";
      return `till price ${baht(charge.unitSatang)}${charge.weekend ? " (weekend)" : ""}${charge.from === "party_item" ? " (made for this party)" : ""}`;
    case "not_charged":
      return "not charged";
    case "with_kids":
      return "charged once, with the kids' line";
    default:
      return null;
  }
}

/**
 * SCRUM-970: the words the BEO PDF prints beside an EXTRA line's badge — the
 * editor's own hint for it (`beoExtraHintOf`), so the two cannot disagree: the
 * price entered, written out for each item ("120฿ each"); "till price 420",
 * "(weekend)" as the editor shows it; "not charged". Nothing for a coded line
 * the till's menu could not price (the PDF then prints the badge alone, as
 * before), a SET line or a line with no name.
 */
export function beoExtraPrintWordsOf(charge: BeoExtraCharge): string | null {
  if (charge.kind === "charged" && charge.from === "entered") return `${baht(charge.unitSatang)}฿ each`;
  return beoExtraHintOf(charge);
}

/** A kitchen line as the BEO PDF reads it (only these fields matter here). */
export interface BeoPrintLine {
  itemName?: string;
  quantity?: number;
  notes?: string;
  price?: number | null;
  source?: string | null;
  productCode?: string | null;
}

/**
 * SCRUM-978: the words the BEO PDF prints in a food line's price cell: "SET"
 * for a set-menu line; for an EXTRA its badge and what the till charges for
 * it (`beoExtraPrintWordsOf`): "EXTRA 400฿ each", "EXTRA till price 450",
 * "EXTRA not charged", or the badge alone when it cannot be priced here.
 */
export function beoFoodPrintWordsOf(line: BeoPrintLine, ctx: BeoExtraContext): string {
  if (line.source === "set_menu") return "SET";
  const words = beoExtraPrintWordsOf(
    beoExtraChargeOf(
      { itemName: line.itemName ?? "", quantity: line.quantity ?? 1, price: line.price ?? null, source: line.source ?? null, productCode: line.productCode ?? null },
      "food",
      ctx,
    ),
  );
  return words ? `EXTRA ${words}` : "EXTRA";
}

/**
 * SCRUM-978 (the read-fix lane's staging proof: kids Margherita 3 at 400 and
 * adults 2 at 450 printed as ONE row, "3x Margherita — kids 3 · adults 2
 * EXTRA 400฿ each", while the editor shows each list's own price and the till
 * charges 3 × 400 + 2 × 450): whether the PDF may fold an adults' line into the
 * kids' row of the same name, beside its "kids N · adults M" or "adults:
 * <note>" mark. Only when what the row prints beside the mark holds for both:
 * the same kind of line at the same price each (`beoFoodPrintWordsOf`), or the
 * one dish the till charges once with the kids' line (`sameKitchenDish`: name,
 * count and code, the editor's "charged once, with the kids' line"). Any other
 * adults' line prints as its own row, with its own count and price.
 */
export function beoPrintFoldable(ctx: BeoExtraContext): (kids: BeoPrintLine, adults: BeoPrintLine) => boolean {
  return (kids, adults) =>
    sameKitchenDish(
      { itemName: kids.itemName, quantity: kids.quantity, productCode: kids.productCode ?? undefined },
      { itemName: adults.itemName, quantity: adults.quantity, productCode: adults.productCode ?? undefined },
    ) || beoFoodPrintWordsOf(kids, ctx) === beoFoodPrintWordsOf(adults, ctx);
}

/** The plan's extras total, as the till will charge them: "Extras charged at the till: ฿1,180". */
export const beoExtrasTotalWords = (satang: number): string => `Extras charged at the till: ฿${baht(satang)}`;
