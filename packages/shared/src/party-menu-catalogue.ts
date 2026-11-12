import { z } from 'zod';
import { PARTY_MENU_STATIONS } from './party-menu';

/**
 * SCRUM-905 — THE TILL'S MENU INSIDE THE BEO (the kitchen plan, Lane A).
 *
 * Staff plan a party's food and drinks in the OTO App's BEO. Until now every
 * kitchen and bar line was typed by hand, so the party's plan, its slips and
 * its settlement could only find a line the BEO had made a till product for
 * (SCRUM-828). With this read the BEO offers the till's own food and drink:
 * staff pick an item and the line carries the till's name and code, which is
 * what the party's plan and its kitchen and bar slips find it by.
 *
 * `GET /otoapp/party-menu/catalogue?branchId=` is the OTO App SERVER's door,
 * with its provisioning key (the operator is the key's, the branch must be
 * that operator's), never a person's session. It answers the branch's live
 * food and drink: every item of the till's menu (`kind` menu) that is not
 * archived, is on sale (`active`), carries a code (the code is what a BEO line
 * is matched by) and is made at the kitchen or the bar. The BEO-only items
 * the BEO made (SCRUM-828) are in it too, flagged, so a picker can tell them
 * apart. Nothing is written; the app keeps no copy (it holds an answer for a
 * minute in memory, `apps/oto-app/server/lib/tillMenu.ts`).
 */

export const PartyMenuCatalogueQuerySchema = z
  .object({
    /** The platform branch of the party's park (the app's `branches.core_branch_id`). */
    branchId: z.string().uuid(),
  })
  .strict();
export type PartyMenuCatalogueQuery = z.infer<typeof PartyMenuCatalogueQuerySchema>;

export const PartyMenuCatalogueItemSchema = z.object({
  /** The till's code: what a BEO line carries as its `productCode`. */
  code: z.string(),
  /** The till's own name for it. */
  name: z.string(),
  /** Its menu category's name (a sub-category's own name), null when it has none. */
  category: z.string().nullable(),
  /** The top-level category above a sub-category; null for an item in a top-level one. */
  parentCategory: z.string().nullable(),
  /** Where it is made: the slip it prints on (the item's own station, else its category's). */
  station: z.enum(PARTY_MENU_STATIONS),
  /** The weekday price, in satang. */
  priceSatang: z.number().int().nonnegative(),
  /** The weekend and holiday price, in satang (the weekday price when it has none of its own). */
  priceWeekendSatang: z.number().int().nonnegative(),
  /** Made from a BEO for a party (SCRUM-828): never on the till's selling grids. */
  beoOnly: z.boolean(),
});
export type PartyMenuCatalogueItem = z.infer<typeof PartyMenuCatalogueItemSchema>;

export const PartyMenuCatalogueAnswerSchema = z.object({
  branchId: z.string().uuid(),
  /** In the till menu's own order: category, then the item's place in it, then its name. */
  items: z.array(PartyMenuCatalogueItemSchema),
});
export type PartyMenuCatalogueAnswer = z.infer<typeof PartyMenuCatalogueAnswerSchema>;
