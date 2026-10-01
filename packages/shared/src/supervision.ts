import { z } from 'zod';
import type { Satang } from './money';
import type { RateMode } from './pricing-mode';

/**
 * S2-13 — CHILD SUPERVISION: the policy, the resolver and the fee law.
 *
 * A faithful port of the prototype's two pure modules, so the till, the api
 * and (round 4) the box all decide the same thing from the same code:
 *
 *   - `lib/supervision.ts` — which service a child of a given age needs, what
 *     a staff waiver does to it, when the waiver is OFFERED (never applied),
 *     and the confirmations checklist (prototype lines 15-164);
 *   - `lib/dropoff.ts` — the flat drop-off fee, the nanny's hourly fee charged
 *     ONCE per nanny on her longest child's ticket, and prepaid food riding as
 *     a line charge (prototype lines 21-228), in satang rather than baht.
 *
 * The prototype's resolver reads the live catalogue store when no policy is
 * passed; here the policy is always passed — the api reads it from
 * `pos.supervision_policy`, the till from the platform's answer — so nothing
 * in this file has a default it could silently fall back to except the named
 * seed constants below, which ARE the prototype's seed.
 */

// --- Vocabulary ------------------------------------------------------------------

export const SUPERVISION_REQUIREMENTS = ['nanny', 'drop_off', 'none'] as const;
/** Prototype `SupervisionRequirement` (types.ts:2030). */
export type SupervisionRequirement = (typeof SUPERVISION_REQUIREMENTS)[number];

/** One age band → one requirement. `maxAge: null` = the open-ended top band. */
export interface SupervisionBand {
  id: string;
  label: string;
  minAge: number;
  maxAge: number | null;
  requirement: SupervisionRequirement;
}

export interface SiblingWaiverPolicy {
  enabled: boolean;
  /** A sibling this age or older can cover a younger child (default 9). */
  guardianMinAge: number;
  /** Which requirement may be waived (default drop_off). */
  waivableRequirement: SupervisionRequirement;
  /** Only staff may accept a waiver (OD-C3: enforced by permission). */
  staffOnly: boolean;
}

export interface ConfirmationItem {
  id: string;
  text: string;
  required: boolean;
  order: number;
}

export interface SupervisionPolicy {
  bands: SupervisionBand[];
  siblingWaiver: SiblingWaiverPolicy;
  confirmations: ConfirmationItem[];
}

/** One ticked confirmation, frozen with its wording and its moment. */
export interface AcknowledgedConfirmation {
  itemId: string;
  text: string;
  acknowledgedAt: string;
}

/** The prototype's seed policy (store/catalogStore.ts:695-712). */
export const DEFAULT_SUPERVISION_POLICY: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [
    { id: 'confirm-15min', text: 'I will remain within 15 minutes of the venue', required: true, order: 0 },
    { id: 'confirm-no-refund', text: 'I understand early pickup does not qualify for refund', required: true, order: 1 },
    { id: 'confirm-evac', text: 'I acknowledge the emergency evacuation point', required: true, order: 2 },
  ],
};

// --- The resolver (prototype lib/supervision.ts) -----------------------------------

function bandContains(band: SupervisionBand, age: number): boolean {
  if (age < band.minAge) return false;
  if (band.maxAge === null) return true;
  return age <= band.maxAge;
}

/**
 * The service the park requires of a child of this age. An age no band
 * covers resolves to 'none' — the prototype's rule (lib/supervision.ts:27-40),
 * which also logs a warning; the caller that cares about a gap in the bands
 * checks `bandFor` itself.
 */
export function resolveRequirement(age: number, policy: SupervisionPolicy): SupervisionRequirement {
  return bandFor(age, policy)?.requirement ?? 'none';
}

/** The band an age falls in, or null when the policy has a gap there. */
export function bandFor(age: number, policy: SupervisionPolicy): SupervisionBand | null {
  return policy.bands.find((b) => bandContains(b, age)) ?? null;
}

/** A waived child drops to 'none' (no drop-off line, no check-in). */
export function effectiveRequirement(
  requirement: SupervisionRequirement,
  waived: boolean,
): SupervisionRequirement {
  return waived ? 'none' : requirement;
}

