import { z } from 'zod';
import type { DiscountTarget } from './discount';
import { PRICING_ENGINE_VERSION } from './engine';
import type { Satang } from './money';
import { PROTOTYPE_BAHT_ROUNDING, type RoundingPolicy } from './rounding';

/**
 * Staff benefits — the engine (S2-21, SCRUM-218; plan
 * `docs/progress/plans/benefits/PLAN.md` §3 and §7).
 *
 * A port of the prototype's `lib/benefits.ts` (imports/oto-pos/artifacts/
 * oto-till/src, copied byte for byte to `apps/pos/src/lib/benefits.ts`). The
 * rules are the prototype's and are kept as they are:
 *
 *   - applied in a fixed order: comp → free items → credit → standing
 *     percent. A comp ends the calculation and the whole order is free;
 *     otherwise each stage works on what the stage before it left;
 *   - a free item's relief is capped by the quota left AND by what the line's
 *     remaining value can pay for, and quota is never claimed for a unit that
 *     was not relieved (`benefits.ts:126-145`);
 *   - credit is spent greedily, line by line, on the lines its target covers
 *     (all F&B when it names none);
 *   - the standing percent comes off whatever is left, line by line (all F&B
 *     when it names no target);
 *   - an override, while on, is the person's WHOLE profile, not a per-part
 *     merge (`resolveEffectiveBenefitProfile`, plan Q1).
 *
 * What changes is the money and nothing else:
 *
 *   - **Satang in, satang out.** The prototype carries baht as floats. Every
 *     amount here is an integer in satang, and a fraction exists only inside
 *     one expression that is rounded once (engine.ts, rounding.ts).
 *   - **Whole-baht rounding** (plan Q8's default, `PROTOTYPE_BAHT_ROUNDING`):
 *     a free item's share of a line and a standing percentage round half-up
 *     to the baht, as the prototype's `Math.round` on baht does and as manual
 *     percentage discounts already do (SCRUM-495 #10). The owner can move it
 *     to the satang by passing `DEFAULT_ROUNDING`.
 *   - **Exact ties.** The rounding is done on exact integers. The prototype's
 *     `Math.round(remaining * (pct / 100))` divides first, so for a few
 *     percentages (29, 35, 57, 58, 70, 82 …) an exact half-baht lands a hair
 *     below .5 and rounds DOWN: 70 % of ฿45 is ฿31.50 and the prototype takes
 *     ฿31. Here it is ฿32, the same answer `resolveManualDiscountAmount` gives
 *     the same figure. No seeded percentage (30 %) is affected; the parity test
 *     names the class and pins it (`apps/pos/test/benefits-engine-parity`).
 *   - **A cut never exceeds what the line has left.** With whole-baht prices
 *     the prototype cannot overshoot; with a satang price (฿65.50) at 100 % a
 *     baht-rounded cut would. Clamped, so relief is never more than the bill.
 *
 * Pure: no clock, no store, no network. The period a quota belongs to is the
 * caller's (`benefitPeriodKey` takes the date), and the categories a line sits
 * in come on the line.
 */

// --- Vocabulary -----------------------------------------------------------------

/** The benefit role — separate from the login role (prototype `types.ts:7-12`). */
export const BENEFIT_ROLES = ['owner', 'manager', 'staff'] as const;
export type BenefitRole = (typeof BENEFIT_ROLES)[number];

/** The prototype's template names (`seedRoleBenefitTemplates`, catalogStore.ts:802-841). */
export const BENEFIT_ROLE_NAMES: Record<BenefitRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
};

export const BENEFIT_PERIODS = ['daily', 'monthly'] as const;
export type BenefitPeriod = (typeof BENEFIT_PERIODS)[number];

/**
 * What a benefit may be scoped to: the F&B scopes of the prototype's
 * `DiscountTarget`, which is all a benefit can match at the F&B station
 * (`BenefitTargetSchema` below says why the rest are refused).
 */
export type BenefitTarget = Extract<
  DiscountTarget,
  { kind: 'everything' | 'fnb' | 'fnbCategory' | 'menuItems' }
>;

/** "2 free coffees per day" (prototype `FreeItemsBenefit`, types.ts:488). */
export interface FreeItemsBenefit {
  /** Stable key the period's usage is counted under, e.g. `coffee`. */
  id: string;
  label: string;
  target: BenefitTarget;
  quotaPerPeriod: number;
  period: BenefitPeriod;
}

