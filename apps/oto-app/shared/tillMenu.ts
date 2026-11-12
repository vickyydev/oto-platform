import { z } from "zod";

/**
 * THE TILL'S MENU INSIDE THE BEO (SCRUM-905), as the server and the screens
 * both read it.
 *
 * The BEO's kitchen and bar plan used to be typed by hand, so the till's party
 * page, its kitchen and bar slips and its settlement could find a line only
 * when the BEO had made it a till product (SCRUM-828, "+ NEW ITEM"). Now staff
 * pick the till's own item: the line takes the till's name and its code as
 * `productCode`, which is what the till's plan view reads (app migration 0048)
 * and what its slips and settlement find the product by. Free typing stays: a
 * line nobody picked is printed by its name.
 *
 * The platform answers a park's live food and drink (`GET
 * /otoapp/party-menu/catalogue`): menu items not archived, on sale, coded and
 * made at the kitchen or the bar. This app passes it through with its
 * provisioning key (`server/lib/tillMenu.ts`), holds an answer a minute in
 * memory and keeps no copy in its database. Money is satang from the till;
 * a BEO line holds baht.
 */

export const TILL_MENU_STATIONS = ["kitchen", "bar"] as const;
export type TillMenuStation = (typeof TILL_MENU_STATIONS)[number];

/** One item of the till's menu, as the platform answers it. */
export const TillMenuItemSchema = z.object({
  /** The till's code: what a BEO line carries as its `productCode`. */
  code: z.string().min(1),
  name: z.string(),
  category: z.string().nullable(),
  parentCategory: z.string().nullable(),
  station: z.enum(TILL_MENU_STATIONS),
  priceSatang: z.number().int().nonnegative(),
  priceWeekendSatang: z.number().int().nonnegative(),
  /** Made from a BEO for a party (SCRUM-828): never on the till's selling grids. */
  beoOnly: z.boolean(),
});
export type TillMenuItem = z.infer<typeof TillMenuItemSchema>;

/** The platform's answer for one park. */
export const PlatformTillMenuSchema = z.object({
  branchId: z.string(),
  items: z.array(TillMenuItemSchema),
});

/**
 * One park's till menu, or why there is none: "ok" with the items; the park
 * not linked to the till, this deployment without the key, or the till not
 * answering, each with a sentence and no items. A screen with no menu offers
 * no picker and marks no line: it cannot tell a dead code from an unknown one.
 */
export const TillMenuParkSchema = z.object({
  /** The app's park (`branches.id`). */
  parkId: z.string(),
  parkName: z.string(),
  status: z.enum(["ok", "not_linked", "unconfigured", "not_reachable"]),
  message: z.string().nullable(),
  items: z.array(TillMenuItemSchema),
  /** When the till answered (ISO), null without a menu. */
  readAt: z.string().nullable(),
});
export type TillMenuPark = z.infer<typeof TillMenuParkSchema>;

/** `GET /api/beo/till-menu[?parkId=]`: the one park asked for, or every park the caller may open. */
export const TillMenuReadingSchema = z.object({ parks: z.array(TillMenuParkSchema) });
export type TillMenuReading = z.infer<typeof TillMenuReadingSchema>;

/** Satang as the baht a BEO line holds. */
export const bahtOfSatang = (satang: number): number => Math.round(satang) / 100;

/**
 * What a line's code says once the till's menu is known: "live" when an item
 * of the menu carries it, "dead" when the menu was read and none does ("No
 * longer on the till"), "unknown" when there is no code or no menu to ask.
 */
export type TillCodeState = "live" | "dead" | "unknown";

export interface TillMenuIndex {
  /** True when at least one park's menu was read: only then can a code be called dead. */
  known: boolean;
  items: TillMenuItem[];
  byCode: Map<string, TillMenuItem>;
}

/**
 * The parks' menus as one index. A code is unique among the operator's live
 * products, so the same code at two parks is the same product; the first
 * park's reading of it is kept.
 */
export function tillMenuIndexOf(parks: readonly TillMenuPark[] | null | undefined): TillMenuIndex {
  const read = (parks ?? []).filter((p) => p.status === "ok");
  const byCode = new Map<string, TillMenuItem>();
  for (const park of read) {
    for (const item of park.items) if (!byCode.has(item.code)) byCode.set(item.code, item);
  }
  return { known: read.length > 0, items: [...byCode.values()], byCode };
}

export function tillCodeState(index: TillMenuIndex, code: string | null | undefined): TillCodeState {
  const c = typeof code === "string" ? code.trim() : "";
  if (!c || !index.known) return "unknown";
  return index.byCode.has(c) ? "live" : "dead";
}

export const TILL_CODE_DEAD = "No longer on the till";

/**
 * A set-menu dish the template resolved (`server/lib/setMenuResolve.ts`: an
 * always-included item or a parent's choice, `source` "set_menu" with the
 * template item's `groupId`), and the adults' copy of one. Its till code is
 * the template's (Settings > Set menu templates), which the till's plan view
 * already reads for it (app migration 0048, part 0); a code on the line as
 * well would send the dish to the till a second time (part 1 emits every
 * coded line), and a pick would write over the parent's choice. So no till
 * item is picked on it. A line added on the set menu block ("+ Add item", no
 * `groupId`) is not the template's and takes a pick like any other.
 */
export function isTemplateSetMenuLine(line: { source?: string | null; groupId?: string | null }): boolean {
  return line.source === "set_menu" && typeof line.groupId === "string" && line.groupId.length > 0;
}

