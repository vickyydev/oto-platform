import { z } from 'zod';
import { BENEFIT_ONLINE_ONLY_STAGES, type BenefitScopeDay } from './benefit-credential';
import {
  BENEFIT_ROLES,
  BenefitTargetSchema,
  type BenefitApplyResult,
  type BenefitLine,
  type BenefitProfile,
  type BenefitRole,
} from './benefits';
import type { ManualDiscount } from './discount';
import { ITEM_LINE_PACKAGE_KEY } from './item-cart';
import type { Satang } from './money';
import type { TicketCartLine } from './pricing';

/**
 * Staff benefits at checkout (S2-21, SCRUM-218, round 3 of
 * docs/progress/plans/benefits/PLAN.md §3, §4 and §8): what the till, the
 * platform and the box share about a benefit on an F&B order.
 *
 * THE PROTOTYPE'S SHAPE, KEPT (`pages/OrderStation.tsx:109-141`, plan §3). The
 * relief is worked out on the order's own lines by the engine
 * (`applyStaffBenefits`) and lands on the bill as ONE order-scope manual
 * discount with the reason "Staff benefit" and the note
 * `Scanned: <name> (<role>)` — `comp` for an owner's comp, otherwise `fixed`
 * for the total relief — after the order's other manual discounts and before
 * any promo code (plan Q11's default).
 *
 * WHAT CHANGES, and only for reliability (plan §4):
 *
 *   - **The figures are the platform's.** The till names the benefit by the QR
 *     it scanned and a client-minted application id (`CartBenefitSchema`); the
 *     relief is recomputed on every quote and at the commit from the stored
 *     profile and the stored usage, and nothing the till computed is used.
 *   - **The discount is the platform's.** A till never sends the "Staff
 *     benefit" row itself; one sent among its manual discounts is refused
 *     (`BENEFIT_DISCOUNT_UNLINKED`), and the one the platform builds is linked
 *     to its application (`pos.sale_discount.benefit_application_id`).
 *   - **It names its lines** (`staffBenefitDiscount` → `lineShares`), so the
 *     relief comes off the VAT basis of the lines that were relieved (H14).
 *   - **Offline, only what carries no quota** (`offlineBenefitProfile`): the
 *     comp and the standing percent. Free items and credit are online only.
 */

/** The reason the "Staff benefit" row carries — the prototype's word, kept. */
export const STAFF_BENEFIT_REASON = 'Staff benefit';

/**
 * Is this a "Staff benefit" reason, however a till spelled or spaced it? Read
 * as it prints: compatibility forms folded (NFKC — a no-break or full-width
 * space, full-width letters), and every character that prints as nothing
 * dropped (format characters such as a zero-width space or joiner, a soft
 * hyphen, a bidi mark, and the other default-ignorable code points such as a
 * variation selector), before the spacing and the case are folded (H16).
 */
export function isStaffBenefitReason(reason: string | null | undefined): boolean {
  return (
    (reason ?? '')
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase() === 'staff benefit'
  );
}

/**
 * The benefit on a cart, as the till sends it with every quote and with the
 * commit. The QR is presented again each time — the platform verifies it on
 * every pricing and keeps no copy — and `applicationId` is minted once per
 * scan, so a retried or re-rung commit claims the quota once.
 */
export const CartBenefitSchema = z.object({
  /** Minted by the till when the QR is scanned (UUIDv7). The application's idempotency key. */
  applicationId: z.string().uuid(),
  /** The scanned or typed benefit QR. Verified, never stored, never echoed. */
  code: z.string().min(1).max(512),
  /**
   * The relief the till was last shown, in satang. Never charged: a commit
   * whose recompute comes to LESS — the last coffee taken at another till
   * since the order was priced — is refused `BENEFIT_QUOTA_EXHAUSTED` rather
   * than recorded at a figure nobody showed the guest.
   */
  expectedReliefSatang: z.number().int().min(0).optional(),
});
export type CartBenefitInput = z.infer<typeof CartBenefitSchema>;

