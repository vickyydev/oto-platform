import { z } from 'zod';
import { isoDateInTz } from './dates';
import { formatTHB } from './money';

/**
 * HELD SALES (SCRUM-774) — the till's "Hold sale" and "Save as partly paid".
 *
 * A held sale is an open (`tendering`) sale parked in the branch's Held sales
 * list under the customer's name or band, with an optional note. Any till at
 * the branch may resume it and take the balance. Nothing is issued while it is
 * held — no bands, no receipt, no check-in, no wallet credit: all of that
 * happens on the call that brings the balance to zero, as for any sale.
 *
 * `held` took no money; `part_paid` was parked after a part payment and shows
 * the amount paid and the balance. Which one a sale is is read from its money,
 * never from what a till said it was.
 */
export const SALE_HOLD_KIND_VALUES = ['held', 'part_paid'] as const;
export const SaleHoldKindSchema = z.enum(SALE_HOLD_KIND_VALUES);
export type HeldSaleKind = z.infer<typeof SaleHoldKindSchema>;

export const HOLD_LABEL_MAX = 80;
export const HOLD_NOTE_MAX = 200;

/**
 * The reason the midnight job voids a held sale nobody came back for, as the
 * void report and History read it.
 */
export const HELD_SALE_NOT_COLLECTED = 'not collected';

/** A held sale is part-paid exactly when money was taken on it. */
export function heldSaleKindOf(paidSatang: number): HeldSaleKind {
  return paidSatang > 0 ? 'part_paid' : 'held';
}

/**
 * THE MIDNIGHT RULE — a held sale still in the list when the calendar day it
 * was parked on ends in the branch's timezone (00:00, the park's day end for
 * this list) has outlived its day. This is deliberately the calendar
 * midnight, NOT the 05:00 business-day boundary every report counts on: the
 * park closes in the evening, and a sale nobody collected by midnight is not
 * coming back. Nothing else in the platform moves to this boundary.
 */
export function holdOutlivedItsDay(heldAt: Date, now: Date, timeZone: string): boolean {
  return isoDateInTz(now, timeZone) > isoDateInTz(heldAt, timeZone);
}

export const SaleHoldBodySchema = z.object({
  /** What the till's button said: `held` (Hold sale) or `part_paid` (Save as partly paid). */
  kind: SaleHoldKindSchema,
  /** The customer's name or band the sale is parked under. */
  label: z
    .string()
    .trim()
    .min(1, 'Say whose sale this is — the customer’s name or their band')
    .max(HOLD_LABEL_MAX),
  note: z.string().trim().max(HOLD_NOTE_MAX).nullish(),
  actionId: z.string().min(1).max(200).optional(),
});
export type SaleHoldBody = z.infer<typeof SaleHoldBodySchema>;

export const SaleResumeBodySchema = z.object({
  actionId: z.string().min(1).max(200).optional(),
});
export type SaleResumeBody = z.infer<typeof SaleResumeBodySchema>;

const PersonSchema = z.object({ accountId: z.string().uuid(), name: z.string().nullable() });

/** One sale in the branch's Held sales list, with its money read live. */
export const HeldSaleSchema = z.object({
  holdId: z.string().uuid(),
  saleId: z.string().uuid(),
  branchId: z.string().uuid(),
  kind: SaleHoldKindSchema,
  label: z.string(),
  note: z.string().nullable(),
  grossSatang: z.number().int(),
  paidSatang: z.number().int(),
  balanceSatang: z.number().int(),
  businessDate: z.string(),
  heldAt: z.string(),
  heldBy: PersonSchema,
  heldStation: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
  /** Set when the midnight job left this part-paid sale for the manager. */
  flaggedAt: z.string().nullable(),
});
export type HeldSale = z.infer<typeof HeldSaleSchema>;

export const HeldSalesAnswerSchema = z.object({
  branchId: z.string().uuid(),
  sales: z.array(HeldSaleSchema),
  counts: z.object({ held: z.number().int(), partPaid: z.number().int() }),
});
export type HeldSalesAnswer = z.infer<typeof HeldSalesAnswerSchema>;

export const SaleHoldAnswerSchema = z.object({
  replay: z.boolean(),
  hold: HeldSaleSchema,
});
export type SaleHoldAnswer = z.infer<typeof SaleHoldAnswerSchema>;

export const SaleResumeAnswerSchema = z.object({
  replay: z.boolean(),
  saleId: z.string().uuid(),
  /** The till the sale now belongs to: its receipt and bands print here. */
  stationId: z.string().uuid(),
  kind: SaleHoldKindSchema,
  label: z.string(),
  note: z.string().nullable(),
  grossSatang: z.number().int(),
  paidSatang: z.number().int(),
  balanceSatang: z.number().int(),
});
export type SaleResumeAnswer = z.infer<typeof SaleResumeAnswerSchema>;

// --- The End of Day's view ------------------------------------------------------

/**
 * An open sale of the day, as the End of Day shows it: a held sale (no money)
 * or a part-paid one (held or still on a till's screen).
 */
export const EodOpenSaleSchema = z.object({
  saleId: z.string().uuid(),
  kind: SaleHoldKindSchema,
  /** The hold's name or band; the member's name; else "Walk-in". */
  label: z.string(),
  /** Parked in Held sales, or still open on a till. */
  held: z.boolean(),
  stationName: z.string().nullable(),
  grossSatang: z.number().int(),
  paidSatang: z.number().int(),
  balanceSatang: z.number().int(),
  flaggedAt: z.string().nullable(),
});
export type EodOpenSale = z.infer<typeof EodOpenSaleSchema>;

export const EodOpenSalesSchema = z.object({
  held: z.number().int(),
  partPaid: z.number().int(),
  rows: z.array(EodOpenSaleSchema),
});
export type EodOpenSales = z.infer<typeof EodOpenSalesSchema>;

/** How many part-paid sales a refusal names before it says "and N more". */
const NAMED_IN_REFUSAL = 3;

/**
 * THE END OF DAY'S REFUSAL while a sale is partly paid, in the words the till
 * shows before the press and the platform answers after it:
 *
 *   End of Day cannot close: 1 sale is partly paid — Khun Anna (in Held
 *   sales), ฿200 paid, balance ฿350. Take the balance or refund what was paid,
 *   from Held sales on a till, then close the day.
 *
 * Null when nothing part-paid stands in the way.
 */
export function partPaidCloseRefusal(rows: readonly EodOpenSale[]): string | null {
  const partPaid = rows.filter((r) => r.kind === 'part_paid');
  if (partPaid.length === 0) return null;
  const named = partPaid.slice(0, NAMED_IN_REFUSAL).map((r) => {
    const where = r.held ? 'in Held sales' : `open on ${r.stationName ?? 'a till'}`;
    return `${r.label} (${where}), ${formatTHB(r.paidSatang)} paid, balance ${formatTHB(r.balanceSatang)}`;
  });
  const more = partPaid.length - named.length;
  const count = `${partPaid.length} sale${partPaid.length === 1 ? ' is' : 's are'} partly paid`;
  const anyOnScreen = partPaid.some((r) => !r.held);
  const how = anyOnScreen
    ? 'Take the balance, or save it as partly paid and refund what was paid from Held sales on a till, then close the day.'
    : 'Take the balance or refund what was paid, from Held sales on a till, then close the day.';
  return `End of Day cannot close: ${count} — ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}. ${how}`;
}