export interface SupervisionOutcome {
  /** The badge-facing requirement after any staff waiver. */
  effective: SupervisionRequirement;
  /** True when the child runs the full consent / photo / allergy / food capture. */
  needsConsent: boolean;
  /**
   * The service on the resulting drop-off line, or null for a plain ticket.
   * 'none' here is a REAL opted-in line at a zero fee, not "no line".
   */
  service: SupervisionRequirement | null;
}

/**
 * The safety FLOW decoupled from the FEE (R-86): a mandatory requirement runs
 * the full flow; a genuinely-'none' child may opt in to the identical flow at
 * no fee; a requirement WAIVED down to 'none' stays a plain ticket
 * (lib/supervision.ts:76-87).
 */
export function resolveSupervisionOutcome(
  requirement: SupervisionRequirement,
  waived: boolean,
  optIn: boolean | undefined,
): SupervisionOutcome {
  const effective = effectiveRequirement(requirement, waived);
  if (effective === 'nanny' || effective === 'drop_off') {
    return { effective, needsConsent: true, service: effective };
  }
  const optedIn = requirement === 'none' && !!optIn;
  return { effective, needsConsent: optedIn, service: optedIn ? 'none' : null };
}

export interface ResolvedChildRequirement {
  id: string;
  age: number;
  requirement: SupervisionRequirement;
  /**
   * The sibling waiver COULD apply to this child: enabled, this child's base
   * requirement is the waivable one, and some OTHER child in the group is old
   * enough to cover. Offered, never auto-applied.
   */
  waiverEligible: boolean;
}

/** Every child's requirement plus `waiverEligible`, judged across the group. */
export function resolveGroupRequirements(
  children: readonly { id: string; age: number }[],
  policy: SupervisionPolicy,
): ResolvedChildRequirement[] {
  const { siblingWaiver } = policy;
  return children.map((c) => {
    const requirement = resolveRequirement(c.age, policy);
    const waiverEligible =
      siblingWaiver.enabled &&
      requirement === siblingWaiver.waivableRequirement &&
      children.some((other) => other.id !== c.id && other.age >= siblingWaiver.guardianMinAge);
    return { id: c.id, age: c.age, requirement, waiverEligible };
  });
}

/**
 * The sibling a waiver names: the OLDEST other child old enough to cover
 * (the prototype's choice, pages/Till.tsx resolveSupervisionGate). Null when
 * no child in the group may cover — which is exactly when a waiver must be
 * refused, including after an age edit took the cover away.
 */
export function coveringSibling<T extends { id: string; age: number }>(
  children: readonly T[],
  childId: string,
  policy: SupervisionPolicy,
): T | null {
  const candidates = children
    .filter((o) => o.id !== childId && o.age >= policy.siblingWaiver.guardianMinAge)
    .sort((a, b) => b.age - a.age);
  return candidates[0] ?? null;
}

/**
 * Why a waiver for this child and this sibling may NOT be accepted, in the
 * counter's words, or null when it may. The server's check of what the till
 * offered: the same three conditions as `waiverEligible`, against the two
 * named children.
 */
export function waiverRefusal(
  input: { childAge: number; siblingAge: number; waivedRequirement: SupervisionRequirement },
  policy: SupervisionPolicy,
): string | null {
  const { siblingWaiver } = policy;
  if (!siblingWaiver.enabled) return 'The sibling waiver is switched off at this park.';
  const requirement = resolveRequirement(input.childAge, policy);
  if (requirement !== input.waivedRequirement) {
    return `A ${input.childAge}-year-old needs ${requirementLabel(requirement)}, not ${requirementLabel(input.waivedRequirement)} — check the age.`;
  }
  if (requirement !== siblingWaiver.waivableRequirement) {
    return `${requirementLabel(requirement)} cannot be waived for a sibling — only ${requirementLabel(siblingWaiver.waivableRequirement)} can.`;
  }
  if (input.siblingAge < siblingWaiver.guardianMinAge) {
    return `The sibling must be at least ${siblingWaiver.guardianMinAge} to cover a younger child.`;
  }
  return null;
}

/** What the counter calls each requirement. */
export function requirementLabel(requirement: SupervisionRequirement): string {
  return requirement === 'nanny' ? 'a nanny' : requirement === 'drop_off' ? 'drop-off' : 'no supervision';
}

