import type { PaymentStageController } from '@/lib/usePaymentStage';

/**
 * SCRUM-960 — LEAVING A PART-PAID F&B OR SHOP ORDER AS IT IS.
 *
 * Once a part of an F&B or shop order is paid, the payment stage shuts Back
 * and the station holds its header's tabs (`canBack`, SCRUM-916): money taken
 * on this screen is never walked away from by accident. But with the rest
 * not coming now, nothing let staff go on to the next family: only a reload
 * freed the till (staging's 14c2). The order itself was safe all along: it
 * stays on the platform part-paid, History lists it as Partly paid with its
 * balance, and a manager refunds what was paid from there.
 *
 * So the counter offers the ticket till's own way out, in its words: "Save as
 * partly paid", after which the station starts afresh. Unlike the ticket
 * till's, it writes no hold to the platform: Held sales is read on the ticket
 * tills, which cannot open a food or shop order (SCRUM-917), so a card there
 * would offer a Resume that is refused. Nothing is voided, refunded or
 * printed: the order is left exactly as a reload left it.
 *
 * Offered only when money was taken on this screen (a party's deposit taken
 * before is not this screen's) and something is still owed; shut, with the
 * till's own reason, while a payment is in flight (a QR on the display, a
 * card being read, an answer awaited), so a hold that protects money moving
 * is never lifted.
 */
export interface ItemPartPaidExit {
  shown: boolean;
  /** Null when it can be pressed; otherwise why not. */
  reason: string | null;
  paidSatang: number;
  balanceSatang: number;
}

/** The ticket till's sentence for the same case (`holdButtonReasons`, lib/heldSales). */
export const PAYMENT_IN_FLIGHT = 'A payment is in progress — finish or cancel it first.';

export function itemPartPaidExit(stage: Pick<PaymentStageController, 'state' | 'locked'>): ItemPartPaidExit {
  const taken = stage.state.settlements.filter((part) => !part.partyDeposit);
  const paidSatang = taken.reduce((sum, part) => sum + part.amountSatang, 0);
  const balanceSatang = stage.state.outstandingSatang;
  const shown = stage.state.phase !== 'complete' && taken.length > 0 && paidSatang > 0 && balanceSatang > 0;
  return { shown, reason: shown && stage.locked ? PAYMENT_IN_FLIGHT : null, paidSatang, balanceSatang };
}
