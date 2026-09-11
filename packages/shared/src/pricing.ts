import type { RateMode } from './pricing-mode';
import { resolveRate } from './pricing-mode';
import type { Satang, WWPrice } from './money';
import type { TierAdultRuleShape } from './catalog-shapes';

/**
 * Ticket pricing — a faithful port of the prototype's `lib/pricing.ts`
 * (priceForTier / resolveAdultLine / line total), pure and in satang, used by
 * the API to compute booking totals server-side. The rules are the approved
 * behaviour:
 *   - kid price: the package's per-tier {weekday, weekend} pair; a tier with
 *     no entry is "not priced" and resolves to 0 (defensive, as in the
 *     prototype).
 *   - adults per tier: same_as_kid (default when absent) | set_price |
 *     free_adults (first N free, overflow at kid price or the set price).
 */
export interface PackagePricingShape {
  prices: Record<string, WWPrice>;
  adultRules?: Record<string, TierAdultRuleShape> | null;
}

export function priceForTier(pkg: PackagePricingShape, tier: string, mode: RateMode): Satang {
  return resolveRate(pkg.prices[tier], mode);
}

export interface ResolvedAdultLine {
  freeCount: number;
  paidCount: number;
  paidUnit: Satang;
  total: Satang;
}

/** Port of prototype `resolveAdultLine` (lib/pricing.ts:42) — free count is per LINE. */
export function resolveAdultLine(
  pkg: PackagePricingShape,
  tier: string,
  adults: number,
  mode: RateMode,
): ResolvedAdultLine {
  const kidPrice = priceForTier(pkg, tier, mode);
  const rule = pkg.adultRules?.[tier];
  if (!rule || rule.kind === 'same_as_kid') {
    return { freeCount: 0, paidCount: adults, paidUnit: kidPrice, total: adults * kidPrice };
  }
  if (rule.kind === 'set_price') {
    const unit = resolveRate(rule.price, mode);
    return { freeCount: 0, paidCount: adults, paidUnit: unit, total: adults * unit };
  }
  // free_adults
  const freeCount = Math.min(adults, Math.max(0, rule.freeAdults ?? 0));
  const paidCount = adults - freeCount;
  const paidUnit = rule.overflow === 'set_price' ? resolveRate(rule.price, mode) : kidPrice;
  return { freeCount, paidCount, paidUnit, total: paidCount * paidUnit };
}

export interface TicketLineInput {
  pkg: PackagePricingShape;
  tier: string;
  kids: number;
  adults: number;
}

export interface TicketLineBreakdown {
  kidUnit: Satang;
  kidsTotal: Satang;
  adults: ResolvedAdultLine;
  lineTotal: Satang;
}

/** Kids + adults line total (socks/add-ons are till-side scope, M2). */
export function computeTicketLine(input: TicketLineInput, mode: RateMode): TicketLineBreakdown {
  const kidUnit = priceForTier(input.pkg, input.tier, mode);
  const kidsTotal = input.kids * kidUnit;
  const adults = resolveAdultLine(input.pkg, input.tier, input.adults, mode);
  return { kidUnit, kidsTotal, adults, lineTotal: kidsTotal + adults.total };
}
