/**
 * THE KIDS' MENU IS THE MAIN SELECTION; THE ADULTS MIRROR IT (SCRUM-829).
 *
 * The kitchen plan keeps two food lists, `menus.kids` and `menus.adults`.
 * Until now they were independent: the adults' list opened empty with its own
 * option list, and staff typed the adults' food a second time. The owner's
 * rule: the adults eat what was chosen for the kids, and the adults' section
 * starts from that. A "Different for adults" switch is the one exception.
 *
 * What is stored, in the same `menus` object every reader already reads:
 *
 *   - `kids`          the food list, as before;
 *   - `adults`        the adults' OWN list while the switch is on (a copy of
 *                     the kids' list, changed by staff); `[]` while it is off,
 *                     because the adults' list IS the kids' list then;
 *   - `adultsDiffer`  the switch, `true` / `false`, written by the editor's
 *                     Save. A BEO saved before this has no key.
 *
 * How a saved BEO opens (`adultsDifferOf`): the switch is ON when it was saved
 * on, or — for a BEO with no key — when the adults' list holds lines and is
 * not line for line the kids' list. An empty adults' list, or one equal to
 * the kids', opens with the switch OFF: the adults eat the kids' menu.
 *
 * How the adults' changes are marked on ONE food list (`kitchenAdultsMarks`):
 * beside each kids' line, "kids only" when the adults' list has no line of
 * that name, "kids N · adults M" when it has one in another count, "adults:
 * <note>" when only its note differs ("adults: no note" when the adults'
 * copy has none and the kids' line has one); after the kids' lines, each
 * adults' line with no kids' line of its name, marked "adults only". The BEO
 * PDF prints these; the till's kitchen slip prints the same words from what
 * the plan view hands it (migration 0048, packages/shared/src/party-slips.ts).
 *
 * The till's charges do not move: a coded line copied for the adults is the
 * same dish whatever its note (`sameKitchenDish`: name, count and till code),
 * so the plan view emits it once and carries the adults' note on that one
 * line; a one-list BEO is charged exactly so today. Only a copy in another
 * count, or of another code, is a line of the adults' own.
 */

/** A kitchen plan line as every list holds it; only these fields matter here. */
export interface KitchenLineLike {
  id?: string;
  itemName?: string;
  quantity?: number;
  notes?: string;
  productCode?: string;
  source?: string;
  [key: string]: unknown;
}

/** What the adults' section says while the switch is off. */
export const ADULTS_SAME_AS_KIDS = "Same as the kids' menu";
/** The marks on the one food list. The till's slip uses the same words. */
export const KIDS_ONLY_MARK = "kids only";
export const ADULTS_ONLY_MARK = "adults only";
/** Beside a kids' line with a note whose adults' copy has none. */
export const ADULTS_NO_NOTE_MARK = "adults: no note";
/** "adults: <note>", or the no-note mark for an adults' copy whose note was cleared. */
export const adultsNoteMark = (note: string): string => (note.trim() ? `adults: ${note.trim()}` : ADULTS_NO_NOTE_MARK);

export const kitchenLinesOf = (value: unknown): KitchenLineLike[] =>
  Array.isArray(value) ? (value.filter((l) => l && typeof l === "object" && !Array.isArray(l)) as KitchenLineLike[]) : [];

/** A dish's name as the kitchen reads it: case and spacing aside. */
export const foldDishName = (name: unknown): string =>
  typeof name === "string" ? name.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ") : "";

const qtyOf = (line: KitchenLineLike): number => {
  const q = typeof line.quantity === "number" && Number.isFinite(line.quantity) ? Math.round(line.quantity) : 1;
  return q > 0 ? q : 1;
};
const noteOf = (line: KitchenLineLike): string => (typeof line.notes === "string" ? line.notes.trim() : "");
const codeOf = (line: KitchenLineLike): string => (typeof line.productCode === "string" ? line.productCode.trim() : "");

/**
 * The same dish for the kitchen and the till: the same name, count and till
 * code, its note aside. A coded line copied for the adults and changed only
 * in its note is this one dish, cooked and charged once, with the adults'
 * note carried beside it.
 */
export function sameKitchenDish(a: KitchenLineLike, b: KitchenLineLike): boolean {
  return foldDishName(a.itemName) === foldDishName(b.itemName) && qtyOf(a) === qtyOf(b) && codeOf(a) === codeOf(b);
}

/**
 * The same dish with the same note: an unchanged copy. A note the staff
 * changed for the adults is a change of theirs, so the lists are not the
 * same (the switch reads on) — but the dish is, for the till.
 */
export function sameKitchenLine(a: KitchenLineLike, b: KitchenLineLike): boolean {
  return sameKitchenDish(a, b) && noteOf(a) === noteOf(b);
}

