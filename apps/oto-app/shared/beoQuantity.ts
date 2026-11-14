/** A kitchen/bar count as publication 0050 reads it: whole 1..999999, otherwise one. */
export function beoQuantityOf(value: unknown): number {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= 999_999 ? value : 1;
  return typeof value === "string" && /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : 1;
}

/** Step a stored count without text concatenation or leaving the published range. */
export function stepBeoQuantity(value: unknown, direction: -1 | 1): number {
  return Math.min(999_999, Math.max(1, beoQuantityOf(value) + direction));
}
