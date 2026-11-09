import { PartyPlanSchema, type PartyPlan, type PartyPlanStatus } from '@oto/shared';
import { getEventPackage, type SeamEventPackage } from './otoapp-events';
import type { Exec } from './tx';

/**
 * SCRUM-804 — THE PARTY'S PLAN, as the OTO App publishes it (birthday plan §2,
 * §3 and §4; the data contract of SCRUM-803).
 *
 * Plan in the OTO App, execute in the POS: staff plan every party in the BEO
 * (the package, the counts, the menu, the food times, the entertainment, the
 * add-ons) and the app publishes that plan in `otoapp_v.event_packages`. This
 * reads it through the seam repository (`otoapp-events.ts`, the one file that
 * names `otoapp_v`) and puts it in the platform's words: the party page shows
 * it read-only, and the settlement (`party-settlement.ts`) prices from it.
 * Money passes through in satang, as the view gives it.
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
/** "HH:MM" from a time the view gives as "HH:MM:SS". */
const clock = (v: unknown): string | null => {
  const t = text(v);
  return t && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t;
};

/** Each line's own id: its template's, unless two lines share one; else its place. */
function idsOf(rows: Json[], prefix: string): string[] {
  const templates = rows.map((r) => text(r.template_id));
  return templates.map((t, i) =>
    t && templates.filter((other) => other === t).length === 1 ? t : `${prefix}-${i + 1}`,
  );
}

/**
 * A row of `otoapp_v.event_packages` in the platform's words, or null when it
 * names no package at all. Read defensively, as every seam read is: the view
 * passes the app's jsonb through, and one bad field must not lose the party.
 * Money passes through as the view gives it, in satang.
 */
export function partyPlanOfRow(row: SeamEventPackage): PartyPlan | null {
  const pkg = rec(row.package);
  if (!pkg || !text(pkg.name) || !row.partyDate) return null;
  const counts = rec(row.counts) ?? {};
  const settlement = rec(row.settlement) ?? {};
  const kitchen = rec(row.kitchen);
  const addOnRows = list(row.addOns).map(rec).filter((r): r is Json => r !== null);
  const showRows = list(row.entertainment).map(rec).filter((r): r is Json => r !== null);
  const addOnIds = idsOf(addOnRows, 'add-on');
  const showIds = idsOf(showRows, 'entertainment');
  const maybe = (v: unknown): number | null => {
    const n = whole(v);
    return n === null ? null : Math.max(0, n);
  };
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
    setMenu: list(row.setMenu)
      .map(rec)
      .filter((r): r is Json => r !== null)
      .map((m) => ({
        productCode: text(m.product_code),
        name: text(m.name) ?? '',
        qty: nonNegative(m.qty),
        choiceGroup: text(m.choice_group),
        chosenOption: text(m.chosen_option),
        note: text(m.note),
      })),
    barItems: list(row.barItems)
      .map(rec)
      .filter((r): r is Json => r !== null)
      .map((b) => ({ productCode: text(b.product_code), name: text(b.name) ?? '', qty: nonNegative(b.qty) })),
    kitchen: kitchen
      ? {
          kidsFoodTime: clock(kitchen.kids_food_time),
          adultsFoodTime: clock(kitchen.adults_food_time),
          readyOffsetMinutes: whole(kitchen.ready_offset_minutes),
          slipsTime: clock(kitchen.slips_time) ?? '11:00',
        }
      : null,
    settlement: { depositSatang: nonNegative(settlement.deposit_satang), posSaleId: text(settlement.pos_sale_id) },
  };
  const parsed = PartyPlanSchema.safeParse(plan);
  return parsed.success ? parsed.data : null;
}

/** The party's plan and why it has none, read through the seam. */
export async function readPartyPlan(
  db: Exec,
  q: { branchId: string; eventId: string },
): Promise<{ plan: PartyPlan | null; status: PartyPlanStatus }> {
  const { seam, row } = await getEventPackage(db, q);
  if (seam === 'missing') return { plan: null, status: 'seam_missing' };
  if (seam === 'not_granted') return { plan: null, status: 'seam_not_granted' };
  const plan = row ? partyPlanOfRow(row) : null;
  return { plan, status: plan ? 'ready' : 'no_package' };
}

