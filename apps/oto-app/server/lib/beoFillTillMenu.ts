import { and, eq } from "drizzle-orm";
import { branches } from "@shared/schema";
import type { BeoAiCatalogueView, BeoAiReview, BeoAiTillItem } from "@shared/beoAiFill";
import type { TillMenuItem } from "@shared/tillMenu";
import { log } from "./logger";
import type { DbExecutor } from "./packageSnapshot";
import { suiteProvisionConfig } from "./suiteSignIn";
import { readTillMenu } from "./tillMenu";

/**
 * THE TILL'S MENU FOR THE BEO FILL (SCRUM-944, Phase C).
 *
 * The conversation's read matched a dish only to what the park's set menus
 * code, so a pizza or a drink the till sells but no set menu lists came back
 * as "not on the menu" and was written by name only. Now the read is handed
 * the party's park's till food and drink as part of its menu, through the
 * door SCRUM-905 built (`readTillMenu`: the platform asked with this app's
 * provisioning key, an answer held a minute, nothing kept in this app's
 * tables), and a dish the till sells is matched to it, written with its till
 * code as the line's own `productCode`.
 *
 * Only what a party's kitchen plan can hold is handed over: items made at the
 * kitchen or the bar, coded, on sale — and not an item made from another
 * party's BEO (SCRUM-828's "BEO only"), which is no dish of this party's.
 * When the till's menu cannot be read the fill works as before, matching to
 * the set menus only, and says so; nothing is called "no longer on the till".
 */

export type FillTillMenu = NonNullable<BeoAiReview["tillMenu"]> & { items: TillMenuItem[] };

export const FILL_TILL_NOT_LINKED = "This park is not linked to the till yet.";
export const FILL_TILL_UNCONFIGURED = "This deployment cannot ask the till yet (PLATFORM_API_URL and OTOAPP_PROVISION_KEY).";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The party's park's till menu, or why there is none; never throws. */
export async function readFillTillMenu(
  db: DbExecutor,
  event: { tenantId: string; branchId: string | null },
  requestId?: string,
): Promise<FillTillMenu> {
  try {
    if (!event.branchId) return { status: "not_linked", message: FILL_TILL_NOT_LINKED, items: [] };
    const [park] = await db
      .select({ coreBranchId: branches.coreBranchId })
      .from(branches)
      .where(and(eq(branches.id, event.branchId), eq(branches.tenantId, event.tenantId)));
    const linked = park?.coreBranchId?.trim().toLowerCase() ?? "";
    if (!UUID.test(linked)) return { status: "not_linked", message: FILL_TILL_NOT_LINKED, items: [] };
    const config = suiteProvisionConfig();
    if (!config) return { status: "unconfigured", message: FILL_TILL_UNCONFIGURED, items: [] };
    const read = await readTillMenu(config, linked, requestId);
    if (!read.ok) return { status: "not_reachable", message: read.message, items: [] };
    return { status: "ok", message: null, items: read.items };
  } catch (error) {
    log().warn({ err: (error as Error)?.message ?? String(error) }, "the till's menu was not read for the AI fill");
    return { status: "not_reachable", message: "The till's menu could not be read.", items: [] };
  }
}

/** The till's items a party's kitchen and bar plan can hold, as the fill reads them. */
export function tillItemsForFill(items: readonly TillMenuItem[]): BeoAiTillItem[] {
  return items
    .filter((i) => !i.beoOnly && i.code.trim() !== "")
    .map((i) => ({ code: i.code.trim(), name: i.name, category: i.category ?? i.parentCategory ?? null, station: i.station, priceSatang: i.priceSatang }));
}

/** The catalogue with the till's menu in it (none when it was not read). */
export function withTillMenu<C extends BeoAiCatalogueView>(catalogue: C, till: FillTillMenu): C {
  return till.status === "ok" ? { ...catalogue, till: tillItemsForFill(till.items) } : catalogue;
}
