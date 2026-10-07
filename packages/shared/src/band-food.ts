import { z } from 'zod';
import { formatTHB } from './money';

/**
 * SCRUM-494 (food) — WHAT A SCANNED BAND TELLS THE F&B AND SHOP COUNTERS ABOUT
 * THE CHILD WEARING IT, and the prepaid meal entitlements the parent paid for
 * at the door.
 *
 * The design keeps these on the band (`Wristband.allergiesMedical`,
 * `foodRestrictions`, `mayOrderFood`, `foodProvision`, `checkInId`), copied
 * there from the child's drop-off stay. The platform keeps them on the stay
 * (`pos.checkin`), so the counter's scan resolves the band to the child's stay
 * at this park, in the park, and reads them from there.
 *
 * The entitlements are the design's `prepaid_items` (`types.ts:PrepaidItem`):
 * an item, how many were paid for, and how many have been served. Serving one
 * is the design's `redeemPrepaidItem` (`mockApi.ts:412-424`): at order
 * confirmation, never at add-time, and `redeemedQty` never passes `qty`.
 */

/** One prepaid item on a child's stay, as the counter reads it. */
export interface BandPrepaidItemView {
  /** The menu item (`pos.product.id`) the parent paid for. */
  menuItemId: string;
  menuItemName: string;
  unitSatang: number;
  qty: number;
  redeemedQty: number;
}

export interface BandFoodProvisionView {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  creditSatang: number | null;
  items: BandPrepaidItemView[];
}

/**
 * The child's in-park stay behind a scanned band: the staff-only safety data
 * and the food the parent authorised. Never shown on a customer display.
 */
export interface BandStayView {
  /** `pos.checkin.id` — the stay; the cart names it as the order's band holder. */
  checkinId: string;
  branchId: string;
  childName: string;
  /** The stay's allergies (else the saved child's) and the saved medical notes, joined "; ". */
  allergiesMedical: string | null;
  foodRestrictions: string | null;
  mayOrderFood: boolean;
  foodProvision: BandFoodProvisionView | null;
  /**
   * S2-20 E3 — what the band belongs to: a drop-off or nanny stay (absent on
   * older answers), or an event check-in (`checkinId` is then the
   * `pos.event_checkin` id). An event band carries the allergy and diet lines,
   * `mayOrderFood=false` and no prepaid food (`checkInEventAttendee`,
   * mockApi.ts:3818-3826: "event attendees don't order F&B on wristband credit").
   */
  source?: 'dropoff' | 'event';
}

export const BandScanQuerySchema = z.object({
  /** What was scanned or typed: a band code (full or short), a voucher QR. */
  key: z.string().trim().min(1).max(200),
  /** The counter's park. The stay is looked for here only; omitted = the session's park. */
  branchId: z.string().uuid().optional(),
});

/** What a cart says about the band its F&B order was taken against. */
export const CartBandHolderSchema = z
  .object({
    /** The stay `GET /wallets/scan` answered with. */
    checkinId: z.string().uuid(),
    /**
     * Staff recorded the design's food-consent override for a child whose
     * parent did not authorise food (`FoodConsentModal`). Stamped with the
     * session's account, never a name sent here.
     */
    foodOverride: z.boolean().optional(),
  })
  .strict();
export type CartBandHolderInput = z.infer<typeof CartBandHolderSchema>;

/** On an F&B item line: this line is served from the band holder's prepaid items. */
export const CartPrepaidSchema = z
  .object({
    checkinId: z.string().uuid(),
  })
  .strict();
export type CartPrepaidInput = z.infer<typeof CartPrepaidSchema>;

// --- Refusals, in the counter's words -------------------------------------------------

export const BAND_FOOD_REFUSALS = {
  /** The design's "Food not authorized" banner, word for word. */
  FOOD_NOT_AUTHORIZED: 'Parent did not authorize food orders for this child.',
  STAY_NOT_FOUND: 'This band is not checked in at the park any more — scan it again.',
  PREPAID_NEEDS_BAND: 'A prepaid item is served only against the band it was prepaid on — scan the band again.',
  PREPAID_NO_OPTIONS: 'A prepaid item is served as it was prepaid — take the options off, or ring it up as a paid item.',
} as const;

