/**
 * Public, customer-facing configuration for the OTO Lucky Wheel.
 *
 * These identifiers deliberately do not use the legacy QR campaign IDs. The
 * wheel QR payload is only a four-digit redemption code, never a QR URL or a
 * Funtovia identifier.
 */
export type SpinRewardDefinition = {
  prizeId: string;
  campaignId: string;
  displayName: string;
  customerValue: string;
  title: string;
  instructions: string;
  terms: string | null;
  activeByDefault: boolean;
};

export const SPIN_REWARDS: readonly SpinRewardDefinition[] = [
  {
    prizeId: "voucher-100",
    campaignId: "spin-wheel-voucher-100",
    displayName: "100 THB Voucher",
    customerValue: "100 THB",
    title: "YOU WON 100 THB!",
    instructions: "Show this QR at OTO Reception and get 100 THB off your ticket order.",
    terms: "Cannot be combined with other offers.",
    activeByDefault: true,
  },
  {
    prizeId: "bracelet-making",
    campaignId: "spin-wheel-bracelet-making",
    displayName: "Free Bracelet Workshop",
    customerValue: "Free Bracelet Workshop",
    title: "YOU WON A FREE BRACELET WORKSHOP!",
    instructions: "Show this QR at OTO and create your own bracelet with us.",
    terms: null,
    activeByDefault: true,
  },
  {
    prizeId: "voucher-150",
    campaignId: "spin-wheel-voucher-150",
    displayName: "150 THB Voucher",
    customerValue: "150 THB",
    title: "YOU WON 150 THB!",
    instructions: "Show this QR at OTO Reception and get 150 THB off your ticket order.",
    terms: "Cannot be combined with other offers.",
    activeByDefault: true,
  },
  {
    prizeId: "voucher-200",
    campaignId: "spin-wheel-voucher-200",
    displayName: "200 THB Voucher",
    customerValue: "200 THB",
    title: "YOU WON 200 THB!",
    instructions: "Show this QR at OTO Reception and get 200 THB off your ticket order.",
    terms: "Cannot be combined with other offers.",
    activeByDefault: true,
  },
  {
    prizeId: "kids-pizza",
    campaignId: "spin-wheel-kids-pizza",
    displayName: "Kids Pizza",
    customerValue: "1 mini pizza + 1 juice",
    title: "YOU WON A FREE KIDS PIZZA!",
    instructions: "Enjoy 1 mini pizza + 1 juice of your choice at OTO Restaurant.\n\nShow this QR to redeem your prize.",
    terms: null,
    activeByDefault: true,
  },
  {
    prizeId: "kids-ticket-1-plus-1",
    campaignId: "spin-wheel-kids-ticket-1-plus-1",
    displayName: "1+1 Kids Ticket",
    customerValue: "1+1 Kids Ticket",
    title: "YOU WON 1+1 KIDS TICKETS!",
    instructions: "Bring 2 children and pay for only 1 kids ticket.",
    terms: "Not valid for Eat & Play. Cannot be combined with other offers.",
    activeByDefault: true,
  },
  {
    prizeId: "mystery-gift",
    campaignId: "spin-wheel-mystery-gift",
    displayName: "Mystery Gift",
    customerValue: "Mystery Gift",
    title: "YOU WON A MYSTERY GIFT!",
    instructions: "Show this QR at OTO Reception to receive your surprise.",
    terms: null,
    activeByDefault: false,
  },
] as const;

export const SPIN_REWARDS_BY_PRIZE_ID = new Map(
  SPIN_REWARDS.map((reward) => [reward.prizeId, reward]),
);