import { z } from 'zod';

const id = z.string().min(1).max(200);
const text = z.string().max(500);
const money = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER / 100)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.001);

/** A captured guest purchase, never a catalog, wallet or staff record. */
export const DisplayMerchCartSchema = z.object({
  kind: z.literal('merch'), supported: z.boolean(),
  lines: z.array(z.object({ id, name: text,
    translations: z.object({ en: text.optional(), th: text.optional(), ru: text.optional(),
      zh: text.optional(), fr: text.optional() }).optional(),
    qty: z.number().int().min(1).max(100_000), unitPrice: money, lineTotal: money,
    variantLabel: text.optional(),
  })).max(200),
  manualDiscounts: z.array(z.object({ id, scope: z.enum(['order', 'line']),
    targetLineId: id.optional(), targetLabel: text.optional(),
    type: z.enum(['percent', 'fixed', 'comp']), value: money,
  })).max(200),
  completion: z.object({ saleId: id, total: money,
    payment: z.object({ cash: money, card: money, promptpay: money }),
  }).nullable(),
}).superRefine((value, ctx) => {
  if (!value.supported && (value.lines.length || value.manualDiscounts.length || value.completion)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An unsupported display must clear its previous purchase' });
  }
  if (value.completion && Math.round(value.completion.total * 100)
    !== Math.round(value.completion.payment.cash * 100) + Math.round(value.completion.payment.card * 100)
      + Math.round(value.completion.payment.promptpay * 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completion', 'payment'], message: 'Paid amounts must match the completed total' });
  }
});
export type DisplayMerchCart = z.infer<typeof DisplayMerchCartSchema>;

export function readDisplayMerchCart(value: unknown, stage: string): DisplayMerchCart | null {
  if (!['welcome', 'order', 'payment', 'thankyou'].includes(stage)) return null;
  const parsed = DisplayMerchCartSchema.safeParse(value);
  if (!parsed.success || parsed.data.supported && (stage === 'thankyou' ? !parsed.data.completion : !!parsed.data.completion)) return null;
  return parsed.data;
}
