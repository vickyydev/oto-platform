import { beoKitchenChargesOf } from "./beoExtras";
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
