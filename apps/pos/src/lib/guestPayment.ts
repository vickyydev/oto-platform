/**
 * Staging F2 — WHAT THE GUEST STILL OWES, as the customer displays say it.
 *
 * The payment frame carries the stage's figure for the money still to take
 * (`amountSatang`) and the credit taken, or about to be, on the order
 * (`creditSatang`). "Left to pay" is never more than the order less that
 * credit, and never below zero, so a display cannot ask a guest whose credit
 * covers the order to pay the whole order again (the staging drive showed
 * "From your credit ฿60 / Left to pay ฿60 — Please pay our staff").
 *
 * `totalSatang` is the order's total when the frame carries it; without it the
 * stage's figure stands as it is.
 */
export function guestLeftToPaySatang(
  payment: { amountSatang: number; creditSatang?: number | undefined },
  totalSatang?: number | null,
): number {
  const credit = Math.max(0, payment.creditSatang ?? 0);
  const owed = Math.max(0, payment.amountSatang);
  if (credit === 0 || totalSatang === undefined || totalSatang === null || !Number.isFinite(totalSatang)) return owed;
  return Math.min(owed, Math.max(0, Math.round(totalSatang) - credit));
}

/** Whether the credit on the frame covers the order: nothing is asked of the guest. */
export function creditCoversOrder(
  payment: { amountSatang: number; creditSatang?: number | undefined },
  totalSatang?: number | null,
): boolean {
  return (payment.creditSatang ?? 0) > 0 && guestLeftToPaySatang(payment, totalSatang) === 0;
}
