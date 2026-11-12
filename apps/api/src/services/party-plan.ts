import { and, eq, inArray, isNull } from 'drizzle-orm';
import { product } from '@oto/db';
import {
  PARTY_PLAN_LINE_QTY_MAX,
  PartyKitchenPlanSchema,
  PartyPlanSchema,
  isPartyMenuCode,
  type PartyKitchenPlan,
  type PartyMenuOrigin,
  type PartyPlan,
  type PartyPlanBarItem,
  type PartyPlanCake,
  type PartyPlanMenuItem,
  type PartyPlanStatus,
} from '@oto/shared';
import { getEventPackage, type SeamEventPackage } from './otoapp-events';
import type { Exec } from './tx';

/**
 * SCRUM-804 — THE PARTY'S PLAN, as the OTO App publishes it (birthday plan §2,
 * §3 and §4; the data contract of SCRUM-803).
 *
 * Plan in the OTO App, execute in the POS: staff plan every party in the BEO
 * (the package, the counts, the menu, the food times, the entertainment, the
 * add-ons) and the app publishes that plan through the events seam (its event
 * packages view). This reads it through the seam repository (`otoapp-events.ts`,
 * the one events file that names the app's views) and puts it in the platform's
 * words: the party page shows
 * it read-only, and the settlement (`party-settlement.ts`) prices from it.
 * Money passes through in satang, as the view gives it.
 *
 * SCRUM-906 — THE WHOLE KITCHEN PLAN (the owner's decisions of 12 November).
 * Where the view publishes it (app migration 0050's `kitchen_plan`), the plan's
 * menu is every line of the BEO's kitchen plan — coded or typed by hand, the
 * staff's latest set-menu choice, each line's badge and entered price — with
 * the cake and the bar's lines with their own codes; a view without it gives
 * the menu as before. A party with a kitchen plan and no package has a
 * KITCHEN PLAN (`PartyKitchenPlan`) and no plan: the party page shows it and
 * its slips print, and settling it still needs a package (decision 8).
 */

type Json = Record<string, unknown>;

const rec = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
/** A whole number from the app's jsonb: a number, or a string of one (a bigint passed through). */
const whole = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};
const nonNegative = (v: unknown, fallback = 0): number => Math.max(0, whole(v) ?? fallback);
const maybe = (v: unknown): number | null => {
  const n = whole(v);
  return n === null ? null : Math.max(0, n);
};
/**
 * SCRUM-906: a kitchen-plan line's quantity, held to the bound the view reads
 * one with (`PARTY_PLAN_LINE_QTY_MAX`), so one line can never fail the plan.
 */
const lineQty = (n: number): number => Math.min(n, PARTY_PLAN_LINE_QTY_MAX);
/** "HH:MM" from a time the view gives as "HH:MM:SS". */
const clock = (v: unknown): string | null => {
  const t = text(v);
  return t && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t;
};
/** A price entered on a BEO line, in satang: a positive amount the plan's money may hold, else none. */
const enteredPrice = (v: unknown): number | null => {
  const n = whole(v);
  return n !== null && n > 0 && n <= 10_000_000_000 ? n : null;
};

/** Each line's own id: its template's, unless two lines share one; else its place. */
function idsOf(rows: Json[], prefix: string): string[] {
  const templates = rows.map((r) => text(r.template_id));
  return templates.map((t, i) =>
    t && templates.filter((other) => other === t).length === 1 ? t : `${prefix}-${i + 1}`,
  );
}

/** Which shape the row's menu was published in: the whole kitchen plan (0050), or the set menu of before. */
export type PartyPlanSource = 'kitchen_plan_1' | 'legacy';

/** The view's whole kitchen plan, when it publishes one. */
const kitchenPlanOf = (row: SeamEventPackage): Json | null => {
  const kp = rec(row.kitchenPlan);
  return kp && whole(kp.version) === 1 ? kp : null;
};