/** A periodic credit pool (prototype `CreditBenefit`, `amountTHB` there). */
export interface CreditBenefit {
  amountSatang: Satang;
  period: BenefitPeriod;
  /** Absent = all F&B. */
  target?: BenefitTarget;
}

/** A standing percentage off (prototype `PercentDiscountBenefit`). */
export interface PercentDiscountBenefit {
  percent: number;
  /** Absent = all F&B. */
  target?: BenefitTarget;
}

/** One person's, or one role template's, whole benefit (prototype `BenefitProfile`). */
export interface BenefitProfile {
  comp?: boolean;
  freeItems?: FreeItemsBenefit[];
  credit?: CreditBenefit;
  standingDiscount?: PercentDiscountBenefit;
}

/** What has already been used this period (prototype `BenefitUsageState`). */
export interface BenefitUsageState {
  /** Free-item id → quantity already relieved this period. */
  freeItemsUsed: Record<string, number>;
  /** Satang already drawn from the credit pool this period. */
  creditUsedSatang: Satang;
}

export const emptyBenefitUsage = (): BenefitUsageState => ({
  freeItemsUsed: {},
  creditUsedSatang: 0,
});

/**
 * One F&B line as the engine sees it. The F&B order station sells menu items
 * only, which is the only place a benefit applies (R-70).
 */
export interface BenefitLine {
  /** The menu item — what a `menuItems` target names. */
  itemId: string;
  /**
   * The item's own menu category and then its parent: the walk an
   * `fnbCategory` target matches on, exactly as the prototype's
   * `menuItemMatchesTarget` (discountTarget.ts:79-104) asks "is it the item's
   * category, or that category's parent".
   */
  categoryIds: readonly string[];
  qty: number;
  lineTotal: Satang;
}

export interface BenefitApplyResult {
  compedSatang: Satang;
  freeItemsSatang: Satang;
  creditSatang: Satang;
  discountSatang: Satang;
  totalReliefSatang: Satang;
  /** Free-item quota this order uses, per free-item id. */
  freeItemUsageDeltas: { benefitId: string; qtyUsed: number }[];
  /** Satang this order draws from the credit pool. */
  creditUsedDelta: Satang;
  /**
   * The relief on each line, in the order the lines were given, summing to
   * `totalReliefSatang`. The prototype never needed it (it folds the relief
   * into one order-wide discount); the platform records it so the VAT basis
   * comes off the lines that were actually relieved (plan §4, H14).
   */
  lineRelief: Satang[];
  /** Which arithmetic produced these figures (engine.ts). */
  engineVersion: typeof PRICING_ENGINE_VERSION;
}

// --- Profiles -------------------------------------------------------------------

/**
 * A person's effective profile: their override if one is switched on,
 * otherwise their role template. An override REPLACES the template entirely
 * (prototype `resolveEffectiveBenefitProfile`, benefits.ts:33-44; plan Q1).
 */
export function resolveEffectiveBenefitProfile(
  template: BenefitProfile | null | undefined,
  override: BenefitProfile | null | undefined,
): BenefitProfile {
  if (override) return override;
  return {
    comp: template?.comp,
    freeItems: template?.freeItems,
    credit: template?.credit,
    standingDiscount: template?.standingDiscount,
  };
}

/** Nothing configured: no benefit to scan or apply (prototype `isEmptyBenefitProfile`). */
export function isEmptyBenefitProfile(profile: BenefitProfile): boolean {
  return (
    !profile.comp &&
    (!profile.freeItems || profile.freeItems.length === 0) &&
    !profile.credit &&
    !profile.standingDiscount
  );
}

/**
 * The key a period's usage is counted under: `YYYY-MM-DD` for a daily
 * entitlement, `YYYY-MM` for a monthly one (prototype `benefitPeriodKey`).
 *
 * The prototype reads the device's local date. Here the date is an argument:
 * which day it is — calendar midnight or the 05:00 trading day, and on whose
 * clock — is the caller's to decide (plan §4, Q6).
 */
export function benefitPeriodKey(period: BenefitPeriod, isoDate: string): string {
  return period === 'monthly' ? isoDate.slice(0, 7) : isoDate.slice(0, 10);
}