/**
 * A BEO line once a till item is picked for it: the till's name and code; an
 * EXTRA (a line the badge shows as EXTRA, not the set menu's) also takes the
 * till's weekday price as its price, which is what it is charged at (the
 * owner's decision of 12 November: "charge it according to the right entered
 * price"). A set-menu line added on the set menu block is part of the package
 * and keeps its price. A set-menu dish the template resolved is returned as it
 * was (`isTemplateSetMenuLine`): its code lives on the template. Everything
 * else on the line (its count, its note, its badge) stays.
 */
export function lineWithTillItem<L extends { itemName: string; price: number; source?: string; groupId?: string | null; productCode?: string }>(
  line: L,
  item: Pick<TillMenuItem, "code" | "name" | "priceSatang">,
): L {
  if (isTemplateSetMenuLine(line)) return line;
  const extra = line.source !== "set_menu";
  return {
    ...line,
    itemName: item.name,
    productCode: item.code,
    ...(extra ? { price: bahtOfSatang(item.priceSatang) } : {}),
  };
}

/** A line taken off the till: its code gone, its name and everything else kept. */
export function lineWithoutTillItem<L extends { productCode?: string }>(line: L): L {
  const { productCode: _code, ...rest } = line;
  return rest as L;
}

/** Lower case, accents off, runs of spaces as one: how the search reads both the menu and what was typed. */
const foldForSearch = (s: string): string =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * HOW WELL ONE TILL ITEM ANSWERS THE PICKER'S SEARCH (SCRUM-939). 0 leaves the
 * item out; the picker lists the highest first.
 *
 * The picker used the list component's own fuzzy match over the code and the
 * name, which finds letters scattered across both: "fries" matched Porridge
 * and Vegetarian breakfast (the "CF-" of every code supplies the f) and left
 * French fries fifteenth. Here an item is found only by what was typed as it
 * stands: in the name first (the whole name, whole words of it, the start of
 * a word, anywhere in it), then the code, then the category ("pizza" lists
 * the pizzas, whose names do not say pizza), then the station. Several words
 * must each be found. Nothing typed keeps the menu as it is.
 */
export function tillMenuSearchScore(
  item: Pick<TillMenuItem, "code" | "name" | "category" | "parentCategory" | "station">,
  search: string,
): number {
  const q = foldForSearch(search);
  if (!q) return 1;
  const name = foldForSearch(item.name);
  const code = foldForSearch(item.code);
  if (name === q || code === q) return 1;
  const words = ` ${name.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const typed = q.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // Whole words before the start of a word: "water" is Mineral water before
  // Fresh watermelon juice, whichever the menu lists first.
  if (typed && words.startsWith(` ${typed} `)) return 0.97;
  if (typed && words.includes(` ${typed} `)) return 0.93;
  if (name.startsWith(q) || (typed && words.startsWith(` ${typed}`))) return 0.9;
  if (typed && words.includes(` ${typed}`)) return 0.85;
  // SCRUM-958 (SCRUM-940 point a, the staging proof): a whole word of the category, or the start
  // of one, before a match found only inside another word of a name: "tea" lists the Tea pot's
  // teas above Steamed jasmine rice, "egg" the Eggs' dishes above Veggie delight.
  const category = foldForSearch(`${item.parentCategory ?? ""} ${item.category ?? ""}`);
  const categoryWords = ` ${category.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  if (typed && categoryWords.includes(` ${typed} `)) return 0.83;
  if (typed && categoryWords.includes(` ${typed}`)) return 0.82;
  if (name.includes(q)) return 0.8;
  if (code.startsWith(q)) return 0.75;
  if (category.includes(q)) return 0.6;
  const parts = typed.split(" ").filter(Boolean);
  if (parts.length > 1 && parts.every((p) => name.includes(p) || code.includes(p) || category.includes(p))) {
    return parts.every((p) => name.includes(p)) ? 0.7 : 0.5;
  }
  if (code.includes(q)) return 0.4;
  if (item.station === q) return 0.3;
  return 0;
}

/**
 * The items a search finds, the best answer first whatever its category; equal
 * answers keep the order they were given in (the menu's). The picker shows this
 * as one list: the list component kept the menu's headings in their own order,
 * so "chicken" put Grilled chicken (Sides) above Chicken schnitzel (Mains).
 */
export function tillMenuSearch<T extends Pick<TillMenuItem, "code" | "name" | "category" | "parentCategory" | "station">>(
  items: readonly T[],
  search: string,
): T[] {
  return items
    .map((item, at) => ({ item, at, score: tillMenuSearchScore(item, search) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((row) => row.item);
}

/**
 * SCRUM-958 (SCRUM-940 point b, the staging proof: two items named "Latte",
 * one in the Free Drinks Menu at 0 baht): the category to show beside each
 * listed item whose name another listed item shares, by its code, so the one
 * meant is picked. Items with a name of their own are not in it.
 */
export function sameNameCategories(items: readonly Pick<TillMenuItem, "code" | "name" | "category" | "parentCategory">[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const item of items) seen.set(foldForSearch(item.name), (seen.get(foldForSearch(item.name)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const item of items) {
    if ((seen.get(foldForSearch(item.name)) ?? 0) > 1) out.set(item.code, item.category ?? item.parentCategory ?? "Other");
  }
  return out;
}

/** The same reading for a row that is no till item ("Not from the till"): found by its own words only. */
export function tillMenuWordsMatch(words: readonly string[], search: string): boolean {
  const q = foldForSearch(search);
  return !q || foldForSearch(words.join(" ")).includes(q);
}
