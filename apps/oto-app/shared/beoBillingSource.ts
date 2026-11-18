import { beoKitchenChargesOf } from "./beoExtras";
import { beoQuantityOf } from "./beoQuantity";
import type { TillBillingReading } from "./tillBilling";
/** All source facts that affect billing eligibility, identity, amount or tax attribution. */
export function beoBillingFingerprint(line: Record<string, unknown>, area: "food" | "bar"): string {
  return JSON.stringify([area, line.id, line.itemName, line.quantity, line.price, line.included, line.productCode, line.source, line.chargeApproved]);
}

export function billingSyncAfterAttempt(line: Record<string, unknown>, area: "food" | "bar", expected: string, status: string): string | undefined {
  if (beoBillingFingerprint(line, area) === expected) return status;
  return line.chargeApproved === true && line.source !== "set_menu" ? "pending" : typeof line.billingSync === "string" ? line.billingSync : undefined;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((line) => line && typeof line === "object") : [];
/** The exact eligible set is shared by request capture and delayed-response acceptance. */
export function approvedBeoBillingSources(value: unknown, barItems: unknown): Record<string, unknown>[] {
  const menus = record(value);
  const kids = records(menus.kids);
  const adults = menus.adultsDiffer === true ? records(menus.adults) : [];
  const asExtra = (line: Record<string, unknown>) => ({ itemName: String(line.itemName ?? ""), quantity: Number(line.quantity) || 1, productCode: typeof line.productCode === "string" ? line.productCode : null });
  const charges = beoKitchenChargesOf(kids.map(asExtra), adults.map(asExtra), menus.adultsDiffer === true, { till: { known: false, byCode: new Map() }, partyDate: null });
  return [...kids.map((line): Record<string, unknown> => ({ ...line, billingArea: "food" })), ...adults.filter((_, index) => charges.adults[index]?.kind !== "with_kids").map((line): Record<string, unknown> => ({ ...line, billingArea: "food" })), ...records(barItems).map((line): Record<string, unknown> => ({ ...line, billingArea: "bar" }))].filter((line) => line.chargeApproved === true && line.source !== "set_menu" && typeof line.id === "string" && typeof line.itemName === "string" && line.itemName.trim());
}
export function billingSourceSetMatches(expected: ReadonlyMap<string, string>, current: readonly Record<string, unknown>[]): boolean {
  return expected.size === current.length && current.every((line) => expected.get(String(line.id)) === beoBillingFingerprint(line, line.billingArea as "food" | "bar"));
}

/** The till's answer to a Save's approved lines (SCRUM-990), as the BEO keeps and says it. `added`: the charges the till made. */
export type AdditionalBillingResult = { status: "synced" | "plan_only" | "pending"; message: string; added?: number };

/** SCRUM-1001: said only when the till made or changed a charge on the party's additional bill. */
export const ADDITIONAL_BILL_LINKED = "New approved items are linked to the party's additional bill; the original paid receipt is unchanged.";
/** SCRUM-1001: said when the till was asked and made no charge: every approved item is already on the party's bills. */
export const NOTHING_NEW_TO_BILL = "Nothing new to bill; the party's bills are unchanged.";

/**
 * SCRUM-1001: the till's answer (`POST /otoapp/parties/:eventId/beo-additions`: synced, or plan
 * only before the main bill is settled, with how many charges it `added`) in the BEO's words:
 * "linked to the party's additional bill" only when it added one. A till that does not count what
 * it added is answered as it always was.
 */
export function additionalBillingResultOf(answer: { status?: string; added?: unknown }): AdditionalBillingResult {
  if (answer.status !== "synced") return { status: "plan_only", message: "Items remain in the plan until the main party is settled." };
  if (typeof answer.added !== "number") return { status: "synced", message: ADDITIONAL_BILL_LINKED };
  return { status: "synced", message: answer.added > 0 ? ADDITIONAL_BILL_LINKED : NOTHING_NEW_TO_BILL, added: answer.added };
}

/** SCRUM-1001: the editor's words after a Save the till billed or found nothing new in; null leaves the Save's other words. */
export function additionalBillingToastOf(result: AdditionalBillingResult | null | undefined): { title: string; description?: string } | null {
  if (result?.status !== "synced") return null;
  return result.added === 0 ? { title: "BEO saved, nothing new to bill" } : { title: "BEO saved", description: ADDITIONAL_BILL_LINKED };
}

type SaveLine = { id?: unknown; quantity?: unknown; price?: unknown; included?: unknown; chargeApproved?: unknown; source?: unknown };

/**
 * SCRUM-1001: whether a BEO Save may put a new charge on the party's bills at the till, so the
 * editor asks first only then. The till bills at a Save only once the main bill is settled (its
 * answer `state: sale`), and then only a line staff approved (never a set-menu dish), not included
 * and with a price of its own, above the count it has billed (`beoLines`). The till not read, or a
 * platform from before `beoLines`, is answered yes: the editor asks, as it did before.
 */
export function mayBillAtSave(lines: readonly SaveLine[], reading: TillBillingReading | null | undefined): boolean {
  const priced = lines.filter((line) => line.chargeApproved === true && line.source !== "set_menu" && line.included !== true && typeof line.price === "number" && line.price > 0);
  if (priced.length === 0) return false;
  if (!reading || reading.status !== "ok") return true;
  if (reading.billing.state !== "sale") return false;
  const billed = reading.billing.beoLines;
  if (!billed) return true;
  const counts = new Map(billed.map((line) => [line.lineId, line.billedQuantity]));
  return priced.some((line) => beoQuantityOf(line.quantity) > (counts.get(String(line.id)) ?? 0));
}
