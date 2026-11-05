/**
 * SCRUM-762 — WHERE A TICKET ORDER GOES WHEN STAFF PRESS PAY.
 *
 * Agreed by the park on 30 October: the customer screen asks for the phone
 * number once, at the very start, and it is required; that number is then the
 * one used at payment and on the drop-off and nanny forms, and the family is
 * never asked for it again.
 *
 * The customer's details step (the till's step 4) was the second time a walk-in
 * was asked for their number. It now opens only for what nothing else has
 * collected:
 *
 * - `payment` — a member is on the sale, or the supervision gate already took
 *   the family's details: straight to the payment screen, as before.
 * - `contact_known` — the number was given at the start: the details step is
 *   skipped and the sale carries that number. A rate verified before the
 *   family was known is saved to their profile on the way (SCRUM-227).
 * - `details` — there is no number yet (an order that reached the till some
 *   other way), or a verified rate needs a name before it can be saved to a new
 *   profile. The details screen opens, and shows a number already given rather
 *   than asking for it.
 */
export type PaymentRoute = 'payment' | 'contact_known' | 'details';

export function routeToPayment(input: {
  hasMember: boolean;
  supervisionResolved: boolean;
  phone: string;
  nickname: string;
  /** A tier verified for a walk-in, waiting to be saved to a profile. */
  verificationPending: boolean;
}): PaymentRoute {
  if (input.hasMember || input.supervisionResolved) return 'payment';
  const nameNeeded = input.verificationPending && input.nickname.trim().length === 0;
  if (input.phone.trim().length > 0 && !nameNeeded) return 'contact_known';
  return 'details';
}
