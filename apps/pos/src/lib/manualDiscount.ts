import { CartLine, ManualDiscount } from '@/types';
import { componentKey, lineComponentBases } from '@/lib/pricing';

/** Resolve a single manual discount to a ฿ amount against a given base. */
export function resolveDiscountAmount(d: ManualDiscount, base: number): number {
  if (base <= 0) return 0;
  if (d.type === 'comp') return base;
  if (d.type === 'fixed') return Math.min(Math.max(0, d.value), base);
  // percent
  const pct = Math.max(0, Math.min(100, d.value));
  return Math.min(base, Math.round(base * (pct / 100)));
}

export interface ManualDiscountResult {
  /** Resolved ฿ amount per discount id (live, reconciles with totals). */
  amounts: Record<string, number>;
  lineTotal: number;
  orderTotal: number;
  total: number;
}

/**
 * Compute manual-discount amounts. Line-scope discounts reduce their specific
 * line; order-scope discounts then reduce the running subtotal. Each discount is
 * resolved against what remains, so stacked discounts never push a value below 0.
 *
 * A line-scope discount may target a single component of a line (kids, adults,
 * socks, or one add-on) via `targetComponent`. It then resolves against that
 * component's ฿ base — supplied per line in `componentBases` (lineId →
 * componentKey → ฿ subtotal) — instead of the whole line. The amount is still
 * clamped to the line's remaining total so a line can never go negative even
 * when component and whole-line discounts stack. Callers without component
 * targets (e.g. F&B carts) simply omit `componentBases` and get whole-line math.
 */
export function computeManualDiscount(
  manualDiscounts: ManualDiscount[],
  subtotal: number,
  lineAmounts: Record<string, number>,
  componentBases: Record<string, Record<string, number>> = {}
): ManualDiscountResult {
  const amounts: Record<string, number> = {};

  // Per-line running state, built lazily as discounts reference each line:
  // how much of the whole line is left, and how much of each component is left.
  const lineRemaining: Record<string, number> = {};
  const compRemaining: Record<string, Record<string, number>> = {};

  let lineTotal = 0;
  for (const d of manualDiscounts) {
    if (d.scope !== 'line' || !d.targetLineId) continue;
    const lineId = d.targetLineId;
    if (!(lineId in lineRemaining)) {
      lineRemaining[lineId] = lineAmounts[lineId] ?? 0;
      compRemaining[lineId] = { ...(componentBases[lineId] ?? {}) };
    }
    const remaining = lineRemaining[lineId];

    let base = remaining;
    let key: string | null = null;
    if (d.targetComponent) {
      key = componentKey(d.targetComponent);
      base = compRemaining[lineId][key] ?? 0;
    }

    // Resolve against the component (or whole line) base, then clamp to what's
    // left on the line so stacked discounts never drive the line below 0.
    let amt = resolveDiscountAmount(d, base);
    if (amt > remaining) amt = remaining;
    if (amt < 0) amt = 0;

    amounts[d.id] = amt;
    lineTotal += amt;
    lineRemaining[lineId] = remaining - amt;
    if (key) compRemaining[lineId][key] = base - amt;
  }

  let running = subtotal - lineTotal;
  let orderTotal = 0;
  for (const d of manualDiscounts) {
    if (d.scope === 'order') {
      const amt = resolveDiscountAmount(d, running);
      amounts[d.id] = amt;
      orderTotal += amt;
      running -= amt;
    }
  }

  return { amounts, lineTotal, orderTotal, total: lineTotal + orderTotal };
}

/** Short description of the discount type/value, e.g. "10% off", "฿50 off", "Comp". */
export function formatDiscountDetail(d: ManualDiscount): string {
  if (d.type === 'comp') return 'Comp (100% off)';
  if (d.type === 'percent') return `${d.value}% off`;
  return `฿${d.value} off`;
}

/** Where the discount applies — the item label for line scope, else "Whole order". */
export function formatDiscountTarget(d: ManualDiscount): string {
  if (d.scope === 'line') return d.targetLabel ?? 'Item';
  return 'Whole order';
}

/**
 * Drop any line-scoped manual discounts whose target line no longer exists.
 * Call after any cart mutation that can remove lines so discounts can't orphan.
 * Use this for line types with no breakable components (e.g. F&B carts).
 */
export function dropDiscountsForRemovedLines(
  discounts: ManualDiscount[],
  existingLineIds: Iterable<string>
): ManualDiscount[] {
  const ids = new Set(existingLineIds);
  return discounts.filter((d) => !d.targetLineId || ids.has(d.targetLineId));
}

/**
 * Drop orphaned manual discounts for a ticket cart: those whose target line was
 * removed, AND component-scoped ones whose targeted component is now gone (e.g.
 * kids reduced to 0, an add-on removed). Call after any cart mutation that can
 * remove lines or zero out a component.
 */
export function dropOrphanedDiscounts(
  discounts: ManualDiscount[],
  lines: CartLine[]
): ManualDiscount[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  return discounts.filter((d) => {
    if (!d.targetLineId) return true; // order scope — never orphaned by a line
    const line = byId.get(d.targetLineId);
    if (!line) return false; // line removed
    if (!d.targetComponent) return true; // whole-line discount, line still here
    const bases = lineComponentBases(line);
    return (bases[componentKey(d.targetComponent)] ?? 0) > 0; // component still present
  });
}