// --- Confirmations -------------------------------------------------------------------

export function sortedConfirmations(policy: SupervisionPolicy): ConfirmationItem[] {
  return [...policy.confirmations].sort((a, b) => a.order - b.order);
}

export function requiredConfirmationIds(policy: SupervisionPolicy): string[] {
  return policy.confirmations.filter((c) => c.required).map((c) => c.id);
}

export function confirmationsSatisfied(policy: SupervisionPolicy, acknowledgedIds: readonly string[]): boolean {
  return requiredConfirmationIds(policy).every((id) => acknowledgedIds.includes(id));
}

/** The audited records (item, wording, moment) for every ticked confirmation. */
export function buildAcknowledgedConfirmations(
  policy: SupervisionPolicy,
  acknowledgedIds: readonly string[],
  acknowledgedAt: string = new Date().toISOString(),
): AcknowledgedConfirmation[] {
  return sortedConfirmations(policy)
    .filter((c) => acknowledgedIds.includes(c.id))
    .map((c) => ({ itemId: c.id, text: c.text, acknowledgedAt }));
}

// --- The fee law (prototype lib/dropoff.ts) ------------------------------------------

/** Weekday / weekend pairs, as `pos.drop_off_pricing` stores them. */
export interface DropOffPricingConfig {
  oneTimeFee: { weekday: Satang; weekend: Satang };
  nannyHourly: { weekday: Satang; weekend: Satang };
  /** DISPLAY ONLY — overstay is shown, never billed (S2-13 excludes overstay billing). */
  extraHour: { weekday: Satang; weekend: Satang };
  fullDayHours: number;
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}

/** The config resolved for one rate mode — plain numbers, as the prototype's fee math wants. */
export interface DropOffPricing {
  oneTimeFee: Satang;
  nannyHourly: Satang;
  extraHour: Satang;
  fullDayHours: number;
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}

/** The prototype's seed: ฿225 flat, ฿330 an hour, ฿300 an extra hour, 8 h day, ratio 3, refund. */
export const DEFAULT_DROP_OFF_PRICING: DropOffPricingConfig = {
  oneTimeFee: { weekday: 22_500, weekend: 22_500 },
  nannyHourly: { weekday: 33_000, weekend: 33_000 },
  extraHour: { weekday: 30_000, weekend: 30_000 },
  fullDayHours: 8,
  nannyRatioSoftMax: 3,
  prepaidFoodUnused: 'refund',
};

export function resolveDropOffPricing(config: DropOffPricingConfig, mode: RateMode): DropOffPricing {
  return {
    oneTimeFee: config.oneTimeFee[mode],
    nannyHourly: config.nannyHourly[mode],
    extraHour: config.extraHour[mode],
    fullDayHours: config.fullDayHours,
    nannyRatioSoftMax: config.nannyRatioSoftMax,
    prepaidFoodUnused: config.prepaidFoodUnused,
  };
}

/** Rate × hours, in whole satang (hours may be fractional: 1.5 h). */
function hourly(rate: Satang, hours: number): Satang {
  return Math.round(rate * Math.max(0, hours));
}

/**
 * One child's service fee, not group-aware (lib/dropoff.ts:43-51): the flat
 * fee for drop-off, the hourly rate × hours for a nanny, nothing for 'none'.
 */
export function dropOffServiceFee(
  service: SupervisionRequirement,
  hours: number,
  pricing: DropOffPricing,
): Satang {
  if (service === 'nanny') return hourly(pricing.nannyHourly, hours);
  if (service === 'drop_off') return pricing.oneTimeFee;
  return 0;
}

/** A supervised cart line, as the fee law reads it. */
export interface DropOffFeeLine {
  id: string;
  service: SupervisionRequirement;
  /** The chosen play ticket's length — supervised hours always follow it. */
  hours: number;
  /** False until staff pick the length; such a line does not enter the cart. */
  lengthChosen: boolean;
  nannyId?: string | null;
}

