import { CheckIn, CartLine, TicketType, CustomerTier, DropOffServiceType, ChildFoodProvision, ChildFoodProvisionMode, DropOffPricing as CatalogDropOffPricing } from '@/types';
import {
  bahtFromSatang,
  dropOffFees,
  satangFromBaht,
  type DropOffFeeLine,
  type DropOffPricing as SharedDropOffPricing,
} from '@oto/shared';
import { computeLineTotal, priceForTier } from '@/lib/pricing';
import { RateMode, resolveRate, todayRateMode } from '@/lib/pricingMode';

// Minutes left before a child's booked play time runs out. Below this, "due soon".
export const DUE_SOON_MINUTES = 15;

// Plain-number view of the catalog's drop-off pricing config, resolved for one
// rate mode. All fee math in this file works off concrete numbers — never the
// raw WeekdayWeekendPrice shape — so callers must resolve once via
// resolveDropOffPricing before passing pricing into these functions.
export interface DropOffPricing {
  oneTimeFeeTHB: number;
  nannyHourlyRateTHB: number;
  extraHourTHB: number;
  fullDayHours: number;
  nannyRatioSoftMax: number;
  prepaidFoodRefundPolicy: 'refund' | 'forfeit';
}

/** Resolve the catalog's (weekday/weekend) drop-off pricing config to plain numbers for one rate mode. */
export function resolveDropOffPricing(
  pricing: CatalogDropOffPricing,
  mode: RateMode = todayRateMode().mode,
): DropOffPricing {
  return {
    oneTimeFeeTHB: resolveRate(pricing.oneTimeFeeTHB, mode),
    nannyHourlyRateTHB: resolveRate(pricing.nannyHourlyRateTHB, mode),
    extraHourTHB: resolveRate(pricing.extraHourTHB, mode),
    fullDayHours: pricing.fullDayHours,
    nannyRatioSoftMax: pricing.nannyRatioSoftMax,
    prepaidFoodRefundPolicy: pricing.prepaidFoodRefundPolicy,
  };
}

/**
 * The drop-off service charge for a SINGLE child (not group-aware): a flat
 * one-time fee for plain drop-off, or the nanny hourly rate × hours. Used as the
 * provisional fee on a freshly-built line; normalizeDropOffFees re-derives the
 * shared nanny fee across the cart. (Mirrors getDropOffPricing — the venue config
 * is the backend seam.)
 */
export function dropOffServiceFee(
  service: DropOffServiceType,
  hours: number,
  pricing: DropOffPricing,
): number {
  if (service === 'nanny') return pricing.nannyHourlyRateTHB * Math.max(0, hours);
  if (service === 'drop_off') return pricing.oneTimeFeeTHB;
  return 0; // 'none' — child is self-sufficient, no service fee
}

/**
 * Build a drop-off cart line from a registered child: a single kid (kids:1,
 * adults:0, socks:0, addOns:[]) whose play time is priced by the chosen ticket
 * and whose drop-off/nanny fee rides in lineTotal via the `dropOff` metadata.
 * Supervised hours always follow the chosen play ticket. Staff must explicitly
 * pick the length: until `lengthChosen` is true the line is unpriced (the caller
 * passes a placeholder ticket only to satisfy the type). buildCreditGrants mints
 * nothing extra for it but still counts the child toward the printed bracelets.
 */
export function makeDropOffLine(args: {
  ci: CheckIn;
  ticket: TicketType;
  tier: CustomerTier;
  service: DropOffServiceType;
  lengthChosen: boolean;
  nannyId?: string;
  nannyName?: string;
  pricing: DropOffPricing;
}): CartLine {
  const { ci, ticket, tier, service, lengthChosen, nannyId, nannyName, pricing } = args;
  const hours = ticket.hours;
  const serviceFeeTHB = lengthChosen ? dropOffServiceFee(service, hours, pricing) : 0;
  // When the child has prepaid food provision, add its cost to the line total so
  // the Till cart total and the tax engine both see the correct amount. The amount
  // is NOT a credit grant (see buildCreditGrants gotcha) — it's a bare line-level charge.
  const foodTHB = lengthChosen ? (ci.foodProvision?.paidTHB ?? 0) : 0;
  return {
    id: `line-${ci.id}`,
    ticketType: ticket,
    tier,
    kids: 1,
    adults: 0,
    socks: 0,
    addOns: [],
    lineTotal: lengthChosen ? priceForTier(ticket, tier) + serviceFeeTHB + foodTHB : 0,
    dropOff: {
      registrationId: ci.registrationId,
      checkInId: ci.id,
      childName: ci.childName,
      childAge: ci.childAge,
      dateOfBirth: ci.dateOfBirth,
      allergiesMedical: ci.allergiesMedical,
      mayOrderFood: ci.mayOrderFood,
      foodRestrictions: ci.foodRestrictions,
      foodProvision: ci.foodProvision,
      service,
      hours,
      lengthChosen,
      nannyId: service === 'nanny' ? nannyId : undefined,
      nannyName: service === 'nanny' ? nannyName : undefined,
      serviceFeeTHB,
    },
  };
}

