/**
 * The documents reception may record for a discounted tier.
 *
 * A fixed built-in list rather than a table: the four names are the park's
 * real documents and no operator configures them anywhere yet (SCRUM-238's
 * remaining half). Held here, once, because both ends need the same list —
 * the till's picker offers it, and the platform's tier-claim route accepts
 * nothing else (SCRUM-307): a claim carries the KIND of document and never
 * its number, and a free-text field was the one place a passport number could
 * have landed in a table that is never swept.
 *
 * 'Other' prompts the till for a short description, which is saved with the
 * member's verification record, not with the claim.
 */
export const TIER_PROOF_TYPES = ['Passport', 'Residence certificate', 'School card', 'Other'] as const;
export type TierProofType = (typeof TIER_PROOF_TYPES)[number];
