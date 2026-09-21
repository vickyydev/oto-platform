import { z } from 'zod';

/**
 * zod shapes for the catalog jsonb payloads — the API contract for ticket
 * packages and tax config. Ported 1:1 from the prototype's `types.ts`
 * (TicketType / TierAdultRule / TicketFreebie / TicketCreditRule / TaxConfig),
 * with every ฿ amount stored as integer satang.
 */

export const WWPriceSchema = z.object({
  weekday: z.number().int().nonnegative(),
  weekend: z.number().int().nonnegative(),
});
export type WWPriceShape = z.infer<typeof WWPriceSchema>;

/** prototype TierPriceRule: how a non-base tier derives from the base tier. */
export const TierPriceRuleSchema = z.object({
  mode: z.enum(['manual', 'percent', 'amount']),
  value: z.number().nonnegative(),
});

/**
 * prototype TierAdultRule (lib/pricing.ts resolveAdultLine semantics).
 *
 * A rule that charges a price of its own has to carry one (SCRUM-228): without
 * the refinement, `kind: 'set_price'` with no `price` — or `free_adults` whose
 * overflow is `set_price` with no `price` — stored cleanly and then resolved to
 * ฿0 per adult at the till, with nothing on any screen saying why.
 */
export const TierAdultRuleSchema = z
  .object({
    kind: z.enum(['same_as_kid', 'set_price', 'free_adults']),
    price: WWPriceSchema.optional(),
    freeAdults: z.number().int().nonnegative().optional(),
    overflow: z.enum(['same_as_kid', 'set_price']).optional(),
  })
  .refine((r) => !(r.kind === 'set_price' && !r.price), {
    message: 'An adult rule that sets its own price must carry that price',
    path: ['price'],
  })
  .refine((r) => !(r.kind === 'free_adults' && r.overflow === 'set_price' && !r.price), {
    message: 'An overflow adult price of set_price must carry that price',
    path: ['price'],
  });
export type TierAdultRuleShape = z.infer<typeof TierAdultRuleSchema>;

export const TicketFreebieSchema = z.object({
  id: z.string(),
  kind: z.enum(['adult', 'child', 'addon']),
  addOnId: z.string().optional(),
  quantity: z.number().int().positive(),
  tiers: z.array(z.string()),
});

export const TicketCreditRuleSchema = z.object({
  appliesTo: z.enum(['none', 'adults', 'kids', 'both']),
  basis: z.enum(['full_price', 'fixed', 'percent']),
  value: z.number().nonnegative().optional(),
});

export const TranslationsSchema = z.record(
  z.string(),
  z.object({ name: z.string(), description: z.string().optional() }),
);

export const TicketPackageBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  durationLabel: z.string().min(1),
  hours: z.number().int().positive(),
  prices: z.record(z.string(), WWPriceSchema),
  tierPricing: z.record(z.string(), TierPriceRuleSchema).optional().nullable(),
  adultRules: z.record(z.string(), TierAdultRuleSchema).optional().nullable(),
  freebies: z.array(TicketFreebieSchema).optional().nullable(),
  creditRule: TicketCreditRuleSchema.optional().nullable(),
  gateAccess: z.boolean().optional(),
  translations: TranslationsSchema.optional().nullable(),
  active: z.boolean().optional(),
});
export type TicketPackageBody = z.infer<typeof TicketPackageBodySchema>;

// --- Tax config (prototype TaxConfig, lib/tax.ts) --------------------------

export const TAXABLE_CATEGORIES = [
  'tickets',
  'fnb',
  'bar',
  'drop_off',
  'parties',
  'addons',
  'merch',
  'stored_value',
] as const;
export const TaxableCategorySchema = z.enum(TAXABLE_CATEGORIES);
export type TaxableCategory = z.infer<typeof TaxableCategorySchema>;

export const TaxModeSchema = z.enum(['inclusive', 'exclusive', 'none']);
export type TaxMode = z.infer<typeof TaxModeSchema>;

export const TaxRateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Whole percent, e.g. 7 = 7%. */
  percent: z.number().nonnegative(),
  defaultMode: TaxModeSchema.optional(),
});
export type TaxRateShape = z.infer<typeof TaxRateSchema>;

export const CategoryTaxRuleSchema = z.object({
  category: TaxableCategorySchema,
  taxRateId: z.string().optional(),
  taxMode: TaxModeSchema,
  serviceChargePercent: z.number().nonnegative().optional(),
  taxOnServiceCharge: z.boolean().optional(),
  secondaryTaxRateId: z.string().optional(),
  secondaryTaxMode: TaxModeSchema.optional(),
});
export type CategoryTaxRuleShape = z.infer<typeof CategoryTaxRuleSchema>;

export const TaxConfigSchema = z.object({
  rates: z.array(TaxRateSchema),
  categoryRules: z.array(CategoryTaxRuleSchema),
  discountPlacement: z.enum(['before_tax', 'after_tax']),
});
export type TaxConfigShape = z.infer<typeof TaxConfigSchema>;