/** The till's baht pricing as the shared fee law reads it (satang). */
function pricingInSatang(pricing: DropOffPricing): SharedDropOffPricing {
  return {
    oneTimeFee: satangFromBaht(pricing.oneTimeFeeTHB),
    nannyHourly: satangFromBaht(pricing.nannyHourlyRateTHB),
    extraHour: satangFromBaht(pricing.extraHourTHB),
    fullDayHours: pricing.fullDayHours,
    nannyRatioSoftMax: pricing.nannyRatioSoftMax,
    prepaidFoodUnused: pricing.prepaidFoodRefundPolicy,
  };
}

/**
 * Re-derive every drop-off line's fee + lineTotal across the whole cart so the
 * nanny fee is charged ONCE per nanny (shared by the siblings she covers), while
 * plain drop-off kids each keep their own one-time fee. For each assigned nanny
 * the fee = rate × the LONGEST play-ticket length among her covered length-chosen
 * kids, placed on the group's "owner" line (the longest-hours one; first wins
 * ties) and 0 on her other covered lines — so summing lineTotals counts it once.
 * Unassigned nanny lines carry a provisional own fee; unconfigured lines are 0.
 * Non-drop-off lines pass through untouched.
 *
 * S2-13 (round-1 fix, finding R2): THE FEE IS THE SHARED LAW'S. The figures
 * come from `dropOffFees` in `@oto/shared` — the one port of this rule that
 * the api reads too — so a child who OPTED IN to the safety flow at service
 * 'none' pays no service fee (R-86, "the safety flow without the fee"). The
 * prototype's own `else` branch here charged the flat fee to every non-nanny
 * line, 'none' included, and the platform takes the till's figure as given;
 * the plan corrects the prototype on this point. Everything else — the flat
 * fee, once-per-nanny on her longest child, first wins a tie — is unchanged.
 */
export function normalizeDropOffFees(
  lines: CartLine[],
  pricing: DropOffPricing,
): CartLine[] {
  const feeLines: DropOffFeeLine[] = [];
  for (const l of lines) {
    const d = l.dropOff;
    if (!d) continue;
    feeLines.push({
      id: l.id,
      service: d.service,
      hours: l.ticketType.hours,
      lengthChosen: d.lengthChosen,
      nannyId: d.nannyId ?? null,
    });
  }
  const fees = dropOffFees(feeLines, pricingInSatang(pricing));

  return lines.map((l) => {
    const d = l.dropOff;
    if (!d) return l;
    const hours = l.ticketType.hours;
    if (!d.lengthChosen) {
      return { ...l, lineTotal: 0, dropOff: { ...d, hours, serviceFeeTHB: 0 } };
    }
    const serviceFeeTHB = bahtFromSatang(fees.get(l.id) ?? 0);
    // Preserve any prepaid food amount that was captured at door consent.
    // computeLineTotal only sees the ticket + extras; food provision was added
    // as a separate charge in makeDropOffLine and must survive every fee
    // re-derivation so lineTotal, tax inputs, and check-in sale totals stay in sync.
    const foodTHB = d.foodProvision?.paidTHB ?? 0;
    return {
      ...l,
      // Price the child's ticket + socks + add-ons + service fee + food provision.
      lineTotal: computeLineTotal({ ...l, serviceFeeTHB }) + foodTHB,
      dropOff: { ...d, hours, serviceFeeTHB },
    };
  });
}

// One nanny's supervision charge across the kids she covers in this sale, for the
// order summary (a single shared row). Pending = a nanny line with no nanny yet.
export interface NannyGroup {
  key: string;
  nannyId?: string;
  nannyName?: string;
  hours: number; // shared = longest covered length
  fee: number;
  childNames: string[];
  assigned: boolean;
}

/**
 * Group the cart's length-chosen nanny lines for display: one row per assigned
 * nanny (fee = rate × longest covered length), plus one pending row per still-
 * unassigned nanny line. Fees mirror normalizeDropOffFees so the rows reconcile
 * to the cart subtotal.
 */
export function computeNannyGroups(
  lines: CartLine[],
  pricing: DropOffPricing,
): NannyGroup[] {
  const assigned = new Map<string, NannyGroup>();
  const pending: NannyGroup[] = [];
  for (const l of lines) {
    const d = l.dropOff;
    if (!d || !d.lengthChosen || d.service !== 'nanny') continue;
    const h = l.ticketType.hours;
    if (d.nannyId) {
      const g = assigned.get(d.nannyId);
      if (g) {
        g.childNames.push(d.childName);
        g.hours = Math.max(g.hours, h);
      } else {
        assigned.set(d.nannyId, {
          key: `n-${d.nannyId}`,
          nannyId: d.nannyId,
          nannyName: d.nannyName,
          hours: h,
          fee: 0,
          childNames: [d.childName],
          assigned: true,
        });
      }
    } else {
      pending.push({
        key: `p-${l.id}`,
        hours: h,
        fee: 0,
        childNames: [d.childName],
        assigned: false,
      });
    }
  }
  const groups = [...assigned.values(), ...pending];
  for (const g of groups) g.fee = pricing.nannyHourlyRateTHB * Math.max(0, g.hours);
  return groups;
}

