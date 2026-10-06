import { z } from 'zod';

/**
 * S2-14a round 5 — PROMOTIONAL VOUCHERS (plan docs/progress/plans/wallet/PLAN.md
 * §2.7; SPRINT_2_PLAN §S2-14a, the promotional-vouchers paragraph).
 *
 * The landed voucher engine (`apps/api/src/services/vouchers.ts`: kinds, holds,
 * the S2-10b redemption path, `consumeSaleVouchers`) is the model; this file is
 * the words a definition's promotional rules, a till issue, a campaign and the
 * foregone-revenue report may use. The prototype has no promotional-voucher
 * logic (the S2-14a study says so), so every rule here is the requirement's,
 * and what the requirement leaves open is an owner question, never a guess.
 *
 * WHAT A DISCOUNT VOUCHER COMES OFF (`VoucherTarget`). The landed engine took
 * every amount- and percent-off voucher off the ticket rows. A definition may
 * now aim one at a CATEGORY or an ITEM, in the pricing engine's own scopes
 * (`DiscountTarget` in `discount.ts`), so the engine — and its tax attribution
 * by `discountPlacement` (the S2-09a seam) — decides what it takes and where
 * the tax falls. Nothing here re-derives a scope or a tax:
 *
 *   tickets      kids and adults admission (the landed default; null means it)
 *   ticketType   one ticket package — an item at the ticket till
 *   fnb          every menu item
 *   fnbCategory  one menu category (a `product_category` id) and its children
 *   menuItems    named menu products — an item at the F&B till
 *   merch        every shop item
 *
 * A single shop item is not a scope the engine has (`menuItems` matches menu
 * rows only), so it is not offered rather than priced as something else.
 */

export const VOUCHER_TARGET_KINDS = [
  'tickets',
  'ticketType',
  'fnb',
  'fnbCategory',
  'menuItems',
  'merch',
] as const;
export type VoucherTargetKind = (typeof VOUCHER_TARGET_KINDS)[number];

/** At most this many items on one item-scoped voucher. */
export const VOUCHER_TARGET_ITEMS_MAX = 50;

export const VoucherTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tickets') }),
  z.object({ kind: z.literal('ticketType'), ticketTypeId: z.string().uuid() }),
  z.object({ kind: z.literal('fnb') }),
  z.object({ kind: z.literal('fnbCategory'), category: z.string().uuid() }),
  z.object({
    kind: z.literal('menuItems'),
    menuItemIds: z.array(z.string().uuid()).min(1).max(VOUCHER_TARGET_ITEMS_MAX),
  }),
  z.object({ kind: z.literal('merch') }),
]);
export type VoucherTarget = z.infer<typeof VoucherTargetSchema>;

/** A trading day, `YYYY-MM-DD`, judged at the redeeming branch (`businessDate`). */
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');

/** The largest limit a definition may carry: a bigger number is a typo, not a campaign. */
export const VOUCHER_LIMIT_MAX = 1_000_000;

/**
 * A definition's promotional rules, as the voucher-definition routes accept
 * them (create and patch). Every field is optional and null clears it:
 *
 *   target            what a discount voucher comes off (see above); ignored
 *                     — and cleared — for every other kind
 *   usageLimit        how many of this definition's vouchers may be redeemed,
 *                     across every voucher, till and branch (global)
 *   perCustomerLimit  how many one member may redeem; a walk-in is not held to
 *                     it (there is nobody to count against — the promo-code rule)
 *   validFrom/Until   the window, inclusive, on the redeeming branch's trading day
 */
export const VoucherPromoRulesSchema = z.object({
  target: VoucherTargetSchema.nullable().optional(),
  usageLimit: z.number().int().positive().max(VOUCHER_LIMIT_MAX).nullable().optional(),
  perCustomerLimit: z.number().int().positive().max(VOUCHER_LIMIT_MAX).nullable().optional(),
  validFrom: IsoDay.nullable().optional(),
  validUntil: IsoDay.nullable().optional(),
});
export type VoucherPromoRules = z.infer<typeof VoucherPromoRulesSchema>;