/** Line for line the same list (the ids aside). */
export function kitchenListsEqual(kids: unknown, adults: unknown): boolean {
  const k = kitchenLinesOf(kids);
  const a = kitchenLinesOf(adults);
  return k.length === a.length && k.every((line, i) => sameKitchenLine(line, a[i]!));
}

/**
 * Whether the adults' list is the adults' own (the switch ON): saved on, or —
 * with no key saved — holding lines that are not the kids' list.
 */
export function adultsDifferOf(menus: unknown): boolean {
  const m = menus && typeof menus === "object" && !Array.isArray(menus) ? (menus as Record<string, unknown>) : {};
  if (m.adultsDiffer === true) return true;
  const adults = kitchenLinesOf(m.adults);
  if (adults.length === 0) return false;
  return !kitchenListsEqual(m.kids, adults);
}

/**
 * The same dishes by name, however counted or annotated: the kids' list said
 * again in the adults' own words. An AI fill told "the adults eat what the
 * kids eat unless the message says otherwise" has still answered the kids'
 * dishes a second time as the adults' list, in the adults' headcount and
 * noted "adults eat the same as the kids" (the SCRUM-829 staging proof).
 * Such a list IS the kids' list: the fill's read, Load into Editor and the
 * review's approval fold it away and the switch stays off. A list naming a
 * dish of the adults' own, or leaving one of the kids' out, is the adults'
 * own and is kept.
 */
export function sameKitchenDishNames(kids: unknown, adults: unknown): boolean {
  const namesOf = (lines: unknown) => new Set(kitchenLinesOf(lines).map((l) => foldDishName(l.itemName)).filter(Boolean));
  const k = namesOf(kids);
  const a = namesOf(adults);
  return a.size > 0 && a.size === k.size && [...a].every((name) => k.has(name));
}

/** One kids' line's mark, or null when the adults eat it as it is. */
export type AdultsMark = string | null;

export interface KitchenAdultsMarks {
  /** By the kids' line's place: its mark. */
  marks: AdultsMark[];
  /** The adults' lines no kids' line shares a name with, in the adults' list's order. */
  adultsOnly: KitchenLineLike[];
}

/** "kids N · adults M": the two counts beside a dish both eat in different numbers. */
export const adultsCountMark = (kidsQty: number, adultsQty: number): string => `kids ${kidsQty} · adults ${adultsQty}`;

/**
 * The adults' changes against the kids' list. With the switch off there are
 * none. Each kids' line takes the first adults' line of its name not taken by
 * an earlier kids' line.
 *
 * SCRUM-978: and, when the caller says so (`foldable`), only an adults' line
 * whose own words beside the mark would be the kids' line's (the BEO PDF: the
 * same kind of line at the same price each). Any other adults' line of that
 * name is listed among the adults' own, with its own count and price: kids
 * Margherita 3 at 400 and adults 2 at 450 are two rows, never "kids 3 ·
 * adults 2" at 400.
 */
export function kitchenAdultsMarks(
  kids: unknown,
  adults: unknown,
  adultsDiffer: boolean,
  foldable: (kidsLine: KitchenLineLike, adultsLine: KitchenLineLike) => boolean = () => true,
): KitchenAdultsMarks {
  const k = kitchenLinesOf(kids);
  const a = kitchenLinesOf(adults);
  if (!adultsDiffer) return { marks: k.map(() => null), adultsOnly: [] };
  const taken = new Set<number>();
  const marks = k.map((line) => {
    const name = foldDishName(line.itemName);
    const at = a.findIndex((other, i) => !taken.has(i) && foldDishName(other.itemName) === name && foldable(line, other));
    if (at < 0) return KIDS_ONLY_MARK;
    taken.add(at);
    const match = a[at]!;
    if (qtyOf(line) !== qtyOf(match)) return adultsCountMark(qtyOf(line), qtyOf(match));
    if (noteOf(line) !== noteOf(match)) return adultsNoteMark(noteOf(match));
    return null;
  });
  return { marks, adultsOnly: a.filter((_, i) => !taken.has(i)) };
}

/**
 * The kids' lines copied for the adults' own list, each with an id of its
 * own (a list's rows are keyed by id). The server copies the set menu's
 * resolved lines this way so the adults' set menu stays in step with the
 * kids' when the parent chooses or an approval writes it.
 */
export function adultsCopiesOf<T extends KitchenLineLike>(lines: T[]): T[] {
  return lines.map((line) => ({ ...line, id: `${typeof line.id === "string" && line.id ? line.id : "line"}_adults` }));
}