export const partyPlanSourceOf = (row: SeamEventPackage): PartyPlanSource =>
  kitchenPlanOf(row) ? 'kitchen_plan_1' : 'legacy';

/** Where a line came from: an item made for the party alone, the set menu (SET), or an extra. */
function originOf(code: string | null, source: unknown): PartyMenuOrigin {
  if (isPartyMenuCode(code)) return 'party_only';
  return source === 'set_menu' ? 'set_menu' : 'extra';
}

/** One food line in the platform's words; the whole kitchen plan's lines carry where they came from. */
function menuItemOf(m: Json, whole906: boolean): PartyPlanMenuItem {
  const productCode = text(m.product_code);
  const price = whole906 ? enteredPrice(m.unit_price_satang) : null;
  const lineId = whole906 ? text(m.line_id) : null;
  const qty = maybe(m.qty);
  return {
    productCode,
    name: text(m.name) ?? '',
    qty: qty === null ? null : lineQty(qty),
    choiceGroup: text(m.choice_group),
    chosenOption: text(m.chosen_option),
    note: text(m.note),
    // SCRUM-829: only where the view marks a line; a plan from before carries none.
    ...(m.audience === 'kids' || m.audience === 'adults' ? { audience: m.audience } : {}),
    ...(typeof m.adults_note === 'string' ? { adultsNote: m.adults_note } : {}),
    ...(whole906
      ? {
          ...(lineId ? { lineId } : {}),
          origin: originOf(productCode, m.source),
          ...(price === null ? {} : { unitPriceSatang: price }),
        }
      : {}),
  };
}

/** One bar line in the platform's words. */
function barItemOf(b: Json, whole906: boolean): PartyPlanBarItem {
  const productCode = text(b.product_code);
  const price = whole906 ? enteredPrice(b.unit_price_satang) : null;
  const lineId = whole906 ? text(b.line_id) : null;
  return {
    productCode,
    name: text(b.name) ?? '',
    qty: lineQty(nonNegative(b.qty)),
    ...(whole906
      ? {
          note: text(b.note),
          ...(lineId ? { lineId } : {}),
          origin: originOf(productCode, b.source),
          ...(price === null ? {} : { unitPriceSatang: price }),
        }
      : {}),
  };
}

/** The cake as the BEO's cake choice says it: the park's or the family's; null for no cake. */
function cakeOf(v: unknown): PartyPlanCake | null {
  const c = rec(v);
  if (!c) return null;
  const type = c.mode === 'INTERNAL' ? 'our' : c.mode === 'EXTERNAL' ? 'own' : null;
  if (!type) return null;
  const qty = whole(c.qty);
  return { type, qty: qty !== null && qty > 0 ? lineQty(qty) : 1, time: clock(c.time), note: text(c.notes) };
}

/** The menu, the bar, the cake and the times of a row, from the whole kitchen plan when the view gives it. */
function kitchenPartsOf(row: SeamEventPackage): Pick<PartyKitchenPlan, 'setMenu' | 'barItems' | 'kitchen' | 'cake'> {
  const kp = kitchenPlanOf(row);
  const kitchen = rec(row.kitchen);
  const records = (v: unknown) => list(v).map(rec).filter((r): r is Json => r !== null);
  if (!kp) {
    return {
      setMenu: records(row.setMenu).map((m) => menuItemOf(m, false)),
      barItems: records(row.barItems).map((b) => barItemOf(b, false)),
      kitchen: kitchen
        ? {
            kidsFoodTime: clock(kitchen.kids_food_time),
            adultsFoodTime: clock(kitchen.adults_food_time),
            readyOffsetMinutes: whole(kitchen.ready_offset_minutes),
            slipsTime: clock(kitchen.slips_time) ?? '11:00',
          }
        : null,
    };
  }
  return {
    setMenu: records(kp.lines).map((m) => menuItemOf(m, true)),
    barItems: records(kp.bar_lines).map((b) => barItemOf(b, true)),
    kitchen: kitchen
      ? {
          kidsFoodTime: clock(kitchen.kids_food_time),
          adultsFoodTime: clock(kitchen.adults_food_time),
          readyOffsetMinutes: whole(kitchen.ready_offset_minutes),
          slipsTime: clock(kitchen.slips_time) ?? '11:00',
          barServiceTime: clock(kp.bar_service_time),
        }
      : null,
    cake: cakeOf(kp.cake),
  };
}

