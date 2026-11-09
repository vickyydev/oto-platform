import { formatTHB } from './money';

/**
 * SCRUM-797 — EXTRA HOUR, in the owner's words (9 November 2026):
 *
 *   "Extra Hour (300 THB): In History, scan either the kid's or the adult's
 *   wristband to open the order. Add 1 hour to a 1 or 2-hour walk-in child
 *   ticket. Use the same wristband. It's 300 THB per child, so 600 THB for two
 *   kids or more, depending on the information in the order. Can add 1 hour
 *   more or 2 or 3. Example: 3 kids with 1 hour entry want to stay 2 hours
 *   longer: 3 kids x 2 h x 300 THB = 1,800 to pay."
 *
 * One rule for the platform that charges it and the till that shows the sum
 * before the charge is made, so the two cannot differ. It replaced the flat
 * per-bracelet options (+30 minutes ฿60, +1 hour ฿100, +2 hours ฿180).
 */

/** ฿300 for one child for one hour. */
export const EXTRA_HOUR_PER_CHILD_SATANG = 30_000;

/** The ticket lengths, in hours, an extra hour is added to: "a 1 or 2-hour … child ticket". */
export const EXTRA_HOUR_TICKET_HOURS: readonly number[] = [1, 2];

export interface ExtraHourOption {
  id: string;
  label: string;
  hours: number;
  minutes: number;
  /** What ONE child pays for this option: hours × ฿300. */
  unitSatang: number;
}

/**
 * "Can add 1 hour more or 2 or 3." The ids of 1 and 2 hours are the ones the
 * per-bracelet options used, so an extension recorded before this rule still
 * names an option that exists.
 */
export const EXTRA_HOUR_OPTIONS: readonly ExtraHourOption[] = [
  { id: 'ext-60', label: '+1 hour', hours: 1, minutes: 60, unitSatang: EXTRA_HOUR_PER_CHILD_SATANG },
  { id: 'ext-120', label: '+2 hours', hours: 2, minutes: 120, unitSatang: 2 * EXTRA_HOUR_PER_CHILD_SATANG },
  { id: 'ext-180', label: '+3 hours', hours: 3, minutes: 180, unitSatang: 3 * EXTRA_HOUR_PER_CHILD_SATANG },
];

/** The ledger fields of a sale line the rule reads ("the information in the order"). */
export interface ExtraHourLine {
  id: string;
  cartLineId: string | null;
  /** The line is a ticket (it names a ticket package). */
  ticket: boolean;
  kidCount: number;
  /** The play length sold on the line, in hours; null on a line written before it was recorded. */
  stayHours: number | null;
}

export type ExtraHourRefusalCode = 'EXTENSION_NO_CHILDREN' | 'EXTENSION_TICKET_NOT_ELIGIBLE';

export type ExtraHourChildren =
  | { ok: true; children: number }
  | { ok: false; code: ExtraHourRefusalCode; message: string };

export const EXTRA_HOUR_NO_CHILDREN_MESSAGE =
  'This order has no child ticket. An extra hour is charged per child on a 1 or 2-hour child ticket.';
export const EXTRA_HOUR_NOT_ELIGIBLE_MESSAGE =
  'An extra hour is added only to a 1 or 2-hour child ticket. A Full Day pass cannot take extra hours.';

/**
 * How many children the extra hour is charged for: the children on the
 * order's 1- and 2-hour tickets. A cart line carries its participant counts and
 * its play length on every one of its rows, so each ticket cart line is read
 * once, from its first row (as `planLedgerBands` reads it). Refused when the
 * order has no child at all, or when none of its children is on a 1 or 2-hour
 * ticket (a Full Day pass).
 */
export function extraHourChildren(lines: readonly ExtraHourLine[]): ExtraHourChildren {
  const byCart = new Map<string, ExtraHourLine>();
  for (const line of lines) {
    if (!line.ticket) continue;
    const key = line.cartLineId ?? line.id;
    if (!byCart.has(key)) byCart.set(key, line);
  }
  let kids = 0;
  let children = 0;
  for (const first of byCart.values()) {
    const count = Math.max(0, first.kidCount);
    kids += count;
    if (isExtraHourLine(first)) children += count;
  }
  if (kids === 0) return { ok: false, code: 'EXTENSION_NO_CHILDREN', message: EXTRA_HOUR_NO_CHILDREN_MESSAGE };
  if (children === 0) {
    return { ok: false, code: 'EXTENSION_TICKET_NOT_ELIGIBLE', message: EXTRA_HOUR_NOT_ELIGIBLE_MESSAGE };
  }
  return { ok: true, children };
}

/** A ticket line sold on 1 or 2 hours of play: the ticket an extra hour is added to. */
export function isExtraHourLine(line: Pick<ExtraHourLine, 'ticket' | 'stayHours'>): boolean {
  return line.ticket && line.stayHours !== null && EXTRA_HOUR_TICKET_HOURS.includes(line.stayHours);
}

/** A band as the rule reads it: whose it is and the ticket row it was issued against. */
export interface ExtraHourBand {
  id: string;
  kind: string;
  saleLineId: string | null;
}

/**
 * The children's bracelets the extra hour is charged for: each kid band issued
 * on one of the order's 1- or 2-hour ticket lines. The charge covers every
 * child on those tickets ("depending on the information in the order"), so
 * each of these bracelets carries the added time and the till keeps them
 * ticked; an adult's bracelet, or a Full Day child's, stays the staff's
 * choice. Whether an extra hour can be bought for only some of an order's
 * children is put to the owner.
 */
export function extraHourChildBandIds(
  lines: readonly ExtraHourLine[],
  bands: readonly ExtraHourBand[],
): string[] {
  const onTicket = new Set(lines.filter(isExtraHourLine).map((line) => line.id));
  return bands
    .filter((band) => band.kind === 'kid' && band.saleLineId !== null && onTicket.has(band.saleLineId))
    .map((band) => band.id);
}

/** hours × children × ฿300, in satang: 3 children for 2 hours is 180,000 (฿1,800). */
export function extraHourAmountSatang(
  hours: number,
  children: number,
  perChildHourSatang: number = EXTRA_HOUR_PER_CHILD_SATANG,
): number {
  return hours * children * perChildHourSatang;
}

/** The add-on line's label on the charge and its receipt: "Extra hour x 2". */
export function extraHourLineLabel(hours: number): string {
  return `Extra hour x ${hours}`;
}

/** "3 children x 2 hours x ฿300" — the sum's factors, as the till shows them beside an option. */
export function extraHourFactors(
  children: number,
  hours: number,
  perChildHourSatang: number = EXTRA_HOUR_PER_CHILD_SATANG,
): string {
  const kids = `${children} ${children === 1 ? 'child' : 'children'}`;
  const time = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${kids} x ${time} x ${formatTHB(perChildHourSatang)}`;
}

/** "3 children x 2 hours x ฿300 = ฿1,800" — the whole sum, shown before the charge is made. */
export function extraHourSum(
  children: number,
  hours: number,
  perChildHourSatang: number = EXTRA_HOUR_PER_CHILD_SATANG,
): string {
  const total = extraHourAmountSatang(hours, children, perChildHourSatang);
  return `${extraHourFactors(children, hours, perChildHourSatang)} = ${formatTHB(total)}`;
}
