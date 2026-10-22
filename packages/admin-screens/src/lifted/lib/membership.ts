import { type CustomerTier, type Member, type TierVerification } from "../model/types";
import type { CatalogReaders } from '../model/ports';

/** Original domain rules, bound to this host's explicit data ports. */
export function createMembershipHelpers(deps: { catalog: Pick<CatalogReaders, 'getTier' | 'getDefaultTier'> }) {
const { getTier, getDefaultTier } = deps.catalog;


// Tier labels are config-driven (editable in Admin → Tiers). This helper
// resolves a label from the store and falls back to the raw id, so historical
// data referencing a since-renamed/removed tier still renders something sensible.
// Imports come from catalogStore (not mockApi) to avoid an import cycle —
// mockApi imports this module.

/** Display label for a tier id (falls back to the id if unknown). */
function tierLabel(tier: CustomerTier): string {
  return getTier(tier)?.name ?? tier;
}


/** True when this tier is the no-verification baseline (the default tier). */
function isDefaultTier(tier: CustomerTier): boolean {
  return getDefaultTier()?.id === tier;
}


/** The verified entitlement a member holds, if any. */
function getVerification(
  member: Member | null,
): TierVerification | undefined {
  return member?.tierVerification;
}


/**
 * Whether granting this tier requires proof. Driven by the tier's config flag;
 * an unknown tier id is treated as not requiring proof (defensive).
 */
function tierNeedsProof(tier: CustomerTier): boolean {
  return getTier(tier)?.requiresVerification ?? false;
}


/** True when this tier is allowed without fresh proof for this member. */
function isTierVerified(
  member: Member | null,
  tier: CustomerTier
): boolean {
  if (!tierNeedsProof(tier)) return true;
  return getVerification(member)?.tier === tier;
}


/**
 * The tier that auto-applies for a member: their verified tier if any,
 * otherwise the configured default (baseline) tier.
 */
function resolveAutoTier(
  member: Member | null,
): CustomerTier {
  return getVerification(member)?.tier ?? getDefaultTier()!.id;
}
return { tierLabel, isDefaultTier, getVerification, tierNeedsProof, isTierVerified, resolveAutoTier };
}
export type MembershipHelpers = ReturnType<typeof createMembershipHelpers>;
