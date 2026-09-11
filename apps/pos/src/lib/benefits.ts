import { BenefitProfile, FnbOrderLine, MenuCategoryDef } from '@/types';
import { menuItemMatchesTarget } from '@/lib/discountTarget';
import { getMenuCategories } from '@/store/catalogStore';

// --- Staff benefits application engine (Task #231) -------------------------
// Pure functions only — no mockApi/runtime-state access here (usage counters
// and audit logging live in mockApi.ts, which calls into this engine). Applied
// ONLY at the F&B order station, in a fixed order: comp -> free items (by
// category) -> credit -> standing % discount. Each stage consumes from what
// remains after the previous stage, so a standing discount can still shave the
// overflow beyond a free-item quota, and credit only has to cover what free
// items didn't already zero out.

/** Stable YYYY-MM-DD (daily) or YYYY-MM (monthly) key for the current period. */
export function benefitPeriodKey(period: 'daily' | 'monthly', now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  if (period === 'monthly') return `${y}-${m}`;
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * An operator's effective profile: their per-operator override if one is
 * set, otherwise their role template. An override REPLACES the template
 * entirely (not a per-primitive merge) — the admin override editor pre-fills
 * a new override from the current effective profile precisely so turning it
 * on doesn't silently blank out a benefit, but once saved, the override is
 * the operator's whole profile. This lets staff explicitly disable a primitive
 * they inherit from their role template (e.g. turn off a Manager's standing
 * discount for one operator) by simply leaving it off in the override editor.
 */
export function resolveEffectiveBenefitProfile(
  template: BenefitProfile | undefined,
  override: BenefitProfile | undefined
): BenefitProfile {
  if (override) return override;
  return {
    comp: template?.comp,
    freeItems: template?.freeItems,
    credit: template?.credit,
    standingDiscount: template?.standingDiscount,
  };
}

/** True when a profile has nothing configured (no benefit to scan/apply). */
export function isEmptyBenefitProfile(profile: BenefitProfile): boolean {
  return (
    !profile.comp &&
    (!profile.freeItems || profile.freeItems.length === 0) &&
    !profile.credit &&
    !profile.standingDiscount
  );
}

// Usage already consumed THIS period, keyed for each primitive that tracks
// usage (comp and the standing discount don't need tracking — they're either
// always-on or unlimited-standing).
export interface BenefitUsageState {
  /** benefitId (FreeItemsBenefit.id) -> qty already redeemed this period */
  freeItemsUsed: Record<string, number>;
  /** ฿ already spent from the periodic credit pool this period */
  creditUsedTHB: number;
}

export const emptyBenefitUsage = (): BenefitUsageState => ({
  freeItemsUsed: {},
  creditUsedTHB: 0,
});

export interface BenefitApplyResult {
  compedTHB: number;
  freeItemsTHB: number;
  creditTHB: number;
  discountTHB: number;
  totalReliefTHB: number;
  /** Free-item quota consumed by this order, per benefit id — commit via mockApi. */
  freeItemUsageDeltas: { benefitId: string; qtyUsed: number }[];
  /** ฿ drawn from the periodic credit pool by this order — commit via mockApi. */
  creditUsedDelta: number;
}

const NO_RELIEF: BenefitApplyResult = {
  compedTHB: 0,
  freeItemsTHB: 0,
  creditTHB: 0,
  discountTHB: 0,
  totalReliefTHB: 0,
  freeItemUsageDeltas: [],
  creditUsedDelta: 0,
};

/**
 * Apply a benefit profile to a set of F&B order lines. Returns the ฿ relief
 * broken out by stage (for the audit trail + receipt) plus the usage deltas
 * the caller must commit (mockApi tracks the actual counters).
 */
export function applyStaffBenefits(
  profile: BenefitProfile,
  usage: BenefitUsageState,
  lines: FnbOrderLine[],
  categories: MenuCategoryDef[] = getMenuCategories()
): BenefitApplyResult {
  const orderSubtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  if (orderSubtotal <= 0) return NO_RELIEF;

  // Comp short-circuits everything else: the whole order is free.
  if (profile.comp) {
    return { ...NO_RELIEF, compedTHB: orderSubtotal, totalReliefTHB: orderSubtotal };
  }

  // Remaining chargeable amount per line, whittled down stage by stage.
  const remaining = lines.map((l) => l.lineTotal);
  const freeItemUsageDeltas: { benefitId: string; qtyUsed: number }[] = [];
  let freeItemsTHB = 0;

  for (const benefit of profile.freeItems ?? []) {
    let quotaLeft = Math.max(0, benefit.quotaPerPeriod - (usage.freeItemsUsed[benefit.id] ?? 0));
    if (quotaLeft <= 0) continue;
    let usedThisBenefit = 0;
    for (let i = 0; i < lines.length; i++) {
      if (quotaLeft <= 0) break;
      const line = lines[i];
      if (remaining[i] <= 0 || line.qty <= 0) continue;
      if (!menuItemMatchesTarget(line.menuItem, benefit.target, categories)) continue;
      const unitPrice = line.lineTotal / line.qty;
      // Cap the requested qty by what the line's REMAINING value can actually
      // fund (an earlier benefit/comp may have already zeroed part of this
      // line), then re-derive amount from that capped qty — never claim more
      // quota than units actually relieved (avoids over-consuming quota when
      // multiple free-item benefits can target the same line).
      const requestedQty = Math.min(quotaLeft, line.qty);
      if (requestedQty <= 0) continue;
      const affordableQty = unitPrice > 0
        ? Math.min(requestedQty, Math.floor(remaining[i] / unitPrice + 1e-9))
        : requestedQty;
      if (affordableQty <= 0) continue;
      const amount = Math.min(Math.round(unitPrice * affordableQty), remaining[i]);
      if (amount <= 0) continue;
      remaining[i] -= amount;
      freeItemsTHB += amount;
      quotaLeft -= affordableQty;
      usedThisBenefit += affordableQty;
    }
    if (usedThisBenefit > 0) freeItemUsageDeltas.push({ benefitId: benefit.id, qtyUsed: usedThisBenefit });
  }

  // Credit: a ฿ pool (whole-bill by default, or category-scoped via
  // `target`) — spends against whatever remains after free items, greedily,
  // line by line, restricted to lines matching the credit's target.
  let creditTHB = 0;
  if (profile.credit) {
    const creditTarget = profile.credit.target ?? { kind: 'fnb' as const };
    let creditLeft = Math.max(0, profile.credit.amountTHB - usage.creditUsedTHB);
    for (let i = 0; i < lines.length && creditLeft > 0; i++) {
      if (remaining[i] <= 0) continue;
      if (!menuItemMatchesTarget(lines[i].menuItem, creditTarget, categories)) continue;
      const take = Math.min(remaining[i], creditLeft);
      remaining[i] -= take;
      creditTHB += take;
      creditLeft -= take;
    }
  }

  // Standing % discount, applied last against whatever is still left — so it
  // also shaves the overflow beyond a free-item quota or the credit pool.
  let discountTHB = 0;
  if (profile.standingDiscount) {
    const target = profile.standingDiscount.target ?? { kind: 'fnb' as const };
    const pct = Math.max(0, Math.min(100, profile.standingDiscount.percent));
    for (let i = 0; i < lines.length; i++) {
      if (remaining[i] <= 0) continue;
      if (!menuItemMatchesTarget(lines[i].menuItem, target, categories)) continue;
      const cut = Math.round(remaining[i] * (pct / 100));
      remaining[i] -= cut;
      discountTHB += cut;
    }
  }

  const totalReliefTHB = freeItemsTHB + creditTHB + discountTHB;
  return {
    compedTHB: 0,
    freeItemsTHB,
    creditTHB,
    discountTHB,
    totalReliefTHB,
    freeItemUsageDeltas,
    creditUsedDelta: creditTHB,
  };
}
