import { z } from 'zod';

/**
 * S2-13 round 3 — PICKUPS AND RELEASE (plan docs/progress/plans/checkin/
 * PLAN.md §2.4), the half both ends share: the wire for the authorised-pickup
 * list and the release, the refusals in the counter's words, and the prepaid
 * food reconciliation in satang.
 *
 * Ported from the prototype: `getAuthorizedPickups`, `addGuardianToRegistration`,
 * `editGuardian`, `addPickupFromChatPhoto` and `checkOut` (`mockApi.ts`), and
 * `computePrepaidFoodReconciliation` (`lib/dropoff.ts`), which worked in baht;
 * this works in satang so a refund is exact to the satang.
 *
 * NEVER, under any flow, is a photo of an identity document taken (C9): every
 * photo here is a person's face — the collector's, or the child with the
 * guardian — and nothing in this wire has a field for anything else.
 */

/** Where a name on the pickup list came from. `dropper_off` is the registration's own guardian. */
export const PICKUP_SOURCES = ['dropper_off', 'in_person', 'from_chat', 'on_the_spot'] as const;
export type PickupSource = (typeof PICKUP_SOURCES)[number];

/** The sources a staff member can ADD (the dropper-off is implicit, never added). */
export const GUARDIAN_ADD_SOURCES = ['in_person', 'from_chat', 'on_the_spot'] as const;
export type GuardianAddSource = (typeof GUARDIAN_ADD_SOURCES)[number];

/** The id the dropper-off carries on the list (prototype `getAuthorizedPickups`). */
export const DROPPER_OFF_PICKUP_ID = 'dropper_off';

/** One person on a registration's authorised-pickup list, as both ends read it. */
export interface PickupView {
  /** `dropper_off` for the registration's own guardian; the guardian row's id otherwise. */
  id: string;
  registrationId: string;
  name: string;
  phone: string | null;
  relationship: string | null;
  /** The stored photo: the sign-up photo for the dropper-off, the captured or chat photo otherwise. */
  photoFileId: string | null;
  isDropperOff: boolean;
  source: PickupSource;
  addedByName: string | null;
  addedAt: string;
}

// --- Refusals (R-92), in the counter's words ----------------------------------------

export const RELEASE_REFUSALS = {
  PICKUP_PHOTO_REQUIRED: 'Take the pickup photo before releasing the child.',
  COLLECTOR_NAME_REQUIRED: "Write down the collector's full name before releasing the child.",
  COLLECTOR_PHOTO_REQUIRED:
    'Take a photo of the collector first — someone who is not on the list is only released with their photo.',
  COLLECTOR_NOT_LISTED:
    "That person is not on this child's pickup list. Add them on the spot with their name and photo, or call the parent.",
  COLLECTOR_REQUIRED: 'Choose who is collecting the child before releasing them.',
} as const;

/** "X is no longer on the pickup list" — the refusal for a revoked collector. */
export function revokedCollectorRefusal(name: string): string {
  return `${name} was taken off the pickup list and cannot collect this child. Add them again on the spot, or call the parent.`;
}

// --- The wire (zod) -------------------------------------------------------------------

const uuid = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Add someone to a registration's list (prototype `addGuardianToRegistration`
 * from the sheet, `addPickupFromChatPhoto` from a chat photo, and the release
 * modal's on-the-spot step). The name and the photo are checked by the
 * service, so a missing one is refused in the counter's words rather than as a
 * schema error. `id` is optional and client-minted (OD-12).
 */
export const AddGuardianSchema = z
  .object({
    id: uuid.optional(),
    name: z.string().trim().max(100),
    relationship: optionalText(100),
    phone: optionalText(40),
    /** A `file_object` uploaded under the registration (or this guardian), never an identity document. */
    photoFileId: uuid.nullable().optional(),
    source: z.enum(GUARDIAN_ADD_SOURCES).default('in_person'),
  })
  .strict();
export type AddGuardianInput = z.infer<typeof AddGuardianSchema>;

/** Edit a listed person (prototype `editGuardian`): name, phone, relationship, photo. */
export const EditGuardianSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    relationship: optionalText(100),
    phone: optionalText(40),
    photoFileId: uuid.nullable().optional(),
  })
  .strict();
export type EditGuardianInput = z.infer<typeof EditGuardianSchema>;

