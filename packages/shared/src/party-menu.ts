import { z } from 'zod';

/**
 * SCRUM-828 — A NEW MENU ITEM ADDED FROM THE BEO (approved by the owner on
 * 10 November).
 *
 * Staff planning a party in the OTO App's BEO sometimes need a dish the till's
 * catalogue does not have yet: a special cake, a dish the family asked for.
 * From the BEO's food line editor they add it with a name, the station it is
 * made at (kitchen or bar) and either a price or a tick for "free / included /
 * alternate item" (no price, part of the package). The OTO App's server asks
 * the platform for it with its provisioning key (`POST
 * /otoapp/party-menu/products`, the operator coming from the key), and the
 * platform makes it a till product in the "Party menu" category, marked
 * BEO-only: never on the till's selling grids or its F&B menu, but found by
 * its code by the party's plan, its kitchen and bar slips and its settlement,
 * which charges a priced item on top of the package (`isPartyMenuCode`). The
 * code is written back to the BEO's line, so the plan names it like any
 * catalogue item.
 */

/** Where a BEO-made item is made: the slip it prints on. */
export const PARTY_MENU_STATIONS = ['kitchen', 'bar'] as const;
export type PartyMenuStation = (typeof PARTY_MENU_STATIONS)[number];

/** The category every BEO-made product lands in, found again by this code. */
export const PARTY_MENU_CATEGORY_CODE = 'PARTY-MENU';
export const PARTY_MENU_CATEGORY_NAME = 'Party menu';

/** Every BEO-made product's code starts with this: `PARTY-3F9A21C4`. */
export const PARTY_MENU_CODE_PREFIX = 'PARTY-';

/**
 * A code the BEO's "New item" door mints: the prefix and eight (or, when the
 * eight are taken, twelve) upper-case hex digits of the product's id
 * (`partyMenuCode` in the api's `services/party-menu.ts`).
 */
const PARTY_MENU_CODE_SHAPE = new RegExp(`^${PARTY_MENU_CODE_PREFIX}(?:[0-9A-F]{8}|[0-9A-F]{12})$`);

/**
 * Whether a plan's code names an item the BEO added (a special cake, a dish
 * one family asked for) rather than one of the catalogue's. The party's
 * settlement charges such an item on top of the package; a catalogue item the
 * set menu names is part of the package. Decided by the code the door minted,
 * not by the product's BEO-only flag: the Console may turn that flag on for a
 * catalogue item a set menu names, or off for a BEO-made one, and neither
 * changes what the family ordered.
 */
export function isPartyMenuCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && PARTY_MENU_CODE_SHAPE.test(code);
}

/** The most a BEO-made item may cost, in satang: the menu's own ceiling. */
export const PARTY_MENU_PRICE_MAX_SATANG = 10_000_000;

/**
 * `POST /otoapp/party-menu/products`. `priceSatang` is the item's price, or
 * null (or 0) with `free` ticked; which of the two holds is
 * `partyMenuPriceProblem`'s to say, in a sentence. `source` names the BEO line
 * the item was made for, for the audit row.
 */
export const PartyMenuProductBodySchema = z
  .object({
    /** The platform branch of the party's park (the app's `branches.core_branch_id`). */
    branchId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    station: z.enum(PARTY_MENU_STATIONS),
    priceSatang: z.number().int().min(0).max(PARTY_MENU_PRICE_MAX_SATANG).nullable(),
    /** Free / included / alternate item: no price, part of the package. */
    free: z.boolean(),
    source: z
      .object({
        /** The OTO App's event (the party) the BEO line belongs to. */
        eventId: z.string().trim().min(1).max(64),
        /** The BEO line's own words for the item. */
        lineLabel: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict();
export type PartyMenuProductBody = z.infer<typeof PartyMenuProductBodySchema>;

/** Why a body's price cannot be taken as it is, in a sentence; null when it can. */
export function partyMenuPriceProblem(body: Pick<PartyMenuProductBody, 'priceSatang' | 'free'>): string | null {
  if (body.free) {
    return body.priceSatang === null || body.priceSatang === 0
      ? null
      : 'A free, included or alternate item has no price: leave the price out, or untick it';
  }
  return body.priceSatang !== null && body.priceSatang > 0
    ? null
    : 'Give the item a price, or tick free / included / alternate item';
}

export const PartyMenuProductAnswerSchema = z.object({
  productId: z.string().uuid(),
  /** What the BEO line carries as its `product_code`. */
  code: z.string(),
  categoryId: z.string().uuid(),
  /** True when this Idempotency-Key made the product before: nothing new was made. */
  replayed: z.boolean(),
});
export type PartyMenuProductAnswer = z.infer<typeof PartyMenuProductAnswerSchema>;