/**
 * A row of the app's event packages view (read in `otoapp-events.ts`) in the platform's words, or null when it
 * names no package at all. Read defensively, as every seam read is: the view
 * passes the app's jsonb through, and one bad field must not lose the party.
 * Money passes through as the view gives it, in satang.
 */
export function partyPlanOfRow(row: SeamEventPackage): PartyPlan | null {
  const pkg = rec(row.package);
  if (!pkg || !text(pkg.name) || !row.partyDate) return null;
  const counts = rec(row.counts) ?? {};
  const settlement = rec(row.settlement) ?? {};
  const addOnRows = list(row.addOns).map(rec).filter((r): r is Json => r !== null);
  const showRows = list(row.entertainment).map(rec).filter((r): r is Json => r !== null);
  const addOnIds = idsOf(addOnRows, 'add-on');
  const showIds = idsOf(showRows, 'entertainment');
  const plan: PartyPlan = {
    eventId: row.eventId,
    partyDate: row.partyDate,
    startTime: clock(row.startTime),
    endTime: clock(row.endTime),
    package: {
      templateId: text(pkg.template_id),
      name: text(pkg.name)!,
      hours: maybe(pkg.hours),
      kidsIncluded: nonNegative(pkg.kids_included),
      adultsIncluded: nonNegative(pkg.adults_included),
      socksIncluded: Math.max(-1, whole(pkg.socks_included) ?? 0),
      priceWeekdaySatang: nonNegative(pkg.price_weekday_satang),
      priceWeekendSatang: nonNegative(pkg.price_weekend_satang),
      extraChildWeekdaySatang: maybe(pkg.extra_child_weekday_satang),
      extraChildWeekendSatang: maybe(pkg.extra_child_weekend_satang),
      extraAdultWeekdaySatang: maybe(pkg.extra_adult_weekday_satang),
      extraAdultWeekendSatang: maybe(pkg.extra_adult_weekend_satang),
      includedLines: list(pkg.included_lines)
        .map((l) => text(rec(l)?.label ?? l))
        .filter((l): l is string => l !== null)
        .map((label) => ({ label })),
    },
    counts: { kidsExpected: maybe(counts.kids_expected), adultsExpected: maybe(counts.adults_expected) },
    addOns: addOnRows.map((a, i) => ({
      id: addOnIds[i]!,
      templateId: text(a.template_id),
      name: text(a.name) ?? 'Add-on',
      qty: whole(a.qty) === null ? 1 : nonNegative(a.qty),
      unitPriceSatang: nonNegative(a.unit_price_satang),
      fnbCreditSatang: nonNegative(a.fnb_credit_satang),
      printsVoucher: a.prints_voucher === true,
    })),
    entertainment: showRows.map((e, i) => ({
      id: showIds[i]!,
      templateId: text(e.template_id),
      name: text(e.name) ?? 'Entertainment',
      category: text(e.category),
      durationMinutes: maybe(e.duration_minutes),
      ageRange: text(e.age_range),
      maxKids: maybe(e.max_kids),
      priceSatang: nonNegative(e.price_satang),
      extraChildren: nonNegative(e.extra_children),
      extraChildPriceSatang: maybe(e.extra_child_price_satang),
    })),
    ...kitchenPartsOf(row),
    settlement: { depositSatang: nonNegative(settlement.deposit_satang), posSaleId: text(settlement.pos_sale_id) },
  };
  const parsed = PartyPlanSchema.safeParse(plan);
  return parsed.success ? parsed.data : null;
}