/** Who is collecting: the dropper-off, a listed guardian, or someone added on the spot. */
export const ReleaseCollectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dropper_off') }).strict(),
  z.object({ kind: z.literal('guardian'), guardianId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      kind: z.literal('on_the_spot'),
      /** Optional client-minted id for the guardian row the release adds. */
      guardianId: uuid.optional(),
      name: z.string().trim().max(100).optional(),
      relationship: optionalText(100),
      phone: optionalText(40),
      photoFileId: uuid.nullable().optional(),
    })
    .strict(),
]);
export type ReleaseCollectorInput = z.infer<typeof ReleaseCollectorSchema>;

/**
 * Release a child (prototype `checkOut`). The pickup photo is mandatory and
 * checked by the service (R-92); the verifier is the signed-in account, never
 * a field. `id` is optional and client-minted (OD-12).
 */
export const CreateReleaseSchema = z
  .object({
    id: uuid.optional(),
    collector: ReleaseCollectorSchema,
    pickupPhotoFileId: uuid.nullable().optional(),
    stationId: uuid.nullable().optional(),
  })
  .strict();
export type CreateReleaseInput = z.infer<typeof CreateReleaseSchema>;

// --- Prepaid food reconciliation (satang) ---------------------------------------------

export interface PrepaidReconciliationItem {
  menuItemName: string;
  qty: number;
  redeemedQty: number;
  unredeemedQty: number;
  unitSatang: number;
  unredeemedSatang: number;
}

export interface PrepaidReconciliation {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  remainingCreditSatang: number;
  itemBreakdown: PrepaidReconciliationItem[];
  totalRedeemedSatang: number;
  totalUnusedSatang: number;
}

/** The provision as a stay stores it (`pos.checkin.food_provision`). */
export interface PrepaidProvisionShape {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  creditSatang?: number;
  items?: { menuItemName: string; unitSatang: number; qty: number; redeemedQty: number }[];
}

/**
 * The prototype's `computePrepaidFoodReconciliation`, in satang:
 *   - prepaid_credit: what is left on the band, never more than was paid;
 *   - prepaid_items: each item's unredeemed quantity at its unit price;
 *   - none: nothing.
 */
export function prepaidReconciliationOf(
  provision: PrepaidProvisionShape | null | undefined,
  remainingCreditSatang: number,
): PrepaidReconciliation {
  if (provision?.mode === 'prepaid_credit') {
    const unused = Math.max(0, Math.min(remainingCreditSatang, provision.paidSatang));
    return {
      mode: 'prepaid_credit',
      paidSatang: provision.paidSatang,
      remainingCreditSatang,
      itemBreakdown: [],
      totalRedeemedSatang: provision.paidSatang - unused,
      totalUnusedSatang: unused,
    };
  }
  if (provision?.mode === 'prepaid_items') {
    const itemBreakdown = (provision.items ?? []).map((it) => {
      const unredeemedQty = Math.max(0, it.qty - it.redeemedQty);
      return {
        menuItemName: it.menuItemName,
        qty: it.qty,
        redeemedQty: it.redeemedQty,
        unredeemedQty,
        unitSatang: it.unitSatang,
        unredeemedSatang: unredeemedQty * it.unitSatang,
      };
    });
    const totalUnused = itemBreakdown.reduce((sum, b) => sum + b.unredeemedSatang, 0);
    return {
      mode: 'prepaid_items',
      paidSatang: provision.paidSatang,
      remainingCreditSatang: 0,
      itemBreakdown,
      totalRedeemedSatang: provision.paidSatang - totalUnused,
      totalUnusedSatang: totalUnused,
    };
  }
  return {
    mode: 'none',
    paidSatang: 0,
    remainingCreditSatang: 0,
    itemBreakdown: [],
    totalRedeemedSatang: 0,
    totalUnusedSatang: 0,
  };
}

/** How a release settled the prepaid food (prototype `CheckIn.prepaidFoodSettlement`). */
export interface PrepaidSettlementView {
  policy: 'refund' | 'forfeit';
  unusedSatang: number;
  /** The refund written against the linked sale, when the policy refunded. */
  refundId: string | null;
  /** The satang the refund actually gave back (the refund path clamps to what is left). */
  refundedSatang: number;
  /** Set when the policy refunded but there was no sale to refund against — staff refund by hand. */
  settlementError: 'refund_no_sale' | null;
}

/** A release as both ends read it. */
export interface ReleaseView {
  id: string;
  checkinId: string;
  registrationId: string;
  childName: string;
  guardianId: string | null;
  collectorName: string;
  collectorSource: PickupSource;
  verifiedByAccountId: string;
  verifiedByName: string | null;
  pickupPhotoFileId: string | null;
  stationId: string | null;
  checkedOutAt: string;
  settlement: PrepaidSettlementView | null;
}