/**
 * Every supervised line's service fee across the WHOLE cart
 * (lib/dropoff.ts:118-169, `normalizeDropOffFees`):
 *
 *   - plain drop-off: each child its own flat fee;
 *   - a nanny: charged ONCE, rate × the LONGEST length among the children she
 *     covers, placed on that longest child's line (first wins a tie) and 0 on
 *     her other lines — so summing the lines counts her once;
 *   - a nanny line with no nanny yet: a provisional fee of its own, so the
 *     running total stays real;
 *   - 'none' (opted in): 0 — the safety flow without a fee (R-86);
 *   - a line whose length is not chosen: 0, and it does not enter the cart.
 */
export function dropOffFees(lines: readonly DropOffFeeLine[], pricing: DropOffPricing): Map<string, Satang> {
  const ownerByNanny = new Map<string, string>();
  const hoursByNanny = new Map<string, number>();
  for (const l of lines) {
    if (!l.lengthChosen || l.service !== 'nanny' || !l.nannyId) continue;
    const prev = hoursByNanny.get(l.nannyId);
    if (prev === undefined || l.hours > prev) {
      hoursByNanny.set(l.nannyId, l.hours);
      ownerByNanny.set(l.nannyId, l.id);
    }
  }
  const fees = new Map<string, Satang>();
  for (const l of lines) {
    if (!l.lengthChosen) {
      fees.set(l.id, 0);
    } else if (l.service === 'nanny') {
      if (l.nannyId) {
        fees.set(
          l.id,
          ownerByNanny.get(l.nannyId) === l.id ? hourly(pricing.nannyHourly, hoursByNanny.get(l.nannyId) ?? 0) : 0,
        );
      } else {
        fees.set(l.id, hourly(pricing.nannyHourly, l.hours));
      }
    } else if (l.service === 'drop_off') {
      fees.set(l.id, pricing.oneTimeFee);
    } else {
      fees.set(l.id, 0);
    }
  }
  return fees;
}

/** One nanny's shared charge for the order summary (lib/dropoff.ts:189-228). */
export interface NannyGroup {
  key: string;
  nannyId: string | null;
  hours: number;
  fee: Satang;
  lineIds: string[];
  assigned: boolean;
}

export function nannyGroups(lines: readonly DropOffFeeLine[], pricing: DropOffPricing): NannyGroup[] {
  const assigned = new Map<string, NannyGroup>();
  const pending: NannyGroup[] = [];
  for (const l of lines) {
    if (!l.lengthChosen || l.service !== 'nanny') continue;
    if (l.nannyId) {
      const g = assigned.get(l.nannyId);
      if (g) {
        g.lineIds.push(l.id);
        g.hours = Math.max(g.hours, l.hours);
      } else {
        assigned.set(l.nannyId, {
          key: `n-${l.nannyId}`,
          nannyId: l.nannyId,
          hours: l.hours,
          fee: 0,
          lineIds: [l.id],
          assigned: true,
        });
      }
    } else {
      pending.push({ key: `p-${l.id}`, nannyId: null, hours: l.hours, fee: 0, lineIds: [l.id], assigned: false });
    }
  }
  const groups = [...assigned.values(), ...pending];
  for (const g of groups) g.fee = hourly(pricing.nannyHourly, g.hours);
  return groups;
}

/**
 * THE CART RULE (S2-13, settling the question `findStaleLines` handed over in
 * cart-totals.ts): a drop-off line ENTERS the cart only once its length is
 * chosen. Until then it is on the screen and nowhere else — not in the
 * engine's cart, not in a quote, not in a sale — so there is no unpriced line
 * for the engine to mistake for a stale one, and no `trust_stored` anywhere.
 */
export function dropOffLineEntersCart(line: { dropOff?: { lengthChosen: boolean } | null }): boolean {
  return !line.dropOff || line.dropOff.lengthChosen;
}

/** Prepaid food as a line charge — what the provision adds to the line, in satang. */
export function prepaidFoodCharge(provision: { mode: string; paidSatang: number } | null | undefined): Satang {
  if (!provision || provision.mode === 'none' || provision.paidSatang <= 0) return 0;
  return provision.paidSatang;
}

/** The band's badge for a supervised child: printed on the kids band (R-50). */
export type SupervisionBadge = 'DROP-OFF' | 'NANNY';

export function supervisionBadgeOf(service: SupervisionRequirement): SupervisionBadge | null {
  return service === 'nanny' ? 'NANNY' : service === 'drop_off' ? 'DROP-OFF' : null;
}

