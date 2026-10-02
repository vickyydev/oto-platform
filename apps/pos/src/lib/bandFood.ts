import { redeemPrepaid } from '@oto/shared';
import type { FnbOrderLine, Wristband } from '@/types';

/**
 * SCRUM-494 — the band as it stands after an order the platform closed: each
 * prepaid line served from the band's entitlements, the design's
 * `redeemPrepaidItem` (`redeemedQty` up, never past `qty`). The platform did
 * this on the child's stay in the transaction that closed the order; this is
 * the till's copy of the band for the order record and the confirmation, so
 * both read what the platform holds. A band with no platform stay serves
 * nothing here.
 */
export function withPrepaidServed(wristband: Wristband, lines: readonly FnbOrderLine[]): Wristband {
  const fp = wristband.foodProvision;
  if (!wristband.stayId || fp?.mode !== 'prepaid_items' || !fp.items?.length) return wristband;
  let items = fp.items;
  for (const line of lines) {
    if (!line.isPrepaid || line.prepaidStayId !== wristband.stayId) continue;
    items = redeemPrepaid(items, line.menuItem.id, line.qty).items;
  }
  return { ...wristband, foodProvision: { ...fp, items } };
}

/** The stay a scanned band names as the order's band holder, with the food-consent override. */
export function bandHolderOf(
  wristband: Wristband | null,
  foodOverride: unknown,
): { checkinId: string; foodOverride?: boolean } | null {
  if (!wristband?.stayId) return null;
  return { checkinId: wristband.stayId, ...(foodOverride ? { foodOverride: true } : {}) };
}
