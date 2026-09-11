import type {
  AcknowledgedConfirmation,
  ConfirmationItem,
  SupervisionBand,
  SupervisionPolicy,
  SupervisionRequirement,
} from '@/types';
import { getSupervisionPolicy } from '@/store/catalogStore';

// Pure resolver seam for the configurable child-supervision policy. Components
// and the door flow read requirements ONLY through here so the rules stay in
// one place (mirrors lib/sale.ts / lib/membership.ts). Defaults to the live
// store policy but accepts an explicit policy for testability.

// Does this band's age range contain `age`? (maxAge null = open-ended top band.)
function bandContains(band: SupervisionBand, age: number): boolean {
  if (age < band.minAge) return false;
  if (band.maxAge === null) return true;
  return age <= band.maxAge;
}

/**
 * The service the park requires of a child of the given age. Out-of-range ages
 * (no band matches) resolve to 'none' but log a console warning so a gap in the
 * admin-edited bands is visible during the prototype.
 */
export function resolveRequirement(
  age: number,
  policy: SupervisionPolicy = getSupervisionPolicy()
): SupervisionRequirement {
  const band = policy.bands.find((b) => bandContains(b, age));
  if (!band) {
    console.warn(
      `[supervision] no band matches age ${age}; defaulting to 'none'. ` +
        `Check the Supervision policy bands for a gap.`
    );
    return 'none';
  }
  return band.requirement;
}

/**
 * The requirement that actually applies to a child once a staff-authorized
 * sibling waiver is accounted for. A waived child drops to 'none' (no drop-off
 * line, no check-in). Centralized so the gate, the consent screen, and the cart
 * conversion all agree on what "covered" means.
 */
export function effectiveRequirement(
  requirement: SupervisionRequirement,
  waived: boolean
): SupervisionRequirement {
  return waived ? 'none' : requirement;
}

export interface SupervisionOutcome {
  // The badge-facing requirement after any staff waiver ('none' | 'drop_off' | 'nanny').
  effective: SupervisionRequirement;
  // True when this child needs the full consent/photo/allergy/dietary/credit
  // capture — either because supervision is mandatory, or because a 'none'
  // (no-fee) child explicitly opted into the identical flow.
  needsConsent: boolean;
  // The service to carry on the resulting drop-off line, or null when the child
  // should remain a plain ticket (no drop-off line at all). 'none' here means a
  // real (opted-in) drop-off line with a ฿0 fee — not "no line".
  service: SupervisionRequirement | null;
}

/**
 * Decouple the safety FLOW from the FEE for a single child: a mandatory
 * requirement (nanny/drop_off, after waiver) always runs the full flow. A
 * 'none'-requirement child normally stays a plain ticket, but may opt in to
 * the identical flow at no fee — opt-in only ever applies to a genuinely
 * 'none' BASE requirement; a requirement waived down to 'none' still resolves
 * to a plain ticket (sibling-waiver behavior is unchanged).
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
  // True when the sibling waiver could apply to THIS child: the waiver is
  // enabled, this child's base requirement is the waivable one, and at least one
  // OTHER child in the group is old enough to act as guardian. The waiver is
  // OFFERED here, never auto-applied — staff must choose it (with operator audit
  // in the door flow).
  waiverEligible: boolean;
}

/**
 * Resolve every child's requirement plus a `waiverEligible` flag, judged across
 * the whole group (so a younger child can be marked waivable when an older
 * sibling is present).
 */
export function resolveGroupRequirements(
  children: { id: string; age: number }[],
  policy: SupervisionPolicy = getSupervisionPolicy()
): ResolvedChildRequirement[] {
  const { siblingWaiver } = policy;
  return children.map((child) => {
    const requirement = resolveRequirement(child.age, policy);
    const waiverEligible =
      siblingWaiver.enabled &&
      requirement === siblingWaiver.waivableRequirement &&
      children.some(
        (other) =>
          other.id !== child.id && other.age >= siblingWaiver.guardianMinAge
      );
    return { id: child.id, age: child.age, requirement, waiverEligible };
  });
}

// --- Confirmations checklist -----------------------------------------------
// Centralizes the "which confirmations must the parent tick" logic so the
// door gate, the customer consent screen, and the /book flow all agree.

/** The policy's confirmations in display order. */
export function sortedConfirmations(
  policy: SupervisionPolicy = getSupervisionPolicy(),
): ConfirmationItem[] {
  return [...policy.confirmations].sort((a, b) => a.order - b.order);
}

/** IDs of the confirmations a parent MUST tick before continuing. */
export function requiredConfirmationIds(
  policy: SupervisionPolicy = getSupervisionPolicy(),
): string[] {
  return policy.confirmations.filter((c) => c.required).map((c) => c.id);
}

/** True once every required confirmation is present in `acknowledgedIds`. */
export function confirmationsSatisfied(
  policy: SupervisionPolicy,
  acknowledgedIds: string[],
): boolean {
  const required = requiredConfirmationIds(policy);
  return required.every((id) => acknowledgedIds.includes(id));
}

/**
 * Build the audited `acknowledgedConfirmations` records (text + timestamp) for
 * every confirmation the parent ticked, at the moment of capture. Stamped onto
 * the CheckIn(s) and/or Booking created by that registration.
 */
export function buildAcknowledgedConfirmations(
  policy: SupervisionPolicy,
  acknowledgedIds: string[],
  acknowledgedAt: string = new Date().toISOString(),
): AcknowledgedConfirmation[] {
  return sortedConfirmations(policy)
    .filter((c) => acknowledgedIds.includes(c.id))
    .map((c) => ({ text: c.text, acknowledgedAt }));
}
