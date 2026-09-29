import { z } from 'zod';

const text = z.string().max(500);
const id = z.string().min(1).max(200);
const count = z.number().int().min(0).max(100_000);
const money = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER / 100)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.001);
const taxMode = z.enum(['none', 'inclusive', 'exclusive']);

/** Captured presentation rows; a display never resolves a catalog price. */
export const DisplayLineBreakdownSchema = z.object({
  rows: z.array(z.object({
    key: id, kind: z.enum(['kids', 'adults', 'socks', 'addon']), label: text,
    unitPrice: money, quantity: count, subtotal: money, unpriced: z.boolean().optional(),
  })).max(200),
  priced: z.boolean(), lengthChosen: z.boolean(),
});
const translations = z.object({
  en: text.optional(), th: text.optional(), ru: text.optional(), zh: text.optional(), fr: text.optional(),
});
const component = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kids') }), z.object({ kind: z.literal('adults') }),
  z.object({ kind: z.literal('socks') }), z.object({ kind: z.literal('addon'), addOnId: id }),
]);

export const DisplayCartSchema = z.object({
  supported: z.boolean(), nickname: z.string().max(100),
  sale: z.object({
    id, tier: id, total: money,
    lines: z.array(z.object({
      id, name: text, translations: translations.optional(), lineTotal: money,
      promoItem: z.object({ name: text }).optional(), breakdown: DisplayLineBreakdownSchema,
    })).max(200),
    manualDiscounts: z.array(z.object({
      id, scope: z.enum(['order', 'line']), targetLineId: id.optional(),
      targetComponent: component.optional(), targetLabel: text.optional(),
      type: z.enum(['percent', 'fixed', 'comp']), value: money,
    })).max(200),
    // Issued wallet/band identifiers are deliberately absent from summaries.
    creditGrants: z.array(z.object({
      type: z.enum(['fnb_credit', 'item']), label: text,
      valueTHB: money.optional(), quantity: count.optional(),
    })).max(200),
    bracelets: z.object({ adults: count, children: count }),
  }),
  voucherPrize: z.object({ nameEn: text, nameTh: text.nullable() }).nullable(),
  nothingToPay: z.boolean(),
});
export const DisplayMemberSchema = z.object({ id, nickname: z.string().max(100), tier: id });
export const DisplayTotalsSchema = z.object({
  manualAmounts: z.record(id, money).refine(value => Object.keys(value).length <= 200),
  discountAmount: money, total: money,
  taxBreakdown: z.object({
    serviceChargeTotal: money,
    categories: z.array(z.object({
      taxMode, taxName: text.optional(), tax: money, secondaryTaxMode: taxMode,
      secondaryTaxName: text.optional(), secondaryTax: money,
    })).max(20),
  }),
});
const imageUrl = z.string().max(2_000_000).refine(value => {
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
});
export const DisplayPaymentSchema = z.object({
  saleId: id.nullable(), amountSatang: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  qrPayload: z.string().min(1).max(10_000).nullable(), qrImageUrl: imageUrl.nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(['idle', 'pending', 'paid', 'blocked', 'failed']),
  offline: z.boolean(), online: z.boolean(),
});
export type DisplayCart = z.infer<typeof DisplayCartSchema>;
export type DisplayMember = z.infer<typeof DisplayMemberSchema>;
export type DisplayTotals = z.infer<typeof DisplayTotalsSchema>;
export type DisplayPayment = z.infer<typeof DisplayPaymentSchema>;
export type DisplayLineBreakdown = z.infer<typeof DisplayLineBreakdownSchema>;