/**
 * Whether a menu item falls inside a benefit's target. The F&B half of the
 * prototype's `menuItemMatchesTarget` (discountTarget.ts:79-104): everything
 * and all-F&B match any menu item, a category matches the item's own category
 * or its parent, named items match by id, and every ticket or shop scope
 * matches nothing at the F&B station.
 */
export function benefitTargetMatches(
  line: Pick<BenefitLine, 'itemId' | 'categoryIds'>,
  target: DiscountTarget,
): boolean {
  switch (target.kind) {
    case 'everything':
    case 'fnb':
      return true;
    case 'fnbCategory':
      return line.categoryIds.includes(target.category);
    case 'menuItems':
      return target.menuItemIds.includes(line.itemId);
    case 'tickets':
    case 'ticketGroup':
    case 'ticketType':
    case 'addOns':
    case 'addOn':
    case 'merch':
    case 'event_pass':
      return false;
  }
}

// --- The engine -----------------------------------------------------------------

const ALL_FNB: DiscountTarget = { kind: 'fnb' };

/** `numerator / denominator`, rounded once, half-up, to the policy's unit. */
function roundedShare(numerator: number, denominator: number, rounding: RoundingPolicy): Satang {
  if (rounding.unit === 'baht') return Math.round(numerator / (denominator * 100)) * 100;
  return Math.round(numerator / denominator);
}

/** Floor of `a / b` for non-negative integers, without a float quotient. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

function noRelief(lineCount: number): BenefitApplyResult {
  return {
    compedSatang: 0,
    freeItemsSatang: 0,
    creditSatang: 0,
    discountSatang: 0,
    totalReliefSatang: 0,
    freeItemUsageDeltas: [],
    creditUsedDelta: 0,
    lineRelief: new Array<Satang>(lineCount).fill(0),
    engineVersion: PRICING_ENGINE_VERSION,
  };
}

/**
 * Apply a benefit profile to an F&B order's lines. Port of the prototype's
 * `applyStaffBenefits` (benefits.ts:98-190): the relief by stage, the usage
 * the caller must claim, and — added here — the relief per line.
 */
export function applyStaffBenefits(
  profile: BenefitProfile,
  usage: BenefitUsageState,
  lines: readonly BenefitLine[],
  rounding: RoundingPolicy = PROTOTYPE_BAHT_ROUNDING,
): BenefitApplyResult {
  const orderSubtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  if (orderSubtotal <= 0) return noRelief(lines.length);

  // A comp ends it: the whole order is free.
  if (profile.comp) {
    return {
      ...noRelief(lines.length),
      compedSatang: orderSubtotal,
      totalReliefSatang: orderSubtotal,
      lineRelief: lines.map((l) => l.lineTotal),
    };
  }

  // What each line still has to pay, whittled down stage by stage.
  const remaining = lines.map((l) => l.lineTotal);
  const freeItemUsageDeltas: { benefitId: string; qtyUsed: number }[] = [];
  let freeItemsSatang = 0;

  for (const benefit of profile.freeItems ?? []) {
    // Own keys only: an id such as `constructor` must not read Object's.
    const used = Object.prototype.hasOwnProperty.call(usage.freeItemsUsed, benefit.id)
      ? (usage.freeItemsUsed[benefit.id] ?? 0)
      : 0;
    let quotaLeft = Math.max(0, benefit.quotaPerPeriod - used);
    if (quotaLeft <= 0) continue;
    let usedThisBenefit = 0;
    for (let i = 0; i < lines.length; i++) {
      if (quotaLeft <= 0) break;
      const line = lines[i]!;
      const left = remaining[i]!;
      if (left <= 0 || line.qty <= 0) continue;
      if (!benefitTargetMatches(line, benefit.target)) continue;
      const requestedQty = Math.min(quotaLeft, line.qty);
      if (requestedQty <= 0) continue;
      // Capped by what the line's REMAINING value can fund (an earlier free
      // item may have taken part of it), so quota is never claimed for a unit
      // that was not relieved. `left / unitPrice` is `left × qty / lineTotal`.
      const affordableQty =
        line.lineTotal > 0
          ? Math.min(requestedQty, floorDiv(left * line.qty, line.lineTotal))
          : requestedQty;
      if (affordableQty <= 0) continue;
      // `unitPrice × affordableQty`, which is `lineTotal × affordableQty / qty`.
      const amount = Math.min(
        roundedShare(line.lineTotal * affordableQty, line.qty, rounding),
        left,
      );
      if (amount <= 0) continue;
      remaining[i] = left - amount;
      freeItemsSatang += amount;
      quotaLeft -= affordableQty;
      usedThisBenefit += affordableQty;
    }
    if (usedThisBenefit > 0)
      freeItemUsageDeltas.push({ benefitId: benefit.id, qtyUsed: usedThisBenefit });
  }

  // Credit: spent greedily against what free items left, on its target's lines.
  let creditSatang = 0;
  if (profile.credit) {
    const target = profile.credit.target ?? ALL_FNB;
    let creditLeft = Math.max(0, profile.credit.amountSatang - usage.creditUsedSatang);
    for (let i = 0; i < lines.length && creditLeft > 0; i++) {
      const left = remaining[i]!;
      if (left <= 0) continue;
      if (!benefitTargetMatches(lines[i]!, target)) continue;
      const take = Math.min(left, creditLeft);
      remaining[i] = left - take;
      creditSatang += take;
      creditLeft -= take;
    }
  }

  // The standing percentage, last, against whatever is still left — so it
  // also shaves the overflow past a free-item quota or the credit pool.
  let discountSatang = 0;
  if (profile.standingDiscount) {
    const target = profile.standingDiscount.target ?? ALL_FNB;
    const pct = Math.max(0, Math.min(100, profile.standingDiscount.percent));
    for (let i = 0; i < lines.length; i++) {
      const left = remaining[i]!;
      if (left <= 0) continue;
      if (!benefitTargetMatches(lines[i]!, target)) continue;
      const cut = Math.min(roundedShare(left * pct, 100, rounding), left);
      remaining[i] = left - cut;
      discountSatang += cut;
    }
  }

  const totalReliefSatang = freeItemsSatang + creditSatang + discountSatang;
  return {
    compedSatang: 0,
    freeItemsSatang,
    creditSatang,
    discountSatang,
    totalReliefSatang,
    freeItemUsageDeltas,
    creditUsedDelta: creditSatang,
    lineRelief: lines.map((l, i) => l.lineTotal - remaining[i]!),
    engineVersion: PRICING_ENGINE_VERSION,
  };
}

