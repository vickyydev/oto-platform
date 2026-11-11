import { CustomerTier, Member, TierVerification } from '@/types';
import {
  getTier,
  getDefaultTier,
} from '@/store/catalogStore';

// Tier labels are config-driven (editable in Admin → Tiers). This helper
// resolves a label from the store and falls back to the raw id, so historical
// data referencing a since-renamed/removed tier still renders something sensible.
// Imports come from catalogStore (not mockApi) to avoid an import cycle —
// mockApi imports this module.

/** Display label for a tier id (falls back to the id if unknown). */
export function tierLabel(tier: CustomerTier): string {
  return getTier(tier)?.name ?? tier;
}

/** True when this tier is the no-verification baseline (the default tier). */
export function isDefaultTier(tier: CustomerTier): boolean {
  return getDefaultTier()?.id === tier;
}

/** The verified entitlement a member holds, if any. */
export function getVerification(
  member: Member | null,
): TierVerification | undefined {
  return member?.tierVerification;
}

/**
 * Whether granting this tier requires proof. Driven by the tier's config flag;
 * an unknown tier id is treated as not requiring proof (defensive).
 */
export function tierNeedsProof(tier: CustomerTier): boolean {
  return getTier(tier)?.requiresVerification ?? false;
}

/** True when this tier is allowed without fresh proof for this member. */
export function isTierVerified(
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
export function resolveAutoTier(
  member: Member | null,
): CustomerTier {
  return getVerification(member)?.tier ?? getDefaultTier().id;
}

/**
 * SCRUM-858 — the one tier a returning member sees at the till.
 *
 * The owner's rule (8 and 12 November 2026): "Registered members should not
 * see other ticket types. Show only their relevant ticket until their
 * document expires." A member whose rate is verified and whose document is
 * in date — or carries no expiry at all, as a Thai rate confirmed at the till
 * never does — sees that tier's card alone. Null means every tier is shown,
 * as before: a walk-in, a member with no verified rate, and a member whose
 * recorded expiry has passed (`reverifyDue`, beside the re-verify prompt).
 *
 * A rate the branch no longer configures has no card to show alone, so it
 * falls back to every tier rather than to none.
 */
export function soleTierFor(member: Member | null): CustomerTier | null {
  const verification = getVerification(member);
  if (!verification || verification.reverifyDue) return null;
  if (!getTier(verification.tier)) return null;
  return verification.tier;
}
