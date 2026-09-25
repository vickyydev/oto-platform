/**
 * The one honest sentence History tells about itself — SCRUM-238.
 *
 * The list, the cards and the detail panel now read the platform's sale ledger.
 * Everything that would CHANGE a recorded sale — refunding it, reprinting its
 * receipt, selling more time onto its bands — and the bracelet scan that finds
 * a sale by band land with S2-11 (SCRUM-208): that ticket mints and prints the
 * signed bands, and brings refunds and reprints with manager approval. Until
 * it does, those buttons are disabled and this is why, said once, in one
 * place, so the sentence cannot drift between screens.
 *
 * The one change History does make is the void of an unpaid sale that took no
 * money, from that sale's own page (audit C1; `SaleDetail.tsx`): a sale rung up
 * and then left at a till otherwise stays unpaid for ever, holding any Lucky
 * Wheel voucher that was on it.
 */
export const LEDGER_ONLY_NOTICE =
  'Refunds, reprints, adding time and the bracelet scan arrive with SCRUM-208 (S2-11). ' +
  'Until then this page reads recorded sales and changes one thing only: an unpaid sale ' +
  'that took no money can be voided from its own page.';
