import { z } from 'zod';

/**
 * Only the purpose and method of a tender, never the party or family record.
 * SCRUM-797 — `extra_hour`: History's Add time charge for extra play.
 */
export const DisplayTenderCartSchema = z.object({
  kind: z.literal('tender'), supported: z.literal(true),
  subject: z.enum(['event_pass', 'party_balance', 'extra_hour']), method: z.enum(['qr', 'card']),
});
export type DisplayTenderCart = z.infer<typeof DisplayTenderCartSchema>;

export function readDisplayTenderCart(value: unknown, stage: string): DisplayTenderCart | null {
  if (stage !== 'payment') return null;
  const parsed = DisplayTenderCartSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