// --- What the admin routes accept -----------------------------------------------

/**
 * The targets a benefit may name. The prototype's type allows every
 * `DiscountTarget`, but a benefit is applied only at the F&B station, where a
 * ticket or shop scope matches nothing (`menuItemMatchesTarget`); storing one
 * would be a benefit that silently never applies. Ids are the platform's.
 */
export const BenefitTargetSchema: z.ZodType<BenefitTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everything') }),
  z.object({ kind: z.literal('fnb') }),
  z.object({ kind: z.literal('fnbCategory'), category: z.string().uuid() }),
  z.object({
    kind: z.literal('menuItems'),
    menuItemIds: z.array(z.string().uuid()).min(1).max(50),
  }),
]);

const FreeItemsBenefitSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().max(80),
  target: BenefitTargetSchema,
  quotaPerPeriod: z.number().int().min(1).max(1000),
  period: z.enum(BENEFIT_PERIODS),
});

/** The stored shape of a profile, as it goes out: no cross-field rule. */
export const BenefitProfileShapeSchema = z
  .object({
    comp: z.boolean().optional(),
    freeItems: z.array(FreeItemsBenefitSchema).max(20).optional(),
    credit: z
      .object({
        /** Satang. A ฿1,000,000 pool is a typo, not a benefit. */
        amountSatang: z.number().int().min(0).max(100_000_000),
        period: z.enum(BENEFIT_PERIODS),
        target: BenefitTargetSchema.optional(),
      })
      .optional(),
    standingDiscount: z
      .object({
        percent: z.number().min(0).max(100),
        target: BenefitTargetSchema.optional(),
      })
      .optional(),
  })
  .strict();

/**
 * A profile as a save accepts it. One rule beyond the shape: two free items
 * may not share an id, because a period's usage is counted per id and two
 * entitlements under one key would draw on each other's quota.
 */
export const BenefitProfileSchema = BenefitProfileShapeSchema.refine(
  (p) => new Set((p.freeItems ?? []).map((f) => f.id)).size === (p.freeItems ?? []).length,
  { message: 'Two free items share an id', path: ['freeItems'] },
);
export type BenefitProfileInput = z.infer<typeof BenefitProfileSchema>;