/**
 * SCRUM-970: the adults' set-menu lines as the till reads them. An adults' SET
 * line of a dish of their own (an AI fill's "chicken fried rice for the
 * adults") carries the till code the set menu gives its option, as the till
 * reads the kids' line of that dish (server/lib/beoAiApprove.ts). Once the
 * kids' list holds the same dish in the same group (the family's link, the
 * till or staff chose it for the kids too), that line is the copy of the kids'
 * line and carries no code of its own, as the kids' line carries none: the
 * till's plan view (app migration 0050) then reads the two as one dish, as
 * before. Every other line is returned as it is.
 *
 * SCRUM-978: only in the case the plan view folds (name, count and code the
 * kids' line's, `sameKitchenDish`): an adults' line in another count (kids
 * Chicken 12, adults Chicken 8) is a line of the adults' own on the till, and
 * keeps its code, so the till names it and never lists it "not on the till
 * menu".
 */
export function adultsSetCopiesUncoded<T extends KitchenLineLike>(kids: readonly KitchenLineLike[], adults: T[]): T[] {
  const groupOf = (line: KitchenLineLike) => (typeof line.groupId === "string" ? line.groupId.trim() : "");
  const kidsSet = kids.filter((k) => k.source === "set_menu" && groupOf(k) !== "");
  return adults.map((line) => {
    if (line.source !== "set_menu" || !codeOf(line) || !groupOf(line)) return line;
    const copy = kidsSet.some(
      (k) => groupOf(k) === groupOf(line) && foldDishName(k.itemName) === foldDishName(line.itemName) && codeOf(k) === "" && qtyOf(k) === qtyOf(line),
    );
    if (!copy) return line;
    const { productCode: _code, ...rest } = line;
    return rest as T;
  });
}

/**
 * SCRUM-978 (the lane's review): the till code the set menu gives a set-menu
 * line, as the till's plan view (app migration 0050) reads it for the kids'
 * line of that dish: the option's own code, else its group's (an item always
 * included: its own). "" when the set menu has no item of the line's group.
 */
export function setMenuCodeOfLine(templateItems: unknown, line: KitchenLineLike): string {
  const group = typeof line.groupId === "string" ? line.groupId.trim() : "";
  if (!group || !Array.isArray(templateItems)) return "";
  const item = templateItems.find((i) => i && typeof i === "object" && (i as { id?: unknown }).id === group) as
    | { type?: unknown; productCode?: unknown; optionProductCodes?: unknown }
    | undefined;
  if (!item || (item.type !== "choice_group" && item.type !== "always_included")) return "";
  const codes = item.type === "choice_group" && item.optionProductCodes && typeof item.optionProductCodes === "object" ? (item.optionProductCodes as Record<string, unknown>) : {};
  const option = typeof line.itemName === "string" ? codes[line.itemName] : undefined;
  const own = typeof option === "string" ? option.trim() : "";
  return own || (typeof item.productCode === "string" ? item.productCode.trim() : "");
}

/**
 * SCRUM-978 (the lane's review): the other half of `adultsSetCopiesUncoded`.
 * "Different for adults" in the editor and the day-of view copies the kids'
 * set-menu lines, which carry no till code (`resolveSetMenuLines` writes none:
 * the till reads the kids' line's code from the set menu). Once staff give the
 * adults another count (kids Chicken 12, adults Chicken 8), the till's plan view
 * no longer folds the copy into the kids' line and reads it by its own code
 * alone: none, so the till listed it "not on the till menu". Such a line — a
 * SET line of a set-menu group, with no code, that is no kids' line's dish
 * (`sameKitchenDish`) — takes the code the set menu gives it
 * (`setMenuCodeOfLine`), the code the till reads for the kids' line, and stays
 * a SET line, never charged. A line the view folds keeps none; a line that
 * would fold into a kids' line once coded is left as it is; every other line
 * is returned as it is.
 */
export function adultsSetLinesTillCoded<T extends KitchenLineLike>(kids: readonly KitchenLineLike[], adults: T[], templateItems: unknown): T[] {
  return adults.map((line) => {
    if (!adultsSetLineWantsCode(kids, line)) return line;
    const code = setMenuCodeOfLine(templateItems, line);
    if (!code) return line;
    const coded = { ...line, productCode: code };
    return kids.some((k) => sameKitchenDish(k, coded)) ? line : coded;
  });
}

/** Whether an adults' line is one `adultsSetLinesTillCoded` codes from the set menu, the set menu aside. */
export function adultsSetLineWantsCode(kids: readonly KitchenLineLike[], line: KitchenLineLike): boolean {
  return line.source === "set_menu" && !codeOf(line) && typeof line.groupId === "string" && !!line.groupId.trim() && !kids.some((k) => sameKitchenDish(k, line));
}

/** The list the adults eat: their own while the switch is on, else the kids'. */
export function adultsListOf(menus: unknown): KitchenLineLike[] {
  const m = menus && typeof menus === "object" && !Array.isArray(menus) ? (menus as Record<string, unknown>) : {};
  return adultsDifferOf(m) ? kitchenLinesOf(m.adults) : kitchenLinesOf(m.kids);
}
