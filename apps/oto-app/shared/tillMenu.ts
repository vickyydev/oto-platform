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
 * A BEO line once a till item is picked for it: the till's name and code; an
 * EXTRA (a line the badge shows as EXTRA, not the set menu's) also takes the
 * till's weekday price as its price, which is what it is charged at (the
 * owner's decision of 12 November: "charge it according to the right entered
 * price"). A set-menu line is part of the package and keeps its price.
 * Everything else on the line (its count, its note, its badge) stays.
 */
export function lineWithTillItem<L extends { itemName: string; price: number; source?: string; productCode?: string }>(
  line: L,
  item: Pick<TillMenuItem, "code" | "name" | "priceSatang">,
): L {
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
