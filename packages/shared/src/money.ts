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

/** "฿1,090" for whole baht; "฿1,090.50" otherwise (prototype shows whole ฿). */
export function formatTHB(satang: Satang): string {
  const baht = satang / 100;
  const whole = Number.isInteger(baht);
  return `฿${baht.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
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
