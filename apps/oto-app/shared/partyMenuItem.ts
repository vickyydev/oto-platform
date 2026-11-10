import { z } from "zod";

/**
 * A NEW MENU ITEM FROM THE BEO (SCRUM-828), as the form and the server both
 * read it.
 *
 * The BEO's food line editor's "New item" asks for a name, the station it is
 * made at and either a price or a tick for "free / included / alternate item"
 * (no price, part of the package). The server makes it a till product through
 * the platform (`server/lib/partyMenuItem.ts`) and writes the kitchen plan
 * line below, carrying the till's code as `productCode`, which the till's
 * plan view reads (app migration 0047). Money is baht here, as the BEO shows
 * it; the platform is sent satang.
 */

export const PARTY_MENU_ITEM_NAME_MAX = 80;
/** The most a new item may cost, in baht: the till menu's own ceiling (100,000 baht). */
export const PARTY_MENU_ITEM_PRICE_MAX_THB = 100_000;

export const PARTY_MENU_ITEM_STATIONS = ["kitchen", "bar"] as const;
export type PartyMenuItemStation = (typeof PARTY_MENU_ITEM_STATIONS)[number];

/** `POST /api/events/:eventId/beo/party-menu-items`. */
export const PartyMenuItemBodySchema = z
  .object({
    /** The press, minted when the form opens: a retry of it is the same item and the same line. */
    actionId: z.string().uuid(),
    /** The kitchen plan's list the line goes in. */
    menu: z.enum(["kids", "adults"]),
    name: z.string().trim().min(1).max(PARTY_MENU_ITEM_NAME_MAX),
    station: z.enum(PARTY_MENU_ITEM_STATIONS),
    /** Baht; null with `free` ticked. */
    price: z.number().min(0).max(PARTY_MENU_ITEM_PRICE_MAX_THB).nullable(),
    /** Free / included / alternate item: no price, part of the package. */
    free: z.boolean(),
  })
  .strict();
export type PartyMenuItemBody = z.infer<typeof PartyMenuItemBodySchema>;

/** Why the form cannot be sent as it is, in a sentence; null when it can. */
export function partyMenuItemProblem(body: { name: string; price: number | null; free: boolean }): string | null {
  if (!body.name.trim()) return "Give the item a name.";
  if (body.free) {
    return body.price === null || body.price === 0
      ? null
      : "A free, included or alternate item has no price: clear the price, or untick the box.";
  }
  if (body.price === null || !(body.price > 0)) return "Give the item a price, or tick free / included / alternate item.";
  if (body.price > PARTY_MENU_ITEM_PRICE_MAX_THB) return `A price is at most ${PARTY_MENU_ITEM_PRICE_MAX_THB.toLocaleString("en-US")} baht.`;
  return null;
}

/** Baht as the platform's satang, to the satang. */
export const satangOfBaht = (baht: number): number => Math.round(baht * 100);

/** A kitchen plan line the BEO keeps for a new item: the editor's own line, with the till's code. */
export interface PartyMenuLine {
  id: string;
  itemName: string;
  quantity: number;
  notes: string;
  included: boolean;
  /** Baht, as every BEO line holds it; 0 for a free / included / alternate item. */
  price: number;
  /** The till product's code (`PARTY-…`): what the till's plan and slips find it by. */
  productCode: string;
  source?: "additional";
}

/** The line's id comes from the press, so a retry finds the line it wrote instead of adding a second. */
export const partyMenuLineId = (actionId: string): string => `party_${actionId}`;

/**
 * The line a new item becomes: its name, one of it, the price or "included",
 * and its code. On a BEO with a set menu it is one of the additional items,
 * as the editor's own "+ EXTRA" makes one.
 */
export function partyMenuLineOf(body: PartyMenuItemBody, productCode: string, setMenuEnabled: boolean): PartyMenuLine {
  return {
    id: partyMenuLineId(body.actionId),
    itemName: body.name.trim(),
    quantity: 1,
    notes: "",
    included: body.free,
    price: body.free ? 0 : (body.price ?? 0),
    productCode,
    ...(setMenuEnabled ? { source: "additional" as const } : {}),
  };
}
