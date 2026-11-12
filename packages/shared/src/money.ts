/**
 * Money (CLAUDE.md §3): integers in satang (minor units of THB). Never floats
 * in storage or arithmetic. The prototype displays whole-baht figures with a
 * `฿` prefix and `toLocaleString` grouping — `formatTHB` reproduces that.
 */

/** Whole satang. 100 satang = ฿1. */
export type Satang = number;

export function satangFromBaht(baht: number): Satang {
  return Math.round(baht * 100);
}

export function bahtFromSatang(satang: Satang): number {
  return satang / 100;
}

/**
 * SCRUM-933 — AN AMOUNT AS THE TILL WRITES IT, from satang, without the sign.
 *
 * Whole baht is the bare figure the prototype prints (`฿{total}`, "1605"); an
 * amount with satang is written to two places ("1444.50"), the way the
 * prototype writes one (`toFixed(2)`, its tax panel and reports) — never
 * rounded to the baht and never cut to one place ("1444.5"). `grouped` adds
 * the thousands separator for the screens that already group a figure
 * ("1,605", "1,444.50"); `formatTHB` is the grouped figure with its sign. One
 * rule for every staff screen, so a sale reads the same money everywhere.
 */
export function formatBahtAmount(satang: Satang, opts: { grouped?: boolean } = {}): string {
  const whole = satang % 100 === 0;
  const baht = satang / 100;
  if (!opts.grouped) return whole ? String(baht) : baht.toFixed(2);
  return baht.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** "฿1,090" for whole baht; "฿1,090.50" otherwise (prototype shows whole ฿). */
export function formatTHB(satang: Satang): string {
  return `฿${formatBahtAmount(satang, { grouped: true })}`;
}

/** A price that varies weekday vs weekend — the prototype's WeekdayWeekendPrice, in satang. */
export interface WWPrice {
  weekday: Satang;
  weekend: Satang;
}

export const wwp = (weekday: Satang, weekend: Satang = weekday): WWPrice => ({ weekday, weekend });

/**
 * Admin list display, ported from prototype `pricingMode.ts:formatWWPrice`:
 * one figure when both match, else "฿100 / ฿150 wknd".
 */
export function formatWWPrice(price: WWPrice | undefined): string {
  if (!price) return '฿0';
  if (price.weekday === price.weekend) return formatTHB(price.weekday);
  return `${formatTHB(price.weekday)} / ${formatTHB(price.weekend)} wknd`;
}