/**
 * SCRUM-906 — a row's KITCHEN PLAN, with or without a package (the owner's
 * decision 8): the plan's own when the party has a package, else what the
 * kitchen plan holds; null when the party has no package and its kitchen plan
 * holds nothing to make (no line, no bar line, no cake).
 */
export function partyKitchenOfRow(
  row: SeamEventPackage,
  plan: PartyPlan | null = partyPlanOfRow(row),
): PartyKitchenPlan | null {
  if (!row.partyDate) return null;
  const counts = rec(row.counts) ?? {};
  const parts = plan
    ? {
        setMenu: plan.setMenu,
        barItems: plan.barItems,
        kitchen: plan.kitchen,
        ...(plan.cake === undefined ? {} : { cake: plan.cake }),
      }
    : kitchenPartsOf(row);
  if (!plan && parts.setMenu.length === 0 && parts.barItems.length === 0 && !parts.cake) return null;
  const kitchen: PartyKitchenPlan = {
    eventId: row.eventId,
    partyDate: row.partyDate,
    startTime: clock(row.startTime),
    endTime: clock(row.endTime),
    counts: plan?.counts ?? { kidsExpected: maybe(counts.kids_expected), adultsExpected: maybe(counts.adults_expected) },
    ...parts,
  };
  const parsed = PartyKitchenPlanSchema.safeParse(kitchen);
  return parsed.success ? parsed.data : null;
}

export interface PartyPlanRead {
  /** The plan with its package: what a settlement prices. */
  plan: PartyPlan | null;
  /** SCRUM-906: the kitchen plan, with or without a package: what the page shows and the slips print. */
  kitchen: PartyKitchenPlan | null;
  status: PartyPlanStatus;
  /** The shape the OTO App published the menu in (the slips' composer epoch reads it, SCRUM-906). */
  source: PartyPlanSource;
}

/** The party's plan and why it has none, read through the seam. */
export async function readPartyPlan(db: Exec, q: { branchId: string; eventId: string }): Promise<PartyPlanRead> {
  const { seam, row } = await getEventPackage(db, q);
  if (seam === 'missing') return { plan: null, kitchen: null, status: 'seam_missing', source: 'legacy' };
  if (seam === 'not_granted') return { plan: null, kitchen: null, status: 'seam_not_granted', source: 'legacy' };
  const plan = row ? partyPlanOfRow(row) : null;
  const kitchen = row ? partyKitchenOfRow(row, plan) : null;
  return { plan, kitchen, status: plan ? 'ready' : 'no_package', source: row ? partyPlanSourceOf(row) : 'legacy' };
}

/**
 * SCRUM-906 — "not on the till menu" (the owner's decision 1): each line marked
 * with whether a live till product of the operator carries its code, the
 * lookup the slips make for a line's station (`party-slips.ts`). A line typed
 * by hand, or one whose code the till no longer sells, is not on the till menu.
 */
export async function markTillMenu<K extends Pick<PartyKitchenPlan, 'setMenu' | 'barItems'>>(
  db: Exec,
  operatorId: string,
  kitchen: K,
): Promise<K> {
  const codes = [
    ...new Set([...kitchen.setMenu, ...kitchen.barItems].map((l) => l.productCode).filter((c): c is string => !!c)),
  ];
  const rows =
    codes.length === 0
      ? []
      : await db
          .select({ code: product.code })
          .from(product)
          .where(and(eq(product.operatorId, operatorId), inArray(product.code, codes), isNull(product.archivedAt)));
  const live = new Set(rows.map((r) => r.code));
  const on = (code: string | null) => !!code && live.has(code);
  return {
    ...kitchen,
    setMenu: kitchen.setMenu.map((m) => ({ ...m, onTillMenu: on(m.productCode) })),
    barItems: kitchen.barItems.map((b) => ({ ...b, onTillMenu: on(b.productCode) })),
  };
}
