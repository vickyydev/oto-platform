import { paidQuantitiesOf } from "@shared/beoPaidLines";
import { readingFor } from "../party-billing-routes";

/** A missing till reading is distinct from a known empty set of paid lines. */
export async function paidBeoQuantitiesOf(
  event: { id: string; tenantId: string; branchId: string | null; eventType: string },
  requestId: string | undefined,
): Promise<ReadonlyMap<string, number> | null> {
  const reading = await readingFor(event, requestId);
  if (reading.status === "not_a_party") return new Map();
  return reading.status === "ok" ? paidQuantitiesOf(reading.billing.beoLines) : null;
}