/** Whether a trading day falls before, inside or after a definition's window. */
export function voucherWindowOf(
  window: { validFrom: string | null; validUntil: string | null },
  businessDate: string,
): 'before' | 'inside' | 'after' {
  if (window.validFrom && businessDate < window.validFrom) return 'before';
  if (window.validUntil && businessDate > window.validUntil) return 'after';
  return 'inside';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Nov 2026" from `YYYY-MM-DD` — the voucher refusals' own date form. */
export function formatVoucherDay(iso: string): string {
  const [year, month, day] = iso.split('-');
  const name = MONTHS[Number(month) - 1];
  return name && day && year ? `${Number(day)} ${name} ${year}` : iso;
}

/**
 * THE COUNTER'S WORDS for a promotional rule saying no. One place, so the
 * till, the tests and a person reading a refusal later read the same sentence.
 */
export const PROMO_VOUCHER_MESSAGES = {
  notYet: (from: string) => `This voucher can be used from ${formatVoucherDay(from)}`,
  ended: (until: string) => `This promotion ended on ${formatVoucherDay(until)}`,
  usedUp: (limit: number) =>
    limit === 1
      ? 'This promotion is used up — its one redemption has been taken'
      : `This promotion is used up — all ${limit} redemptions have been taken`,
  perCustomer: (limit: number) =>
    `This guest has already used this promotion ${limit === 1 ? 'once' : `${limit} times`} — the limit per guest`,
} as const;

// --- Issue ------------------------------------------------------------------------

/**
 * ISSUE ONE AT THE TILL: a voucher of a definition, minted on the platform and
 * printed on the station's receipt printer as a voucher slip (the booth
 * voucher's template). `memberId` when the guest is a member — what the
 * per-customer limit is later counted against when the redeeming sale names
 * nobody.
 */
export const VoucherIssueBodySchema = z.object({
  definitionId: z.string().uuid(),
  memberId: z.string().uuid().nullable().optional(),
});
export type VoucherIssueBody = z.infer<typeof VoucherIssueBodySchema>;

/** The most codes one campaign mints in one press. */
export const VOUCHER_CAMPAIGN_MAX = 5_000;

/**
 * MINT A CAMPAIGN: a batch of codes of one definition, issued at one branch,
 * each unique (`voucher_code_unique`) and each its own voucher with its own
 * life; the campaign row and its audit row say who minted how many, when.
 */
export const VoucherCampaignBodySchema = z.object({
  definitionId: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z
    .string()
    .max(120)
    .refine((name) => name.trim().length > 0, { message: 'A campaign needs a name' }),
  quantity: z.number().int().min(1).max(VOUCHER_CAMPAIGN_MAX),
});
export type VoucherCampaignBody = z.infer<typeof VoucherCampaignBodySchema>;

// --- Reporting -----------------------------------------------------------------

/**
 * FOREGONE REVENUE FROM PROMOTIONAL VOUCHERS — its own line, separate from
 * discounts (manual discounts and promo codes). One row per definition over the
 * range's trading days at the redeeming branch:
 *
 *   redemptions       vouchers used up on a sale in the range
 *   foregoneSatang    what those sales did not charge for them: each voucher's
 *                     own discount row on its sale (`pos.sale_discount`), which
 *                     is the engine's figure — a free item's shelf price, a
 *                     1+1's kid price, an amount or a percentage as it came off
 *   creditLoadedSatang  for a wallet-credit voucher: the credit it loaded. That
 *                     is stored value (the wallet liability report carries it
 *                     from here), not revenue foregone at the load, so it is
 *                     reported beside the line and never inside it.
 */
export const PromoVoucherReportRowSchema = z.object({
  definitionId: z.string().uuid(),
  definitionCode: z.string(),
  nameEn: z.string(),
  kind: z.string(),
  redemptions: z.number().int(),
  foregoneSatang: z.number().int(),
  creditLoadedSatang: z.number().int(),
});
export type PromoVoucherReportRow = z.infer<typeof PromoVoucherReportRowSchema>;

export const PromoVoucherReportSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  summary: z.object({
    redemptions: z.number().int(),
    foregoneSatang: z.number().int(),
    creditLoadedSatang: z.number().int(),
  }),
  rows: z.array(PromoVoucherReportRowSchema),
});
export type PromoVoucherReport = z.infer<typeof PromoVoucherReportSchema>;

export const PromoVoucherReportQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  from: IsoDay,
  to: IsoDay,
});
