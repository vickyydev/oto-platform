import { approvedBeoBillingSources } from "./beoBillingSource";
import { beoQuantityOf } from "./beoQuantity";
import { adultsDifferOf } from "./kitchenAdults";

/**
 * A BILLED AND PAID BEO ITEM STAYS (SCRUM-1002, the owner's ruling 3 of
 * 18 November 2026: "Refuse both: a paid item stays").
 *
 * Once a party is settled, a kitchen or bar line of its BEO is billed on the
 * main receipt, and a line added or raised later on an additional bill. The
 * till says how many of each line it has billed and how many of those are
 * paid (`beoLines` of `GET /otoapp/parties/:eventId/billing`): the main
 * receipt's count once it is settled, plus every paid additional bill's. A
 * Save may not take such a line below its paid count, nor delete it: the line
 * stays as stored and the rest of the Save is written. A line billed on an
 * additional bill that is still open is not paid, and is left as it was.
 *
 * Only the lines the additional bill counts are held (shared/beoBillingSource.ts:
 * staff-approved extras, never a set-menu dish or the adults' copy of a kids'
 * line), and not one included in the package (it is billed at nothing). The
 * editor answers the same rule on the screen (beo-event-editor.tsx); the BEO's
 * Save and the day-of view's kitchen plan write enforce it (beo-routes.ts), so
 * a client that skips the screen is refused too.
 */

export const BEO_PAID_LINE_REFUSAL = "Already billed and paid: this item cannot be reduced or removed.";

export type BeoPaidLineList = "kids" | "adults" | "bar";

/** A line a Save tried to take below its paid count, kept as stored. */
export interface BeoPaidLineKept {
  id: string;
  itemName: string;
  list: BeoPaidLineList;
  paidQuantity: number;
}

type Line = Record<string, unknown>;
const record = (value: unknown): Line => (value && typeof value === "object" && !Array.isArray(value) ? (value as Line) : {});
const records = (value: unknown): Line[] => (Array.isArray(value) ? value.filter((line): line is Line => !!line && typeof line === "object" && !Array.isArray(line)) : []);

/** The till's `beoLines`, as each line's paid count: only the lines with one. */
export function paidQuantitiesOf(beoLines: unknown): Map<string, number> {
  const paid = new Map<string, number>();
  for (const line of records(beoLines)) {
    const quantity = line.paidQuantity;
    if (typeof line.lineId === "string" && typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0) paid.set(line.lineId, quantity);
  }
  return paid;
}

/** The plan's lines held by the rule, by id, each with its paid count. */
export function paidLinesOf(menus: unknown, barItems: unknown, paid: ReadonlyMap<string, number>): Map<string, number> {
  const held = new Map<string, number>();
  if (paid.size === 0) return held;
  for (const line of approvedBeoBillingSources(menus, barItems)) {
    const quantity = paid.get(String(line.id));
    if (quantity !== undefined && line.included !== true) held.set(String(line.id), quantity);
  }
  return held;
}

/** Whether the plan holds a line the till may have billed and paid: only then is the till asked. */
export function mayHoldPaidLines(menus: unknown, barItems: unknown): boolean {
  return approvedBeoBillingSources(menus, barItems).some((line) => line.included !== true);
}

/**
 * A Save's kitchen lists and bar list with every held line kept: one the Save
 * deletes is put back where it stood, one it takes below its paid count is
 * written as stored. Turning "Different for adults" off would drop the adults'
 * own list with a paid line in it: the switch and that list stay as stored.
 * A list the Save does not write (`undefined`) is left alone.
 */
export function keepPaidBeoLines(
  stored: { menus: unknown; barItems: unknown },
  incoming: { menus?: Line; barItems?: unknown },
  paid: ReadonlyMap<string, number>,
): { menus?: Line; barItems?: unknown; kept: BeoPaidLineKept[] } {
  const held = paidLinesOf(stored.menus, stored.barItems, paid);
  const kept: BeoPaidLineKept[] = [];
  if (held.size === 0) return { ...incoming, kept };
  const storedMenus = record(stored.menus);
  const storedLists: Record<BeoPaidLineList, Line[]> = { kids: records(storedMenus.kids), adults: records(storedMenus.adults), bar: records(stored.barItems) };
  const said = (list: BeoPaidLineList, line: Line, paidQuantity: number) =>
    kept.push({ id: String(line.id), itemName: typeof line.itemName === "string" ? line.itemName : "", list, paidQuantity });
  const keepIn = (list: BeoPaidLineList, into: Line[]): Line[] => {
    const out = [...into];
    storedLists[list].forEach((line, at) => {
      const paidQuantity = held.get(String(line.id));
      if (paidQuantity === undefined) return;
      const now = out.findIndex((l) => l.id === line.id);
      if (now >= 0 && beoQuantityOf(out[now]!.quantity) >= paidQuantity) return;
      if (now >= 0) out[now] = line;
      else out.splice(Math.min(at, out.length), 0, line);
      said(list, line, paidQuantity);
    });
    return out;
  };

  let menus = incoming.menus;
  if (menus) {
    const kids = keepIn("kids", records(menus.kids));
    const adultsHeld = storedLists.adults.filter((line) => held.has(String(line.id)));
    if (adultsHeld.length > 0 && !adultsDifferOf(menus)) {
      for (const line of adultsHeld) said("adults", line, held.get(String(line.id))!);
      menus = { ...menus, kids, adults: storedLists.adults, adultsDiffer: true };
    } else {
      menus = { ...menus, kids, adults: keepIn("adults", records(menus.adults)) };
    }
  }
  const barItems = incoming.barItems === undefined ? undefined : keepIn("bar", records(incoming.barItems));
  return { ...(menus !== undefined ? { menus } : {}), ...(barItems !== undefined ? { barItems } : {}), kept };
}

/** The Save's answer, in words for staff: which lines were kept, and that the rest was saved. */
export function paidLinesKeptWords(kept: readonly BeoPaidLineKept[]): string {
  const names = kept.map((line) => `${line.itemName.trim() || "An item"} (${line.paidQuantity} paid)`).join(", ");
  return `Kept as billed: ${names}. Everything else was saved.`;
}
