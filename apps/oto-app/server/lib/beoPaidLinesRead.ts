import { eq } from "drizzle-orm";
import { beoBarPlans, beoKitchenPlans } from "@shared/schema";
import { mayHoldPaidLines, paidQuantitiesOf } from "@shared/beoPaidLines";
import { db } from "../db";
import { readingFor } from "../party-billing-routes";
import { log } from "./logger";

/**
 * SCRUM-1002 ruling 3 (shared/beoPaidLines.ts): each line's billed and paid count, as the till
 * holds it, for every door that writes a party's kitchen or bar lines — the BEO's Save and the
 * day-of view's kitchen plan write (beo-routes.ts), the till's own kitchen-plan edit
 * (directory/kitchenPlanRoutes.ts) and the AI fill's approval (ai-routes.ts). Asked only of a party
 * whose plan holds a line the till may have billed; when the till cannot say, none is known and the
 * write goes through as sent, as before the rule. Moved here unchanged from beo-routes.ts.
 */
export async function paidBeoQuantitiesOf(
  event: { id: string; tenantId: string; branchId: string | null; eventType: string },
  requestId: string | undefined,
): Promise<ReadonlyMap<string, number>> {
  const [kitchen] = await db.select({ menus: beoKitchenPlans.menus }).from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, event.id));
  const [bar] = await db.select({ items: beoBarPlans.items }).from(beoBarPlans).where(eq(beoBarPlans.eventId, event.id));
  if (!mayHoldPaidLines(kitchen?.menus, bar?.items)) return new Map();
  const reading = await readingFor(event, requestId);
  if (reading.status !== "ok") {
    if (reading.status === "not_reachable") log().warn({ eventId: event.id }, "the till could not say which BEO lines are billed and paid; the Save is written as sent");
    return new Map();
  }
  return paidQuantitiesOf(reading.billing.beoLines);
}
