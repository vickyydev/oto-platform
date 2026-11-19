import { isTemplateSetMenuLine } from "./tillMenu";

/**
 * THE BIRTHDAY PACKAGE'S WAFFLES READ "ADULT WAFFLES" ON THE BEO (SCRUM-1042).
 *
 * The operations brief (Kids Menu): "For the birthday package item, use Adult Waffles instead
 * of Mini Waffles. This naming adjustment applies to the birthday package item and its BEO
 * output. Do not globally rename unrelated F&B products." The owner's choice: the package's
 * waffles item READS "Adult Waffles" in the BEO editor and on the Staff BEO print only. The
 * set menu (Settings), the till's menu, the kitchen slips and the stored line keep their own
 * name: this is a display name at the BEO's edge, never written anywhere.
 *
 * Which line: a set-menu dish the party's set menu resolved (`isTemplateSetMenuLine`: the SET
 * badge with the set menu item's own `groupId`, written by the parent's link, AI Fill's
 * approval or the till's choice from the template; the adults' copy of one keeps it), whose
 * stored name is the set menu's "Mini Waffles" (spaces and capitals aside). A dish typed by
 * hand, SET or EXTRA, carries no `groupId` and is never renamed; neither is any other dish,
 * any drink, nor a line whose name staff changed.
 */
export const BEO_ADULT_WAFFLES = "Adult Waffles";

/** The set menu's own name for the item, compared without case or extra spaces. */
const SET_MENU_WAFFLES = "mini waffles";

const plain = (name: unknown): string => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLowerCase() : "");

/** Whether a kitchen line is the birthday package's waffles item, as the BEO shows it. */
export function isPackageWafflesLine(line: { itemName?: unknown; source?: string | null; groupId?: string | null }): boolean {
  return isTemplateSetMenuLine(line) && plain(line.itemName) === SET_MENU_WAFFLES;
}

/** The name a kitchen line reads on the BEO: "Adult Waffles" for the package's waffles item, else its own. */
export function beoDishNameOf(line: { itemName?: string | null; source?: string | null; groupId?: string | null }): string {
  return isPackageWafflesLine(line) ? BEO_ADULT_WAFFLES : (line.itemName ?? "");
}
