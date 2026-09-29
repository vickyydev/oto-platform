import { z } from 'zod';

const id = z.string().min(1).max(200);
const text = z.string().max(500);
const note = z.string().max(1_000);
const money = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER / 100)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.001);
const translations = z.object({
  en: text.optional(), th: text.optional(), ru: text.optional(), zh: text.optional(), fr: text.optional(),
});

/** Captured guest order facts; no catalog, wristband, member or staff record. */
export const DisplayFnbCartSchema = z.object({
  kind: z.literal('fnb'), supported: z.boolean(),
  lines: z.array(z.object({
    id, name: text, translations: translations.optional(), qty: z.number().int().min(1).max(100_000),
    basePrice: money, lineTotal: money,
    modifiers: z.array(z.object({ groupName: text, optionName: text, price: money })).max(100),
    note: note.optional(), variantLabel: text.optional(),
  })).max(200),
  orderNote: note,
  manualDiscounts: z.array(z.object({
    id, scope: z.enum(['order', 'line']), targetLineId: id.optional(), targetLabel: text.optional(),
    type: z.enum(['percent', 'fixed', 'comp']), value: money,
  })).max(200),
  completion: z.object({
    saleId: id, pickupCode: z.string().max(64), total: money,
    payment: z.object({ cash: money, card: money, promptpay: money }),
  }).nullable(),
}).superRefine((value, ctx) => {
  if (!value.supported && (value.lines.length || value.orderNote || value.manualDiscounts.length || value.completion)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An unsupported display must clear its previous order' });
  }
  if (value.completion && Math.round(value.completion.total * 100)
    !== Math.round(value.completion.payment.cash * 100) + Math.round(value.completion.payment.card * 100)
      + Math.round(value.completion.payment.promptpay * 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completion', 'payment'], message: 'Paid amounts must match the completed total' });
  }
});
export type DisplayFnbCart = z.infer<typeof DisplayFnbCartSchema>;

/** Read the finite frame under the same stage rules on box, display and diagnostics. */
export function readDisplayFnbCart(value: unknown, stage: string): DisplayFnbCart | null {
  if (!['welcome', 'order', 'payment', 'thankyou'].includes(stage)) return null;
  const parsed = DisplayFnbCartSchema.safeParse(value);
  if (!parsed.success || parsed.data.supported && (stage === 'thankyou' ? !parsed.data.completion : !!parsed.data.completion)) return null;
  return parsed.data;
}