export function bandNotInParkRefusal(childName: string): string {
  return `${childName} is not in the park, so food cannot be ordered against their band.`;
}

export function bandOtherParkRefusal(childName: string): string {
  return `${childName} was checked in at another park, so their band cannot be used at this counter.`;
}

export function prepaidNotEntitledRefusal(itemName: string, childName: string): string {
  return `${itemName} is not one of ${childName}'s prepaid items.`;
}

export function prepaidUsedUpRefusal(itemName: string, childName: string, left: number): string {
  return left <= 0
    ? `${childName}'s prepaid ${itemName} has already been served.`
    : `${childName} has only ${left} prepaid ${itemName} left to serve.`;
}

/**
 * A prepaid item already on another order that has not been paid yet: it is
 * held for that order until the order is paid or cancelled.
 */
export function prepaidHeldRefusal(itemName: string, childName: string): string {
  return `${childName}'s prepaid ${itemName} is on another order that is still open — finish or cancel that order first.`;
}

/** The child was collected while this order was still open: their prepaid food was settled at pickup. */
export function prepaidStayClosedRefusal(childName: string): string {
  return `${childName} has already been collected, so their prepaid food cannot be served on this order — cancel it and ring the order up again.`;
}

// --- At registration: what the parent prepaid --------------------------------------

/** A prepaid item the park's menu does not sell here. */
export function prepaidItemNotOnMenuRefusal(itemName: string, childName: string): string {
  return `${itemName} is not on this park's menu, so it cannot be prepaid for ${childName} — choose the prepaid food again.`;
}

/** A prepaid item priced at something other than today's menu price. */
export function prepaidItemPriceRefusal(itemName: string, childName: string, todaySatang: number): string {
  return `${itemName} is ${formatTHB(todaySatang)} on today's menu — choose ${childName}'s prepaid food again.`;
}

/** The amount paid for the prepaid items is not what the items add up to. */
export function prepaidPaidMismatchRefusal(childName: string, itemsSatang: number, paidSatang: number): string {
  return `${childName}'s prepaid food comes to ${formatTHB(itemsSatang)}, not ${formatTHB(paidSatang)} — choose the prepaid food again.`;
}

// --- The arithmetic -------------------------------------------------------------------

/** One stored entitlement: the fields the arithmetic reads. */
export interface PrepaidEntitlement {
  menuItemId: string;
  qty: number;
  redeemedQty: number;
}

/** How many of an item are still to be served, across every entry for it. */
export function prepaidRemainingOf(items: readonly PrepaidEntitlement[], menuItemId: string): number {
  return items
    .filter((it) => it.menuItemId === menuItemId)
    .reduce((sum, it) => sum + Math.max(0, it.qty - it.redeemedQty), 0);
}

/**
 * Serve `qty` of an item from the entitlements (the design's
 * `redeemPrepaidItem`): `redeemedQty` goes up and never passes `qty`, entry by
 * entry in the order they were paid for. Returns the new list and how many
 * were actually taken off — less than asked when fewer were left.
 */
export function redeemPrepaid<T extends PrepaidEntitlement>(
  items: readonly T[],
  menuItemId: string,
  qty: number,
): { items: T[]; applied: number } {
  let wanted = Math.max(0, Math.floor(qty));
  let applied = 0;
  const next = items.map((it) => {
    if (wanted <= 0 || it.menuItemId !== menuItemId) return { ...it };
    const take = Math.min(wanted, Math.max(0, it.qty - it.redeemedQty));
    wanted -= take;
    applied += take;
    return { ...it, redeemedQty: it.redeemedQty + take };
  });
  return { items: next, applied };
}

/** The allergy / medical line: the parts present, joined the way the band paper joins them. */
export function allergiesMedicalOf(allergies: string | null | undefined, medicalNotes: string | null | undefined): string | null {
  const parts = [allergies?.trim(), medicalNotes?.trim()].filter((v): v is string => !!v);
  return parts.length ? parts.join('; ') : null;
}