/** Why a benefit was not applied at checkout. The credential's own refusals are `BENEFIT_CREDENTIAL_REFUSALS`. */
export const BENEFIT_CHECKOUT_REFUSALS = {
  /** The last free item or the last satang of credit went to another order first (H1). */
  QUOTA_EXHAUSTED: 'BENEFIT_QUOTA_EXHAUSTED',
  /** A "Staff benefit" manual discount with no benefit application behind it (H16). */
  DISCOUNT_UNLINKED: 'BENEFIT_DISCOUNT_UNLINKED',
  /** Scanned anywhere but the F&B order station (R-70, plan Q5). */
  FNB_ONLY: 'BENEFIT_FNB_ONLY',
  /** The application already paid for a closed sale. */
  ALREADY_USED: 'BENEFIT_APPLICATION_USED',
  /** The sale's benefit was taken off (or moved to a corrected order): it is rung up again. */
  RELEASED: 'BENEFIT_APPLICATION_RELEASED',
  /** An offline sale's benefit, re-priced with the engine version it was priced with, disagrees (H12). */
  OFFLINE_DRIFT: 'BENEFIT_OFFLINE_DRIFT',
  /** An offline sale priced with an engine this platform does not have. */
  OFFLINE_ENGINE: 'BENEFIT_OFFLINE_ENGINE_UNSUPPORTED',
} as const;

/** The words for them. The prototype has none of these refusals; they are the platform's. */
export const BENEFIT_CHECKOUT_WORDS = {
  quotaExhausted: (name: string) =>
    `${name}'s free items or staff credit were used at another till since this order was priced. The order has been priced again — check it with the guest before taking payment.`,
  unlinked:
    'A "Staff benefit" discount comes from scanning a staff benefit QR (Staff benefit), not from the discount list.',
  fnbOnly: 'A staff benefit applies at the F&B order station only.',
  alreadyUsed: (receipt: string | null) =>
    receipt
      ? `This staff benefit was already used on receipt ${receipt}. Scan the QR again for a new order.`
      : 'This staff benefit was already used on another order. Scan the QR again for a new order.',
  released:
    'The staff benefit was taken off this order after it was rung up. Ring the order up again before taking payment.',
  /** Beside a stage a box does not apply (plan §1, "When the box is offline"). */
  onlineOnly: 'Online only',
} as const;

// --- The lines a benefit reads --------------------------------------------------

/**
 * The F&B lines of a priced cart, as the benefit engine reads them: every menu
 * item line, in cart order, with its own category walk. Ticket lines, shop
 * lines and a voucher's free item are not F&B lines a benefit can relieve; a
 * prepaid line is priced ฿0 and the engine passes over it.
 */
export function benefitLinesOf(cartLines: readonly TicketCartLine[]): {
  lines: BenefitLine[];
  cartLineIds: string[];
} {
  const lines: BenefitLine[] = [];
  const cartLineIds: string[] = [];
  for (const line of cartLines) {
    if (line.packageId !== ITEM_LINE_PACKAGE_KEY) continue;
    const item = line.addOns[0];
    if (!item || item.itemKind !== 'menu') continue;
    lines.push({
      itemId: item.id,
      categoryIds: item.categoryIds ?? [],
      qty: item.quantity,
      lineTotal: line.lineTotal,
    });
    cartLineIds.push(line.id);
  }
  return { lines, cartLineIds };
}

/**
 * What a box may apply of a person's benefit with the link down: the comp and
 * the standing percent, which carry no quota. Free items and credit draw on a
 * quota that lives in the cloud (plan §4, R-48) and are left out.
 */
export function offlineBenefitProfile(
  facts: Pick<BenefitScopeDay, 'comp' | 'standingDiscount'>,
): BenefitProfile {
  const profile: BenefitProfile = {};
  if (facts.comp) profile.comp = true;
  if (facts.standingDiscount) {
    profile.standingDiscount = {
      percent: facts.standingDiscount.percent,
      ...(facts.standingDiscount.target ? { target: facts.standingDiscount.target } : {}),
    };
  }
  return profile;
}

// --- The discount it lands as ---------------------------------------------------

/** The prototype's note on the row (`OrderStation.tsx:269`): whose QR, and their benefit role. */
export function staffBenefitNote(name: string, role: BenefitRole | null): string {
  return `Scanned: ${name} (${role ?? 'staff'})`;
}

/**
 * The "Staff benefit" row an application lands on the bill as — built by the
 * platform (and by a box offline) from the engine's result, never by a till.
 *
 * Its id is the application's, so the row, its amount (`manualAmounts[id]`)
 * and its application are one key. `comp` for an owner's comp, otherwise
 * `fixed` for the total relief; each line's relief is its share. Null when the
 * engine found nothing to relieve: no row, as the prototype writes none.
 */