// --- Prepaid food reconciliation at pickup --------------------------------

export interface PrepaidFoodItemBreakdown {
  menuItemName: string;
  qty: number;
  redeemedQty: number;
  unredeemedQty: number;
  unitPriceTHB: number;
  unredeemedValueTHB: number;
}

export interface PrepaidFoodReconciliation {
  mode: ChildFoodProvisionMode;
  paidTHB: number;
  /** prepaid_credit only: the band's current remaining balance. */
  remainingCreditTHB: number;
  /** prepaid_items only: per-item redemption breakdown. */
  itemBreakdown: PrepaidFoodItemBreakdown[];
  /** Value that was actually consumed (paidTHB − totalUnusedTHB). */
  totalRedeemedTHB: number;
  /** Total unused amount — this is the refund or forfeit candidate. */
  totalUnusedTHB: number;
}

/**
 * Pure math: compute what part of a child's prepaid food provision went unused.
 * Called in the check-out flow so staff see a clear summary before confirming.
 *
 * prepaid_credit → unused = the band's remaining creditBalanceTHB (all child-
 *   prepaid credit, none can have arrived from the admission ticket for a drop-off
 *   child), capped at paidTHB so a top-up after check-in doesn't inflate it.
 * prepaid_items  → unused = items where redeemedQty < qty, valued at paid price.
 * none           → everything is 0 (caller should skip the reconciliation prompt).
 */
export function computePrepaidFoodReconciliation(
  provision: ChildFoodProvision,
  /** Band's current creditBalanceTHB — only relevant for prepaid_credit mode. */
  remainingCreditTHB: number,
): PrepaidFoodReconciliation {
  if (provision.mode === 'prepaid_credit') {
    const unused = Math.max(0, Math.min(remainingCreditTHB, provision.paidTHB));
    return {
      mode: provision.mode,
      paidTHB: provision.paidTHB,
      remainingCreditTHB,
      itemBreakdown: [],
      totalRedeemedTHB: provision.paidTHB - unused,
      totalUnusedTHB: unused,
    };
  }

  if (provision.mode === 'prepaid_items') {
    const items = provision.items ?? [];
    const itemBreakdown: PrepaidFoodItemBreakdown[] = items.map((it) => {
      const unredeemedQty = Math.max(0, it.qty - it.redeemedQty);
      return {
        menuItemName: it.menuItemName,
        qty: it.qty,
        redeemedQty: it.redeemedQty,
        unredeemedQty,
        unitPriceTHB: it.unitPriceTHB,
        unredeemedValueTHB: unredeemedQty * it.unitPriceTHB,
      };
    });
    const totalUnused = itemBreakdown.reduce((s, b) => s + b.unredeemedValueTHB, 0);
    return {
      mode: provision.mode,
      paidTHB: provision.paidTHB,
      remainingCreditTHB: 0,
      itemBreakdown,
      totalRedeemedTHB: provision.paidTHB - totalUnused,
      totalUnusedTHB: totalUnused,
    };
  }

  return {
    mode: 'none',
    paidTHB: 0,
    remainingCreditTHB: 0,
    itemBreakdown: [],
    totalRedeemedTHB: 0,
    totalUnusedTHB: 0,
  };
}

export type DueState = 'ok' | 'due_soon' | 'overdue';

/**
 * Minutes remaining for an in-park child: bookedDurationMinutes − elapsed since
 * checkedInAt. Returns null when it can't be computed (not in park, no booked
 * duration, or never checked in) so callers can fall back to plain elapsed time.
 */
export function remainingMinutes(c: CheckIn, now: number = Date.now()): number | null {
  if (c.status !== 'in_park' || !c.checkedInAt || c.bookedDurationMinutes == null) {
    return null;
  }
  const elapsedMin = (now - new Date(c.checkedInAt).getTime()) / 60_000;
  return c.bookedDurationMinutes - elapsedMin;
}

/** Bucket a remaining-minutes value into ok / due-soon / overdue. */
export function dueState(rem: number | null): DueState {
  if (rem == null) return 'ok';
  if (rem <= 0) return 'overdue';
  if (rem < DUE_SOON_MINUTES) return 'due_soon';
  return 'ok';
}

/** Format remaining time: "1h 05m left" / "12m left" / "25m over". */
export function formatRemaining(rem: number): string {
  const over = rem <= 0;
  const totalMin = Math.max(0, Math.round(Math.abs(rem)));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const body = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return over ? `${body} over` : `${body} left`;
}
