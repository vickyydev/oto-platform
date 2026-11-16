/** All source facts that affect billing eligibility, identity, amount or tax attribution. */
export function beoBillingFingerprint(line: Record<string, unknown>, area: "food" | "bar"): string {
  return JSON.stringify([area, line.id, line.itemName, line.quantity, line.price, line.included, line.productCode, line.source, line.chargeApproved]);
}

export function billingSyncAfterAttempt(line: Record<string, unknown>, area: "food" | "bar", expected: string, status: string): string | undefined {
  if (beoBillingFingerprint(line, area) === expected) return status;
  return line.chargeApproved === true && line.source !== "set_menu" ? "pending" : typeof line.billingSync === "string" ? line.billingSync : undefined;
}