// --- The wire (zod) -------------------------------------------------------------------

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(100);

export const FoodProvisionSchema = z
  .object({
    mode: z.enum(['none', 'prepaid_credit', 'prepaid_items']),
    paidSatang: z.number().int().min(0).max(10_000_000),
    creditSatang: z.number().int().min(0).max(10_000_000).optional(),
    items: z
      .array(
        z.object({
          menuItemId: z.string().min(1).max(200),
          menuItemName: z.string().min(1).max(200),
          unitSatang: z.number().int().min(0),
          qty: z.number().int().min(1).max(99),
          redeemedQty: z.number().int().min(0).default(0),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict();
export type FoodProvisionInput = z.infer<typeof FoodProvisionSchema>;

/** One child on a registration, as the gate sends it. */
export const RegistrationChildSchema = z
  .object({
    /** The check-in row's id — and the till's drop-off cart line id. Client-minted UUIDv7. */
    checkinId: uuid,
    /** The saved child record, when the guardian has one. */
    childId: uuid.nullable().optional(),
    name,
    ageYears: z.number().int().min(0).max(17),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    /** What the gate resolved. The server resolves it again from the age and refuses a mismatch. */
    service: z.enum(SUPERVISION_REQUIREMENTS),
    allergies: z.string().trim().max(1000).nullable().optional(),
    foodRestrictions: z.string().trim().max(1000).nullable().optional(),
    foodProvision: FoodProvisionSchema.nullable().optional(),
  })
  .strict();
export type RegistrationChildInput = z.infer<typeof RegistrationChildSchema>;

export const CreateRegistrationSchema = z
  .object({
    /** Client-minted UUIDv7 (OD-12): the same id again answers with the registration that exists. */
    id: uuid.optional(),
    branchId: uuid,
    stationId: uuid.nullable().optional(),
    memberId: uuid.nullable().optional(),
    visitId: uuid.nullable().optional(),
    guardianName: name,
    guardianPhone: z.string().trim().max(40).nullable().optional(),
    contactChannel: z.enum(['whatsapp', 'telegram', 'line']).default('whatsapp'),
    consentAcknowledged: z.boolean(),
    acknowledgedConfirmationIds: z.array(z.string().min(1).max(200)).max(50).default([]),
    children: z.array(RegistrationChildSchema).min(1).max(20),
  })
  .strict();
export type CreateRegistrationInput = z.infer<typeof CreateRegistrationSchema>;

export const AddRegistrationChildrenSchema = z
  .object({ children: z.array(RegistrationChildSchema).min(1).max(20) })
  .strict();

export const CreateWaiverSchema = z
  .object({
    id: uuid.optional(),
    branchId: uuid,
    stationId: uuid.nullable().optional(),
    registrationId: uuid.nullable().optional(),
    child: z.object({ name, ageYears: z.number().int().min(0).max(17), childId: uuid.nullable().optional() }).strict(),
    sibling: z.object({ name, ageYears: z.number().int().min(0).max(17), childId: uuid.nullable().optional() }).strict(),
    waivedRequirement: z.enum(['drop_off', 'nanny']),
  })
  .strict();
export type CreateWaiverInput = z.infer<typeof CreateWaiverSchema>;

export const CheckInNowSchema = z
  .object({
    saleId: uuid,
    entries: z
      .array(z.object({ checkinId: uuid, nannyId: uuid.nullable().optional() }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type CheckInNowInput = z.infer<typeof CheckInNowSchema>;

export const LeaveAsBookedSchema = z
  .object({
    saleId: uuid,
    /** The booked play-start time; now when absent (the prototype's booking moment). */
    scheduledFor: z.string().datetime().optional(),
    entries: z.array(z.object({ checkinId: uuid }).strict()).min(1).max(20),
  })
  .strict();
export type LeaveAsBookedInput = z.infer<typeof LeaveAsBookedSchema>;

export const AttachRegistrationPhotoSchema = z
  .object({
    fileId: uuid,
    /** The children this photo shows with the guardian; the registration's own when empty. */
    checkinIds: z.array(uuid).max(20).default([]),
  })
  .strict();