export function staffBenefitDiscount(input: {
  applicationId: string;
  result: BenefitApplyResult;
  cartLineIds: readonly string[];
  name: string;
  benefitRole: BenefitRole | null;
}): ManualDiscount | null {
  const { result } = input;
  if (result.totalReliefSatang <= 0) return null;
  const isComp = result.compedSatang > 0;
  return {
    id: input.applicationId,
    scope: 'order',
    type: isComp ? 'comp' : 'fixed',
    value: isComp ? 0 : result.totalReliefSatang,
    reason: STAFF_BENEFIT_REASON,
    note: staffBenefitNote(input.name, input.benefitRole),
    lineShares: result.lineRelief
      .map((amount, index) => ({ lineId: input.cartLineIds[index] ?? '', amount }))
      .filter((share) => share.amount > 0 && share.lineId !== ''),
  };
}

// --- What a quote and a sale say about it ---------------------------------------

/** One line's share of the relief. */
export const BenefitLineReliefSchema = z.object({
  cartLineId: z.string(),
  reliefSatang: z.number().int().min(0),
});

/**
 * The benefit on an order as the till draws it — the four amounts the
 * prototype's `StaffBenefitBreakdown` shows, from the platform (or, offline,
 * from the box). Never the QR.
 */
export const BenefitBreakdownSchema = z.object({
  applicationId: z.string().uuid(),
  employeeId: z.string().uuid(),
  credentialId: z.string().uuid(),
  /** The staff member whose QR it is (prototype `scannedOperatorName`). */
  name: z.string(),
  benefitRole: z.enum(BENEFIT_ROLES),
  isComp: z.boolean(),
  compedSatang: z.number().int().min(0),
  freeItemsSatang: z.number().int().min(0),
  creditSatang: z.number().int().min(0),
  discountSatang: z.number().int().min(0),
  totalReliefSatang: z.number().int().min(0),
  /**
   * What came off the bill: the total relief, or less when the order's own
   * manual discounts had already taken part of it (the cascade caps, H15).
   */
  appliedSatang: z.number().int().min(0),
  /** Free items and credit the person has that were NOT applied: a box offline says "online only". */
  onlineOnly: z.array(z.enum(BENEFIT_ONLINE_ONLY_STAGES)),
  /** Each relieved line's share of the relief, by the till's cart line id. */
  lines: z.array(BenefitLineReliefSchema),
  /** Which arithmetic produced it (engine.ts). */
  engineVersion: z.string(),
  /** Who priced it: the platform, or this counter's box with the link down. */
  source: z.enum(['platform', 'box']),
});
export type BenefitBreakdown = z.infer<typeof BenefitBreakdownSchema>;

/**
 * An offline benefit as a box records it in the sale's fact — the QR is NOT
 * in it. The platform re-prices the comp and the standing percent from its own
 * profile with the engine version named here and refuses a disagreement
 * (`BENEFIT_OFFLINE_DRIFT`, H12); nothing here is used for money unchecked.
 */
export const OfflineBenefitRecordSchema = z.object({
  applicationId: z.string().uuid(),
  credentialId: z.string().uuid(),
  employeeId: z.string().uuid(),
  name: z.string().max(160),
  benefitRole: z.enum(BENEFIT_ROLES),
  /** The trading day the box resolved the person's facts for. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isComp: z.boolean(),
  compedSatang: z.number().int().min(0),
  discountSatang: z.number().int().min(0),
  totalReliefSatang: z.number().int().min(0),
  onlineOnly: z.array(z.enum(BENEFIT_ONLINE_ONLY_STAGES)).max(2),
  /** The standing percent the box applied, as its scope carried it. */
  standingDiscount: z
    .object({ percent: z.number().min(0).max(100), target: BenefitTargetSchema.optional() })
    .nullable(),
  engineVersion: z.string().min(1).max(40),
});
export type OfflineBenefitRecord = z.infer<typeof OfflineBenefitRecordSchema>;

/** Each relieved line's share, by cart line id, from the engine's per-line relief. */
export function benefitLineRelief(
  result: Pick<BenefitApplyResult, 'lineRelief'>,
  cartLineIds: readonly string[],
): { cartLineId: string; reliefSatang: Satang }[] {
  return result.lineRelief
    .map((reliefSatang, index) => ({ cartLineId: cartLineIds[index] ?? '', reliefSatang }))
    .filter((line) => line.reliefSatang > 0 && line.cartLineId !== '');
}
