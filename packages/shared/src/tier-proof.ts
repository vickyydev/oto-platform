/**
 * The documents reception may record for a discounted tier.
 *
 * The till, platform and offline box accept these three kinds for new
 * verifications. Historical records retain their recorded document text.
 * A claim carries the kind of document, never its number.
 */
export const TIER_PROOF_TYPES = ['Passport', 'Residence certificate', 'School card'] as const;
export type TierProofType = (typeof TIER_PROOF_TYPES)[number];
