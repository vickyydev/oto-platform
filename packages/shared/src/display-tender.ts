import { z } from 'zod';

const text = z.string().max(500);
const money = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER / 100)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.001);

/**
 * SCRUM-859 — what the tender is for, as a line the family can read beside
 * the amount: the event pass by the event's title, the extra hour by its
 * option and the children it is charged for. A figure and a label only, never
 * the party, the child or the family record. Optional, so a till or box built
 * before it sends none and a display built before it reads none: either keeps
 * the amount-only screen it had.
 */
export const DisplayTenderLineSchema = z.object({
  label: text, qty: z.number().int().min(1).max(100_000),
  unitPrice: money.optional(), lineTotal: money,
});
export type DisplayTenderLine = z.infer<typeof DisplayTenderLineSchema>;

/**
 * Only the purpose and method of a tender, never the party or family record.
 * SCRUM-797 — `extra_hour`: History's Add time charge for extra play.
 */
export const DisplayTenderCartSchema = z.object({
  kind: z.literal('tender'), supported: z.literal(true),
  subject: z.enum(['event_pass', 'party_balance', 'extra_hour']), method: z.enum(['qr', 'card']),
  lines: z.array(DisplayTenderLineSchema).max(50).optional(),
});
export type DisplayTenderCart = z.infer<typeof DisplayTenderCartSchema>;

export function readDisplayTenderCart(value: unknown, stage: string): DisplayTenderCart | null {
  if (stage !== 'payment') return null;
  const parsed = DisplayTenderCartSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
